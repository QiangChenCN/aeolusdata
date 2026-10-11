import { Injectable, Logger } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { TeamsFetchService, TeamRef, readKnownTeams } from '../fetch/teams-fetch.service';
import { RawCacheService } from '../fetch/raw-cache.service';

/**
 * 配置层（原 Python `dashboard/standard/{teams_config,grade_standards,threshold_config,
 * period_config,attend_period_teams}.py` + `dashboard/realtime/config.py`）的 NestJS 原生实现。
 *
 * 迁移目标（见 server.py→NestJS 映射 / ADR「Python 只做大计算」）：这些端点是**纯配置读写 +
 * 少量校验/塑形**，不是大数据计算，故由 Nest 接管为唯一写入方；Python 计算侧仍按原路径**读**
 * 同一批文件（格式与 Python `json.dump(ensure_ascii=False, indent=2)` 解析兼容）。
 *
 * 落盘路径刻意与 Python 一致（不搬文件，避免改动 Python 计算侧的读取路径）：
 *   · 标准类配置 → `<root>/python/dashboard/standard/*.json`
 *   · 服务质量考核目标 → `<root>/backend/data/.service_quality_targets.json`
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
// 考核项 / 日期类型 / 天气 三维口径（与 `analytics/realtime/config.py` 逐字对应，
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
    this.root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    // 与 Python `dashboard/standard/*` 同目录 —— 计算侧仍按此路径读配置。
    this.stdDir = path.join(this.root, 'python', 'dashboard', 'standard');
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

  // ============================================================ 标准达成设置（按月份 × 站点）
  // 数据模型：standard_grade_settings.json =
  //   { schema_version, updated_at, updated_by,
  //     default: { levels:[5], threshold_pct, cap_pct },   // 仅兜底/新站点填充用，前台已不再提供编辑
  //     months: { "<YYYY-MM>": { "<team_id>": { levels:[5], threshold_pct, cap_pct } | {use_default:true} } } }
  // 「参与考核站点」已移除：某月下【配置了记录的站点】即参与考核（有设置就默认考核）。
  // 某月从未保存过时参与站点为空（前端提示），仅旧单套 schema 会套用旧名单做迁移。
  // 落盘于 python/dashboard/standard/standard_grade_settings.json（计算侧按此路径读取，同源）。
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
  private periodHmmAdd(hhmm: string, hours: number): string {
    const [h, m] = hhmm.split(':').map(Number);
    let total = h * 60 + m + Math.round(hours * 60);
    total = ((total % 1440) + 1440) % 1440;
    const hh = Math.floor(total / 60);
    const mm = total % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
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
  private periodDefaults(): any[] {
    const base: [string, number, string, number][] = [
      ['00:00', 1.5, '凌晨1', 1],
      ['02:00', 1.3, '凌晨2', 1],
      ['04:00', 1.2, '凌晨3', 1],
      ['06:00', 1.5, '早餐1', 1],
      ['08:00', 2.0, '早餐2', 1],
      ['10:30', 2.5, '午高峰', 5],
      ['13:30', 1.5, '下午茶1', 2],
      ['15:30', 1.5, '下午茶2', 2],
      ['17:30', 2.0, '晚高峰', 3],
      ['20:00', 1.5, '夜宵1', 2],
      ['22:00', 2.0, '夜宵2', 2],
    ];
    return base.map(([start, dur, name, orders]) => {
      const end = this.periodHmmAdd(start, dur);
      const pdur = this.periodDurationH(start, end);
      return { start, end, name, orders, weight: 100, period_duration_h: pdur, effective_online_req_h: pdur };
    });
  }
  private periodRead(month: string): any | null {
    const p = this.stdPath(`period_config_${month}.json`);
    const d = this.readJson(p);
    if (!d || !Array.isArray(d.periods)) return null;
    return d;
  }
  private periodLoad(month?: string) {
    month = month || currentMonth();
    const d = this.periodRead(month);
    let periods: any[];
    let updatedAt: string | null;
    if (d === null) {
      periods = this.periodDefaults();
      updatedAt = null;
    } else {
      periods = d.periods.map((x: any) => ({ ...x }));
      updatedAt = d.updated_at;
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
      schema_version: 3,
      month,
      updated_at: updatedAt,
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
  private periodSave(periods: unknown, month?: string) {
    month = month || currentMonth();
    if (month < currentMonth()) throw new Error(`历史月份（${month}）不可编辑`);
    if (!Array.isArray(periods)) throw new Error('periods 须为数组');
    const normed = (periods as unknown[]).map((x) => this.periodNormPeriod(x));
    const data = { schema_version: 3, month, updated_at: nowIso(), periods: normed };
    this.atomicWrite(this.stdPath(`period_config_${month}.json`), data);
    return data;
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

  // ============================================================ delivery_timeout_teams
  private dtGetTeams(): string[] {
    const obj = this.readJson(this.stdPath('delivery_timeout_teams.json'));
    const ids = obj && Array.isArray(obj.teams) ? obj.teams : null;
    if (!ids) return readKnownTeams().map((t) => t.id);
    const out = ids.map((x: unknown) => String(x).trim()).filter((x: string) => x);
    return out.length ? out : readKnownTeams().map((t) => t.id);
  }
  private dtSetTeams(ids: unknown): { ok: boolean; teams: string[]; error: string | null } {
    if (!Array.isArray(ids) || !ids.length) {
      return { ok: false, teams: this.dtGetTeams(), error: '站点不能为空' };
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
      return { ok: false, teams: this.dtGetTeams(), error: '站点不能为空' };
    }
    try {
      this.atomicWrite(this.stdPath('delivery_timeout_teams.json'), { teams: clean });
      return { ok: true, teams: clean, error: null };
    } catch (e) {
      return { ok: false, teams: this.dtGetTeams(), error: `写入失败：${(e as Error).message}` };
    }
  }

  // ===================================================================== 对外分发
  /** 是否为「配置端点」（应归 Nest 处理，而非转发 Python）。 */
  isConfigPath(urlPath: string): boolean {
    return [
      '/api/standard/grade-global',
      '/api/service-quality/targets',
      '/api/attend-period/config',
      '/api/attend-period/teams',
      '/api/realtime/timeout/teams',
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
        return method === 'GET' ? this.periodConfigGet(q('month')) : this.periodConfigPost(body);
      case '/api/attend-period/teams':
        return method === 'GET' ? this.apTeamsGet(allowed) : this.apTeamsPost(body);
      case '/api/realtime/timeout/teams':
        return method === 'GET' ? this.dtTeamsGet(allowed) : this.dtTeamsPost(body);
      case '/api/service-quality/targets':
        return method === 'GET'
          ? this.serviceQualityTargetsGet(q('month'))
          : this.serviceQualityTargetsPost(user, body);
      default:
        return { ok: false, error: '未知配置端点' };
    }
  }

  // -------------------------------------------------------------- 各端点实现
  periodConfigGet(month?: string): unknown {
    return this.periodLoad(month);
  }
  periodConfigPost(body: any): unknown {
    try {
      return this.periodSave(body && body.periods, body && body.month);
    } catch (e) {
      return { ok: false, error: `${(e as Error).name}: ${(e as Error).message}` };
    }
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

  // ============================================================ delivery_timeout_teams
  // 配送超时看板「展示站点」配置：与 attend_period_teams 同构，落盘到
  // python/dashboard/standard/delivery_timeout_teams.json（前端按此过滤站点下拉与「全部站点」聚合）。
  async dtTeamsGet(allowed: Allowed): Promise<unknown> {
    const payload = await this.teams.fetchAll();
    const list = (payload.teams && payload.teams.length ? payload.teams : payload.fallback) || [];
    const allRefs = list
      .filter((t) => allowed === null || allowed.has(String(t.id)))
      .map((t) => ({ id: String(t.id), name: String(t.name) }));
    const teams = filterIds(this.dtGetTeams(), allowed);
    return {
      ok: payload.ok === false ? false : true,
      teams,
      all: allRefs,
      source: payload.source,
      error: payload.error || null,
    };
  }
  dtTeamsPost(body: any): unknown {
    const r = this.dtSetTeams(body && body.teams);
    return { ok: r.ok, teams: r.teams, error: r.error };
  }

  // ============================================================ 服务质量考核设置
  // 考核项 / 日期类型 / 天气 三维与 realtime 口径一致（同一批 RT_METRICS 等常量），
  // 差别只有两点：① 按月份独立；② 每格是 t0/t60/t100 三档阈值（0分/60分/100分）而非单值。
  //
  // 落盘：{ version, updated_at, updated_by, months: { "<YYYY-MM>": {
  //     weights: { "<metric>": number|null },        // 权重项：百分比 0~100
  //     ranges:  { "<metric>": { min, max } },      // 调分项：得分区间（可负）
  //     kinds:   { "<metric>": "weight"|"adjust"|null },
  //     layering:     { "<metric>": "none"|"date"|"weather"|"date_weather" }, // 按考核项
  //     "<metric>": { "<date_type>": { "<weather>": { t0, t60, t100 } } } } } }
  private sqPath(): string {
    // 后端本地状态统一落 backend/data/（带点前缀，与 .users.json / todo.db 等同目录）
    return path.join(this.root, 'backend', 'data', '.service_quality_targets.json');
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
    for (const m of RT_METRICS) {
      const perMetric: Record<string, Record<string, { t0: number | null; t60: number | null; t100: number | null }>> = {};
      for (const dt of RT_DATE_TYPES) {
        const perWx: Record<string, { t0: number | null; t60: number | null; t100: number | null }> = {};
        for (const wx of RT_WEATHER) {
          const cell = entry[m.key] && entry[m.key][dt.key] ? entry[m.key][dt.key] : {};
          perWx[wx.key] = this.sqNormTiers(cell[wx.key], m.key);
        }
        perMetric[dt.key] = perWx;
      }
      out[m.key] = perMetric;
    }
    return out;
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
      weather: RT_WEATHER,
      targets: this.sqMonthCells(month),
      weights: this.sqMonthWeights(month),
      ranges: this.sqMonthRanges(month),
      kinds: this.sqMonthKinds(month),
      kinds_meta: SQ_KINDS,
      layering: this.sqMonthLayering(month),
      layering_meta: SQ_LAYERING,
      updated_at: all.updated_at || '',
      updated_by: all.updated_by || '',
    };
  }
  async serviceQualityTargetsPost(user: string, body: any): Promise<unknown> {
    const month = String((body && body.month) || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: 'month 须为 YYYY-MM 格式' };
    const incoming = (body && body.targets) || {};
    const errors: string[] = [];
    const out: Record<string, Record<string, Record<string, { t0: number | null; t60: number | null; t100: number | null }>>> = {};
    for (const m of RT_METRICS) {
      const perMetric: Record<string, Record<string, { t0: number | null; t60: number | null; t100: number | null }>> = {};
      const src = incoming[m.key] && typeof incoming[m.key] === 'object' ? incoming[m.key] : {};
      for (const dt of RT_DATE_TYPES) {
        const perWx: Record<string, { t0: number | null; t60: number | null; t100: number | null }> = {};
        const srcDt = src[dt.key] && typeof src[dt.key] === 'object' ? src[dt.key] : {};
        for (const wx of RT_WEATHER) {
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
        for (const wx of RT_WEATHER) {
          const [rDt, rWx] = rep(dt.key, wx.key);
          if (rDt === dt.key && rWx === wx.key) continue;
          out[m.key][dt.key][wx.key] = { ...out[m.key][rDt][rWx] };
        }
      }
    }
    const all = this.sqLoadAll();
    all.version = 1;
    all.months = all.months && typeof all.months === 'object' ? all.months : {};
    all.months[month] = { ...out, weights, ranges, kinds, layering };
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
}
