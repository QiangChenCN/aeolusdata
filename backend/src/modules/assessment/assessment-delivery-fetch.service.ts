import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { OrdersFetchService, OrderRow } from '../../../fetch/orders-fetch.service';

/**
 * 考核看板 —— 运单明细「自有取数落盘」（2026-10-14 起：考核看板自行落盘运单，
 * 不再复用标准达成 / 任务中心落盘的 orders_*；后续「所有落盘整合」由用户统一处理）。
 *
 * 与违规取数（assessment-violation-fetch.service.ts）并列，但粒度不同：
 *   · 违规取数已全站合并为单文件（覆盖写）落盘到 backend/data/违规处罚明细-实时.json，不再按团队 × 日期拆分；
 *   · 运单是**全站单文件、覆盖写**快照，落盘到 `backend/data/运单明细-实时.json`
 *     （文件名 / 目录由用户明确规定，整合前固定不动）。
 *
 * 取数复用底层 primitive `OrdersFetchService.fetchOrders`（导出优先 + 分页兜底 + 会话重登，
 * 属取数基础设施，等同 cache 数据层，按需复用）；解析 / 落盘本服务独立实现。
 *
 * 时间窗：实时 = 北京当日 00:00:00 ~ 当前（截至此刻的今日运单）。
 *
 * 触发：前端「考核看板」刷新（拉运单）→ `POST /api/assessment-fetch/delivery`。
 * 读侧：Python 后续整合时再改读本文件（本次不动）。
 */
const DATA_FILE = '运单明细-实时.json';

/** 北京时间 `YYYY-MM-DD HH:MM:SS`（与 Python 同口径）。 */
function nowStamp(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

@Injectable()
export class AssessmentDeliveryFetchService {
  private readonly logger = new Logger(AssessmentDeliveryFetchService.name);
  private readonly dataDir: string;

  constructor(
    private readonly config: ConfigService,
    private readonly orders: OrdersFetchService,
  ) {
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.dataDir = path.join(root, 'backend', 'data');
  }

  /** 单文件落盘路径。 */
  filePath(): string {
    return path.join(this.dataDir, DATA_FILE);
  }

  /**
   * 拉取今日（实时：截至当前）全站运单明细 → 落盘单文件（覆盖写）。
   * date 缺省今天。失败写 fetch_ok=false。
   */
  async fetchAndLand(date?: string): Promise<{ ok: boolean; msg: string }> {
    const d =
      date && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? date
        : new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const [y, mo, day] = d.split('-').map(Number);
    const startMs = Date.UTC(y, mo - 1, day, -8, 0, 0); // 北京当日 00:00:00
    const endMs = Date.now() + 8 * 3600 * 1000; // 北京现在（实时）

    let rows: OrderRow[];
    try {
      rows = await this.orders.fetchOrders(startMs, endMs);
    } catch (e) {
      const err = `运单取数失败：${(e as Error).message}`;
      this.logger.warn(err);
      this.writeFailed(d, err);
      return { ok: false, msg: err };
    }

    this.writeOk(d, rows);
    const msg = `运单 ${rows.length} 条，已落盘 ${this.filePath()}`;
    this.logger.log(`考核看板运单取数 ${d}：${msg}`);
    return { ok: true, msg };
  }

  private writeOk(date: string, rows: OrderRow[]): void {
    const payload = {
      date,
      fetched_at: nowStamp(),
      fetch_ok: true,
      fetch_error: null,
      total: rows.length,
      rows,
    };
    fs.writeFileSync(this.filePath(), JSON.stringify(payload), 'utf-8');
  }

  /** 取数失败：仍写文件但置 fetch_ok=false，便于读侧 / 排障识别。 */
  private writeFailed(date: string, error: string): void {
    const payload = {
      date,
      fetched_at: nowStamp(),
      fetch_ok: false,
      fetch_error: String(error).slice(0, 300) || null,
      total: 0,
      rows: [],
    };
    fs.writeFileSync(this.filePath(), JSON.stringify(payload), 'utf-8');
  }
}
