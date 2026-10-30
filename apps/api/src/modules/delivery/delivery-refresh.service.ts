import { Injectable, Logger } from '@nestjs/common';
import { OrdersFetchService, OrderRow } from '../../infra/fetch/sources/orders-fetch.service';
import { RawCacheService, todayYmd } from '../../infra/fetch/storage/raw-cache.service';
import { DeliveryStoreService } from './delivery-store.service';

/**
 * 运单明细看板的刷新入口（`POST /api/delivery/refresh`）。
 *
 * 与配送超时看板「共享的只剩底层取数」`OrdersFetchService.fetchOrders`（风神运单，一次拉全站）；
 * 落库写的是同一张 `delivery_realtime`，且**写入口径刻意与配送超时刷新保持一致**
 * （时间维度固定 trackingFinish、整日覆盖写、只落有 teamId 的行）——
 * 这样两个入口刷出来的明细完全等价，不会因为「谁最后刷」而让别的看板数字跳变。
 */
function dayRangeMs(date: string): [number, number] {
  return [Date.parse(`${date}T00:00:00.000+08:00`), Date.parse(`${date}T23:59:59.999+08:00`)];
}

export interface DeliveryRefreshResult {
  ok: boolean;
  date: string;
  /** 风神抓回的运单总行数（全站，未过滤前）。 */
  total: number;
  /** 实际写入 PG 表的行数。 */
  saved: number;
  /** 按站点分组的行数（等价于本次刷新的站点覆盖）。 */
  perTeam: { team: string; rows: number }[];
  /** 失败原因：not_ready = DATABASE_URL 未配置，PG 表不可用。 */
  error?: string | null;
}

@Injectable()
export class DeliveryRefreshService {
  private readonly logger = new Logger(DeliveryRefreshService.name);

  constructor(
    private readonly orders: OrdersFetchService,
    private readonly raw: RawCacheService,
    private readonly store: DeliveryStoreService,
  ) {}

  /**
   * 拉全站运单 → 整份覆盖写实时运单明细表（当天快照）。同步返回，前端无需轮询。
   *
   * 实时表只保留「当天」：无论调用方传什么 date，都强制刷今天，且写完后清掉
   * 所有非今天的旧行（历史 T-1~T-7 由每天 4 点的滚动任务维护在 `delivery_history`）。
   * 这样实时表恒定是单日、不会与历史表重复，也不会出现「22 号有、21 号前没有」的断层。
   */
  async refresh(date?: string): Promise<DeliveryRefreshResult> {
    const d = todayYmd();
    // 后端防线：只允许刷新当天。传入非今天的日期直接拒绝，不执行任何写入。
    // （前端历史日已置灰刷新按钮，此处防止直接调 API 越权刷新历史日）
    if (date && date.trim() && date.trim() !== d) {
      const why = `运单明细刷新仅支持当天（${d}），已拒绝刷新历史日期 ${date.trim()}（历史数据由每日 04:00 滚动任务维护）`;
      this.logger.warn(why);
      return { ok: false, date: date.trim(), total: 0, saved: 0, perTeam: [], error: why };
    }
    if (!this.store.ready) {
      const why = 'DATABASE_URL 未配置，PG 未启用：无法写入实时运单明细';
      this.logger.error(why);
      return { ok: false, date: d, total: 0, saved: 0, perTeam: [], error: why };
    }
    const [startMs, endMs] = dayRangeMs(d);
    this.logger.log(`运单明细刷新：日期 ${d}（仅当天），开始拉全站运单明细`);

    let rows: OrderRow[];
    try {
      rows = await this.orders.fetchOrders(startMs, endMs, 'trackingFinish');
    } catch (e) {
      const why = `运单取数失败：${(e as Error).message}`;
      this.logger.error(why);
      return { ok: false, date: d, total: 0, saved: 0, perTeam: [], error: why };
    }

    const withTeam = rows.filter((r) => String(r['teamId'] ?? '').trim() !== '');
    const skipped = rows.length - withTeam.length;
    if (skipped > 0) this.logger.warn(`${skipped} 行缺少 teamId，不写入运单明细表`);

    const counter = new Map<string, number>();
    for (const r of withTeam) {
      const t = String(r['teamId']);
      counter.set(t, (counter.get(t) || 0) + 1);
    }
    const perTeam = [...counter.entries()].map(([team, n]) => ({ team, rows: n }));

    let saved = 0;
    try {
      saved = await this.store.replaceDay(d, withTeam);
      // 实时表只留当天：清掉其余所有旧日行（与历史表分工，避免重复/断层）
      const purged = await this.store.purgeOtherDays(d);
      if (purged > 0) this.logger.log(`运单明细刷新：已清理实时表 ${purged} 行非当天旧数据`);
    } catch (e) {
      const why = `写入实时运单明细失败：${(e as Error).message}`;
      this.logger.error(why);
      return { ok: false, date: d, total: rows.length, saved: 0, perTeam, error: why };
    }

    await this.raw.invalidateResults([...counter.keys()], d);
    this.logger.log(`运单明细刷新完成：全量 ${rows.length} 条，入库 ${saved} 条，覆盖 ${counter.size} 个站点`);
    return { ok: true, date: d, total: rows.length, saved, perTeam, error: null };
  }
}
