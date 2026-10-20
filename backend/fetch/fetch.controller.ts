import { Body, Controller, Get, Logger, Post, Query } from '@nestjs/common';
import { OrdersFetchService } from './sources/orders-fetch.service';
import { FetchPaceService } from './runners/fetch-pace.service';
import { RefreshAllService } from './runners/refresh-all.service';
import { TIME_FIELDS, TIME_FIELD } from './sources/delivery-query.service';
import { QuarkCredsService } from './creds/quark-creds.service';
import { TeamsFetchService } from './sources/teams-fetch.service';
import { ContactImFetchService } from './sources/contact-im-fetch.service';
import { AttendanceFetchService } from './sources/attendance-fetch.service';
import { AeolusCookieService } from './creds/aeolus-cookie.service';
import { AeolusCredentialsService } from './creds/aeolus-credentials.service';
import { ScheduleFetchService } from './sources/schedule-fetch.service';
import { ViolationFetchService } from './sources/violation-fetch.service';
import { ViolationListFetchService } from './sources/violation-list-fetch.service';
import { ViolationStoreService } from './storage/violation-store.service';
import { RealtimeStoreService } from './storage/realtime-store.service';
import { ViolationSchedulerService } from './runners/violation-scheduler.service';

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
    private readonly aeolusCreds: AeolusCredentialsService,
    private readonly schedule: ScheduleFetchService,
    private readonly violation: ViolationFetchService,
    private readonly violationListSvc: ViolationListFetchService,
    private readonly violationStore: ViolationStoreService,
    private readonly realtimeStore: RealtimeStoreService,
    private readonly violationScheduler: ViolationSchedulerService,
    private readonly contactImSvc: ContactImFetchService,
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
   * 全量刷新「阶段 0」：一次拉全量运单 → 按站点分组 → 写 backend/data/raw/orders_*.json。
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
   * 违规处罚明细列表（风神 queryList，分页 JSON；区别于 violation-csv 的 CSV 导出）。
   * 入参：start_ms / end_ms（毫秒区间，必填）、page_no（默认1）、page_size（默认10）、cookie（可选）。
   * 返回上游 result（含 data 列表与分页信息），由调用方解析具体字段。
   */
  @Post('violation-list')
  async violationList(
    @Body()
    b: { start_ms?: number; end_ms?: number; page_no?: number; page_size?: number; cookie?: string },
  ) {
    if (b?.start_ms == null || b?.end_ms == null) {
      return { ok: false, error: 'start_ms / end_ms 必填' };
    }
    try {
      const result = await this.violationListSvc.queryList(
        Number(b.start_ms),
        Number(b.end_ms),
        Number(b.page_no ?? 1),
        Number(b.page_size ?? 10),
        b.cookie,
      );
      return { ok: true, result };
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

  /**
   * 风神登录凭据（系统设置「风神设置」维护）。GET 返回脱敏快照（账号脱敏 + 是否设密码），
   * 明文密码永不外泄；POST 保存（账号必填，密码留空 = 沿用原值）。落盘到
   * `backend/aeolus_sdk/credentials.json`（与 AeolusLoginService 读取路径一致）。
   */
  @Get('settings/aeolus')
  aeolusCredsGet() {
    return this.aeolusCreds.masked();
  }
  @Post('settings/aeolus')
  aeolusCredsSave(@Body() b: { account?: unknown; password?: unknown }) {
    return this.aeolusCreds.save(b || {});
  }

  /**
   * 退出风神登录态（系统设置「账号设置」→ 退出登录）。只清除本地 SSO cookie 会话，
   * 不删除账号密码；下次取数会自动用已保存凭据重登。
   */
  @Post('settings/aeolus/logout')
  aeolusLogout() {
    return this.aeolusCookie.logout();
  }

  /**
   * 违规处罚明细·整段区间全量（自动翻页）。入参：start_ms / end_ms（必填）、page_size（默认200）。
   * 返回 `{total, rows}`，rows 为上游列表项的拼接（不做字段约定，前端按实际字段渲染）。
   */
  @Post('violation-range')
  async violationRange(
    @Body()
    b: { start_ms?: number; end_ms?: number; page_size?: number; cookie?: string },
  ) {
    if (b?.start_ms == null || b?.end_ms == null) {
      return { ok: false, error: 'start_ms / end_ms 必填' };
    }
    try {
      const r = await this.violationListSvc.queryRange(
        Number(b.start_ms),
        Number(b.end_ms),
        Number(b.page_size ?? 200),
        b.cookie,
      );
      return { ok: true, total: r.total, rows: r.rows };
    } catch (e) {
      return this.fail(e);
    }
  }

  /**
   * 实时看板"刷新"落盘：将一批违规明细写入独立的 realtime.db（按违规时间日期分桶、按 violationOrderId 去重覆盖）。
   * 与月累计的 violation.db 完全分离，互不影响。
   */
  @Post('violation-save')
  async violationSave(@Body() b: { rows?: Record<string, any>[] }) {
    try {
      const n = await this.realtimeStore.upsertRows(b?.rows || []);
      return { ok: true, saved: n };
    } catch (e) {
      return this.fail(e);
    }
  }

  /**
   * 实时看板读取本地缓存：按日期区间 [start, end]（YYYY-MM-DD）从 realtime.db 取已落盘数据，不再请求风神。
   */
  @Post('violation-range-db')
  async violationRangeDb(@Body() b: { start?: string; end?: string }) {
    if (!b?.start || !b?.end) return { ok: false, error: 'start / end 必填（YYYY-MM-DD）' };
    try {
      const rows = await this.realtimeStore.getRange(b.start, b.end);
      const fetchedAt = await this.realtimeStore.lastFetchedAt(b.start, b.end);
      return {
        ok: true,
        total: rows.length,
        rows,
        fetchedAt,
      };
    } catch (e) {
      return this.fail(e);
    }
  }

  /** 按月（YYYY-MM）读取已落库的违规明细（月累计看板数据源）。 */
  @Get('violation-month')
  async violationMonth(@Query('month') month: string) {
    if (!month) return { ok: false, error: 'month 必填（YYYY-MM）' };
    const rows = await this.violationStore.getMonth(month);
    return { ok: true, month, total: rows.length, rows };
  }

  /**
   * 月累计看板：按日期区间 [start, end]（YYYY-MM-DD，含两端）读取已落库违规明细。
   * 配合前端「日期范围」选择器（含快捷选项）使用，替代原先的按月查询。
   */
  @Post('violation-month-range')
  async violationMonthRange(@Body() b: { start?: string; end?: string }) {
    if (!b?.start || !b?.end) return { ok: false, error: 'start / end 必填（YYYY-MM-DD）' };
    const rows = await this.violationStore.getRange(b.start, b.end);
    const days = await this.violationStore.dayCountRange(b.start, b.end);
    return { ok: true, start: b.start, end: b.end, total: rows.length, days, rows };
  }

  /** 按天（YYYY-MM-DD）读取已落库的违规明细。 */
  @Get('violation-day')
  async violationDay(@Query('date') date: string) {
    if (!date) return { ok: false, error: 'date 必填（YYYY-MM-DD）' };
    const rows = await this.violationStore.getDay(date);
    return { ok: true, date, total: rows.length, rows };
  }

  /**
   * 电联 & IM 回复看板取数（Quark/FBI 报表 473269，透视表）。
   * 入参：startDate / endDate（YYYY-MM-DD，必填）、region（大区数组，可选，默认全部）。
   * 凭证（DA cookie / 三件套 token）由 QuarkCredsService 自动兑换，本端点只负责取数 + 透出。
   */
  @Post('contact-im')
  async contactIm(
    @Body() b: { startDate?: string; endDate?: string; region?: string[] },
  ) {
    if (!b?.startDate || !b?.endDate) {
      return { ok: false, error: 'startDate / endDate 必填（YYYY-MM-DD）' };
    }
    try {
      const view = await this.contactImSvc.fetchReportView({
        startDate: b.startDate,
        endDate: b.endDate,
        region: Array.isArray(b.region) ? b.region : [],
      });
      return {
        ok: true,
        shape: view.shape,
        headers: view.headers,
        rows: view.rows,
        labels: view.labels,
        raw: view.raw,
      };
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
