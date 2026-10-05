import { Injectable, Logger } from '@nestjs/common';
import { OrdersFetchService, OrderRow } from './orders-fetch.service';
import { FetchPaceService } from './fetch-pace.service';
import { RawCacheService } from './raw-cache.service';

/**
 * 全量刷新编排（移植自 dashboard/standard/refresh_all.py 的阶段 0）。
 *
 * 阶段 0 的关键事实：运单明细接口**请求体没有站点参数**，返回的是当前账号权限下的
 * 全部站点数据。所以「每个站点各拉一遍」拉的是同一批数据 —— 3 个站点就是 3 倍请求数、
 * 3 倍耗时、3 倍限流风险。故改为：一次拉全量 + 内存按 teamId 分组 + 逐站落盘。
 *
 * 落盘本身（路径 / 格式 / 非空判定 / 结果缓存失效通知）在 `RawCacheService` —— 它是原始层
 * 的唯一写入方；本服务只负责「运单」这一类数据的生产与分组。
 *
 * 时间维度固定 trackingFinish（运单终态时间），与 Python 侧口径一致 ——
 * 用 trackingCreated 会漏「生成早于当天、当天接单完成」的改派/跨日单（实测少 34 行）。
 */
function dayRangeMs(date: string): [number, number] {
  return [Date.parse(`${date}T00:00:00.000+08:00`), Date.parse(`${date}T23:59:59.999+08:00`)];
}

@Injectable()
export class RefreshAllService {
  private readonly logger = new Logger(RefreshAllService.name);

  constructor(
    private readonly orders: OrdersFetchService,
    private readonly pace: FetchPaceService,
    private readonly raw: RawCacheService,
  ) {}

  /** 阶段 0：一次拉全量运单 → 按 teamId 分组 → 逐站落盘 → 通知 Python 失效缓存。 */
  async refreshOrders(
    teams: string[],
    date: string,
  ): Promise<{
    ok: boolean;
    total: number;
    hit: number;
    perTeam: { team: string; rows: number; saved: boolean }[];
    /** 抓取返回里实际出现的站点 id（含无 teamId 的 _unknown），用于诊断「配置站 vs 账号可见站」错配。 */
    distinctTeams: string[];
    stats: unknown;
  }> {
    const [startMs, endMs] = dayRangeMs(date);
    this.pace.statsReset();
    this.logger.log(`开始阶段 0：站点 ${teams.join(',')}，日期 ${date}`);

    const rows = await this.orders.fetchOrders(startMs, endMs, 'trackingFinish');

    const grouped = new Map<string, OrderRow[]>();
    for (const r of rows) {
      const tid = String(r['teamId'] ?? '_unknown');
      const list = grouped.get(tid);
      if (list) list.push(r);
      else grouped.set(tid, [r]);
    }

    const perTeam: { team: string; rows: number; saved: boolean }[] = [];
    let hit = 0;
    for (const t of teams) {
      const list = grouped.get(String(t)) || [];
      hit += list.length;
      perTeam.push({
        team: String(t),
        rows: list.length,
        saved: this.raw.saveRaw('orders', String(t), list, date),
      });
    }
    const unknown = grouped.get('_unknown')?.length || 0;
    if (unknown) this.logger.warn(`${unknown} 行缺少 teamId，归入 _unknown 不落盘`);

    // 结果缓存失效不用在这里操心：`this.raw.saveRaw(...)` 写成功后会按站点自动通知 Python
    // （详见 RawWriteOptions.notify 的注释）。原先这里是整批通知一次，机制下沉后每行都会通知，
    // 省掉「新增写入点却忘了通知」这个隐蔽坑 —— 那种漏掉的表现是刷新成功但看板数字不变。
    this.logger.log(`阶段 0 完成：全量 ${rows.length} 条，本批站点命中 ${hit} 条`);
    return {
      ok: true,
      total: rows.length,
      hit,
      perTeam,
      distinctTeams: [...grouped.keys()],
      stats: this.pace.statsSnapshot(),
    };
  }
}
