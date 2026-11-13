import { Injectable, Logger } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { dirs, ROOT } from '../../config/paths';
import { TeamsFetchService, TeamRef, readKnownTeams } from '../../infra/fetch/sources/teams-fetch.service';
import { RawCacheService } from '../../infra/fetch/storage/raw-cache.service';

/**
 * 配置层（原 Python `dashboard/standard/{teams_config,grade_standards,threshold_config,
 * period_config,attend_period_teams}.py` + `dashboard/realtime/config.py`）的 NestJS 原生实现。
 *
 * 迁移目标（见 server.py→NestJS 映射 / ADR「Python 只做大计算」）：这些端点是**纯配置读写 +
 * 少量校验/塑形**，不是大数据计算，故由 Nest 接管为唯一写入方；Python 计算侧仍按原路径**读**
 * 同一批文件（格式与 Python `json.dump(ensure_ascii=False, indent=2)` 解析兼容）。
 *
 * 落盘路径刻意与 Python 一致（不搬文件，避免改动 Python 计算侧的读取路径）：
 *   · 标准类配置 → `<root>/services/compute/dashboard/standard/*.json`
 *   · 时段配置（按月） → `<root>/services/compute/analytics/core/period_config_YYYY-MM.json`
 *     （Python `analytics.core.period_config.PC.load` 按此目录读，读写必须同源）
 *     未保存月份返回空 periods，不回落任何内置默认规则（与 Python 计算侧口径一致）
 *   · 服务质量考核目标 → `<root>/apps/api/runtime/.service_quality_targets.json`
 * 其中 `<root>` = PROJECT_ROOT（默认仓库根，与 Python 的 `_ROOT` 同源）。
 *
 * 接口形状逐条对齐 `compute_service/handlers.py` 的 `_get/_post_*` 处理函数，保证前端零改动。
 */

// ============================================================================
// 通用工具（与 Python `datetime` 北京时间口径一致）
// ============================================================================
const BJ_OFFSET_MS = 8 * 3600 * 1000;

function nowStamp(d = new Date()): string {
  const x = new Date(d.getTime() + BJ_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())} ` +
    `${p(x.getUTCHours())}:${p(x.getUTCMinutes())}:${p(x.getUTCSeconds())}`;
}
function nowIso(d = new Date()): string {
  const x = new Date(d.getTime() + BJ_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())}T` +
    `${p(x.getUTCHours())}:${p(x.getUTCMinutes())}:${p(x.getUTCSeconds())}+08:00`;
}
function currentMonth(d = new Date()): string {
  const x = new Date(d.getTime() + BJ_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}`;
}

/** 可见站点集合：`null` 表示不受限（x-scope=*），否则为 id 集合。 */
type Allowed = Set<string> | null;

function filterIds(ids: string[], allowed: Allowed): string[] {
  if (allowed === null) return ids;
  return ids.filter((i) => allowed.has(String(i)));
}

// ============================================================================
// 考核项 / 日期类型 / 天气 三维口径（与 `analytics/assessment/config.py` 逐字对应，
// 也是实时看板计算得分唯一的目标来源 —— 见 service_quality.py）。
// ============================================================================
const RT_METRICS = [
  { key: 'delivery_rate', name: '物流妥投率', direction: 'pos', unit: '%' },
  { key: 'ontime_rate', name: '考核准时率', direction: 'pos', unit: '%' },
  { key: 'unsat_rate', name: '不满意率', direction: 'neg', unit: '%' },
  { key: 'compound_overtime', name: '复合超时时长', direction: 'neg', unit: 's' },
  { key: 'call_rate', name: '电联率', direction: 'pos', unit: '%' },
  { key: 'im_reply_rate', name: 'IM及时回复率', direction: 'pos', unit: '%' },
  { key: 'visit_rate', name: '新专送拜访', direction: 'pos', unit: '%' },
] as const;
const RT_DATE_TYPES = [
  { key: 'weekday', name: '周中' },
  { key: 'weekend', name: '周末' },
] as const;
const RT_WEATHER = [
  { key: 'normal', name: '正常天' },
  { key: 'light', name: '轻微恶天' },
  { key: 'moderate', name: '一般恶天' },
  { key: 'severe', name: '严重恶天' },
] as const;

// 服务质量考核项的「计分方式」：权重项=按指标权重加权计分；调分项=不参与权重，直接加减分。
const SQ_KINDS = [
  { key: 'weight', name: '权重项' },
  { key: 'adjust', name: '调分项' },
] as const;
const SQ_KIND_KEYS = new Set<string>(SQ_KINDS.map((k) => k.key));

// 考核项是否分层：决定三档阈值在「日期类型 / 天气」两个维度上的区分粒度。
//   none         不分层——所有日期类型与天气共用一套阈值
//   date         日期分层——周中/周末各一套，天气不影响
//   weather      天气分层——每个天气等级各一套，日期类型不影响
//   date_weather 日期天气分层——8 个场景各一套（默认，最细粒度）
const SQ_LAYERING = [
  { key: 'none', name: '不分层' },
  { key: 'date', name: '日期分层' },
  { key: 'weather', name: '天气分层' },
  { key: 'date_weather', name: '日期天气分层' },
] as const;
const SQ_LAYERING_KEYS = new Set<string>(SQ_LAYERING.map((x) => x.key));
/** 权重项合计须为 100%（允许 0.1 的浮点误差） */
const SQ_WEIGHT_SUM = 100;
const SQ_WEIGHT_SUM_TOL = 0.1;

@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name);
  private readonly root: string;
  private readonly stdDir: string;

  constructor(
    private readonly config: NestConfigService,
    private readonly teams: TeamsFetchService,
    private readonly rawCache: RawCacheService,
  ) {
    this.root = ROOT;
    // 与 Python `dashboard/standard/*` 同目录 —— 计算侧仍按此路径读配置。
    this.stdDir = dirs.computeStandard();
  }

  // ------------------------------------------------------------------ 路径/IO
  private stdPath(name: string): string {
    return path.join(this.stdDir, name);
  }
  private atomicWrite(file: string, obj: unknown): void {
    const tmp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  }
  private readJson(file: string): any {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** 读 services/compute/dashboard/standard/<name>（独立看板配置共享此存储约定）。 */
  readStdJson(name: string): any { return this.readJson(this.stdPath(name)); }
  /** 原子写 services/compute/dashboard/standard/<name>（与内部落盘同约定）。 */
  writeStdJson(name: string, obj: unknown): void { this.atomicWrite(this.stdPath(name), obj); }

  // ------------------------------------------------------------------ 看板自有配置目录
  // 新增标的自己一套目录（如 services/compute/dashboard/delivery-timeout/teams.json）时用它：
  // 与 readStdJson 完全同构（同原子写约定），只是允许拼子目录，
  // 使「看板自己的配置不必塞进共享的 dashboard/standard 目录」。
  private rootPath(relPath: string): string {
    return path.join(this.root, ...relPath.split('/'));
  }
  /** 读 `PROJECT_ROOT/<relPath>`（相对路径用 '/'，如 'services/compute/dashboard/delivery-timeout/teams.json'）。 */
  readRootJson(relPath: string): any { return this.readJson(this.rootPath(relPath)); }
  /** 原子写 `PROJECT_ROOT/<relPath>`（同 writeStdJson 约定）。 */
  writeRootJson(relPath: string, obj: unknown): void { this.atomicWrite(this.rootPath(relPath), obj); }

  // ============================================================ 标准达成设置（按月份 × 站点）
  // 数据模型：standard_grade_settings.json =
  //   { schema_version, updated_at, updated_by,
  //     default: { levels:[5], threshold_pct, cap_pct },   // 仅兜底/新站点填充用，前台已不再提供编辑
  //     months: { "<YYYY-MM>": { "<team_id>": { levels:[5], threshold_pct, cap_pct } | {use_default:true} } } }
  // 「参与考核站点」已移除：某月下【配置了记录的站点】即参与考核（有设置就默认考核）。
  // 某月从未保存过时参与站点为空（前端提示），仅旧单套 schema 会套用旧名单做迁移。
  // 落盘于 services/compute/dashboard/standard/standard_grade_settings.json（计算侧按此路径读取，同源）。
  private readonly SG_DEFAULT_LEVELS: { level: number; orders: number; hours: number }[] = [
    { level: 1, orders: 18, hours: 6 },
    { level: 2, orders: 21, hours: 6 },
    { level: 3, orders: 26, hours: 6 },
    { level: 4, orders: 32, hours: 7 },
    { level: 5, orders: 39, hours: 8 },
  ];
  private readonly SG_DEFAULT_THRESHOLD = 80;
  private readonly SG_DEFAULT_CAP = 100;
  /**
   * 旧单套 schema 的参与站点名单（顶层 participating_teams）。旧配置本就不分月份，
   * 迁移时把这份名单套用到【任何尚未单独配置的月份】，避免旧数据丢失；新写入一律走 months。
   */
  private sgLegacyTeams(d: any): string[] {
    const p = d && d.participating_teams;
    if (!Array.isArray(p)) return [];
    return p.map((x: unknown) => String(x).trim()).filter((x: string) => x);
  }
  private stdGradeGlobalPath(): string {
    return path.join(this.stdDir, 'standard_grade_settings.json');
  }
  private sgRead(): any {
    return this.readJson(this.stdGradeGlobalPath());
  }
  private sgNormLevel(src: any, idx: number): { level: number; orders: number; hours: number } {
    const o = src && typeof src === 'object' ? src : {};
    const orders = Math.max(0, parseInt(String(o.orders ?? 0), 10) || 0);
    const hours = Math.max(0, Math.min(24, parseFloat(String(o.hours ?? 0)) || 0));
    return { level: idx + 1, orders, hours: Math.round(hours * 100) / 100 };
  }
  private sgNormLevels(d: any): { level: number; orders: number; hours: number }[] {
    const raw: any[] = Array.isArray(d && d.levels) ? d.levels : [];
    const out: { level: number; orders: number; hours: number }[] = [];
    for (let i = 0; i < 5; i++) {
      out.push(this.sgNormLevel(raw[i] || this.SG_DEFAULT_LEVELS[i], i));
    }
    return out;
  }
  private sgNormThreshold(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const f = parseFloat(String(v));
    if (isNaN(f) || f < 0 || f > 100) throw new Error('门槛值须在 0~100 之间');
    return f;
  }
  private sgNormCap(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const f = parseFloat(String(v));
    if (isNaN(f) || f < 0) throw new Error('封顶值不能为负数');
    return f;
  }
  private sgTemplate(d: any): { levels: any[]; threshold_pct: number | null; cap_pct: number | null } {
    // 优先用新 schema 的 default 模板；兼容旧单套 schema（levels/threshold/cap 在顶层）；
    // 都没有 → 回落代码内置默认。
    const tmpl = d && d.default;
    if (tmpl && typeof tmpl === 'object' &&
        (Array.isArray(tmpl.levels) || tmpl.threshold_pct != null || tmpl.cap_pct != null)) {
      return {
        levels: this.sgNormLevels(tmpl),
        threshold_pct: this.sgNormThreshold(tmpl.threshold_pct),
        cap_pct: this.sgNormCap(tmpl.cap_pct),
      };
    }
    if (d && (Array.isArray(d.levels) || d.threshold_pct != null || d.cap_pct != null)) {
      return {
        levels: this.sgNormLevels(d),
        threshold_pct: this.sgNormThreshold(d.threshold_pct),
        cap_pct: this.sgNormCap(d.cap_pct),
      };
    }
    return {
      levels: this.SG_DEFAULT_LEVELS.map((l) => ({ ...l })),
      threshold_pct: this.SG_DEFAULT_THRESHOLD,
      cap_pct: this.SG_DEFAULT_CAP,
    };
  }
  private sgNormSite(cfg: any, dflt: any): any {
    if (cfg && cfg.use_default) {
      return {
        levels: dflt.levels.map((l: any) => ({ ...l })),
        threshold_pct: dflt.threshold_pct,
        cap_pct: dflt.cap_pct,
        use_default: true,
      };
    }
    const c = cfg || {};
    return {
      levels: this.sgNormLevels(c),
      threshold_pct: this.sgNormThreshold(c.threshold_pct),
      cap_pct: this.sgNormCap(c.cap_pct),
      use_default: false,
    };
  }
  /** 指标权重（仅「权重项」有意义）：百分比，0~100；空 → null（未设置）。 */
  private sqNormWeight(v: unknown): number | null {
    // 兼容早期按 { weekday, weekend } 分开存的形态：取周中优先，其次周末
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return this.sqNormWeight(o.weekday ?? o.weekend);
    }
    if (v === null || v === undefined || v === '') return null;
    const f = parseFloat(String(v));
    if (isNaN(f) || f < 0 || f > 100) return null;
    return Math.round(f * 100) / 100;
  }
  /** 调分项「得分区间」：{ min, max }，允许负数（如 -5 ~ +5）；空 → null。 */
  private sqNormRangeNum(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const f = parseFloat(String(v));
    if (isNaN(f) || !isFinite(f)) return null;
    return Math.round(f * 100) / 100;
  }
  private sqNormRange(v: unknown): { min: number | null; max: number | null } {
    const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    return { min: this.sqNormRangeNum(o.min), max: this.sqNormRangeNum(o.max) };
  }
  private sqMonthRanges(month: string): Record<string, { min: number | null; max: number | null }> {
    const out: Record<string, { min: number | null; max: number | null }> = {};
    const all = this.sqLoadAll();
    const months = all.months && typeof all.months === 'object' ? all.months : {};
    const entry = months[month] && typeof months[month] === 'object' ? months[month] : {};
    const rs = entry.ranges && typeof entry.ranges === 'object' ? entry.ranges : {};
    for (const m of RT_METRICS) out[m.key] = this.sqNormRange(rs[m.key]);
    return out;
  }
  private sqMonthWeights(month: string): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    const all = this.sqLoadAll();
    const months = all.months && typeof all.months === 'object' ? all.months : {};
    const entry = months[month] && typeof months[month] === 'object' ? months[month] : {};
    const ws = entry.weights && typeof entry.weights === 'object' ? entry.weights : {};
    for (const m of RT_METRICS) out[m.key] = this.sqNormWeight(ws[m.key]);
    return out;
  }
  /** 计分方式：weight=权重项 / adjust=调分项；缺省 null（未设置，页面提示需选择）。 */
  private sqNormKind(v: unknown): 'weight' | 'adjust' | null {
    const s = v === null || v === undefined ? '' : String(v);
    return SQ_KIND_KEYS.has(s) ? (s as 'weight' | 'adjust') : null;
  }
  private sqMonthKinds(month: string): Record<string, 'weight' | 'adjust' | null> {
    const out: Record<string, 'weight' | 'adjust' | null> = {};
    const all = this.sqLoadAll();
    const months = all.months && typeof all.months === 'object' ? all.months : {};
    const entry = months[month] && typeof months[month] === 'object' ? months[month] : {};
    const ks = entry.kinds && typeof entry.kinds === 'object' ? entry.kinds : {};
    for (const m of RT_METRICS) out[m.key] = this.sqNormKind(ks[m.key]);
    return out;
  }
  /** 是否分层；缺省 'date_weather'（最细粒度，与历史行为一致）。 */
  private sqNormLayering(v: unknown): string {
    const s = v === null || v === undefined ? '' : String(v);
    return SQ_LAYERING_KEYS.has(s) ? s : 'date_weather';
  }
  private sqMonthLayering(month: string): Record<string, string> {
    const out: Record<string, string> = {};
    const all = this.sqLoadAll();
    const months = all.months && typeof all.months === 'object' ? all.months : {};
    const entry = months[month] && typeof months[month] === 'object' ? months[month] : {};
    const ls = entry.layering && typeof entry.layering === 'object' ? entry.layering : {};
    for (const m of RT_METRICS) out[m.key] = this.sqNormLayering(ls[m.key]);
    return out;
  }
  /** 读取某月「标准达成设置」；参与考核站点 = 该月下配置了记录的站点。
   *
   * 该月从未配置时：
   *  - 旧单套 schema（有顶层 participating_teams）→ 套用旧名单（迁移，不丢旧数据）；
   *  - 否则 → 返回空（前端据此提示「尚未配置」，不再回落默认三站）。
   */
  getStandardGradeSettings(month?: string): unknown {
    month = month || currentMonth();
    const raw = this.sgRead();
    const empty = !raw || typeof raw !== 'object';
    const dflt = this.sgTemplate(empty ? null : raw);
    const months = empty ? {} : (raw.months && typeof raw.months === 'object' ? raw.months : {});
    const entry = months[month] && typeof months[month] === 'object' ? months[month] : null;
    const teams: Record<string, any> = {};
    if (entry) {
      for (const [tid, cfg] of Object.entries(entry)) {
        teams[String(tid)] = this.sgNormSite(cfg, dflt);
      }
    } else {
      for (const tid of empty ? [] : this.sgLegacyTeams(raw)) {
        teams[tid] = { levels: dflt.levels.map((l) => ({ ...l })), threshold_pct: dflt.threshold_pct, cap_pct: dflt.cap_pct, use_default: true };
      }
    }
    return {
      ok: true,
      schema_version: empty ? 2 : raw.schema_version || 2,
      updated_at: empty ? null : (raw.updated_at ?? null),
      updated_by: empty ? null : (raw.updated_by ?? null),
      month,
      /** 该月是否已有显式配置（false = 从未保存过，前端应提示去配置）。 */
      configured: !!entry,
      default: dflt,
      teams,
    };
  }
  /** 机器人运力达成专用：返回某 (月,站) 归一化 5 档（单量+时长，小时）。teamId 缺失/未配置 → 回落默认模板。 */
  getStandardGradeLevels(month?: string, teamId?: string | number | null): { level: number; orders: number; hours: number }[] {
    month = month || currentMonth();
    const s = this.getStandardGradeSettings(month) as any;
    const t = teamId != null ? s.teams[String(teamId)] : null;
    return this.sgNormLevels(t || s.default);
  }
  /** 某月参与考核站点 id 列表（有配置记录即参与；该月从未配置 → 空列表，由前端提示去配置）。 */
  getStandardGradeParticipating(month?: string): string[] {
    const s = this.getStandardGradeSettings(month) as any;
    return Object.keys(s.teams);
  }
  async saveStandardGradeSettings(body: any, user: string): Promise<unknown> {
    let data: any = this.sgRead();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      data = { schema_version: 2, months: {} };
    }
    data.schema_version = 2;
    // 可选：更新默认模板（新站点 / 首运行沿用）。
    if (body && typeof body.default === 'object' && body.default !== null) {
      data.default = {
        levels: this.sgNormLevels(body.default),
        threshold_pct: this.sgNormThreshold(body.default.threshold_pct),
        cap_pct: this.sgNormCap(body.default.cap_pct),
      };
    }
    // 必填：某月站点设置（全量覆盖该月）。
    const month = String((body && body.month) || currentMonth());
    if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: 'month 须为 YYYY-MM 格式' };
    const teamsIn = (body && body.teams) || {};
    const outTeams: Record<string, any> = {};
    if (teamsIn && typeof teamsIn === 'object') {
      for (const [tid, cfg] of Object.entries(teamsIn)) {
        const id = String(tid).trim();
        if (!id) continue;
        const c = cfg as any;
        if (c && c.use_default) {
          outTeams[id] = { use_default: true };
        } else {
          outTeams[id] = {
            levels: this.sgNormLevels(c || {}),
            threshold_pct: this.sgNormThreshold(c && c.threshold_pct),
            cap_pct: this.sgNormCap(c && c.cap_pct),
          };
        }
      }
    }
    data.months = data.months && typeof data.months === 'object' ? data.months : {};
    data.months[month] = outTeams;
    data.updated_at = nowIso();
    data.updated_by = user || '';
    try {
      this.atomicWrite(this.stdGradeGlobalPath(), data);
      await this.rawCache.invalidateAll();
      return { ok: true, ...(this.getStandardGradeSettings(month) as Record<string, unknown>) };
    } catch (e) {
      return { ok: false, error: `写入失败：${(e as Error).message}` };
    }
  }

  // ================================================================== period_config
  private periodDurationH(start: string, end: string): number {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    let mins = eh * 60 + em - (sh * 60 + sm);
    if (mins <= 0) mins += 1440;
    return Math.round((mins / 60) * 100) / 100;
  }
  private periodEditableFor(month: string): boolean {
    return month >= currentMonth();
  }
  /** 时段配置的唯一落盘位置：Python 计算侧 analytics/core（PC.load 按此目录读文件）。 */
  private periodPath(month: string): string {
    return dirs.computeAnalyticsCore(`period_config_${month}.json`);
  }
  private periodRead(month: string): any | null {
    const d = this.readJson(this.periodPath(month));
    if (!d || !Array.isArray(d.periods)) return null;
    return d;
  }
  private periodLoad(month?: string) {
    month = month || currentMonth();
    const d = this.periodRead(month);
    let periods: any[];
    let updatedAt: string | null;
    let updatedBy = '';
    if (d === null) {
      // 未保存月份：无默认兜底，返回空规则；计算侧据此走「未配置」口径。
      periods = [];
      updatedAt = null;
    } else {
      periods = d.periods.map((x: any) => ({ ...x }));
      updatedAt = d.updated_at;
      updatedBy = d.updated_by || '';
    }
    for (const p of periods) {
      try {
        p.period_duration_h = this.periodDurationH(p.start, p.end);
      } catch {
        p.period_duration_h = null;
      }
      if (p.effective_online_req_h === null || p.effective_online_req_h === undefined) {
        p.effective_online_req_h = p.duration_h !== undefined ? p.duration_h : p.period_duration_h;
      }
      try {
        p.effective_online_req_h = Math.round(parseFloat(p.effective_online_req_h) * 100) / 100;
      } catch {
        p.effective_online_req_h = p.period_duration_h;
      }
      try {
        let w = parseFloat(p.weight !== undefined && p.weight !== null ? String(p.weight) : '100');
        if (w < 0 || w > 100) w = 100;
        p.weight = Math.round(w * 100) / 100;
      } catch {
        p.weight = 100;
      }
    }
    return {
      ok: true,
      schema_version: 3,
      month,
      /** 该月是否已保存过（false = 从未配置，前端据此提示）。 */
      configured: d !== null,
      updated_at: updatedAt,
      updated_by: updatedBy,
      periods,
      editable: this.periodEditableFor(month),
    };
  }
  private periodNormPeriod(p: any): any {
    if (!p || typeof p !== 'object') throw new Error('时段项须为对象');
    const start = String(p.start || '').trim();
    const end = String(p.end || '').trim();
    const name = String(p.name || '').trim();
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(start)) {
      throw new Error(`开始时间格式须为 HH:MM: ${start}`);
    }
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(end)) {
      throw new Error(`结束时间格式须为 HH:MM: ${end}`);
    }
    if (!name) throw new Error('时段名称不能为空');
    const orders = parseInt(String(p.orders), 10);
    if (isNaN(orders)) throw new Error('单量要求须为整数');
    if (orders < 0) throw new Error('单量要求不能为负数');
    const req = parseFloat(String(p.effective_online_req_h));
    if (isNaN(req)) throw new Error('有效在线时长要求须为数字');
    if (req < 0) throw new Error('有效在线时长要求不能为负数');
    const weight = parseFloat(p.weight !== undefined && p.weight !== null ? String(p.weight) : '100');
    if (isNaN(weight)) throw new Error('时段权重须为数字');
    if (weight < 0 || weight > 100) throw new Error('时段权重须在 0-100 之间（百分比）');
    return {
      start,
      end,
      name,
      orders,
      weight: Math.round(weight * 100) / 100,
      period_duration_h: this.periodDurationH(start, end),
      effective_online_req_h: Math.round(req * 100) / 100,
    };
  }
  private async periodSave(periods: unknown, month: string | undefined, user: string): Promise<unknown> {
    month = month || currentMonth();
    if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: 'month 须为 YYYY-MM 格式' };
    if (month < currentMonth()) return { ok: false, error: `历史月份（${month}）不可编辑` };
    if (!Array.isArray(periods)) return { ok: false, error: 'periods 须为数组' };
    let normed: any[];
    try {
      normed = (periods as unknown[]).map((x) => this.periodNormPeriod(x));
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const data = {
      schema_version: 3, month, updated_at: nowIso(), updated_by: user || '', periods: normed,
    };
    try {
      this.atomicWrite(this.periodPath(month), data);
      await this.rawCache.invalidateAll();
      return { ok: true, ...(this.periodLoad(month) as Record<string, unknown>) };
    } catch (e) {
      return { ok: false, error: `写入失败：${(e as Error).message}` };
    }
  }

  // ============================================================ attend_period_teams
  private aptGetTeams(): string[] {
    const obj = this.readJson(this.stdPath('attend_period_teams.json'));
    const ids = obj && Array.isArray(obj.teams) ? obj.teams : null;
    if (!ids) return readKnownTeams().map((t) => t.id);
    const out = ids.map((x: unknown) => String(x).trim()).filter((x: string) => x);
    return out.length ? out : readKnownTeams().map((t) => t.id);
  }
  private aptSetTeams(ids: unknown): { ok: boolean; teams: string[]; error: string | null } {
    if (!Array.isArray(ids) || !ids.length) {
      return { ok: false, teams: this.aptGetTeams(), error: '站点不能为空' };
    }
    const clean: string[] = [];
    const seen = new Set<string>();
    for (const x of ids) {
      const s = String(x).trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
    }
    if (!clean.length) {
      return { ok: false, teams: this.aptGetTeams(), error: '站点不能为空' };
    }
    try {
      this.atomicWrite(this.stdPath('attend_period_teams.json'), { teams: clean });
      return { ok: true, teams: clean, error: null };
    } catch (e) {
      return { ok: false, teams: this.aptGetTeams(), error: `写入失败：${(e as Error).message}` };
    }
  }

  // ============================================================ assessment 展示站点
  // 考核看板「展示站点」配置：与 attend_period_teams 同构（独立文件，避免与时段出勤/配送超时混用）。
  // 仅控制前端**展示**哪些站点；考核计算逻辑（Python 按 team 实时算）不受影响、仍全量可用。
  // 落盘于 services/compute/dashboard/standard/assessment_teams.json（与 attend-period 同目录约定）。
  private asGetTeams(): string[] {
    const obj = this.readJson(this.stdPath('assessment_teams.json'));
    const ids = obj && Array.isArray(obj.teams) ? obj.teams : null;
    if (!ids) return readKnownTeams().map((t) => t.id);
    const out = ids.map((x: unknown) => String(x).trim()).filter((x: string) => x);
    return out.length ? out : readKnownTeams().map((t) => t.id);
  }
  private asSetTeams(ids: unknown): { ok: boolean; teams: string[]; error: string | null } {
    if (!Array.isArray(ids) || !ids.length) {
      return { ok: false, teams: this.asGetTeams(), error: '站点不能为空' };
    }
    const clean: string[] = [];
    const seen = new Set<string>();
    for (const x of ids) {
      const s = String(x).trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
    }
    if (!clean.length) {
      return { ok: false, teams: this.asGetTeams(), error: '站点不能为空' };
    }
    try {
      this.atomicWrite(this.stdPath('assessment_teams.json'), { teams: clean });
      return { ok: true, teams: clean, error: null };
    } catch (e) {
      return { ok: false, teams: this.asGetTeams(), error: `写入失败：${(e as Error).message}` };
    }
  }
  async asTeamsGet(allowed: Allowed): Promise<unknown> {
    const payload = await this.teams.fetchAll();
    const list = (payload.teams && payload.teams.length ? payload.teams : payload.fallback) || [];
    const allRefs = list
      .filter((t) => allowed === null || allowed.has(String(t.id)))
      .map((t) => ({ id: String(t.id), name: String(t.name) }));
    const teams = filterIds(this.asGetTeams(), allowed);
    return {
      ok: payload.ok === false ? false : true,
      teams,
      all: allRefs,
      source: payload.source,
      error: payload.error || null,
    };
  }
  asTeamsPost(body: any): unknown {
    const r = this.asSetTeams(body && body.teams);
    return { ok: r.ok, teams: r.teams, error: r.error };
  }

  // ===================================================================== 对外分发
  /** 是否为「配置端点」（应归 Nest 处理，而非转发 Python）。 */
  isConfigPath(urlPath: string): boolean {
    return [
      '/api/standard/grade-global',
      '/api/service-quality/targets',
      '/api/service-quality/weather',
      '/api/attend-period/config',
      '/api/attend-period/months',
      '/api/attend-period/teams',
      '/api/delivery-timeout/teams',
      '/api/assessment/teams',
      '/api/im-contact/teams',
    ].includes(urlPath);
  }

  /** 由 ProxyController 在鉴权后调用：按路径分发到对应配置逻辑。 */
  async dispatch(
    method: 'GET' | 'POST',
    urlPath: string,
    body: any,
    query: Record<string, any>,
    user: string,
    allowed: Allowed,
  ): Promise<unknown> {
    const q = (k: string): string | undefined => {
      const v = query[k];
      if (Array.isArray(v)) return v[0];
      return v === undefined || v === null ? undefined : String(v);
    };
    switch (urlPath) {
      case '/api/standard/grade-global':
        return method === 'GET'
          ? this.getStandardGradeSettings(q('month'))
          : this.saveStandardGradeSettings(body, user);
      case '/api/attend-period/config':
        return method === 'GET' ? this.periodConfigGet(q('month')) : this.periodConfigPost(body, user);
      case '/api/attend-period/months':
        return method === 'GET' ? this.periodMonthsGet() : { ok: false, error: '不支持的方法' };
      case '/api/attend-period/teams':
        return method === 'GET' ? this.apTeamsGet(allowed) : this.apTeamsPost(body);
      case '/api/assessment/teams':
        return method === 'GET' ? this.asTeamsGet(allowed) : this.asTeamsPost(body);
      case '/api/service-quality/targets':
        return method === 'GET'
          ? this.serviceQualityTargetsGet(q('month'))
          : this.serviceQualityTargetsPost(user, body);
      case '/api/service-quality/weather':
        return method === 'GET'
          ? this.weatherLayeringGet(q('month'))
          : this.weatherLayeringPost(user, body);
      default:
        return { ok: false, error: '未知配置端点' };
    }
  }

  // -------------------------------------------------------------- 各端点实现
  periodConfigGet(month?: string): unknown {
    return this.periodLoad(month);
  }
  async periodConfigPost(body: any, user: string): Promise<unknown> {
    return this.periodSave(body && body.periods, body && body.month, user);
  }
  /** 已落盘配置的月份（降序）+ 当前月；与 Python PC.list_months() 同形，但不依赖 8900 在线。 */
  periodMonthsGet(): unknown {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dirs.computeAnalyticsCore());
    } catch {
      files = [];
    }
    const months: string[] = [];
    for (const f of files) {
      const m = /^period_config_(\d{4}-\d{2})\.json$/.exec(f);
      if (m) months.push(m[1]);
    }
    const cur = currentMonth();
    if (!months.includes(cur)) months.push(cur);
    return { ok: true, months: [...new Set(months)].sort().reverse(), current: cur };
  }

  async apTeamsGet(allowed: Allowed): Promise<unknown> {
    const payload = await this.teams.fetchAll();
    const list = (payload.teams && payload.teams.length ? payload.teams : payload.fallback) || [];
    const allRefs = list
      .filter((t) => allowed === null || allowed.has(String(t.id)))
      .map((t) => ({ id: String(t.id), name: String(t.name) }));
    const teams = filterIds(this.aptGetTeams(), allowed);
    return {
      ok: payload.ok === false ? false : true,
      teams,
      all: allRefs,
      source: payload.source,
      error: payload.error || null,
    };
  }
  apTeamsPost(body: any): unknown {
    const r = this.aptSetTeams(body && body.teams);
    return { ok: r.ok, teams: r.teams, error: r.error };
  }

  // ============================================================ 服务质量考核设置
  // 考核项 / 日期类型 / 天气 三维与 assessment 口径一致（同一批 RT_METRICS 等常量），
  // 差别只有两点：① 按月份独立；② 每格是 t0/t60/t100 三档阈值（0分/60分/100分）而非单值。
  //
  // 落盘：{ version, updated_at, updated_by, months: { "<YYYY-MM>": {
  //     weights: { "<metric>": number|null },        // 权重项：百分比 0~100
  //     ranges:  { "<metric>": { min, max } },      // 调分项：得分区间（可负）
  //     kinds:   { "<metric>": "weight"|"adjust"|null },
  //     layering:     { "<metric>": "none"|"date"|"weather"|"date_weather" }, // 按考核项
  //     date_overrides: { "<YYYY-MM-DD>": "weekday"|"weekend" }, // 特殊日期：强制按周中/周末算
  //     "<metric>": { "<date_type>": { "<weather>": { t0, t60, t100 } } } } } }
  private sqPath(): string {
    // 后端本地状态统一落 apps/api/runtime/（带点前缀，与 .users.json / cron.db 等同目录）
    return dirs.runtime('.service_quality_targets.json');
  }
  private sqLoadAll(): any {
    const d = this.readJson(this.sqPath());
    return d && typeof d === 'object' ? d : {};
  }
  private static readonly SQ_TIERS = ['t0', 't60', 't100'] as const;
  /** 单个阈值归一化：空 → null（未设置）；负数/超范围（%）→ null（丢弃脏值）。 */
  private sqNormNum(v: unknown, metric: string): number | null {
    if (v === null || v === undefined || v === '') return null;
    const f = parseFloat(String(v));
    if (isNaN(f) || f < 0) return null;
    const m = RT_METRICS.find((x) => x.key === metric);
    if (m && m.unit === '%' && f > 100) return null;
    return Math.round(f * 100) / 100;
  }
  private sqNormTiers(src: any, metric: string): { t0: number | null; t60: number | null; t100: number | null } {
    const s = src && typeof src === 'object' ? src : {};
    const out: { t0: number | null; t60: number | null; t100: number | null } = {
      t0: null, t60: null, t100: null,
    };
    for (const k of ConfigService.SQ_TIERS) out[k] = this.sqNormNum(s[k], metric);
    return out;
  }
  /**
   * 校验三档顺序（正向 t0<t60<t100、负向反之；与服务质量页面的口径一致）：
   * 正向指标需 t0 < t60 < t100，负向指标需 t0 > t60 > t100。
   * 仅当三档都填了才校验（允许只填部分档位）。
   */
  private sqValidateTiers(
    tiers: { t0: number | null; t60: number | null; t100: number | null },
    direction: string,
  ): string | null {
    const { t0, t60, t100 } = tiers;
    if (t0 === null || t60 === null || t100 === null) return null; // 部分档位不校验顺序
    if (direction === 'pos') {
      return t0 < t60 && t60 < t100 ? null : `需 0分<60分<100分（当前 ${t0}/${t60}/${t100}）`;
    }
    return t0 > t60 && t60 > t100 ? null : `需 0分>60分>100分（当前 ${t0}/${t60}/${t100}）`;
  }
  /** 某月各考核项的 8 个格子（2 日期类型 × 4 天气），每格三档；缺省全 null（未设置）。 */
  private sqMonthCells(month: string): Record<string, Record<string, Record<string, { t0: number | null; t60: number | null; t100: number | null }>>> {
    const out: Record<string, Record<string, Record<string, { t0: number | null; t60: number | null; t100: number | null }>>> = {};
    const all = this.sqLoadAll();
    const months = all.months && typeof all.months === 'object' ? all.months : {};
    const entry = months[month] && typeof months[month] === 'object' ? months[month] : {};
    const wxCols = this.sqWeatherCols(month);
    for (const m of RT_METRICS) {
      const perMetric: Record<string, Record<string, { t0: number | null; t60: number | null; t100: number | null }>> = {};
      for (const dt of RT_DATE_TYPES) {
        const perWx: Record<string, { t0: number | null; t60: number | null; t100: number | null }> = {};
        for (const wx of wxCols) {
          const cell = entry[m.key] && entry[m.key][dt.key] ? entry[m.key][dt.key] : {};
          perWx[wx.key] = this.sqNormTiers(cell[wx.key], m.key);
        }
        perMetric[dt.key] = perWx;
      }
      out[m.key] = perMetric;
    }
    return out;
  }
  /**
   * 特殊日期覆盖表：{ "<YYYY-MM-DD>": "weekday"|"weekend" }。
   * 仅接受属于该月、值合法的条目（其余静默丢弃，与阈值/tiers 的宽松口径一致）。
   * 语义：把某日历日强制按「周中 / 周末」算（原本周中→按周末算、原本周末→按周中算）。
   * 评分接入为后续任务；此处仅负责读写与存储。
   */
  private sqNormDateOverrides(incoming: any, month: string): Record<string, 'weekday' | 'weekend'> {
    const out: Record<string, 'weekday' | 'weekend'> = {};
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return out;
    const prefix = month + '-';
    for (const [k, v] of Object.entries(incoming)) {
      if (typeof k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      if (!k.startsWith(prefix)) continue; // 仅接受当月日期
      if (v !== 'weekday' && v !== 'weekend') continue;
      out[k] = v;
    }
    return out;
  }
  private sqMonthDateOverrides(month: string): Record<string, 'weekday' | 'weekend'> {
    const all = this.sqLoadAll();
    const months = all.months && typeof all.months === 'object' ? all.months : {};
    const entry = months[month] && typeof months[month] === 'object' ? months[month] : {};
    return this.sqNormDateOverrides(entry.date_overrides, month);
  }
  /** 该月服务质量页的天气列：按「天气设置 → 天气分层设置」该月配置的分层名展示（列表顺序即严重度）。
   *  键映射与评分侧 board.py weather_key 同规则：前 4 档沿用 normal/light/moderate/severe，
   *  第 5 档起用 wx4/wx5/…（评分侧按层级序号一一对应）。
   *  该月未配置天气分层时**不回落默认四级**：仅保留单个「不分天气」列（key=normal，
   *  与评分侧未配置时按 normal 档取阈值的口径一致），页面上天气维度即告消失。 */
  private sqWeatherCols(month: string): Array<{ key: string; name: string }> {
    const names = this.wlMonthTiers(month)
      .tiers
      .map((t) => String((t as any).name ?? '').trim())
      .filter(Boolean);
    if (!names.length) return [{ key: 'normal', name: '不分天气' }];
    return names.map((name, i) => ({
      key: i < RT_WEATHER.length ? RT_WEATHER[i].key : `wx${i}`,
      name,
    }));
  }
  serviceQualityTargetsGet(month?: string): unknown {
    month = month || currentMonth();
    const all = this.sqLoadAll();
    const months = all.months && typeof all.months === 'object' ? all.months : {};
    return {
      ok: true,
      month,
      /** 该月是否已保存过（false = 从未配置，前端据此提示）。 */
      configured: !!months[month],
      metrics: RT_METRICS,
      date_types: RT_DATE_TYPES,
      weather: this.sqWeatherCols(month),
      /** 该月是否配置了天气分层（false = 天气维度不参与，前端只展示周中/周末两列）。 */
      weather_configured: this.wlMonthTiers(month).tiers.length > 0,
      targets: this.sqMonthCells(month),
      weights: this.sqMonthWeights(month),
      ranges: this.sqMonthRanges(month),
      kinds: this.sqMonthKinds(month),
      kinds_meta: SQ_KINDS,
      layering: this.sqMonthLayering(month),
      layering_meta: SQ_LAYERING,
      date_overrides: this.sqMonthDateOverrides(month),
      updated_at: all.updated_at || '',
      updated_by: all.updated_by || '',
    };
  }
  async serviceQualityTargetsPost(user: string, body: any): Promise<unknown> {
    const month = String((body && body.month) || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: 'month 须为 YYYY-MM 格式' };
    const incoming = (body && body.targets) || {};
    const errors: string[] = [];
    const wxCols = this.sqWeatherCols(month);
    const out: Record<string, Record<string, Record<string, { t0: number | null; t60: number | null; t100: number | null }>>> = {};
    for (const m of RT_METRICS) {
      const perMetric: Record<string, Record<string, { t0: number | null; t60: number | null; t100: number | null }>> = {};
      const src = incoming[m.key] && typeof incoming[m.key] === 'object' ? incoming[m.key] : {};
      for (const dt of RT_DATE_TYPES) {
        const perWx: Record<string, { t0: number | null; t60: number | null; t100: number | null }> = {};
        const srcDt = src[dt.key] && typeof src[dt.key] === 'object' ? src[dt.key] : {};
        for (const wx of wxCols) {
          const tiers = this.sqNormTiers(srcDt[wx.key], m.key);
          const bad = this.sqValidateTiers(tiers, m.direction);
          if (bad) errors.push(`${m.name} / ${dt.name} / ${wx.name}：${bad}`);
          perWx[wx.key] = tiers;
        }
        perMetric[dt.key] = perWx;
      }
      out[m.key] = perMetric;
    }
    if (errors.length) return { ok: false, error: errors[0], errors };
    // 权重（权重项=百分比 0~100；调分项用得分区间，权重置空）
    const kIn0 = (body && body.kinds) || {};
    const kindsIn: Record<string, 'weight' | 'adjust' | null> = {};
    for (const m of RT_METRICS) kindsIn[m.key] = this.sqNormKind(kIn0[m.key]);
    const wIn = (body && body.weights) || {};
    const weights: Record<string, number | null> = {};
    let weightFilled = 0;
    let weightSum = 0;
    for (const m of RT_METRICS) {
      // 仅「权重项」的百分比参与合计校验（调分项用得分区间，不计入）
      const w = kindsIn[m.key] === 'adjust' ? null : this.sqNormWeight(wIn[m.key]);
      weights[m.key] = w;
      if (kindsIn[m.key] === 'weight' && w !== null) {
        weightFilled += 1;
        weightSum += w;
      }
    }
    // 权重合计校验：有填写才校验，全未填写放行（交由页面提示「未设置」）
    if (weightFilled > 0 && Math.abs(weightSum - SQ_WEIGHT_SUM) > SQ_WEIGHT_SUM_TOL) {
      errors.push(`权重项合计 ${weightSum.toFixed(2)}%，应为 ${SQ_WEIGHT_SUM}%`);
    }
    // 调分项得分区间：允许负数；两端都填时下限须 ≤ 上限
    const rIn = (body && body.ranges) || {};
    const ranges: Record<string, { min: number | null; max: number | null }> = {};
    for (const m of RT_METRICS) {
      const r = this.sqNormRange(rIn[m.key]);
      if (r.min !== null && r.max !== null && r.min > r.max) {
        errors.push(`${m.name}：得分区间下限不能大于上限（当前 ${r.min}~${r.max}）`);
      }
      ranges[m.key] = r;
    }
    if (errors.length) return { ok: false, error: errors[0], errors };
    // 计分方式：weight=权重项 / adjust=调分项
    const kinds: Record<string, 'weight' | 'adjust' | null> = { ...kindsIn };
    // 分层方式：**按考核项**（有的项分层、有的不分层）；页面按此合并该行的值单元格。
    const lIn = (body && body.layering) || {};
    const layering: Record<string, string> = {};
    for (const m of RT_METRICS) layering[m.key] = this.sqNormLayering(lIn[m.key]);
    // 逐考核项按**自身**分层方式把矩阵补全成 8 格（未分层维度用代表格回填，避免空洞）
    for (const m of RT_METRICS) {
      const L = layering[m.key];
      const rep = (dt: string, wx: string): [string, string] => {
        if (L === 'none') return ['weekday', 'normal'];
        if (L === 'date') return [dt, 'normal'];
        if (L === 'weather') return ['weekday', wx];
        return [dt, wx];
      };
      for (const dt of RT_DATE_TYPES) {
        for (const wx of wxCols) {
          const [rDt, rWx] = rep(dt.key, wx.key);
          if (rDt === dt.key && rWx === wx.key) continue;
          out[m.key][dt.key][wx.key] = { ...out[m.key][rDt][rWx] };
        }
      }
    }
    // 特殊日期覆盖表（仅存储，评分接入为后续任务）
    const dateOverrides = this.sqNormDateOverrides((body && body.date_overrides) || {}, month);
    const all = this.sqLoadAll();
    all.version = 1;
    all.months = all.months && typeof all.months === 'object' ? all.months : {};
    // 该月条目按本次保存重建，但保留同月并存的其他设置块
    // （如天气分层 weather_layering —— 与「天气设置」页共用同一条目，不能被服务质量保存抹掉）。
    const prev = all.months[month] && typeof all.months[month] === 'object' ? all.months[month] : {};
    all.months[month] = {
      ...out, weights, ranges, kinds, layering, date_overrides: dateOverrides,
      ...(prev.weather_layering && typeof prev.weather_layering === 'object'
        ? { weather_layering: prev.weather_layering } : {}),
    };
    all.updated_at = nowStamp();
    all.updated_by = user || '';
    try {
      this.atomicWrite(this.sqPath(), all);
      await this.rawCache.invalidateAll();
      return { ok: true, ...(this.serviceQualityTargetsGet(month) as Record<string, unknown>) };
    } catch (e) {
      return { ok: false, error: `写入失败：${(e as Error).message}` };
    }
  }

  // ============================================================ 天气分层（考核设置 → 天气分层设置）
  // 考核看板当天天气分层由**用户自定义的判定链**判定：每层
  // {name, logic, conditions:[{grades, cmp, value}]}，grades 为勾选的恶劣天气等级组合
  // （如 [1,2] / [3,4] / [4]，占比 = 勾选等级运单数 / 全部运单，不再限定固定四种口径），
  // logic 为 and（满足全部）/ or（满足任一）。
  // 判定按列表顺序（严重度升序）逐层进行，首个命中即止，全部未命中兜底最后一层。
  // Python board.py weather_level() 按同一列表判定；层序号映射服务质量配置的
  // weather 键（normal/light/moderate/severe，序号钳制 0~3）。
  // 落盘：.service_quality_targets.json 的 months["<YYYY-MM>"].weather_layering.tiers
  // （按月份独立，与服务质量设置同文件同月份键），另存 grade_tags（独立天气等级标签库）
  // 与 tags（天气标签行 [{label,name}]）——二者均不参与判定，三块数据互不联动；
  // updated_at/updated_by 只写在 weather_layering 内部。
  // 该月未配置时计算侧**不判定天气分层**（weather_level 为空、评分按 normal 档取阈值）。
  private static readonly WL_GRADES = [1, 2, 3, 4];
  private static readonly WL_CMP = ['lte', 'lt', 'gte', 'gt'];
  /** 历史固定口径（metric 字符串）→ 等级组合，仅用于兼容旧数据。 */
  private static readonly WL_METRIC_GRADES: Record<string, number[]> = {
    r1234: [1, 2, 3, 4],
    r234: [2, 3, 4],
    r34: [3, 4],
    r4: [4],
  };
  private static readonly WL_CMP_SIGNS: Record<string, string> = { lte: '≤', lt: '<', gte: '≥', gt: '>' };
  /** 数值归一化：须为 0~100 的有限数字，否则 null。 */
  private wlNorm(v: unknown): number | null {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  }
  /** 等级组合归一化：升序去重，只保留 1~4；无效返回 []（兼容旧配置的序号口径）。 */
  private wlGrades(v: unknown): number[] {
    const out: number[] = [];
    if (Array.isArray(v)) {
      for (const g of v) {
        const n = Number(g);
        if (ConfigService.WL_GRADES.includes(n) && !out.includes(n)) out.push(n);
      }
    }
    return out.sort((a, b) => a - b);
  }
  /** 天气标签归一化：去空、去重、限长 20；无效返回 []。 */
  private wlTags(v: unknown): string[] {
    const out: string[] = [];
    if (Array.isArray(v)) {
      for (const t of v) {
        const s = String(t ?? '').trim();
        if (!s || s.length > 20 || out.includes(s)) continue;
        out.push(s);
      }
    }
    return out;
  }
  /** 单条分层的判定条件归一化：[{tags, grades, cmp, value}]；兼容旧格式（序号 / 固定口径 / 单条件平铺）。 */
  private wlTierConditions(t: any): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const one = (c: any): Record<string, unknown> | null => {
      if (!c || typeof c !== 'object') return null;
      const tags = this.wlTags(c.tags);
      const grades = this.wlGrades(c.grades).length
        ? this.wlGrades(c.grades)
        : (ConfigService.WL_METRIC_GRADES[String(c.metric ?? '')] || []);
      const cmp = String(c.cmp ?? '');
      const value = this.wlNorm(c.value);
      if ((!tags.length && !grades.length) || !ConfigService.WL_CMP.includes(cmp) || value === null) return null;
      return { tags, grades, cmp, value };
    };
    const raw = Array.isArray(t && t.conditions) ? t.conditions : [];
    for (const c of raw) {
      const o = one(c);
      if (o) out.push(o);
    }
    if (!out.length) {
      const o = one(t);
      if (o) out.push(o);
    }
    return out;
  }
  /** 该月已落盘的配置（脏条目剔除）：tiers = 判定链，tags = 天气标签行，grade_tags = 等级标签库。 */
  private wlMonthTiers(month: string): {
    tiers: Array<Record<string, unknown>>;
    tags: Array<Record<string, unknown>>;
    gradeTags: string[];
    updated_at: string;
    updated_by: string;
  } {
    const all = this.sqLoadAll();
    const months = all.months && typeof all.months === 'object' ? all.months : {};
    const entry = months[month] && typeof months[month] === 'object' ? months[month] : {};
    const wl = entry.weather_layering && typeof entry.weather_layering === 'object' ? entry.weather_layering : {};
    const raw = Array.isArray(wl.tiers) ? wl.tiers : [];
    const tiers: Array<Record<string, unknown>> = [];
    for (const t of raw) {
      if (!t || typeof t !== 'object') continue;
      const name = String((t as any).name ?? '').trim();
      if (!name) continue;
      // 判定条件：新格式为条件数组，旧格式（单条件平铺 metric/cmp/value）自动包成一条
      const conditions = this.wlTierConditions(t);
      if (!conditions.length) continue;
      const logic = String((t as any).logic ?? '') === 'or' ? 'or' : 'and';
      tiers.push({ name, logic, conditions });
    }
    // 天气标签行（与判定链互不影响）：{label 手工标签, name 天气等级}
    const tags: Array<Record<string, unknown>> = [];
    if (Array.isArray(wl.tags)) {
      for (const t of wl.tags) {
        if (!t || typeof t !== 'object') continue;
        const label = String((t as any).label ?? '').trim();
        const name = String((t as any).name ?? '').trim();
        if (!label || label.length > 20 || !name || name.length > 20) continue;
        tags.push({ label, name });
      }
    } else {
      // 兼容旧数据：历史上标签与判定链混存在 tiers（label 字段），此时按 tiers 还原一份标签行
      for (const t of raw) {
        if (!t || typeof t !== 'object') continue;
        const name = String((t as any).name ?? '').trim();
        if (!name) continue;
        const label = String((t as any).label ?? '').trim() || name;
        if (label.length > 20 || name.length > 20) continue;
        tags.push({ label, name });
      }
    }
    // 天气等级标签库：与上面两块互不影响，仅作独立维护的标签清单
    const gradeTags: string[] = [];
    const rawTags = Array.isArray(wl.grade_tags) ? wl.grade_tags : [];
    for (const g of rawTags) {
      const n = String(g ?? '').trim();
      if (!n || n.length > 20 || gradeTags.includes(n)) continue;
      gradeTags.push(n);
    }
    return {
      tiers,
      tags,
      gradeTags,
      updated_at: (wl && wl.updated_at) || '',
      updated_by: (wl && wl.updated_by) || '',
    };
  }
  weatherLayeringGet(month?: string): unknown {
    const m = /^\d{4}-\d{2}$/.test(month || '') ? month as string : currentMonth();
    const st = this.wlMonthTiers(m);
    return {
      ok: true,
      month: m,
      tiers: st.tiers,
      tags: st.tags,
      grade_tags: st.gradeTags,
      configured: st.tiers.length > 0,
      updated_at: st.updated_at,
      updated_by: st.updated_by,
    };
  }
  weatherLayeringPost(user: string, body: any): unknown {
    const month = body && body.month;
    const m = /^\d{4}-\d{2}$/.test(month || '') ? month as string : currentMonth();
    const in0 = Array.isArray(body && body.tiers) ? body.tiers : [];
    const out: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < in0.length; i++) {
      const t = in0[i] || {};
      const name = String(t.name ?? '').trim();
      if (!name) { errors.push(`天气分层第 ${i + 1} 条：请填写天气分层名称`); continue; }
      if (name.length > 20) { errors.push(`天气分层第 ${i + 1} 条：分层名称过长（≤20 字）`); continue; }
      if (seen.has(name)) { errors.push(`天气分层「${name}」重复`); continue; }
      seen.add(name);
      const logic = String(t.logic ?? '') === 'or' ? 'or' : 'and';
      // 条件数组；兼容旧前端传来的单条件平铺字段
      const rawConds: any[] = Array.isArray(t.conditions)
        ? t.conditions
        : (t.metric || t.cmp || t.value !== undefined ? [{ metric: t.metric, cmp: t.cmp, value: t.value }] : []);
      if (!rawConds.length) { errors.push(`天气分层第 ${i + 1} 条（${name}）：至少配置一个判定条件`); continue; }
      if (rawConds.length > 10) { errors.push(`天气分层第 ${i + 1} 条（${name}）：判定条件最多 10 个`); continue; }
      const conditions: Array<Record<string, unknown>> = [];
      let bad = false;
      for (let j = 0; j < rawConds.length; j++) {
        const c = rawConds[j] || {};
        const tags = this.wlTags(c.tags);
        const grades = this.wlGrades(c.grades).length
          ? this.wlGrades(c.grades)
          : (ConfigService.WL_METRIC_GRADES[String(c.metric ?? '')] || []);
        const cmp = String(c.cmp ?? '');
        const value = this.wlNorm(c.value);
        if (!tags.length && !grades.length) { errors.push(`天气分层第 ${i + 1} 条（${name}）第 ${j + 1} 个条件：请勾选天气标签`); bad = true; break; }
        if (!ConfigService.WL_CMP.includes(cmp)) { errors.push(`天气分层第 ${i + 1} 条（${name}）第 ${j + 1} 个条件：判定符无效`); bad = true; break; }
        if (value === null) { errors.push(`天气分层第 ${i + 1} 条（${name}）第 ${j + 1} 个条件：阈值须为 0~100 的数字`); bad = true; break; }
        conditions.push({ tags, grades, cmp, value });
      }
      if (bad) continue;
      out.push({ name, logic, conditions });
    }
    // 天气标签行（独立于判定链）：{label 手工标签, name 天气等级}，允许为空
    const inTagRows = Array.isArray(body && body.tags) ? body.tags : [];
    const tagRows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < inTagRows.length; i++) {
      const t = inTagRows[i] || {};
      const label = String(t.label ?? '').trim();
      const name = String(t.name ?? '').trim();
      if (!label) { errors.push(`天气标签第 ${i + 1} 行：天气标签不能为空`); continue; }
      if (label.length > 20) { errors.push(`天气标签「${label}」过长（≤20 字）`); continue; }
      if (!name) { errors.push(`天气标签「${label}」：未选择天气等级`); continue; }
      if (name.length > 20) { errors.push(`天气标签「${label}」：天气等级名称过长（≤20 字）`); continue; }
      tagRows.push({ label, name });
    }
    // 天气等级标签库（独立标签清单）：仅校验名称，允许为空
    const inTags = Array.isArray(body && body.grade_tags) ? body.grade_tags : [];
    const tags: string[] = [];
    for (let i = 0; i < inTags.length; i++) {
      const n = String(inTags[i] ?? '').trim();
      if (!n) continue;
      if (n.length > 20) { errors.push(`天气等级「${n}」名称过长（≤20 字）`); continue; }
      if (tags.includes(n)) { errors.push(`天气等级「${n}」重复`); continue; }
      tags.push(n);
    }
    if (errors.length) return { ok: false, error: errors[0], errors };
    // 允许保存空列表：等于清空该月的天气等级配置（前端「没设置就不要有数据」，
    // 计算侧 weather_tiers() 读到空列表时回落业务默认四级，看板不至于无档位可用）。
    const all = this.sqLoadAll();
    all.months = all.months && typeof all.months === 'object' ? all.months : {};
    const entry = all.months[m] && typeof all.months[m] === 'object' ? all.months[m] : {};
    all.months[m] = {
      ...entry,
      weather_layering: { tiers: out, tags: tagRows, grade_tags: tags, updated_at: nowStamp(), updated_by: user || '' },
    };
    try {
      this.atomicWrite(this.sqPath(), all);
      return { ok: true, ...(this.weatherLayeringGet(m) as Record<string, unknown>) };
    } catch (e) {
      return { ok: false, error: `写入失败：${(e as Error).message}` };
    }
  }
}
