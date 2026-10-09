import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 数据权限（行级隔离）服务（端口自 core/dataperm.py，配合 AuthService 的 RBAC）。
 *
 * 背景：报表天然以「站点 / team」为隔离边界。本服务以 team 为隔离键，规则表达为
 * 「某用户可访问哪些站点」。组织层级：业务线(business_line) -> 城市(city) -> 站点(team)。
 *
 * 与 RBAC 的关系（纵深防御）：
 *  · RBAC 管「能不能看报表」（功能权限：view / file:read ...）
 *  · 本服务管「能看哪些站点的数据」（数据权限）
 *  两者正交——即使拥有 view 权限，可见站点仍受本服务约束。
 *
 * 调用方（ProxyController）在委托 Python 计算前，调用 resolveAllowed 计算可见范围，
 * 经请求头 x-scope 下发，做到「数据权限在 NestJS 侧执行，再委托 Python 计算」。
 */

export type Scope = 'all' | 'teams' | 'cities' | 'business_lines';

export interface DataRule {
  scope: Scope;
  teams: string[];
  cities: string[];
  business_lines: string[];
  inherit_new: boolean;
}

export interface OrgTree {
  cities: Record<string, unknown>;
  business_lines: Record<string, unknown>;
  default_new_site: 'include' | 'exclude';
}

export const DEFAULT_SCOPE: Scope = 'all';

@Injectable()
export class DataPermService implements OnModuleInit {
  private readonly logger = new Logger(DataPermService.name);
  private orgFile = '';
  private dataPermsFile = '';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const root = this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..');
    const dataDir = path.join(process.cwd(), 'data');
    this.orgFile = path.join(dataDir, 'org_tree.json');
    this.dataPermsFile = path.join(dataDir, '.data_perms.json');
  }

  // ---------------- 组织树 ----------------
  private loadOrg(): OrgTree {
    try {
      const obj = JSON.parse(fs.readFileSync(this.orgFile, 'utf-8'));
      if (!obj || typeof obj !== 'object') return { cities: {}, business_lines: {}, default_new_site: 'exclude' };
      obj.cities = obj.cities || {};
      obj.business_lines = obj.business_lines || {};
      obj.default_new_site = obj.default_new_site || 'exclude';
      return obj;
    } catch {
      return { cities: {}, business_lines: {}, default_new_site: 'exclude' };
    }
  }
  private saveOrg(obj: OrgTree): void {
    const tmp = this.orgFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tmp, this.orgFile);
  }

  cities(): string[] {
    return Object.keys(this.loadOrg().cities).sort();
  }
  businessLines(): string[] {
    return Object.keys(this.loadOrg().business_lines).sort();
  }
  getDefaultNewSite(): 'include' | 'exclude' {
    return this.loadOrg().default_new_site;
  }
  private cityTeams(info: unknown): string[] {
    if (info && typeof info === 'object') {
      const t = (info as Record<string, unknown>).teams;
      if (Array.isArray(t)) return t.map((x) => String(x).trim()).filter(Boolean);
    }
    if (Array.isArray(info)) return (info as unknown[]).map((x) => String(x).trim()).filter(Boolean);
    return [];
  }
  teamsOfCity(city: string): Set<string> {
    return new Set(this.cityTeams(this.loadOrg().cities[city]));
  }
  allTeams(): Set<string> {
    const s = new Set<string>();
    const org = this.loadOrg();
    for (const info of Object.values(org.cities)) for (const t of this.cityTeams(info)) s.add(t);
    return s;
  }
  /** 组织树原样：{城市: [站点id...]}（与 core/dataperm.py 的 load_org()["cities"] 同结构）。
   *  前端「组织/业务线/城市」编辑器直接按这个形状读（admin.js 的 _dataPerms.org）。 */
  orgCities(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    const org = this.loadOrg();
    for (const [c, info] of Object.entries(org.cities)) out[c] = this.cityTeams(info);
    return out;
  }
  /** {城市: 业务线}；未归入任何业务线的城市不出现在结果里（与前端 bl_of_city 一致）。 */
  blOfCity(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const c of this.cities()) {
      const bl = this.businessLineOf(c);
      if (bl) out[c] = bl;
    }
    return out;
  }
  cityOf(team: string): string | null {
    const t = String(team);
    for (const [c, info] of Object.entries(this.loadOrg().cities)) {
      if (this.cityTeams(info).includes(t)) return c;
    }
    return null;
  }
  private blCities(info: unknown): string[] {
    if (info && typeof info === 'object') {
      const c = (info as Record<string, unknown>).cities;
      if (Array.isArray(c)) return c.map((x) => String(x).trim()).filter(Boolean);
    }
    if (Array.isArray(info)) return (info as unknown[]).map((x) => String(x).trim()).filter(Boolean);
    return [];
  }
  citiesOfBusinessLine(bl: string): Set<string> {
    return new Set(this.blCities(this.loadOrg().business_lines[bl]));
  }
  businessLineOf(city: string): string | null {
    const c = String(city);
    for (const [bl, info] of Object.entries(this.loadOrg().business_lines)) {
      if (this.blCities(info).includes(c)) return bl;
    }
    return null;
  }
  teamsOfBusinessLine(bl: string): Set<string> {
    const s = new Set<string>();
    for (const c of this.citiesOfBusinessLine(bl)) for (const t of this.teamsOfCity(c)) s.add(t);
    return s;
  }
  businessLineOfTeam(team: string): string | null {
    const c = this.cityOf(team);
    return c ? this.businessLineOf(c) : null;
  }

  setOrg(citiesMap: Record<string, string[]>, defaultNewSite?: string, businessLinesMap?: Record<string, string[]>): void {
    const normCities: Record<string, string[]> = {};
    for (const [c, ts] of Object.entries(citiesMap || {})) {
      const cc = String(c).trim();
      if (!cc) continue;
      normCities[cc] = (ts || []).map((x) => String(x).trim()).filter(Boolean);
    }
    const normBl: Record<string, string[]> = {};
    for (const [bl, cs] of Object.entries(businessLinesMap || {})) {
      const b = String(bl).trim();
      if (!b) continue;
      normBl[b] = (cs || []).map((x) => String(x).trim()).filter(Boolean);
    }
    const obj = this.loadOrg();
    obj.cities = normCities;
    obj.business_lines = normBl;
    if (defaultNewSite === 'include' || defaultNewSite === 'exclude') obj.default_new_site = defaultNewSite as 'include' | 'exclude';
    this.saveOrg(obj);
  }

  // ---------------- 规则 ----------------
  private loadRules(): Record<string, DataRule> {
    try {
      const obj = JSON.parse(fs.readFileSync(this.dataPermsFile, 'utf-8'));
      if (!obj || typeof obj !== 'object' || !obj.rules || typeof obj.rules !== 'object') {
        return {};
      }
      return obj.rules as Record<string, DataRule>;
    } catch {
      return {};
    }
  }
  private saveRules(rules: Record<string, DataRule>): void {
    const tmp = this.dataPermsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, rules }, null, 2), 'utf-8');
    fs.renameSync(tmp, this.dataPermsFile);
    try {
      fs.chmodSync(this.dataPermsFile, 0o600);
    } catch {
      /* ignore */
    }
  }

  getRule(username: string): DataRule {
    const r = this.loadRules()[username];
    if (!r) {
      return { scope: DEFAULT_SCOPE, teams: [], cities: [], business_lines: [], inherit_new: false };
    }
    return {
      scope: (r.scope as Scope) || DEFAULT_SCOPE,
      teams: r.teams || [],
      cities: r.cities || [],
      business_lines: r.business_lines || [],
      inherit_new: !!r.inherit_new,
    };
  }
  listRules(): Record<string, DataRule> {
    return this.loadRules();
  }

  setRule(
    username: string,
    scope: Scope,
    opts: { teams?: string[]; cities?: string[]; business_lines?: string[]; inherit_new?: boolean } = {},
  ): void {
    if (!['all', 'teams', 'cities', 'business_lines'].includes(scope)) {
      throw new Error('scope 只能是 all / teams / cities / business_lines');
    }
    const business_lines = (opts.business_lines || []).map((b) => String(b).trim()).filter(Boolean);
    const cities = (opts.cities || []).map((c) => String(c).trim()).filter(Boolean);
    const teams = (opts.teams || []).map((t) => String(t).trim()).filter(Boolean);
    const base: DataRule = {
      scope: 'all',
      teams: [],
      cities: [],
      business_lines: [],
      inherit_new: !!opts.inherit_new,
    };
    const rules = this.loadRules();
    if (scope === 'all') {
      rules[username] = { ...base };
    } else if (scope === 'business_lines') {
      if (!business_lines.length) throw new Error('scope=business_lines 时至少选择一个业务线');
      rules[username] = { ...base, scope, business_lines };
    } else if (scope === 'cities') {
      if (!cities.length) throw new Error('scope=cities 时至少选择一个城市');
      rules[username] = { ...base, scope, cities };
    } else {
      if (!teams.length) throw new Error('scope=teams 时至少选择一个站点');
      rules[username] = { ...base, scope, teams };
    }
    this.saveRules(rules);
  }
  deleteRule(username: string): void {
    const rules = this.loadRules();
    if (rules[username]) {
      delete rules[username];
      this.saveRules(rules);
    }
  }

  // ---------------- 解析可见范围 ----------------
  /** 返回被允许的取值集合；null 表示不限制（看全部）。 */
  resolveAllowed(username: string, role: string, dimension: 'team' | 'business_line' = 'team'): Set<string> | null {
    if (dimension === 'business_line') return this.resolveBusinessLines(username, role);
    if (role === 'admin') return null;
    const rule = this.loadRules()[username];
    if (!rule || rule.scope === 'all') return null;
    const ids = new Set<string>();
    for (const bl of rule.business_lines) for (const t of this.teamsOfBusinessLine(bl)) ids.add(t);
    for (const c of rule.cities) for (const t of this.teamsOfCity(c)) ids.add(t);
    for (const t of rule.teams) ids.add(String(t));
    if (rule.inherit_new) {
      for (const c of rule.cities) {
        const bl = this.businessLineOf(c);
        if (bl) for (const t of this.teamsOfBusinessLine(bl)) ids.add(t);
      }
      for (const t of rule.teams) {
        const c = this.cityOf(t);
        if (c) for (const x of this.teamsOfCity(c)) ids.add(x);
      }
    }
    return ids;
  }
  private resolveBusinessLines(username: string, role: string): Set<string> | null {
    if (role === 'admin') return null;
    const rule = this.loadRules()[username];
    if (!rule || rule.scope === 'all') return null;
    const ids = new Set<string>();
    for (const bl of rule.business_lines) ids.add(bl);
    for (const c of rule.cities) {
      const bl = this.businessLineOf(c);
      if (bl) ids.add(bl);
    }
    for (const t of rule.teams) {
      const bl = this.businessLineOfTeam(t);
      if (bl) ids.add(bl);
    }
    if (rule.inherit_new) {
      for (const c of rule.cities) {
        const bl = this.businessLineOf(c);
        if (bl) ids.add(bl);
      }
      for (const t of rule.teams) {
        const c = this.cityOf(t);
        const bl = c ? this.businessLineOf(c) : null;
        if (bl) ids.add(bl);
      }
    }
    return ids;
  }

  /** 单点判定：team 是否在可见范围内。 */
  inScope(username: string, role: string, teamId: string): boolean {
    const ids = this.resolveAllowed(username, role, 'team');
    if (ids === null) return true;
    return ids.has(String(teamId));
  }

  /** 过滤 teams：[id,...] 或 [(id,name),...]，返回可见子集。 */
  filterTeams<T>(username: string, role: string, teams: T[]): T[] {
    const ids = this.resolveAllowed(username, role, 'team');
    if (ids === null) return [...teams];
    return teams.filter((t) => ids.has(String(Array.isArray(t) ? (t as unknown[])[0] : t)));
  }
}
