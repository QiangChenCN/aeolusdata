import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { OrdersFetchService, OrderRow } from '../../infra/fetch/sources/orders-fetch.service';
import { AssessmentHistoryStoreService } from './assessment-history-store.service';
import { AssessmentDetailStoreService } from './assessment-detail-store.service';

/**
 * 考核看板 —— 运单明细「自有取数入库」（2026-10-23 起：不再落盘 JSON，改写 PG；
 * 2026-11-13 修订：实时 / 历史两表写入解耦）。
 *
 * 写入两张表（读写入口都在 `AssessmentDetailStoreService`）：
 *   · `delivery_realtime` 实时运单明细（全站当天快照，覆盖写）—— 今日看板计算源，
 *     手动 / 自动刷新写入；
 *   · `delivery`          历史运单明细（按 order_id + date 幂等 UPSERT）—— 历史区间聚合源，
 *     **仅**由每日 04:00 回补任务写全天数据
 *     （`AssessmentDeliveryHistorySchedulerService`，historyOnly=true）。
 *
 * 为什么刷新不再写历史表：刷新时间窗是「今日 00:00 ~ 刷新时刻」，落进历史表的是残缺
 * 快照（例：22:33 刷新 → 当天只入 5753/6345 条），跨天后无人回补，历史聚合就永久带着
 * 残缺口径。改为凌晨统一回补全天数据，保证历史表只含已完结的完整日。
 *
 * 取数复用底层 primitive `OrdersFetchService.fetchOrders`（导出优先 + 分页兜底 + 会话重登，
 * 属取数基础设施，等同 cache 数据层，按需复用）；解析 / 入库本服务独立实现。
 *
 * 时间窗：实时 = 北京当日 00:00:00 ~ 当前（截至此刻的今日运单）。
 *
 * 触发：前端「考核看板」刷新（拉运单）→ `POST /api/assessment-fetch/delivery`。
 * 读侧：Python `analytics/domains/assessment/delivery_source.py` 经内部端点读 `delivery_realtime`；
 *       历史区间由 Python `period.py` 直读 PG `delivery`。
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
      (historyOnly ? '，已写历史表 delivery' : '，已写实时表 delivery_realtime');
    this.logger.log(`考核看板运单取数 ${d}：${msg}`);
    return { ok: true, msg };
  }

  private async writeOk(date: string, rows: OrderRow[], historyOnly = false): Promise<void> {
    if (historyOnly) {
      // 历史回补：只写历史表 delivery（幂等 UPSERT），不碰实时表（防止破坏今日看板）。
      await this.history.upsertDeliveries(rows.map((o) => ({
        id: deliveryId(o),
        teamId: deliveryTeam(o),
        date,
        payload: o,
      })));
      // 打回补水位：该日期运单历史已完整落库（全天窗口），Python 读侧据此放行该日期。
      await this.detail.markBackfill('delivery', date, rows.length);
      return;
    }
    // 手动 / 自动刷新：只写实时表 delivery_realtime（全站当天快照，覆盖写）。
    // 历史表不再随刷快照写入 —— 刷新时间窗只到「当前时刻」，写进历史的是残缺数据
    // 且跨天无人回补；历史表统一由每日 04:00 回补任务写全天数据。
    await this.detail.replaceDeliveryDay(date, rows as unknown as Record<string, unknown>[]);
  }

  /** 取数失败：不写表（保留上一版数据），仅记日志；读侧当天无数据即判「需刷新」。 */
  private writeFailed(date: string, error: string): void {
    this.logger.warn(`考核运单取数失败 ${date}（保留上一版数据）：${String(error).slice(0, 300)}`);
  }
}
