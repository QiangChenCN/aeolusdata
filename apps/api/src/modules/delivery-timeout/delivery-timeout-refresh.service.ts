import { Injectable, Logger } from '@nestjs/common';
import { OrdersFetchService, OrderRow } from '../../infra/fetch/sources/orders-fetch.service';
import { RawCacheService, todayYmd } from '../../infra/fetch/storage/raw-cache.service';
import { DeliveryTimeoutOrdersStoreService } from './delivery-timeout-orders-store.service';

/**
 * 配送超时看板的**独立**刷新入口（不依赖标准达成的 `RefreshRunnerService` 编排）。
 *
 * 与标准达成共享的只剩**底层取数**：`OrdersFetchService.fetchOrders`（风神运单，一次拉全站）。
 * 落盘却在 2026-10-21 彻底分家 —— 结果写本看板自己的 PG 表
 * `delivery_timeout_orders`（实时运单明细），**不再写**
 * `apps/api/runtime/raw/orders_{team}_{date}.json`，也不再依赖考核看板的
 * `apps/api/runtime/运单明细-实时.json`。
 *
 * 为什么不再用文件：那一版会让标准达成与本看板（乃至考核看板）共用同一份运单文件，
 * 任何人改抓取/清洗口径都会同时改动多个看板，违背「看板独立」；改为各自的表后，
 * 「同一指标多套算法」才可能各自演进。
 *
 * 时间维度固定 trackingFinish（运单终态时间），口径与本看板 Python 计算侧一致。
 */
function dayRangeMs(date: string): [number, number] {
  return [Date.parse(`${date}T00:00:00.000+08:00`), Date.parse(`${date}T23:59:59.999+08:00`)];
}

export interface DeliveryTimeoutRefreshResult {
  ok: boolean;
  date: string;
  /** 风神抓回的运单总行数（全站，未过滤前）。 */
  total: number;
  /** 实际写入 PG 表的行数。 */
  saved: number;
  /** 按站点分组的行数（等价于本次刷新的站点覆盖）。 */
  perTeam: { team: string; rows: number }[];
  /** 抓取实际返回的站点 id 集合（含无 teamId 的 _unknown），用于诊断「账号可见站」覆盖。 */
  distinctTeams: string[];
  /** 失败时（谁乏力）：not_ready = DATABASE_URL 未配置，PG 表不可用。 */
  error?: string | null;
}

@Injectable()
export class DeliveryTimeoutRefreshService {
  private readonly logger = new Logger(DeliveryTimeoutRefreshService.name);

  constructor(
    private readonly orders: OrdersFetchService,
    private readonly raw: RawCacheService,
    private readonly store: DeliveryTimeoutOrdersStoreService,
  ) {}

  /**
   * 一次拉全站运单 → 整份写入本看板的实时运单明细表（全天快照覆盖）。
   *
   * 与标准达成 `RefreshAllService.refreshOrders` 的**关键区别**：
   * 那里只落「传入的标准达成参与站点」，这里落「抓回来的全部 teamId」——
   * 本看板展示的就是这些站点。
   */
  async refresh(date?: string): Promise<DeliveryTimeoutRefreshResult> {
    const d = (date || todayYmd()).trim();
    const [startMs, endMs] = dayRangeMs(d);
    if (!this.store.ready) {
      const why = 'DATABASE_URL 未配置，PG 未启用：无法写入实时运单明细';
      this.logger.error(why);
      return { ok: false, date: d, total: 0, saved: 0, perTeam: [], distinctTeams: [], error: why };
    }
    this.logger.log(`配送超时刷新：日期 ${d}，开始拉全站运单明细`);

    let rows: OrderRow[];
    try {
      rows = await this.orders.fetchOrders(startMs, endMs, 'trackingFinish');
    } catch (e) {
      const why = `运单取数失败：${(e as Error).message}`;
      this.logger.error(why);
      return { ok: false, date: d, total: 0, saved: 0, perTeam: [], distinctTeams: [], error: why };
    }

    const withTeam = rows.filter((r) => String(r['teamId'] ?? '').trim() !== '');
    const skipped = rows.length - withTeam.length;
    if (skipped > 0) {
      this.logger.warn(`${skipped} 行缺少 teamId，不写入本看板明细表`);
    }

    const counter = new Map<string, number>();
    for (const r of withTeam) {
      const t = String(r['teamId']);
      counter.set(t, (counter.get(t) || 0) + 1);
    }
    const perTeam = [...counter.entries()].map(([team, n]) => ({ team, rows: n }));

    let saved = 0;
    try {
      saved = await this.store.replaceDay(d, withTeam);
    } catch (e) {
      const why = `写入实时运单明细失败：${(e as Error).message}`;
      this.logger.error(why);
      return {
        ok: false,
        date: d,
        total: rows.length,
        saved: 0,
        perTeam,
        distinctTeams: [...counter.keys()],
        error: why,
      };
    }

    // 通知 Python 失效本看板的结果缓存（原来由 RawCacheService.saveRaw 内部代劳；
    // 改为写库后显式调用，语义一致：写完即让计算进程下次重算）。
    await this.raw.invalidateResults([...counter.keys()], d);
    this.logger.log(`配送超时刷新完成：全量 ${rows.length} 条，入库 ${saved} 条，覆盖 ${counter.size} 个站点`);
    return {
      ok: true,
      date: d,
      total: rows.length,
      saved,
      perTeam,
      distinctTeams: [...counter.keys()],
      error: null,
    };
  }
}
