import { Injectable, Logger } from '@nestjs/common';
import { AeolusCookieService } from '../creds/aeolus-cookie.service';

/**
 * dispatcher 急单取数（移植自 get_data/rush.py，单一来源）。
 *
 * 三个接口三连调：
 *   ① paging                按状态分页拉 trackingId
 *   ② getShippingOrderList  按 trackingId 批量(80)拉订单（含 isRushOrder）
 *   ③ getOrderDetail        逐单拉完整详情
 * 急单定义（数据定义，非业务筛选）：isRushOrder === true 且 state ∈ {10,20,30}。
 */
export const RUSH_USER_ID = 13053485;
export const RUSH_CITY_ID = 51;
export const RUSH_PAGE_SIZE = 200;
export const RUSH_DETAIL_BATCH = 80;
export const RUSH_IN_PROGRESS = [10, 20, 30];

const API_PAGING = 'https://httpizza.ele.me/xtop/xtop.lpdcs.skyeye.shippingorder.paging/1.0';
const API_LIST =
  'https://httpizza.ele.me/xtop/xtop.lpd.matrix.intervention.shippingOrderQuery.getShippingOrderList/1.0';
const API_DETAIL =
  'https://httpizza.ele.me/xtop/xtop.lpd.matrix.intervention.shippingOrderQuery.getOrderDetail/1.0';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0';

export interface RushOrderPair {
  order: Record<string, any>;
  detail: Record<string, any>;
}
export interface RushTeamResult {
  teamId: number;
  station: string;
  totalTids: number;
  totalOrders: number;
  rushCount: number;
  pairs: RushOrderPair[];
}

@Injectable()
export class RushFetchService {
  private readonly logger = new Logger(RushFetchService.name);

  constructor(private readonly cookies: AeolusCookieService) {}

  private async post(
    cookie: string,
    api: string,
    params: Record<string, unknown>,
    teamId: number,
    timeoutMs = 30000,
  ): Promise<Record<string, any> | null> {
    const body = JSON.stringify({ metas: { teamid: teamId }, params });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(api, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'User-Agent': UA,
          Referer: 'https://dispatcher.ele.me/',
          Origin: 'https://dispatcher.ele.me',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        body,
        signal: ctrl.signal,
      });
      const j = (await res.json()) as any;
      return (j && j.result && j.result.data) || null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 失败重试 3 次、间隔 0.8s（与 Python _post_retry 一致）。 */
  private async postRetry(
    cookie: string,
    api: string,
    params: Record<string, unknown>,
    teamId: number,
    tries = 3,
  ): Promise<Record<string, any> | null> {
    for (let i = 0; i < tries; i++) {
      try {
        const d = await this.post(cookie, api, params, teamId);
        if (d !== null) return d;
      } catch {
        /* 网络/HTTP 异常，继续重试 */
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    this.logger.warn(`接口重试 ${tries} 次仍无数据: ${api}`);
    return null;
  }

  async fetchTeam(teamId: number, station: string, cookie?: string): Promise<RushTeamResult> {
    const ck = cookie || (await this.cookies.ensure());

    // ① paging：逐状态分页拉在途 trackingId
    const tids: unknown[] = [];
    for (const status of RUSH_IN_PROGRESS) {
      let page = 1;
      for (;;) {
        const d = await this.postRetry(
          ck,
          API_PAGING,
          {
            request: {
              teamId,
              userId: RUSH_USER_ID,
              status: [status],
              knightIdList: [],
              retailerIdList: [],
              platformTrackingId: '',
              trackingId: '',
              shippingOrderSort: 'exceptionTime',
              sort: 1,
              pageIndex: page,
              pageSize: RUSH_PAGE_SIZE,
            },
          },
          teamId,
        );
        if (!d) break;
        const pl: Record<string, any>[] = d.shippingOrderInfoList || [];
        for (const o of pl) tids.push(o.trackingId);
        if (tids.length >= Number(d.total || 0) || pl.length < RUSH_PAGE_SIZE) break;
        page += 1;
      }
    }

    // ② 批量(80)拉订单详情，筛 isRushOrder && 在途
    const orders: Record<string, any>[] = [];
    for (let i = 0; i < tids.length; i += RUSH_DETAIL_BATCH) {
      const chunk = tids.slice(i, i + RUSH_DETAIL_BATCH);
      const d2 = await this.postRetry(
        ck,
        API_LIST,
        { request: { teamId, trackingIds: chunk, cityId: RUSH_CITY_ID, shopTeam: false } },
        teamId,
      );
      if (d2) orders.push(...(d2.shippingOrderInfoList || []));
      await new Promise((r) => setTimeout(r, 300));
    }
    const rush = orders.filter(
      (o) => o.isRushOrder === true && RUSH_IN_PROGRESS.includes(Number(o.state)),
    );

    // ③ 逐单拉完整详情
    const pairs: RushOrderPair[] = [];
    for (const o of rush) {
      const det = await this.postRetry(
        ck,
        API_DETAIL,
        { teamId, trackingId: String(o.trackingId) },
        teamId,
      );
      pairs.push({ order: o, detail: det || {} });
      await new Promise((r) => setTimeout(r, 200));
    }

    return {
      teamId,
      station,
      totalTids: tids.length,
      totalOrders: orders.length,
      rushCount: rush.length,
      pairs,
    };
  }
}
