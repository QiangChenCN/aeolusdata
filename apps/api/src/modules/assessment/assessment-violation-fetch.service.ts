import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ViolationFetchService } from '../../infra/fetch/sources/violation-fetch.service';
import { AssessmentHistoryStoreService } from './assessment-history-store.service';

/**
 * 考核看板 —— 违规处罚明细「自有取数」（与标准达成 / 服务质量完全解耦）。
 *
 * 此前考核看板的违规取数挂在「标准达成全量刷新 stage 0.5」上，经
 * `sources.violation` / `RawCacheService.saveViolation` 落到共享的
 * `apps/api/runtime/raw/violation_{team}_{date}.json`，与标准看板共用取数代码与落盘命名空间。
 *
 * 现改为考核看板**自己的**取数函数：
 *   · 取数（打风神接口 / 解码）复用底层 primitive `ViolationFetchService`（属取数基础设施，
 *     等同 `cache` 数据层，按需复用；URL / 请求头 / 解码口径集中在那一处）；
 *   · 解析 / 按站点分组 / 落盘到**自有命名空间** 是本服务独立实现（参考逻辑，不自建 HTTP 客户端）；
 *   · 落盘目录 `apps/api/runtime/`（与「运单明细-实时.json」同级），全站合并为一份当天文件
 *     `违规处罚明细-实时.json`（覆盖写），包装格式与 Python 读侧约定一致：
 *     { date, team_id, fetched_at, fetch_ok, fetch_error, rows }。
 *
 * 触发：前端「考核看板」刷新按钮 → `POST /api/assessment-fetch/violation`。
 * 读侧：Python `analytics/assessment/violations.py::load_team_raw`。
 */
/** 北京时间 `YYYY-MM-DD HH:MM:SS`（与 Python 同口径）。 */
function nowStamp(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** 北京时间某天 [00:00:00.000, 23:59:59.999] 毫秒区间。 */
function dayRangeMs(date: string): [number, number] {
  return [
    Date.parse(`${date}T00:00:00.000+08:00`),
    Date.parse(`${date}T23:59:59.999+08:00`),
  ];
}

/**
 * 违规稳定主键：同一违规（同站点 + 同运单 + 同类型 + 同原因）幂等去重；
 * 状态（成立/不成立）翻转时覆盖同一行而非新增，避免历史计数虚高。
 */
function violationId(r: Record<string, string>): string {
  const base =
    (r['团队ID'] ?? r['teamId'] ?? '') +
    '|' + (r['运单号'] ?? '') +
    '|' + (r['违规类型'] ?? '') +
    '|' + (r['违规原因'] ?? '');
  return createHash('sha1').update(base).digest('hex').slice(0, 24);
}

/** 违规所属站点（团队 id）。 */
function violationTeam(r: Record<string, string>): string {
  const cand = r['团队ID'] ?? r['teamId'];
  return cand != null ? String(cand).trim() : '';
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
  private readonly rawDir: string;

  constructor(
    private readonly config: ConfigService,
    private readonly violation: ViolationFetchService,
    private readonly history: AssessmentHistoryStoreService,
  ) {
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.rawDir = path.join(root, 'apps', 'api', 'runtime');
  }

  /** 全站一份当天文件落盘路径（覆盖写）。 */
  rawPath(): string {
    return path.join(this.rawDir, '违规处罚明细-实时.json');
  }

  /**
   * 拉取 date 全天违规明细 → 全站合并为「一份当天文件」覆盖写
   * （apps/api/runtime/违规处罚明细-实时.json）。失败（下载/解析）时整份写 fetch_ok=false，
   * 并保留旧 rows 便于回查。落盘全站所有站点，与前端是否选中无关。
   */
  async fetchAndLand(_teams: string[], date: string, opts?: { historyOnly?: boolean }): Promise<{ ok: boolean; msg: string }> {
    fs.mkdirSync(this.rawDir, { recursive: true });
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
    const msg = `违规 ${rows.length} 条` + (historyOnly ? '（已写历史库）' : '（全站合并落盘）');
    this.logger.log(`考核看板违规取数 ${date}：${msg}`);
    return { ok: true, msg };
  }

  private async writeOk(date: string, rows: Record<string, string>[], historyOnly = false): Promise<void> {
    if (!historyOnly) {
      const payload = {
        date,
        fetched_at: nowStamp(),
        fetch_ok: true,
        fetch_error: null,
        rows,
      };
      fs.writeFileSync(this.rawPath(), JSON.stringify(payload), 'utf-8');
    }
    // 写入历史库（按 vid + date 幂等 UPSERT），供历史区间聚合读取。
    await this.history.upsertViolations(rows.map((r) => ({
      id: violationId(r),
      teamId: violationTeam(r),
      date,
      payload: r,
    })));
  }

  /** 取数失败：整份写 fetch_ok=false，保留旧 rows（便于回查），使读侧视为不可用。 */
  private writeFailed(date: string, error: string): void {
    let oldRows: Record<string, string>[] = [];
    try {
      const prev = JSON.parse(fs.readFileSync(this.rawPath(), 'utf-8'));
      if (prev && Array.isArray(prev.rows)) oldRows = prev.rows;
    } catch {
      /* 无旧文件则 rows 为空 */
    }
    const payload = {
      date,
      fetched_at: nowStamp(),
      fetch_ok: false,
      fetch_error: String(error).slice(0, 300) || null,
      rows: oldRows,
    };
    fs.writeFileSync(this.rawPath(), JSON.stringify(payload), 'utf-8');
  }
}
