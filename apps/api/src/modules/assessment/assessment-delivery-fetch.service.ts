import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { OrdersFetchService, OrderRow } from '../../infra/fetch/sources/orders-fetch.service';
import { AssessmentHistoryStoreService } from './assessment-history-store.service';
import { AssessmentDetailStoreService } from './assessment-detail-store.service';

/**
 * 考核看板 —— 运单明细「自有取数入库」（2026-10-23 起：不再落盘 JSON，改写 PG）。
 *
 * 写入两张表（读写入口都在 `AssessmentDetailStoreService`）：
 *   · `delivery_realtime` 实时运单明细（全站当天快照，覆盖写）—— 今日看板计算源；
 *   · `delivery`          历史运单明细（按 order_id + date 幂等 UPSERT）—— 历史区间聚合源。
 *
 * 取数复用底层 primitive `OrdersFetchService.fetchOrders`（导出优先 + 分页兜底 + 会话重登，
 * 属取数基础设施，等同 cache 数据层，按需复用）；解析 / 入库本服务独立实现。
 *
 * 时间窗：实时 = 北京当日 00:00:00 ~ 当前（截至此刻的今日运单）。
 *
 * 触发：前端「考核看板」刷新（拉运单）→ `POST /api/assessment-fetch/delivery`。
 * 读侧：Python `analytics/domains/assessment/delivery_source.py` 经内部端点读 `delivery_realtime`。
 */

/** 运单稳定主键：优先 trackingId / 运单id / orderNo，缺失则回退整行哈希（保底，幂等）。 */
function deliveryId(o: Record<string, unknown>): string {
  const v: Record<string, unknown> = o;
  const cand =
    v['trackingId'] ?? v['运单id'] ?? v['platformTrackingId'] ?? v['orderNo'] ?? v['orderId'] ?? v['订单号'];
  if (cand != null && String(cand).trim()) return String(cand).trim();
  return 'h' + createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 24);
}

/** 运单所属站点（团队 id）。 */
function deliveryTeam(o: Record<string, unknown>): string {
  const v: Record<string, unknown> = o;
  const cand = v['teamId'] ?? v['站点id'] ?? v['teamID'];
  return cand != null ? String(cand).trim() : '';
}

@Injectable()
export class AssessmentDeliveryFetchService {
  private readonly logger = new Logger(AssessmentDeliveryFetchService.name);

  constructor(
    private readonly orders: OrdersFetchService,
    private readonly history: AssessmentHistoryStoreService,
    private readonly detail: AssessmentDetailStoreService,
  ) {}

  /**
   * 拉取某日全站运单明细 → 落盘。date 缺省今天。
   *   · 今天：时间窗 = 北京当日 00:00 ~ 当前（实时，截至此刻的今日运单）；
   *   · 过去日：时间窗 = 北京当日 00:00 ~ 当日 23:59:59（用于历史回填，避免跨多天）。
   * opts.historyOnly=true：只写历史表 `delivery`、不覆盖实时表（回填用，防止破坏今日看板）。
   * 失败时不写表（保留上一版数据），仅记日志；读侧当天无数据即提示需刷新。
   */
  async fetchAndLand(date?: string, opts?: { historyOnly?: boolean }): Promise<{ ok: boolean; msg: string }> {
    const d =
      date && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? date
        : new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const [y, mo, day] = d.split('-').map(Number);
    const startMs = Date.UTC(y, mo - 1, day, -8, 0, 0); // 北京当日 00:00:00
    const endOfDayMs = Date.UTC(y, mo - 1, day, 16, 0, 0) - 1; // 北京当日 23:59:59.999
    const endMs = Math.min(Date.now() + 8 * 3600 * 1000, endOfDayMs); // 今日=现在;过去日=当日结束
    const historyOnly = opts?.historyOnly === true;

    let rows: OrderRow[];
    try {
      rows = await this.orders.fetchOrders(startMs, endMs);
    } catch (e) {
      const err = `运单取数失败：${(e as Error).message}`;
      this.logger.warn(err);
      if (!historyOnly) this.writeFailed(d, err);
      return { ok: false, msg: err };
    }

    await this.writeOk(d, rows, historyOnly);
    const msg =
      `运单 ${rows.length} 条` +
      (historyOnly ? '，已写历史表 delivery' : '，已写 delivery_realtime + delivery');
    this.logger.log(`考核看板运单取数 ${d}：${msg}`);
    return { ok: true, msg };
  }

  private async writeOk(date: string, rows: OrderRow[], historyOnly = false): Promise<void> {
    // 实时运单明细表（全站当天快照，覆盖写）—— 今日看板计算源。
    if (!historyOnly) {
      await this.detail.replaceDeliveryDay(date, rows as unknown as Record<string, unknown>[]);
    }
    // 历史运单明细表（按 order_id + date 幂等 UPSERT）—— 历史区间聚合源。
    await this.history.upsertDeliveries(rows.map((o) => ({
      id: deliveryId(o),
      teamId: deliveryTeam(o),
      date,
      payload: o,
    })));
  }

  /** 取数失败：不写表（保留上一版数据），仅记日志；读侧当天无数据即判「需刷新」。 */
  private writeFailed(date: string, error: string): void {
    this.logger.warn(`考核运单取数失败 ${date}（保留上一版数据）：${String(error).slice(0, 300)}`);
  }
}
