import { Injectable, Logger } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { TeamsFetchService, TeamRef } from '../fetch/teams-fetch.service';
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
 *   · 实时类配置 → `<root>/.realtime_(selection|targets).json`
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
// 实时看板配置常量（与 `dashboard/realtime/config.py` 逐字对应）
// ============================================================================
const RT_METRICS = [
  { key: 'delivery_rate', name: '物流妥投率', direction: 'pos', unit: '%' },
  { key: 'ontime_rate', name: '考核准时率', direction: 'pos', unit: '%' },
  { key: 'unsat_rate', name: '不满意率', direction: 'neg', unit: '%' },
  { key: 'compound_overtime', name: '复合超时时长', direction: 'neg', unit: 'min' },
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
const RT_DEFAULT_WEIGHT: Record<string, number> = {
  delivery_rate: 20, ontime_rate: 30, unsat_rate: 20,
  compound_overtime: 15, call_rate: 5, im_reply_rate: 5, visit_rate: 5,
};
const RT_METRIC_DIR = new Map<string, string>(RT_METRICS.map((m) => [m.key, m.direction]));
const RT_METRIC_KEYS = new Set(RT_METRICS.map((m) => m.key));
const RT_DT_KEYS = new Set(RT_DATE_TYPES.map((d) => d.key));
const RT_WX_KEYS = new Set(RT_WEATHER.map((w) => w.key));

const DEFAULT_TEAMS = ['917521130', '917521136', '917521139'];

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
  private realtimePath(name: string): string {
    return path.join(this.root, name);
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

  // ------------------------------------------------------------ 站点目录（`all`）
  private async allTeamRefs(): Promise<TeamRef[]> {
    const p = await this.teams.fetchAll();
    const list = (p.teams && p.teams.length ? p.teams : p.fallback) || [];
    return list.map((t) => ({ id: String(t.id), name: String(t.name) }));
  }

  // ================================================================== teams_config
  private tcGetTeams(): string[] {
    const obj = this.readJson(this.stdPath('teams_config.json'));
    const ids = obj && Array.isArray(obj.teams) ? obj.teams : null;
    if (!ids) return [...DEFAULT_TEAMS];
    const out = ids.map((x: unknown) => String(x).trim()).filter((x: string) => x);
    return out.length ? out : [...DEFAULT_TEAMS];
  }
  private tcSetTeams(ids: unknown): { ok: boolean; teams: string[]; error: string | null } {
    if (!Array.isArray(ids) || !ids.length) {
      return { ok: false, teams: this.tcGetTeams(), error: '参与站点不能为空' };
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
      return { ok: false, teams: this.tcGetTeams(), error: '参与站点不能为空' };
    }
    try {
      this.atomicWrite(this.stdPath('teams_config.json'), { teams: clean });
      return { ok: true, teams: clean, error: null };
    } catch (e) {
      return { ok: false, teams: this.tcGetTeams(), error: `写入失败：${(e as Error).message}` };
    }
  }

  // ================================================================ grade_standards
  private readonly GS_DEFAULT_BY_TEAM: Record<string, { order: number[]; duration_h: number[] }> = {
    '917521130': { order: [18, 27, 33, 40, 50], duration_h: [6, 6, 6, 7, 8] },
    '917521136': { order: [18, 27, 33, 40, 50], duration_h: [6, 6, 6, 7, 8] },
    '917521139': { order: [18, 27, 33, 40, 50], duration_h: [6, 6, 6, 7, 8] },
  };
  private gsValList(v: unknown, n = 5, vtype: 'int' | 'float' = 'int'): number[] {
    const out: number[] = [];
    for (const x of Array.isArray(v) ? (v as unknown[]) : []) {
      const num = vtype === 'int' ? parseInt(String(x), 10) : parseFloat(String(x));
      out.push(isNaN(num) ? 0 : num);
      if (out.length >= n) break;
    }
    while (out.length < n) out.push(0);
    return out;
  }
  private gsDefaults(): Record<string, { order: number[]; duration_h: number[] }> {
    const out: Record<string, { order: number[]; duration_h: number[] }> = {};
    for (const [tid, v] of Object.entries(this.GS_DEFAULT_BY_TEAM)) {
      out[tid] = { order: [...v.order], duration_h: [...v.duration_h] };
    }
    return out;
  }
  private gsRead(): { schema_version: number; updated_at?: string; months?: Record<string, any> } {
    const d = this.readJson(this.stdPath('grade_standards.json'));
    if (!d || typeof d !== 'object') return { schema_version: 1, updated_at: nowIso(), months: {} };
    return { schema_version: d.schema_version || 1, updated_at: d.updated_at, months: d.months || {} };
  }
  private gsNormPct(v: unknown, cap = 200): number | null {
    if (v === null || v === undefined || v === '') return null;
    const f = parseFloat(String(v));
    if (isNaN(f) || f < 0 || f > cap) return null;
    return f;
  }
  private gsMergeTeam(cfg: any, dflt: { order: number[]; duration_h: number[] }) {
    const c = cfg || {};
    return {
      order: this.gsValList(c.order || dflt.order, 5, 'int'),
      duration_h: this.gsValList(c.duration_h || dflt.duration_h, 5, 'float'),
      enabled: c.enabled !== false,
      threshold_pct: this.gsNormPct(c.threshold_pct),
      cap_pct: this.gsNormPct(c.cap_pct),
    };
  }
  private gsGetAll(month: string) {
    month = month || currentMonth();
    const data = this.gsRead();
    const months = data.months || {};
    const configured = months[month] || {};
    const dflt = this.gsDefaults();
    const merged: Record<string, any> = {};
    for (const [tid, d] of Object.entries(dflt)) {
      merged[tid] = this.gsMergeTeam(configured[tid], d);
    }
    for (const [tid, cfg] of Object.entries(configured as Record<string, any>)) {
      if (!(tid in merged)) {
        merged[tid] = this.gsMergeTeam(cfg, this.GS_DEFAULT_BY_TEAM[tid] || { order: [0, 0, 0, 0, 0], duration_h: [0, 0, 0, 0, 0] });
      }
    }
    const configuredIds = Object.keys(configured);
    // 参与考核：有配置记录则该月取 enabled≠false 的站点；
    // 月份记录存在但已清空（用户移除全部）→ 返回空（由前端提示无参与站，不再回落默认三站）；
    // 仅当该月从未配置过（无月份记录）才回落默认三站，保证首运行看板非空。
    const participating = configuredIds.length
      ? configuredIds.filter((t) => (configured[t]?.enabled) !== false)
      : (month in months ? [] : Object.keys(dflt));
    return {
      month,
      schema_version: data.schema_version || 1,
      updated_at: data.updated_at,
      configured_ids: configuredIds,
      participating,
      teams: merged,
      defaults: dflt,
    };
  }
  private gsGet(tid: string, month: string) {
    const all = this.gsGetAll(month);
    const rec = all.teams[tid];
    if (rec) {
      return {
        team_id: tid, month: all.month,
        order: rec.order, duration_h: rec.duration_h,
        enabled: rec.enabled,
        threshold_pct: rec.threshold_pct, cap_pct: rec.cap_pct,
      };
    }
    const d = this.GS_DEFAULT_BY_TEAM[tid] || Object.values(this.GS_DEFAULT_BY_TEAM)[0];
    return {
      team_id: tid, month: all.month,
      order: [...d.order], duration_h: [...d.duration_h],
      enabled: true, threshold_pct: null, cap_pct: null,
    };
  }
  private gsBuildLevels(tid: string, month: string) {
    const rec = this.gsGet(tid, month);
    const orders = rec.order;
    const dursH = rec.duration_h;
    const levels = [{ level: 0, name: '未定级', min_valid_orders: 0, min_valid_minutes: 0 }];
    for (let i = 0; i < 5; i++) {
      levels.push({
        level: i + 1,
        name: `标准${i + 1}`,
        min_valid_orders: parseInt(String(orders[i] || 0), 10),
        min_valid_minutes: parseFloat(String(dursH[i] || 0)) * 60,
      });
    }
    return levels;
  }
  private gsSave(tid: string, mo: string, order: unknown, durH: unknown,
                 opts?: { enabled?: boolean; threshold_pct?: unknown; cap_pct?: unknown }) {
    tid = String(tid).trim();
    mo = String(mo).trim();
    if (!tid || !mo) throw new Error('team_id 与 month 不能为空');
    if (mo.length !== 7 || mo[4] !== '-') throw new Error('month 须为 YYYY-MM 格式');
    let o = this.gsValList(order, 5, 'int');
    let d = this.gsValList(durH, 5, 'float');
    o = o.map((x) => Math.max(0, x));
    d = d.map((x) => Math.max(0, Math.min(24, x)));
    const enabled = opts?.enabled !== false;
    const threshold_pct = this.gsNormPct(opts?.threshold_pct);
    const cap_pct = this.gsNormPct(opts?.cap_pct);
    const data = this.gsRead();
    data.months = data.months || {};
    data.months[mo] = data.months[mo] || {};
    data.months[mo][tid] = { order: o, duration_h: d, enabled, threshold_pct, cap_pct };
    data.updated_at = nowIso();
    this.atomicWrite(this.stdPath('grade_standards.json'), data);
    return { team_id: tid, month: mo, order: o, duration_h: d, enabled, threshold_pct, cap_pct };
  }
  private gsDelete(tid: string, mo: string) {
    tid = String(tid).trim();
    mo = String(mo).trim();
    if (!tid || !mo) throw new Error('team_id 与 month 不能为空');
    if (mo.length !== 7 || mo[4] !== '-') throw new Error('month 须为 YYYY-MM 格式');
    const data = this.gsRead();
    const months = data.months || {};
    const m = months[mo] || {};
    const existed = tid in m;
    if (existed) {
      delete m[tid];
      months[mo] = m;
      data.updated_at = nowIso();
      this.atomicWrite(this.stdPath('grade_standards.json'), data);
    }
    return { team_id: tid, month: mo, existed };
  }

  // =============================================================== threshold_config
  private tcRead(): { schema_version: number; months?: Record<string, any> } {
    const d = this.readJson(this.stdPath('threshold_config.json'));
    if (!d || typeof d !== 'object' || !d.months || typeof d.months !== 'object') {
      return { schema_version: 2, months: {} };
    }
    return d;
  }
  private tcNormThreshold(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const f = parseFloat(String(v));
    if (isNaN(f)) throw new Error('门槛值须为数字');
    if (f < 0 || f > 100) throw new Error('门槛值须在 0~100 之间');
    return f;
  }
  private tcNormCap(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const f = parseFloat(String(v));
    if (isNaN(f)) throw new Error('封顶值须为数字');
    if (f < 0) throw new Error('封顶值不能为负数');
    return f;
  }
  private tcGet(month?: string) {
    month = month || currentMonth();
    const m = (this.tcRead().months || {})[month] || {};
    return {
      month,
      threshold_pct: m.threshold_pct ?? null,
      cap_pct: m.cap_pct ?? null,
      updated_at: m.updated_at ?? null,
    };
  }
  private tcSave(thresholdPct: unknown, capPct: unknown, month?: string) {
    month = month || currentMonth();
    const t = this.tcNormThreshold(thresholdPct);
    const c = this.tcNormCap(capPct);
    const data = this.tcRead();
    data.months = data.months || {};
    data.months[month] = { threshold_pct: t, cap_pct: c, updated_at: nowIso() };
    data.schema_version = 2;
    this.atomicWrite(this.stdPath('threshold_config.json'), data);
    const updatedAt = (data.months[month] as any).updated_at;
    return { month, threshold_pct: t, cap_pct: c, updated_at: updatedAt };
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
    if (!ids) return [...DEFAULT_TEAMS];
    const out = ids.map((x: unknown) => String(x).trim()).filter((x: string) => x);
    return out.length ? out : [...DEFAULT_TEAMS];
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

  // ==================================================================== realtime
  private rtLoadSel(): Record<string, string[]> {
    return this.readJson(this.realtimePath('.realtime_selection.json')) || {};
  }
  private rtSaveSel(obj: unknown): void {
    this.atomicWrite(this.realtimePath('.realtime_selection.json'), obj);
  }
  private rtLoadTargets(): any {
    const obj = this.readJson(this.realtimePath('.realtime_targets.json'));
    if (obj && typeof obj === 'object' && Array.isArray(obj.rows) && obj.rows.length) return obj;
    const seed = this.rtSeedTargets();
    this.rtSaveTargets(seed);
    return seed;
  }
  private rtSaveTargets(obj: unknown): void {
    this.atomicWrite(this.realtimePath('.realtime_targets.json'), obj);
  }
  private rtSeedTargets() {
    const posDef = { t0: 90.0, t60: 95.0, t100: 99.0 };
    const negPct = { t0: 5.0, t60: 3.0, t100: 1.0 };
    const negMin = { t0: 30.0, t60: 15.0, t100: 5.0 };
    const rows: any[] = [];
    for (const dt of RT_DATE_TYPES) {
      for (const wx of RT_WEATHER) {
        for (const m of RT_METRICS) {
          let th: { t0: number; t60: number; t100: number };
          if (m.direction === 'pos') th = { ...posDef };
          else if (m.unit === '%') th = { ...negPct };
          else th = { ...negMin };
          rows.push({
            date_type: dt.key,
            weather: wx.key,
            metric: m.key,
            direction: m.direction,
            t0: th.t0,
            t60: th.t60,
            t100: th.t100,
            weight: RT_DEFAULT_WEIGHT[m.key],
          });
        }
      }
    }
    return { version: 1, updated_at: '', updated_by: '', rows };
  }
  private rtValidate(rows: any[]): string[] {
    const errors: string[] = [];
    const seen = new Set<string>();
    const perDtMetric: Record<string, number> = {};
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r || typeof r !== 'object') {
        errors.push(`第 ${i + 1} 行不是有效对象`);
        continue;
      }
      const dt = r.date_type;
      const wx = r.weather;
      const mk = r.metric;
      if (!RT_DT_KEYS.has(dt)) {
        errors.push(`第 ${i + 1} 行：未知日期类型 ${JSON.stringify(dt)}`);
        continue;
      }
      if (!RT_WX_KEYS.has(wx)) {
        errors.push(`第 ${i + 1} 行：未知天气等级 ${JSON.stringify(wx)}`);
        continue;
      }
      if (!RT_METRIC_KEYS.has(mk)) {
        errors.push(`第 ${i + 1} 行：未知指标 ${JSON.stringify(mk)}`);
        continue;
      }
      const key = `${dt}|${wx}|${mk}`;
      if (seen.has(key)) {
        errors.push(`重复配置：${dt}/${wx}/${mk}`);
        continue;
      }
      seen.add(key);
      const direction = RT_METRIC_DIR.get(mk);
      const t0 = parseFloat(r.t0);
      const t60 = parseFloat(r.t60);
      const t100 = parseFloat(r.t100);
      if ([t0, t60, t100].some(isNaN)) {
        errors.push(`${dt}/${wx}/${mk}：阈值必须为数字`);
        continue;
      }
      const w = parseFloat(r.weight);
      if (isNaN(w)) {
        errors.push(`${dt}/${wx}/${mk}：权重必须为数字`);
        continue;
      }
      if (w < 0) errors.push(`${dt}/${wx}/${mk}：权重不能为负`);
      if (direction === 'pos') {
        if (!(t0 < t60 && t60 < t100)) {
          errors.push(`${dt}/${wx}/${mk}：正向指标需 0分<60分<100分阈值`);
        }
      } else {
        if (!(t0 > t60 && t60 > t100)) {
          errors.push(`${dt}/${wx}/${mk}：负向指标需 0分>60分>100分阈值`);
        }
      }
      perDtMetric[`${dt}|${mk}`] = w;
    }
    const expect = RT_DT_KEYS.size * RT_WX_KEYS.size * RT_METRIC_KEYS.size;
    if (seen.size !== expect) {
      errors.push(`配置行数不完整（应为 ${expect} 行，实得 ${seen.size} 行）`);
    }
    for (const dt of RT_DT_KEYS) {
      let tot = 0;
      for (const k of Object.keys(perDtMetric)) {
        if (k.startsWith(`${dt}|`)) tot += perDtMetric[k];
      }
      if (Math.abs(tot - 100) > 0.1) {
        errors.push(`日期类型 ${dt} 权重合计 ${tot.toFixed(1)}%，应为 100%`);
      }
    }
    return errors;
  }

  // ===================================================================== 对外分发
  /** 是否为「配置端点」（应归 Nest 处理，而非转发 Python）。 */
  isConfigPath(urlPath: string): boolean {
    return [
      '/api/standard/teams-config',
      '/api/standard/grade-standards',
      '/api/standard/thresholds',
      '/api/attend-period/config',
      '/api/attend-period/teams',
      '/api/realtime/selection',
      '/api/realtime/targets',
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
      case '/api/standard/teams-config':
        return method === 'GET' ? this.teamsConfigGet() : this.teamsConfigPost(body);
      case '/api/standard/grade-standards':
        return method === 'GET'
          ? this.gradeStandardsGet(q('month'), q('team'))
          : this.gradeStandardsPost(body);
      case '/api/standard/thresholds':
        return method === 'GET' ? this.thresholdsGet(q('month')) : this.thresholdsPost(body);
      case '/api/attend-period/config':
        return method === 'GET' ? this.periodConfigGet(q('month')) : this.periodConfigPost(body);
      case '/api/attend-period/teams':
        return method === 'GET' ? this.apTeamsGet(allowed) : this.apTeamsPost(body);
      case '/api/realtime/selection':
        return method === 'GET'
          ? this.realtimeSelectionGet(user, allowed)
          : this.realtimeSelectionPost(user, allowed, body);
      case '/api/realtime/targets':
        return method === 'GET' ? this.realtimeTargetsGet() : this.realtimeTargetsPost(user, body);
      default:
        return { ok: false, error: '未知配置端点' };
    }
  }

  // -------------------------------------------------------------- 各端点实现
  async teamsConfigGet(): Promise<unknown> {
    const all = await this.allTeamRefs();
    return { ok: true, teams: this.tcGetTeams(), default: [...DEFAULT_TEAMS], all };
  }
  teamsConfigPost(body: any): unknown {
    const r = this.tcSetTeams(body && body.teams);
    return { ok: r.ok, teams: r.teams, error: r.error };
  }

  async gradeStandardsGet(month?: string, teamOnly?: string): Promise<unknown> {
    if (teamOnly) {
      const rec = this.gsGet(teamOnly, month || '');
      return {
        ok: true,
        record: rec,
        month: rec.month,
        team_id: rec.team_id,
        thresholds: this.gsBuildLevels(teamOnly, month || '').slice(1, 6),
      };
    }
    return { ok: true, ...this.gsGetAll(month || '') };
  }
  async gradeStandardsPost(body: any): Promise<unknown> {
    const tid = String(body && body.team_id != null ? body.team_id : '').trim();
    const mo = String(body && body.month != null ? body.month : '').trim();
    const action = String((body && body.action) != null ? body.action : 'save').trim();
    if (!tid || !mo) return { ok: false, error: 'team_id 与 month 都必填' };
    try {
      if (action === 'delete') {
        const deleted = this.gsDelete(tid, mo);
        await this.rawCache.invalidateAll();
        return { ok: true, deleted };
      }
      const order = body && body.order;
      const durH = body && (body.duration_h !== undefined ? body.duration_h : body.duration);
      if (!Array.isArray(order) || order.length !== 5) {
        return { ok: false, error: 'order 须是长度为 5 的数组' };
      }
      if (!Array.isArray(durH) || durH.length !== 5) {
        return { ok: false, error: 'duration_h 须是长度为 5 的数组' };
      }
      const saved = this.gsSave(tid, mo, order, durH, {
        enabled: body.enabled,
        threshold_pct: body.threshold_pct,
        cap_pct: body.cap_pct,
      });
      await this.rawCache.invalidateAll();
      return { ok: true, saved };
    } catch (e) {
      return { ok: false, error: `${(e as Error).name}: ${(e as Error).message}` };
    }
  }

  thresholdsGet(month?: string): unknown {
    return { ok: true, ...this.tcGet(month) };
  }
  async thresholdsPost(body: any): Promise<unknown> {
    try {
      const saved = this.tcSave(body && body.threshold_pct, body && body.cap_pct, body && body.month);
      await this.rawCache.invalidateAll();
      return { ok: true, ...saved };
    } catch (e) {
      return { ok: false, error: `${(e as Error).name}: ${(e as Error).message}` };
    }
  }

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

  realtimeSelectionGet(user: string, allowed: Allowed): unknown {
    const obj = this.rtLoadSel();
    const sel = filterIds(obj[user] || [], allowed);
    return { ok: true, teams: sel };
  }
  realtimeSelectionPost(user: string, allowed: Allowed, body: any): unknown {
    const incoming: unknown[] = Array.isArray(body && body.teams) ? body.teams : [];
    const clean: string[] = [];
    const seen = new Set<string>();
    for (const t of incoming) {
      const s = String(t).trim();
      if (!s || seen.has(s)) continue;
      if (allowed !== null && !allowed.has(s)) continue; // 越权站点不落库（纵深防御）
      seen.add(s);
      clean.push(s);
    }
    const obj = this.rtLoadSel();
    obj[user] = clean;
    this.rtSaveSel(obj);
    return { ok: true, teams: clean };
  }

  realtimeTargetsGet(): unknown {
    const obj = this.rtLoadTargets();
    return {
      ok: true,
      metrics: RT_METRICS,
      date_types: RT_DATE_TYPES,
      weather: RT_WEATHER,
      rows: obj.rows,
      updated_at: obj.updated_at || '',
      updated_by: obj.updated_by || '',
    };
  }
  async realtimeTargetsPost(user: string, body: any): Promise<unknown> {
    const rows = Array.isArray(body && body.rows) ? body.rows : null;
    if (!Array.isArray(rows)) return { ok: false, error: 'rows 必须为数组' };
    const errors = this.rtValidate(rows);
    if (errors.length) return { ok: false, errors };
    const obj = { version: 1, updated_at: nowStamp(), updated_by: user, rows };
    this.rtSaveTargets(obj);
    return { ok: true, updated_at: obj.updated_at, updated_by: obj.updated_by };
  }
}
