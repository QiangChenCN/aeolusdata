import { Injectable, Logger } from '@nestjs/common';
import { OrdersFetchService, OrderRow } from '../sources/orders-fetch.service';
import { FetchPaceService } from './fetch-pace.service';
import { RawCacheService } from '../storage/raw-cache.service';
import { ScheduleFetchService } from '../sources/schedule-fetch.service';
import { AttendanceFetchService } from '../sources/attendance-fetch.service';

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

/** 时段窗口（北京分钟数）：与 Python `analytics/rider_dimension.TIME_SLOTS` 逐字对齐（仅用于考勤取数 time_code）。 */
const TIME_SLOTS: Record<number, [number, number, string]> = {
  100: [0, 120, '凌晨1'],
  111: [360, 480, '早餐1'],
  112: [480, 630, '早餐2'],
  120: [630, 810, '午高峰'],
  130: [810, 930, '下午茶1'],
  131: [930, 1050, '下午茶2'],
  140: [1050, 1200, '晚高峰'],
  150: [1200, 1320, '夜宵1'],
  151: [1320, 1440, '夜宵2'],
  2: [0, 0, '休息'],
  9999: [0, 0, '全天'],
};

/** 返回当前北京时间所在的时段码（与 Python `current_slot_code` 同口径）。 */
function currentSlotCode(): number {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  let hit: number | null = null;
  for (const [code, [sm, em]] of Object.entries(TIME_SLOTS)) {
    const c = Number(code);
    if (c === 2 || c === 9999) continue;
    if (sm <= em && sm <= nowMin && nowMin < em) return c;
    if (sm <= nowMin) hit = c;
  }
  return hit ?? 120;
}

/** 把按天的排班目标 rows 展平成「站×日期×时段」一行一条（与 Python `flatten_schedule` 逐字一致）。 */
function flattenSchedule(rows: any[]): any[] {
  const out: any[] = [];
  for (const d of rows || []) {
    const tid = d?.teamId;
    const sdate = d?.shiftDate;
    const tkn = d?.teamKnightNum;
    for (const t of d?.timeList || []) {
      out.push({
        team_id: tid,
        shift_date: sdate,
        team_knight_num: tkn,
        time_code: t?.timeCode,
        time_name: t?.timeName,
        start_time: t?.startTime,
        end_time: t?.endTime,
        actual_num: t?.actualNum,
        predict_num: t?.predictNum,
        predict_order: t?.predictOrder,
        actual_order: t?.actualOrder,
      });
    }
  }
  return out;
}

@Injectable()
export class RefreshAllService {
  private readonly logger = new Logger(RefreshAllService.name);

  constructor(
    private readonly orders: OrdersFetchService,
    private readonly pace: FetchPaceService,
    private readonly raw: RawCacheService,
    private readonly sched: ScheduleFetchService,
    private readonly att: AttendanceFetchService,
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

  /** 排班目标取数 + 展平 + 落盘（原 Python `achievement.compute` 内 `_sched_query`+`_sched_flatten`+`save_raw`，现迁 Nest）。 */
  async fetchSchedule(
    team: string,
    date: string,
  ): Promise<{ ok: boolean; rows: number }> {
    try {
      const data = await this.sched.query(team, date, date);
      const rows = flattenSchedule(data || []);
      const saved = this.raw.saveRaw('sched', team, rows, date);
      this.logger.log(`排班目标 站点 ${team} 展平 ${rows.length} 行`);
      return { ok: saved, rows: rows.length };
    } catch (e) {
      this.logger.error(`排班目标取数失败 站点 ${team}：${(e as Error).message}`);
      return { ok: false, rows: 0 };
    }
  }

  /** 实时考勤取数 + 落盘（原 Python `rider_dimension.compute`/`achievement.fetch_attendance` 内 `_att_fetch`+`save_raw`，现迁 Nest）。 */
  async fetchAttendance(
    team: string,
    date: string,
  ): Promise<{ ok: boolean; tc: number; rows: number }> {
    try {
      const tc = currentSlotCode();
      const json = await this.att.fetchTeam(team, tc);
      const riders = (json?.result?.data) || [];
      const fetchedAt = new Date(Date.now() + 8 * 3600 * 1000)
        .toISOString()
        .slice(0, 19);
      const saved = this.raw.saveRaw(
        'att',
        team,
        { tc, rows: riders, fetched_at: fetchedAt },
        date,
      );
      this.logger.log(`实时考勤 站点 ${team} 时段 ${tc} 共 ${riders.length} 人`);
      return { ok: saved, tc, rows: riders.length };
    } catch (e) {
      this.logger.error(`实时考勤取数失败 站点 ${team}：${(e as Error).message}`);
      return { ok: false, tc: 0, rows: 0 };
    }
  }
}
