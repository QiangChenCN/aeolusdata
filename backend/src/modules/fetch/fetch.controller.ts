import { Body, Controller, Get, Logger, Post, Query } from '@nestjs/common';
import { OrdersFetchService } from './orders-fetch.service';
import { FetchPaceService } from './fetch-pace.service';
import { RefreshAllService } from './refresh-all.service';
import { TIME_FIELDS, TIME_FIELD } from './delivery-query.service';
import { QuarkCredsService } from './quark-creds.service';
import { TeamsFetchService } from './teams-fetch.service';
import { AttendanceFetchService } from './attendance-fetch.service';
import { AeolusCookieService } from './aeolus-cookie.service';
import { ScheduleFetchService } from './schedule-fetch.service';
import { ViolationFetchService } from './violation-fetch.service';

/** 北京时间（UTC+8）某天的 [00:00:00.000, 23:59:59.999] 毫秒区间。 */
function dayRangeMs(date: string): [number, number] {
  return [Date.parse(`${date}T00:00:00.000+08:00`), Date.parse(`${date}T23:59:59.999+08:00`)];
}

@Controller('api/fetch')
export class FetchController {
  private readonly logger = new Logger(FetchController.name);

  constructor(
    private readonly orders: OrdersFetchService,
    private readonly pace: FetchPaceService,
    private readonly refreshAll: RefreshAllService,
    private readonly quark: QuarkCredsService,
    private readonly teams: TeamsFetchService,
    private readonly attendance: AttendanceFetchService,
    private readonly aeolusCookie: AeolusCookieService,
    private readonly schedule: ScheduleFetchService,
    private readonly violation: ViolationFetchService,
  ) {}

  /**
   * Quark DA cookie 缓存状态（只读探针）。
   * 原属 Python `server.py::_check_quark_cookie` + `quark_sdk.creds`，现由 Nest 独占。
   */
  @Get('quark/status')
  async quarkStatus() {
    return { ok: true, ...(await this.quark.cacheStatus()) };
  }

  /** 当前节奏状态（AIMD 下限 / 当前间隔 / 碰撞次数 / 抓取统计）。 */
  @Get('pace')
  paceStats() {
    return { ok: true, stats: this.pace.statsSnapshot() };
  }

  /**
   * 全量站点目录（原 Python `get_data/teams.py` + `server.py::_fetch_all_teams`）。
   *
   * 两个消费者，共用本服务这一份 5 分钟缓存（避免两侧各存一份、各打一次 xtop）：
   *   · Python 计算侧回调 —— `compute_service/handlers.py::_fetch_all_teams`；
   *   · 前端 `GET /api/teams`（由 `TeamsModule` 提供，叠加数据权限过滤后再下发）。
   *
   * 风神失败/返回空时 `source=fallback` 并附带兜底三站，绝不让选择器空白。
   * `?force=1` 跳过缓存强制重取（排查用）。
   */
  @Get('teams')
  teamsAll(@Query('force') force?: string) {
    return this.teams.fetchAll(force === '1' || force === 'true');
  }

  /**
   * 拉取指定日期的全部运单明细（不落盘，用于验证取数链路）。
   * 接口本身没有站点维度，按 trackingFinish 时间窗取全量，再按 teamId 分组统计。
   */
  @Get('orders')
  async fetchOrders(
    @Query('date') date?: string,
    @Query('time_field') timeField?: string,
  ) {
    const d = date || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const [startMs, endMs] = dayRangeMs(d);
    this.pace.statsReset();
    const t0 = Date.now();
    const rows = await this.orders.fetchOrders(startMs, endMs, timeField || TIME_FIELD);
    const elapsed = (Date.now() - t0) / 1000;

    const byTeam: Record<string, number> = {};
    for (const r of rows) {
      const tid = String(r['teamId'] ?? r['team_id'] ?? '_unknown');
      byTeam[tid] = (byTeam[tid] || 0) + 1;
    }
    return {
      ok: true,
      date: d,
      time_field: timeField || TIME_FIELD,
      available_time_fields: TIME_FIELDS,
      rows: rows.length,
      by_team: byTeam,
      elapsed_sec: Math.round(elapsed * 10) / 10,
      stats: this.pace.statsSnapshot(),
    };
  }

  /**
   * 全量刷新「阶段 0」：一次拉全量运单 → 按站点分组 → 写 dashboard/data/orders_*.json。
   * 后续阶段（sched 排班 / att 考勤 / violation 违规 / 结果计算）仍在 Python，
   * 通过保留的委托接口调用 —— 见 FetchModule 头部说明。
   */
  @Post('refresh-orders')
  async refreshOrders(@Body() b: { teams?: string[]; date?: string }) {
    const d = b.date || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const teams = (b.teams || []).map(String).filter(Boolean);
    if (!teams.length) return { ok: false, error: 'teams 不能为空' };
    const t0 = Date.now();
    const r = await this.refreshAll.refreshOrders(teams, d);
    return { ...r, date: d, elapsed_sec: Math.round((Date.now() - t0) / 100) / 10 };
  }

  /**
   * 只取数、不落盘，把原始行直接返回给调用方（供 Python 编排层回调）。
   * 反爬节奏/限流退避/会话重登都在本进程完成，Python 侧只负责分组落盘与聚合计算。
   * 可传 start_ms/end_ms，或只传 date（缺省今天）。
   */
  @Post('orders-raw')
  async ordersRaw(
    @Body() b: { start_ms?: number; end_ms?: number; date?: string; time_field?: string },
  ) {
    let s = b.start_ms;
    let e = b.end_ms;
    if (s == null || e == null) {
      const d = b.date || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const [a, z] = dayRangeMs(d);
      s = a;
      e = z;
    }
    this.pace.statsReset();
    const t0 = Date.now();
    const rows = await this.orders.fetchOrders(Number(s), Number(e), b.time_field || TIME_FIELD);
    return {
      ok: true,
      rows,
      elapsed_sec: Math.round((Date.now() - t0) / 100) / 10,
      stats: this.pace.statsSnapshot(),
    };
  }

  // ───────────── 阶段 1+ 三路取数：供 Python 计算侧回调（原在 get_data/*）─────────────
  // 统一返回扁平 {ok, ...}；失败时透出 `code`，供 Python `get_data/_nest.py::unwrap`
  // 判定是否「会话失效」并触发强制重登 —— 与迁移前 Python 直接抛 AuthError 同口径。

  /** 单站实时考勤原始 JSON（原 `get_data/attendance.py::fetch_team`）。 */
  @Post('attendance-raw')
  async attendanceRaw(
    @Body() b: { team_id?: string | number; time_code?: string | number; cookie?: string },
  ) {
    if (b?.team_id == null || b?.time_code == null) {
      return { ok: false, error: 'team_id / time_code 必填' };
    }
    try {
      const raw = await this.attendance.fetchTeam(b.team_id, b.time_code, b.cookie);
      return { ok: true, raw };
    } catch (e) {
      return this.fail(e);
    }
  }

  /** 单站排班统计（按天列表，原 `get_data/schedule_statistics.py::query`）。 */
  @Post('sched-raw')
  async schedRaw(
    @Body() b: { team_id?: string | number; start?: string; end?: string; cookie?: string },
  ) {
    if (b?.team_id == null || !b?.start || !b?.end) {
      return { ok: false, error: 'team_id / start / end 必填' };
    }
    try {
      const rows = await this.schedule.query(b.team_id, b.start, b.end, 8, b.cookie);
      return { ok: true, rows };
    } catch (e) {
      return this.fail(e);
    }
  }

  /** 违规处罚 CSV（原 `get_data/violation.py::download_csv`），返回 `{text, file_url}`。 */
  @Post('violation-csv')
  async violationCsv(@Body() b: { start_ms?: number; end_ms?: number; cookie?: string }) {
    if (b?.start_ms == null || b?.end_ms == null) {
      return { ok: false, error: 'start_ms / end_ms 必填' };
    }
    try {
      const r = await this.violation.downloadCsv(Number(b.start_ms), Number(b.end_ms), b.cookie);
      return { ok: true, text: r.text, file_url: r.fileUrl };
    } catch (e) {
      return this.fail(e);
    }
  }

  /**
   * 强制重新登录风神 SSO（原 Python `aeolus_sdk.login.refresh_shared_cookies`）。
   *
   * 两个用途：① Python 计算侧 `get_data.auth.call_with_relogin` 收到会话失效后触发重登；
   * ② 运维手动复位登录态。返回新 cookie（与 Python 原接口同契约）—— 该文件本就两边可读，
   * 且本端点要求机器令牌。
   */
  @Post('aeolus-relogin')
  async aeolusRelogin() {
    try {
      const cookie = await this.aeolusCookie.relogin();
      return { ok: true, cookie, len: cookie.length };
    } catch (e) {
      return this.fail(e);
    }
  }

  /** 统一失败包装：把异常的 `code` 透出，供 Python 判定会话失效（401/UNAUTHORIZED）。 */
  private fail(e: unknown) {
    const x = e as { code?: string; message?: string; name?: string };
    this.logger.warn(`取数回调失败：${x?.name || 'Error'} ${x?.message || ''}`);
    return {
      ok: false,
      ...(x?.code ? { code: String(x.code) } : {}),
      error: x?.message || String(e),
    };
  }
}
