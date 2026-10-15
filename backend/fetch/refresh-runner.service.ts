import {
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AuthService } from '../src/modules/auth/auth.service';
import { DataPermService } from '../src/modules/auth/data-perm.service';
import { ComputeService } from '../src/modules/compute/compute.service';
import { FetchPaceService } from './fetch-pace.service';
import { RefreshAllService } from './refresh-all.service';
import { TeamsFetchService } from './teams-fetch.service';
import { extractToken } from '../src/common/token.util';

/**
 * 全量刷新「编排器」（原 Python `dashboard/standard/refresh_all.py` 的 Nest 原生实现）。
 *
 * 迁移动机（ADR：「Python 只做大数据计算」）：阶段调度 / 状态机 / 日志 / 单飞 / 频控 /
 * 数据权限收敛都属于**编排**，不是计算 —— 计算留在 Python
 * （`compute_service` 的 `/api/compute/{violations,rider-dimension,achievement}`）。
 *
 * 分工：
 *   阶段 0   运单取数 + 分组落盘 + 通知 Python 失效结果缓存 → 全在 Nest（`RefreshAllService`）
 *   阶段 0.5 违规明细 → 计算步在 Python（其落盘格式与读取方都在 Python）
 *   每站循环 骑手维度 → 站点维度 → 计算步在 Python
 *
 * 状态字段名与迁移前 Python 的 `_STATE` **逐字一致**（前端已依赖；实际只读 `running`
 * 与 `error[]`，其余是诊断信息，保持形状便于对照排查）。
 */
export interface RefreshTeamState {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'ok' | 'error';
  msg: string;
  rows: number;
}

export interface RefreshFailure {
  id: string;
  name: string;
  error: string;
}

export interface RefreshState {
  running: boolean;
  started_at: string | null;
  finished_at: string | null;
  start: string | null;
  end: string | null;
  total: number;
  done: number;
  current_team: string | null;
  current_stage: string;
  teams: RefreshTeamState[];
  error: RefreshFailure[] | null;
  stats: unknown;
  log_file: string | null;
  violation?: { ok: boolean; error: string | null; msg: string | null };
}

export interface RefreshStatus extends RefreshState {
  server_time: string;
  elapsed_sec?: number | null;
  /** 距下次可被放行还需等待的秒数（前端用于跨页面刷新恢复冷却倒计时）。 */
  cooldown_sec?: number;
}

export interface RefreshStartResult {
  ok: boolean;
  already_running?: boolean;
  msg?: string;
  error?: string | null;
  status?: RefreshStatus;
}

/** 阶段 0 / 0.5「共享运单 / 违规明细」不属于具体站点，用这个伪 id 占位（与迁移前一致）。 */
export const SHARED_TEAM_KEY = '__shared__';

/** 按用户的刷新窗口（秒）—— 与迁移前 `handlers.RATE_LIMIT_SEC` 一致。 */
const RATE_LIMIT_SEC = 60;
/** 「任意两次刷新之间」的全局最小间隔（秒）—— 与迁移前 `REFRESH_ALL_GLOBAL_GAP_SEC` 一致。 */
const REFRESH_ALL_GLOBAL_GAP_SEC = 15;

/** 北京时区（UTC+8）—— 刷新窗口与日志时间戳都按北京时间，与 Python `BJ` 同口径。 */
const BJ_OFFSET_MS = 8 * 3600 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:mm:ss`（北京时间）。 */
function nowStr(): string {
  const d = new Date(Date.now() + BJ_OFFSET_MS);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** 北京时间的今天（`YYYY-MM-DD`）。历史日期护栏用它判定。 */
function todayYmd(): string {
  return new Date(Date.now() + BJ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 日志文件名时间戳 `YYYYmmdd_HHmmss`（与迁移前 `refresh_%Y%m%d_%H%M%S.log` 同格式）。 */
function fileStamp(): string {
  const d = new Date(Date.now() + BJ_OFFSET_MS);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

@Injectable()
export class RefreshRunnerService {
  private readonly logger = new Logger(RefreshRunnerService.name);
  private readonly logsDir: string;
  private state: RefreshState = this.freshState();
  private logPath: string | null = null;
  private teamNames = new Map<string, string>();
  /** 频控：key → 上次放行的毫秒时间戳（按用户分桶）。仅内存态，重启即清。 */
  private readonly rateState = new Map<string, number>();
  private lastGlobalAt = 0;
  /** 项目根（PROJECT_ROOT 或 cwd 上一级），用于读全局标准达成设置取参与站 / 写刷新日志。 */
  private readonly rootDir: string;

  constructor(
    private readonly config: ConfigService,
    private readonly ordersStage: RefreshAllService,
    private readonly teams: TeamsFetchService,
    private readonly pace: FetchPaceService,
    private readonly compute: ComputeService,
    private readonly auth: AuthService,
    private readonly dataPerm: DataPermService,
  ) {
    this.rootDir = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.logsDir = path.join(this.rootDir, 'backend', 'logs');
  }

  private freshState(): RefreshState {
    return {
      running: false,
      started_at: null,
      finished_at: null,
      start: null,
      end: null,
      total: 0,
      done: 0,
      current_team: null,
      current_stage: '',
      teams: [],
      error: null,
      stats: null,
      log_file: null,
    };
  }

  /** 进度快照（供前端轮询）。不暴露内部可变对象。 */
  status(req?: Request): RefreshStatus {
    const snap = JSON.parse(JSON.stringify(this.state)) as RefreshStatus;
    snap.server_time = nowStr();
    snap.cooldown_sec = req ? this.rateRemaining(req) : 0;
    if (snap.running && snap.started_at) {
      const t0 = Date.parse(snap.started_at.replace(' ', 'T') + '+08:00');
      snap.elapsed_sec = Number.isFinite(t0) ? Math.floor((Date.now() - t0) / 1000) : null;
      // 运行中：下发实时抓取统计（被限流几次可以边跑边看）。
      try {
        snap.stats = this.pace.statsSnapshot();
      } catch {
        /* 统计只是诊断信息，取不到不影响状态 */
      }
    }
    return snap;
  }

  /**
   * 启动全量刷新。
   *
   * `teams` 为空时取「参与站点」：优先取对话框配置的 grade_standards 当月参与站（单一数据源），
   * 仅当该月从未配置时才回落旧 teams-config。
   * 历史日期护栏与迁移前逐字一致：考勤/运单接口只服务「当天」，刷新非当天日期会用近空
   * 数据覆盖历史快照（2026-09-17 事故根因），故默认拒绝，须显式 force 或设环境变量。
   */
  async start(opts: {
    teams?: string[];
    start?: string;
    end?: string;
    force?: boolean;
  }): Promise<RefreshStartResult> {
    const startDate = (opts.start || '').trim() || todayYmd();
    const endDate = (opts.end || '').trim() || startDate;
    const today = todayYmd();
    if (
      (startDate !== today || endDate !== today) &&
      !opts.force &&
      !process.env.AEOLUS_ALLOW_HISTORICAL_REFRESH
    ) {
      return {
        ok: false,
        error:
          `拒绝刷新历史日期 ${startDate}~${endDate}：考勤/运单接口只服务当天，刷新会用近空` +
          `数据覆盖历史快照。如确需回填，请传 force=true 或设置环境变量 ` +
          `AEOLUS_ALLOW_HISTORICAL_REFRESH=1（覆盖前请先备份缓存）。`,
      };
    }

    let teams = (opts.teams || []).map((t) => String(t).trim()).filter(Boolean);
    if (!teams.length) teams = await this.configuredTeams(startDate.slice(0, 7));
    if (!teams.length) {
      return { ok: false, error: '参与站点为空，请先到『标准达成 → 等级标准设置』配置并启用参与站点' };
    }

    if (this.state.running) {
      // 已有刷新在跑：不报 409，而是把当前进度交回前端，由它转入轮询（始终只跑一个）。
      return {
        ok: true,
        already_running: true,
        msg: '已有刷新任务在运行，已接入进度轮询',
        status: this.status(),
      };
    }

    const names = await this.resolveNames(teams);
    this.state = {
      ...this.freshState(),
      running: true,
      started_at: nowStr(),
      start: startDate,
      end: endDate,
      total: teams.length,
      current_stage: '准备中',
      teams: teams.map((t) => ({
        id: String(t),
        name: names.get(String(t)) || String(t),
        status: 'pending' as const,
        msg: '',
        rows: 0,
      })),
    };
    this.pace.statsReset();

    void this.run(teams, startDate, endDate);
    return { ok: true, error: null, msg: `已启动，共 ${teams.length} 个站点`, status: this.status() };
  }

  // ---------------------------------------------------------------- HTTP 入口语义
  /**
   * `POST /api/standard/refresh-all` 的完整语义：单飞接入 → 频控 → 数据权限收敛 → 启动。
   *
   * 放在 service 而不是 controller 里，是因为 `ProxyController` 的 `standard/{*path}`
   * 通配也会命中这个路径（path-to-regexp 不支持负向断言，靠注册顺序又易碎），
   * 两处必须走**同一份**判定逻辑，不能各写一遍。
   */
  async startFromRequest(
    req: Request,
    body: { teams?: unknown; start?: string; end?: string },
  ): Promise<RefreshStartResult> {
    if (this.state.running) {
      return {
        ok: true,
        already_running: true,
        msg: '已有刷新任务在运行，已接入进度轮询',
        status: this.status(req),
      };
    }

    const retryAfter = this.rateCheck(req);
    if (retryAfter != null) {
      this.logger.warn(`刷新被频控拒绝：${retryAfter}s 后可重试`);
      throw new HttpException(
        {
          ok: false,
          code: 'RATE_LIMITED',
          error: `查询太频繁，请 ${retryAfter} 秒后再试（实时查询每 ${RATE_LIMIT_SEC} 秒限一次）`,
          retry_after: retryAfter,
          endpoint: 'refresh-all',
        },
        429,
      );
    }

    const scope = this.allowedIds(req);
    let teams: string[] | undefined = Array.isArray(body?.teams)
      ? (body!.teams as unknown[]).map(String).filter(Boolean)
      : undefined;
    if (scope) {
      const base =
        teams && teams.length
          ? teams
          : await this.configuredTeams(
              ((typeof body?.start === 'string' && body.start.trim()) || todayYmd()).slice(0, 7),
            );
      teams = base.filter((t) => scope.has(String(t)));
      if (!teams.length) {
        // 绝不能把空列表交给 start —— start 内部会回落成「全量参与站点」，
        // 等于「没有可见站点的用户反而能刷全部」（越权）。
        throw new ForbiddenException({
          ok: false,
          error: '所选站点均不在你的数据权限范围内（或你没有任何可见站点）',
          code: 'DATA_SCOPE_DENIED',
        });
      }
    }
    return this.start({ teams, start: body?.start, end: body?.end });
  }

  /** 通过则返回 null 并记下放行时间；被拒则返回建议等待秒数（**不刷新计时**）。 */
  private rateCheck(req: Request): number | null {
    const now = Date.now();
    const globalGapMs = REFRESH_ALL_GLOBAL_GAP_SEC * 1000;
    if (this.lastGlobalAt && now - this.lastGlobalAt < globalGapMs) {
      return Math.max(1, Math.ceil((globalGapMs - (now - this.lastGlobalAt)) / 1000));
    }
    const key = this.rateKey(req);
    const winMs = RATE_LIMIT_SEC * 1000;
    const last = this.rateState.get(key) || 0;
    if (last && now - last < winMs) {
      return Math.max(1, Math.ceil((winMs - (now - last)) / 1000));
    }
    this.rateState.set(key, now);
    this.lastGlobalAt = now;
    return null;
  }

  /**
   * 只读查询：当前距下次可被放行还需等待的秒数（**不消费放行时间戳**）。
   * 与 `rateCheck` 同一套「用户窗口 + 全局间隔」判定，仅计算不写入，用于前端
   * 跨页面刷新时恢复冷却倒计时。无任何限制返回 0。
   */
  rateRemaining(req: Request): number {
    const now = Date.now();
    const globalGapMs = REFRESH_ALL_GLOBAL_GAP_SEC * 1000;
    if (this.lastGlobalAt && now - this.lastGlobalAt < globalGapMs) {
      return Math.max(0, Math.ceil((globalGapMs - (now - this.lastGlobalAt)) / 1000));
    }
    const key = this.rateKey(req);
    const winMs = RATE_LIMIT_SEC * 1000;
    const last = this.rateState.get(key) || 0;
    if (last && now - last < winMs) {
      return Math.max(0, Math.ceil((winMs - (now - last)) / 1000));
    }
    return 0;
  }

  /** 频控的「用户维度」：优先登录用户名；系统/iframe（无会话）回落到令牌指纹 + IP。 */
  private rateKey(req: Request): string {
    const t = this.token(req);
    const s = this.auth.getSession(t);
    if (s?.user) return `u:${s.user}`;
    return `fp:${String(t || '').slice(0, 12)}|${req.ip || ''}`;
  }

  /** 本次请求可见的站点 id 集合；null 表示不受限（与 ProxyController 的 x-scope='*' 同口径）。 */
  private allowedIds(req: Request): Set<string> | null {
    const s = this.auth.getSession(this.token(req));
    if (!s) return null; // 系统 / iframe（已过机器令牌闸门）→ 不受限
    const ids = this.dataPerm.resolveAllowed(s.user, s.role, 'team');
    return ids === null ? null : new Set([...ids].map(String));
  }

  private token(req: Request): string | undefined {
    return extractToken(req);
  }

  // ---------------------------------------------------------------- 编排主体
  private async run(teams: string[], start: string, end: string): Promise<void> {
    const failed: RefreshFailure[] = [];
    try {
      this.logPath = this.openLogFile();
      this.state.log_file = this.logPath;
      this.state.stats = null;
      this.log(`开始：站点 ${teams.join(',')}，日期 ${start}~${end}`);

      // ── 阶段 0：一次拉全量运单 → 按站点分组落盘（全在 Nest）
      let shared = false;
      this.setCurrent(SHARED_TEAM_KEY, '拉取全站运单明细');
      try {
        const r = await this.ordersStage.refreshOrders(teams, start);
        shared = !!r.ok;
        this.log(`共享运单：全量 ${r.total} 条，本批站点命中 ${r.hit} 条`);
        // 诊断：每个配置站点的命中行数 + 抓取实际返回的站点 id（排查「配置站 vs 账号可见站」错配）
        for (const pt of r.perTeam) {
          this.log(`  · 站点 ${pt.team} → ${pt.rows} 行（${pt.saved ? '已落盘' : '空，未落盘'}）`);
        }
        this.log(`抓取实际返回的站点 id 集合：${[...r.distinctTeams].join(',') || '(无)'}`);
      } catch (e) {
        // 阶段 0 是运单的**唯一**来源：Python 侧的本地拉取路径已按「取数归 NestJS」移除，
        // 因此这里失败即整体失败 —— 不再「降级为逐站拉取」（那等于恢复一套已删除的实现）。
        const why = `阶段 0 取数失败：${(e as Error).message}`;
        this.log(why);
        for (const tid of teams) {
          const nm = this.state.teams.find((t) => t.id === String(tid))?.name || String(tid);
          failed.push({ id: String(tid), name: nm, error: why });
          this.finishTeam(tid, false, why);
        }
        return; // finally 仍会收尾（running=false / 状态落定）
      }
      this.setCurrent(SHARED_TEAM_KEY, '共享运单完成');

      // ── 每站：骑手维度 → 站点维度
      for (const tid of teams) {
        const name = this.state.teams.find((t) => t.id === String(tid))?.name || String(tid);
        try {
          this.setCurrent(tid, '拉取考勤 / 生成骑手数据');
          const rd = await this.callCompute('/api/compute/rider-dimension', {
            team: tid,
            start,
            end,
            reuse_orders: shared,
          });
          if (!rd.ok) throw new Error(String(rd.error || '骑手维度失败'));

          this.setCurrent(tid, '拉取排班目标 / 生成站点数据');
          const ac = await this.callCompute('/api/compute/achievement', {
            team: tid,
            start,
            end,
            reuse_orders: shared,
            reuse_att: true,
            reuse_order_counts: rd.order_counts ?? null,
          });
          if (!ac.ok) throw new Error(String(ac.error || '站点维度失败'));

          this.setCurrent(tid, '生成结果');
          const n = Number(rd.rows) || 0;
          this.finishTeam(tid, true, `骑手 ${n} 人`, n);
        } catch (e) {
          const why = (e as Error).message;
          failed.push({ id: String(tid), name, error: why });
          this.finishTeam(tid, false, why);
          this.log(`站点 ${tid} 失败：${why}`);
        }
      }
    } catch (e) {
      // 编排层自身异常（如日志目录不可写）也必须收敛为「已结束」，不能把 running 卡住。
      const why = (e as Error).message;
      this.log(`编排异常：${why}`);
      failed.push({ id: SHARED_TEAM_KEY, name: '编排', error: why });
    } finally {
      try {
        this.state.stats = this.pace.statsSnapshot();
      } catch {
        /* 统计取不到不影响结束 */
      }
      this.state.running = false;
      this.state.finished_at = nowStr();
      this.state.current_team = null;
      this.state.current_stage = failed.length ? '完成（有失败站点）' : '完成';
      this.state.error = failed.length ? failed : null;
      const st = this.state.stats as Record<string, unknown> | null;
      this.log(
        `结束：${this.state.current_stage} | 请求 ${st?.requests} 次，成功 ${st?.ok}，` +
          `被限流 ${st?.throttle} 次，其它失败 ${st?.failed} 次，重试 ${st?.retries} 次，` +
          `重登 ${st?.relogin} 次`,
      );
      this.logPath = null;
    }
  }

  // ---------------------------------------------------------------- 辅助
  /**
   * 「参与站点」id 列表 —— 单一数据源 = 「标准达成设置」中该月【配置了记录】的站点
   * （standard_grade_settings.json 的 months[月]，与看板「标准达成」、机器人「运力达成查询」同源，
   * 不再维护独立参与名单）。该月从未配置 → 空列表（不回落任何默认站点）。
   */
  async configuredTeams(month?: string): Promise<string[]> {
    const m = (month || '').trim() || todayYmd().slice(0, 7);
    const gp = await this.globalParticipating(m);
    return gp || [];
  }

  /**
   * 读「标准达成设置」（standard_grade_settings.json）某月的参与考核站点 =
   * months[month] 下配置了记录的站点 id。
   * 返回 null 表示文件缺失 / 该月从未配置（调用方回落默认三站）。
   */
  private async globalParticipating(month: string): Promise<string[] | null> {
    const file = path.join(
      this.rootDir,
      'python',
      'dashboard',
      'standard',
      'standard_grade_settings.json',
    );
    try {
      const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      const months = data && data.months && typeof data.months === 'object' ? data.months : {};
      const m = month && months[month];
      if (m && typeof m === 'object') {
        const out = Object.keys(m).map(String).filter(Boolean);
        return out.length ? out : null;
      }
      // 旧单套 schema：顶层 participating_teams 套用到未单独配置的月份（旧配置本就不分月份）。
      const legacy = Array.isArray(data?.participating_teams)
        ? data.participating_teams.map((x: unknown) => String(x).trim()).filter((x: string) => x)
        : [];
      return legacy.length ? legacy : null;
    } catch {
      return null;
    }
  }

  /** 站点 id → 名称（来自 Nest 的站点目录，失败则回落 id）。 */
  private async resolveNames(teams: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const t of teams) map.set(String(t), String(t));
    try {
      const payload = await this.teams.fetchAll();
      for (const t of payload.teams.length ? payload.teams : payload.fallback || []) {
        map.set(String(t.id), t.name);
      }
    } catch {
      /* 名称只是展示，拿不到就用 id */
    }
    this.teamNames = map;
    return map;
  }

  /** 调 Python 计算步。返回 Python 的扁平响应体（含 ok / error / msg / rows / order_counts）。 */
  private async callCompute(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    const r = await this.compute.proxy({ endpoint, method: 'POST', body });
    if (!r.ok) return { ok: false, error: r.error || `计算服务不可达（${endpoint}）` };
    const d = r.data;
    if (d && typeof d === 'object') return d as Record<string, any>;
    return { ok: false, error: `计算步返回结构异常（${endpoint}）` };
  }

  private setCurrent(teamId: string, stage: string): void {
    this.state.current_team = String(teamId);
    this.state.current_stage = stage;
    for (const t of this.state.teams) {
      if (t.id === String(teamId)) {
        t.status = 'running';
        t.msg = stage;
        break;
      }
    }
  }

  private finishTeam(teamId: string, ok: boolean, msg: string, rows = 0): void {
    for (const t of this.state.teams) {
      if (t.id === String(teamId)) {
        t.status = ok ? 'ok' : 'error';
        t.msg = msg;
        t.rows = rows;
        break;
      }
    }
    this.state.done = this.state.teams.filter(
      (t) => t.status === 'ok' || t.status === 'error',
    ).length;
  }

  /** 一次刷新一个日志文件：事后可回查「被限流几次 / 哪一站在哪一步卡住」。 */
  private openLogFile(): string | null {
    try {
      fs.mkdirSync(this.logsDir, { recursive: true });
      return path.join(this.logsDir, `refresh_${fileStamp()}.log`);
    } catch {
      return null;
    }
  }

  private log(msg: string): void {
    this.logger.log(msg);
    if (!this.logPath) return;
    try {
      fs.appendFileSync(this.logPath, `[${nowStr()}] [refresh-all] ${msg}\n`, 'utf-8');
    } catch {
      /* 日志写不进去不影响刷新 */
    }
  }
}
