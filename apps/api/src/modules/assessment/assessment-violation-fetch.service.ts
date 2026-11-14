import { Injectable, Logger } from '@nestjs/common';
import { ViolationFetchService } from '../../infra/fetch/sources/violation-fetch.service';
import { AssessmentDetailStoreService } from './assessment-detail-store.service';

/**
 * 考核看板 —— 违规处罚明细「自有取数入库」（与标准达成 / 服务质量完全解耦）。
 *
 * 历史：本看板的违规取数最早挂在「标准达成全量刷新 stage 0.5」上，落到共享的
 * `apps/api/runtime/raw/violation_{team}_{date}.json`；2026-10-13 起改由本服务独立取数并
 * 落盘 `apps/api/runtime/违规处罚明细-实时.json`；2026-10-23 起**不再落盘**，改写入 PG：
 *   · `violation_realtime`  实时违规处罚明细（当天覆盖写，source='assessment'）；
 *   · `violation`           历史违规处罚明细（same source，供历史区间聚合）。
 *
 * 取数（打风神接口 / 解码）复用底层 primitive `ViolationFetchService`（属取数基础设施，
 * 等同 cache 数据层；URL / 请求头 / 解码口径集中在那一处）；解析 / 入库是本服务独立实现。
 *
 * 触发：前端「考核看板」刷新按钮 → `POST /api/assessment-fetch/violation`。
 * 读侧：Python `analytics/domains/assessment/violations.py::load_team_raw` 经内部端点读表。
 */
/** 北京时间某天 [00:00:00.000, 23:59:59.999] 毫秒区间。 */
function dayRangeMs(date: string): [number, number] {
  return [
    Date.parse(`${date}T00:00:00.000+08:00`),
    Date.parse(`${date}T23:59:59.999+08:00`),
  ];
}

/**
 * 极简稳健 CSV 解析（与 Python `csv.DictReader` 对齐：支持引号包裹、"" 转义、
 * 字段内逗号 / 换行）。返回按表头键名的 dict 列表。
 */
function parseCsv(text: string): Record<string, string>[] {
  const lines: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      lines.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    lines.push(row);
  }
  // 丢弃末尾空行
  if (lines.length && lines[lines.length - 1].length === 1 && lines[lines.length - 1][0] === '') {
    lines.pop();
  }
  if (!lines.length) return [];
  const header = lines[0];
  const out: Record<string, string>[] = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r];
    if (cells.length === 1 && cells[0] === '') continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = (cells[c] ?? '').trim();
    }
    out.push(obj);
  }
  return out;
}

@Injectable()
export class AssessmentViolationFetchService {
  private readonly logger = new Logger(AssessmentViolationFetchService.name);
  constructor(
    private readonly violation: ViolationFetchService,
    private readonly detail: AssessmentDetailStoreService,
  ) {}

  /**
   * 拉取 date 全天违规明细 → 写入 PG（全站所有站点，与前端是否选中无关）。
   * 2026-11-13 修订：实时 / 历史两表写入解耦 ——
   *   · 默认（手动 / 自动刷新）：只写 `violation_realtime` 实时违规处罚明细
   *     （当天覆盖写，source='assessment'），**不再写历史表**；
   *   · opts.historyOnly=true（回补任务）：只写 `violation` 历史违规处罚明细
   *     （供历史区间聚合），不碰实时表，防止破坏今日看板。
   * 历史表统一由每日 04:00 回补任务写完结后的全天数据
   * （见 `AssessmentViolationHistorySchedulerService`）。
   * 失败时不写表（保留上一版数据），仅记日志。
   */
  async fetchAndLand(_teams: string[], date: string, opts?: { historyOnly?: boolean }): Promise<{ ok: boolean; msg: string }> {
    const [startMs, endMs] = dayRangeMs(date);
    const historyOnly = opts?.historyOnly === true;

    let text: string;
    try {
      const r = await this.violation.downloadCsv(startMs, endMs);
      text = r.text;
    } catch (e) {
      const err = `违规取数失败：${(e as Error).message}`;
      this.logger.warn(err);
      if (!historyOnly) this.writeFailed(date, err);
      return { ok: false, msg: err };
    }

    let rows: Record<string, string>[];
    try {
      rows = parseCsv(text);
    } catch (e) {
      const err = `CSV 解析失败：${(e as Error).message}`;
      this.logger.error(err);
      if (!historyOnly) this.writeFailed(date, err);
      return { ok: false, msg: err };
    }

    await this.writeOk(date, rows, historyOnly);
    const msg =
      `违规 ${rows.length} 条` +
      (historyOnly ? '（已写历史表 violation）' : '（已写实时表 violation_realtime）');
    this.logger.log(`考核看板违规取数 ${date}：${msg}`);
    return { ok: true, msg };
  }

  private async writeOk(
    date: string,
    rows: Record<string, string>[],
    historyOnly = false,
  ): Promise<void> {
    if (historyOnly) {
      // 历史回补：只写历史表 violation（供历史区间聚合），不碰实时表（防止破坏今日看板）。
      await this.detail.upsertViolationHistoryDay(date, rows);
      // 打回补水位：该日期违规历史已完整落库（全天窗口），Python 读侧据此放行该日期。
      await this.detail.markBackfill('violation', date, rows.length);
      return;
    }
    // 手动 / 自动刷新：只写实时违规处罚明细表（当天覆盖写，source='assessment'，
    // 与违规看板数据隔离）。历史表不再随刷写入 —— 当天最后一次刷新之前的处罚明细
    // 残缺且跨天无人回补；历史表统一由每日 04:00 回补任务写全天数据。
    await this.detail.upsertViolationDay(date, rows);
  }

  /** 取数失败：不写表（保留上一版数据），仅记日志；读侧当天无数据即判「需刷新」。 */
  private writeFailed(date: string, error: string): void {
    this.logger.warn(`考核违规取数失败 ${date}（保留上一版数据）：${String(error).slice(0, 300)}`);
  }
}
