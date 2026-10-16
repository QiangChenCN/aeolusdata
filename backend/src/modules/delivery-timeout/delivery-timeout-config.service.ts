import { Injectable, Logger } from '@nestjs/common';
import { TeamsFetchService, TeamRef, readKnownTeams } from '../../../fetch/sources/teams-fetch.service';
import { ConfigService } from '../config/config.service';

/** 可见站点集合：`null` 表示不受限（x-scope=*），否则为 id 集合。 */
type Allowed = Set<string> | null;

function filterIds(ids: string[], allowed: Allowed): string[] {
  if (allowed === null) return ids;
  return ids.filter((i) => allowed.has(String(i)));
}

/**
 * 配送超时看板「展示站点」配置（与 attend_period_teams 同构）。
 *
 * 从 ConfigService 的 assessment 命名空间迁移为独立模块：仅复用 ConfigService 的
 * 通用文件存储约定（python/dashboard/standard/delivery_timeout_teams.json），
 * 业务逻辑自管，不再与考核看板配置混在一起。路由由 ProxyController 的
 * `delivery-timeout/{*path}` 通配在命中 isConfigPath 时改派到此。
 */
@Injectable()
export class DeliveryTimeoutConfigService {
  private readonly logger = new Logger(DeliveryTimeoutConfigService.name);

  constructor(
    private readonly teams: TeamsFetchService,
    private readonly config: ConfigService,
  ) {}

  private getConfiguredTeams(): string[] {
    const obj = this.config.readStdJson('delivery_timeout_teams.json');
    const ids = obj && Array.isArray(obj.teams) ? obj.teams : null;
    if (!ids) return readKnownTeams().map((t) => t.id);
    const out = ids.map((x: unknown) => String(x).trim()).filter((x: string) => x);
    return out.length ? out : readKnownTeams().map((t) => t.id);
  }

  private setConfiguredTeams(ids: unknown): { ok: boolean; teams: string[]; error: string | null } {
    if (!Array.isArray(ids) || !ids.length) {
      return { ok: false, teams: this.getConfiguredTeams(), error: '站点不能为空' };
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
      return { ok: false, teams: this.getConfiguredTeams(), error: '站点不能为空' };
    }
    try {
      this.config.writeStdJson('delivery_timeout_teams.json', { teams: clean });
      return { ok: true, teams: clean, error: null };
    } catch (e) {
      return {
        ok: false,
        teams: this.getConfiguredTeams(),
        error: `写入失败：${(e as Error).message}`,
      };
    }
  }

  /** GET /api/delivery-timeout/teams：返回已配置展示站点 + 全部可选站点（受数据权限过滤）。 */
  async getTeams(allowed: Allowed): Promise<unknown> {
    const payload = await this.teams.fetchAll();
    const list = (payload.teams && payload.teams.length ? payload.teams : payload.fallback) || [];
    const allRefs = list
      .filter((t) => allowed === null || allowed.has(String(t.id)))
      .map((t) => ({ id: String(t.id), name: String(t.name) }));
    const teams = filterIds(this.getConfiguredTeams(), allowed);
    return {
      ok: payload.ok === false ? false : true,
      teams,
      all: allRefs,
      source: payload.source,
      error: payload.error || null,
    };
  }

  /** POST /api/delivery-timeout/teams：保存展示站点。 */
  setTeams(body: any): unknown {
    const r = this.setConfiguredTeams(body && body.teams);
    return { ok: r.ok, teams: r.teams, error: r.error };
  }
}
