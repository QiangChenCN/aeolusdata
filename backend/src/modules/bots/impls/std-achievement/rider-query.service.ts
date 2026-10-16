import { Injectable, Logger } from '@nestjs/common';
import { AeolusCookieService } from '../../../../../fetch/creds/aeolus-cookie.service';
import { AttendanceFetchService } from '../../../../../fetch/sources/attendance-fetch.service';

/** std-achievement bot 的运行时配置（来自环境变量，默认值与旧 Python 版一致）。 */
export interface StdAchievementConfig {
  teamIds: number[];
  teamNames: Record<string, string>;
  timeCode: string;
  rosterTtl: number;
}

export interface RiderQueryResult {
  rider_id?: string;
  rider_name?: string | null;
  knight_id?: string | null;
  team_id?: number | null;
  team_name?: string;
  status?: string;
  order_detail?: {
    total_success?: number;
    reverse?: number;
    reassign?: number;
    valid?: number;
    excluded_accept?: number;
  } | null;
  valid_duration_hours?: number | null;
  online_duration_hours?: number | null;
  time_order_volume?: unknown;
  order_err?: string | null;
  att_err?: string | null;
  note?: string;
  /** 同名歧义时，列出所有同名骑手供用户选择（按骑手ID精确再查）。 */
  candidates?: {
    rider_name?: string | null;
    knight_id?: string | null;
    team_name?: string;
  }[];
}

/**
 * 骑手数据查询：接入风神两个接口，复用 AeolusCookieService（进程内单会话、401 自愈重登），
 * 与仪表盘取数共用同一套登录态，避免互相顶号。
 *
 *  - 单量  : xtop.agencyTrackingFs.queryTracking/2.0（全局查今天完成单，逐页统计）
 *  - 有效时长: xtop.fs.special.realtimeattendance.listAttendance/1.0（合并多站点考勤名册匹配，
 *             复用现有 AttendanceFetchService，并加短缓存避免每次查询都打 3 次考勤）
 */
const ORDER_API_URL =
  'https://httpizza.ele.me/xtop/xtop.agencyTrackingFs.queryTracking/2.0';

const ORDER_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json',
  origin: 'https://a.ele.me',
  referer:
    'https://a.ele.me/app/fnjp-gfe/pikipek-apps/aeolus/index.html?platform=fs',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0',
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 北京时间今天 00:00:00 ~ 23:59:59.999 的毫秒时间戳。 */
function todayWindowMs(): [number, number] {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = bj.getUTCFullYear();
  const mo = bj.getUTCMonth();
  const d = bj.getUTCDate();
  const startBjFake = Date.UTC(y, mo, d, 0, 0, 0, 0); // 当成北京时间的 00:00 但按 UTC 解读
  const start = startBjFake - 8 * 3600 * 1000; // 还原为真实 epoch
  const end = start + 24 * 3600 * 1000 - 1;
  return [start, end];
}

/** 毫秒时间戳 -> 北京时间日期字符串(YYYY-MM-DD)；非法/空返回 null。 */
function bjDateStr(tsMs: unknown): string | null {
  if (!tsMs) return null;
  let ts: number;
  try {
    ts = parseInt(String(tsMs), 10);
  } catch {
    return null;
  }
  if (!Number.isFinite(ts)) return null;
  const bj = new Date(ts + 8 * 3600 * 1000);
  const y = bj.getUTCFullYear();
  const mo = bj.getUTCMonth() + 1;
  const d = bj.getUTCDate();
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 是否逆向单/是否转单这类标志：0 / '否' / false / 空 均视为'否'。 */
function flagIsNo(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    return t === '' || t === '否' || t === '0' || t === 'false';
  }
  return !v;
}

/** 骑手实际接手该单的时刻（毫秒）：取 acceptAtLast 与 assignAtLast 的较晚值，否则回退 trackingCreatedAt。 */
function pickAcceptTs(item: Record<string, any>): unknown {
  const vals: number[] = [];
  for (const k of ['acceptAtLast', 'assignAtLast']) {
    const v = item[k];
    let iv: number;
    try {
      iv = parseInt(String(v), 10);
    } catch {
      continue;
    }
    if (iv > 0) vals.push(iv);
  }
  if (vals.length) return Math.max(...vals);
  return item['trackingCreatedAt'];
}

/** 秒 -> 小时（保留 2 位）。 */
function fmtDuration(sec: unknown): number {
  try {
    return Math.round((parseFloat(String(sec ?? 0)) / 3600) * 100) / 100;
  } catch {
    return 0;
  }
}

@Injectable()
export class RiderQueryService {
  private readonly logger = new Logger(RiderQueryService.name);
  /** 合并名册缓存：避免每次骑手查询都打 N 次考勤接口。 */
  private rosterCache: { rows: any[]; ts: number; err: string | null } = {
    rows: [],
    ts: 0,
    err: null,
  };

  constructor(
    private readonly cookies: AeolusCookieService,
    private readonly attendance: AttendanceFetchService,
  ) {}

  /**
   * 查询骑手的「单量」与「有效时长」。
   * 风神单点登录：先 ensure() 拿会话（进程内缓存/探针/必要时登录），任一数据源 401 时
   * relogin() 强制重登后重试（最多 3 次：首查 + 最多 2 次 401 重试）。
   */
  async query(riderId: string, cfg: StdAchievementConfig): Promise<RiderQueryResult> {
    riderId = (riderId || '').trim();
    if (!riderId) return { rider_id: riderId, status: 'empty' };

    let cookie = '';
    try {
      cookie = await this.cookies.ensure();
    } catch (e) {
      return {
        rider_id: riderId,
        status: 'error',
        note: '风神登录失败: ' + (e as Error).message,
      };
    }

    let last: RiderQueryResult | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.queryOnce(cookie, riderId, cfg);
      const errStr = `${res.order_err || ''}${res.att_err || ''}`;
      if (attempt < 2 && errStr.includes('401')) {
        try {
          cookie = await this.cookies.relogin();
        } catch {
          /* 重登失败，下一轮循环会继续尝试 */
        }
        last = res;
        continue;
      }
      return res;
    }
    return last ?? { rider_id: riderId, status: 'error', note: '查询重试后仍失败' };
  }

  private async queryOnce(
    cookie: string,
    riderId: string,
    cfg: StdAchievementConfig,
  ): Promise<RiderQueryResult> {
    const rows = await this.fetchAllTeams(cookie, cfg);

    // 收集所有命中（按骑手ID或姓名精确匹配）；同名会出现多条。
    const matches: any[] = [];
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const kid = String(r.knightId ?? '');
      const name = (r.knightName ?? '').trim();
      if (riderId === kid || riderId === name) matches.push(r);
    }

    // 同名歧义：直接返回候选列表（姓名/ID/站点），不拉单量，让用户选 ID 再查。
    if (matches.length >= 2) {
      const candidates = matches.map((r) => {
        const kid = String(r.knightId ?? '');
        const name = (r.knightName ?? '').trim();
        const teamId = r.teamId ?? null;
        const teamName =
          teamId != null ? (cfg.teamNames[String(teamId)] ?? String(teamId)) : '—';
        return { rider_name: name, knight_id: kid, team_name: teamName };
      });
      return { rider_id: riderId, status: 'ambiguous', candidates };
    }

    const r = matches[0] ?? null;
    let orderDetail: RiderQueryResult['order_detail'] = null;
    let orderErr: string | null = null;
    try {
      orderDetail = await this.queryOrderVolume(cookie, riderId);
    } catch (e) {
      orderErr = (e as Error).message;
    }

    let validHours: number | null = null;
    let onlineHours: number | null = null;
    let timeOrder: unknown = null;
    let riderName: string | null = null;
    let knightId: string | null = null;
    let teamId: number | null = null;
    let teamName = '—';
    let attErr: string | null = this.rosterCache.err;

    if (r) {
      riderName = (r.knightName ?? '').trim();
      knightId = String(r.knightId ?? '');
      teamId = r.teamId ?? null;
      validHours = fmtDuration(r.fullDayValidOnlineTime);
      onlineHours = fmtDuration(r.fullDayOnlineTime);
      timeOrder = r.timeFinishOrder;
    }
    if (teamId != null) teamName = cfg.teamNames[String(teamId)] ?? String(teamId);

    const hasOrders = !!orderDetail && (orderDetail.total_success || 0) > 0;
    if (riderName == null && !hasOrders) {
      let note = '未查到相关记录';
      if (orderErr) note += `；单量查询异常:${orderErr}`;
      if (attErr) note += `；考勤查询异常:${attErr}`;
      return {
        rider_id: riderId,
        status: 'not_found',
        order_detail: orderDetail,
        valid_duration_hours: validHours,
        order_err: orderErr,
        att_err: attErr,
        note,
      };
    }

    if (riderName == null) {
      riderName = riderId;
      knightId = /\d/.test(riderId) ? riderId : '';
      teamName = '—';
    }

    return {
      rider_id: riderId,
      rider_name: riderName,
      knight_id: knightId,
      team_id: teamId,
      team_name: teamName,
      status: 'ok',
      order_detail: orderDetail,
      valid_duration_hours: validHours,
      online_duration_hours: onlineHours,
      time_order_volume: timeOrder,
      order_err: orderErr,
      att_err: attErr,
      note:
        '单量=queryTracking/2.0(完成时间=今天; 最终有效=总成功-非今日接单剔除-改派单-逆向单; ' +
        '转单[isTransfer]不剔除); 有效时长=listAttendance/1.0',
    };
  }

  /** 合并多站点考勤名册（带短缓存）。 */
  private async fetchAllTeams(
    cookie: string,
    cfg: StdAchievementConfig,
  ): Promise<any[]> {
    const now = Date.now();
    if (
      this.rosterCache.rows.length &&
      now - this.rosterCache.ts < cfg.rosterTtl * 1000
    ) {
      return this.rosterCache.rows;
    }
    const merged: any[] = [];
    let attErr: string | null = null;
    for (const tid of cfg.teamIds) {
      try {
        const j: any = await this.attendance.fetchTeam(tid, cfg.timeCode, cookie);
        const data = (j?.result?.data) ?? [];
        if (Array.isArray(data)) {
          merged.push(...data.filter((x: any) => x && typeof x === 'object'));
        }
      } catch (e) {
        attErr = `团队 ${tid} 考勤拉取失败:${(e as Error).message}`;
      }
    }
    this.rosterCache = { rows: merged, ts: Date.now(), err: attErr };
    return merged;
  }

  /** 调 queryTracking/2.0，按明细统计该骑手今天单量明细。 */
  private async queryOrderVolume(
    cookie: string,
    riderId: string,
  ): Promise<NonNullable<RiderQueryResult['order_detail']>> {
    const [start, end] = todayWindowMs();
    const todayStr = bjDateStr(start);
    const pageSize = 50;
    let current = 1;
    let total_success = 0;
    let reverse = 0;
    let reassign = 0;
    let excluded = 0;
    for (;;) {
      const body = {
        params: {
          request: {
            knightInfo: riderId,
            trackingFinishStart: start,
            trackingFinishEnd: end,
            merchantConsumerDistanceStart: '0',
            merchantConsumerDistanceEnd: '999999',
            payAmountStart: '0',
            payAmountEnd: '999999',
            weightStart: '0',
            weightEnd: '999999',
            current,
            pageSize,
            trackingStateKey: 'all',
            trackingLabelKey: 'all',
            trackingFinishTimePeriodList: ['0-86400'],
          },
        },
      };
      const data = await this.fetchOrderPage(cookie, body);
      const lst: any[] = data?.data ?? [];
      for (const it of lst) {
        if (!it || typeof it !== 'object') continue;
        if (String(it.stateDesc ?? '') !== '配送成功') continue;
        total_success++;
        const accTs = pickAcceptTs(it);
        if (bjDateStr(accTs) !== todayStr) {
          excluded++;
          continue;
        }
        if (!flagIsNo(it.isReverse)) reverse++;
        if (!flagIsNo(it.isReassign)) reassign++;
      }
      if (lst.length < pageSize) break;
      current++;
    }
    return {
      total_success,
      reverse,
      reassign,
      valid: total_success - excluded - reassign - reverse,
      excluded_accept: excluded,
    };
  }

  /** 拉取 queryTracking 单页，对'请求过于频繁'退避重试，业务错误直接抛。 */
  private async fetchOrderPage(
    cookie: string,
    body: Record<string, any>,
  ): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(ORDER_API_URL, {
          method: 'POST',
          headers: { ...ORDER_HEADERS, cookie },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const j: any = await res.json();
        if (j.code !== 200) throw new Error('queryTracking 返回 code=' + j.code);
        const result = j.result ?? {};
        const rc = result.code;
        if (
          rc != null &&
          rc !== 200 &&
          rc !== '200' &&
          rc !== 'SUCCESS' &&
          rc !== '0'
        ) {
          if (rc === 'REQUEST_TOO_FREQUENT' && attempt < 2) {
            await sleep(2000 * (attempt + 1));
            continue;
          }
          throw new Error('queryTracking result.code=' + rc + ' msg=' + result.msg);
        }
        return result.data ?? {};
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('queryTracking')) throw e;
        lastErr = e;
        if (attempt < 2) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw new Error(
          'queryTracking 拉页失败: ' +
            (lastErr instanceof Error ? lastErr.message : String(lastErr)),
        );
      }
    }
    throw new Error('queryTracking 拉页失败(超过重试)');
  }
}
