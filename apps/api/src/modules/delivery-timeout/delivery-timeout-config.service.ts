import { Injectable, Logger } from '@nestjs/common';
import { TeamsFetchService, TeamRef, readKnownTeams } from '../../infra/fetch/sources/teams-fetch.service';
import { ConfigService } from '../config/config.service';

/** 可见站点集合：`null` 表示不受限（x-scope=*），否则为 id 集合。 */
type Allowed = Set<string> | null;

function filterIds(ids: string[], allowed: Allowed): string[] {
  if (allowed === null) return ids;
  return ids.filter((i) => allowed.has(String(i)));
}

/** 先看板自有配置目录（2026-10-21 从共享的 dashboard/standard 迁出）。 */
const BOARD_TEAMS_FILE = 'services/compute/dashboard/delivery-timeout/teams.json';
/** 迁移前路径：仅保留「兼容读」（见 readTeamsFile），不再写入。 */
const LEGACY_TEAMS_FILE = 'services/compute/dashboard/standard/delivery_timeout_teams.json';

/**
 * 配送超时看板「展示站点」配置（与 attend_period_teams 同构）。
 *
 * 从 ConfigService 的 assessment 命名空间迁移为独立模块后，配置文件也搬到本看板
 * 自有目录 `services/compute/dashboard/delivery-timeout/teams.json` —— 不再与其他看板共用
 * `services/compute/dashboard/standard/` 目录。仅复用 ConfigService 的通用文件存储约定，
 * 业务逻辑自管。路由由本模块的 `DeliveryTimeoutProxyController` 通配在命中
 * `isConfigPath` 时改派到此。
 */
@Injectable()
export class DeliveryTimeoutConfigService {
  private readonly logger = new Logger(DeliveryTimeoutConfigService.name);

  constructor(
    private readonly teams: TeamsFetchService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 读「展示站点」配置：自有路径优先；读不到时回退历史路径（服务器更新后旧网点里
   * 仍可能躺着用户保存的配置），读取成功即刻落到自有路径完成一次性迁移——
   * 保证「搬目录」不会让线上已保存的站点配置静默失效。
   */
  private readTeamsFile(): { teams: string[] } | null {
    const cur = this.config.readRootJson(BOARD_TEAMS_FILE);
    if (cur && Array.isArray(cur.teams)) return cur;
    const legacy = this.config.readRootJson(LEGACY_TEAMS_FILE);
    if (legacy && Array.isArray(legacy.teams)) {
      try {
        this.config.writeRootJson(BOARD_TEAMS_FILE, { teams: legacy.teams });
        this.logger.log(`展示站点配置已迁到自有目录：${BOARD_TEAMS_FILE}`);
      } catch (e) {
        this.logger.warn(`迁移写入失败（继续用旧路径内存值）：${(e as Error).message}`);
      }
      return legacy;
    }
    return null;
  }

  private getConfiguredTeams(): string[] {
    const obj = this.readTeamsFile();
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
      this.config.writeRootJson(BOARD_TEAMS_FILE, { teams: clean });
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
