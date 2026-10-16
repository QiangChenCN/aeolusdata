import { Injectable, Logger } from '@nestjs/common';
import { OrdersFetchService, OrderRow } from './orders-fetch.service';
import { RawCacheService, todayYmd } from '../storage/raw-cache.service';

/**
 * 配送超时看板的**独立**刷新入口（不依赖标准达成的 `RefreshRunnerService` 编排）。
 *
 * 与标准达成刷新共享**同一套底层基础设施**：
 *   · `OrdersFetchService.fetchOrders` —— 风神运单取数（一次拉全站、异步导出优先、零分页）；
 *   · `RawCacheService.saveRaw('orders', ...)` —— 原始层落盘的唯一写入方。
 *
 * 因此落盘文件 = `backend/data/raw/orders_{team}_{date}.json`，**文件名与标准达成逐字节一致**，
 * 标准达成计算时可直接读取，互不干扰；但本入口**不受**「标准达成参与站点」配置约束 ——
 * 它按抓回来的 teamId 分组落盘，覆盖账号可见的全部站点，正是配送超时看板展示的站点集合。
 *
 * 时间维度固定 trackingFinish（运单终态时间），与标准达成 / Python 侧口径一致。
 */
function dayRangeMs(date: string): [number, number] {
  return [Date.parse(`${date}T00:00:00.000+08:00`), Date.parse(`${date}T23:59:59.999+08:00`)];
}

export interface DeliveryTimeoutRefreshResult {
  ok: boolean;
  date: string;
  /** 风神抓回的运单总行数（全站，未分组前）。 */
  total: number;
  /** 实际成功落盘的站点数。 */
  saved: number;
  perTeam: { team: string; rows: number; saved: boolean }[];
  /** 抓取实际返回的站点 id 集合（含无 teamId 的 _unknown），用于诊断「账号可见站」覆盖。 */
  distinctTeams: string[];
  error?: string | null;
}

@Injectable()
export class DeliveryTimeoutRefreshService {
  private readonly logger = new Logger(DeliveryTimeoutRefreshService.name);

  constructor(
    private readonly orders: OrdersFetchService,
    private readonly raw: RawCacheService,
  ) {}

  /**
   * 一次拉全站运单 → 按 teamId 分组 → 逐站落盘 `orders_{team}_{date}.json`。
   *
   * 与 `RefreshAllService.refreshOrders` 的**关键区别**：那里只保存「传入的 teams 列表」，
   * 而列表默认来自标准达成参与站点；这里保存「抓回来出现的所有 teamId」，等于导出全站。
   */
  async refresh(date?: string): Promise<DeliveryTimeoutRefreshResult> {
    const d = (date || todayYmd()).trim();
    const [startMs, endMs] = dayRangeMs(d);
    this.logger.log(`配送超时刷新：日期 ${d}，开始拉全站运单明细`);

    let rows: OrderRow[];
    try {
      rows = await this.orders.fetchOrders(startMs, endMs, 'trackingFinish');
    } catch (e) {
      const why = `运单取数失败：${(e as Error).message}`;
      this.logger.error(why);
      return { ok: false, date: d, total: 0, saved: 0, perTeam: [], distinctTeams: [], error: why };
    }

    const grouped = new Map<string, OrderRow[]>();
    for (const r of rows) {
      const tid = String(r['teamId'] ?? '_unknown');
      const list = grouped.get(tid);
      if (list) list.push(r);
      else grouped.set(tid, [r]);
    }

    const perTeam: { team: string; rows: number; saved: boolean }[] = [];
    let saved = 0;
    for (const [t, list] of grouped) {
      if (t === '_unknown') {
        this.logger.warn(`${list.length} 行缺少 teamId，归入 _unknown 不落盘`);
        continue;
      }
      const okSave = this.raw.saveRaw('orders', t, list, d);
      if (okSave) saved += 1;
      perTeam.push({ team: t, rows: list.length, saved: okSave });
    }

    this.logger.log(`配送超时刷新完成：全量 ${rows.length} 条，落盘 ${saved} 个站点`);
    return {
      ok: true,
      date: d,
      total: rows.length,
      saved,
      perTeam,
      distinctTeams: [...grouped.keys()],
      error: null,
    };
  }
}
