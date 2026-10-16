import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { DataPermService } from '../auth/data-perm.service';
import { TeamRef, TeamsFetchService } from '../../../fetch/sources/teams-fetch.service';
import { extractToken } from '../../common/token.util';

/**
 * `GET /api/teams` —— 全部站点目录（前端站点选择器用）。
 *
 * 迁移说明：本端点原先由 NestJS 代理到 Python（`compute_service/handlers._fetch_all_teams`），
 * 现已原生化：取数在 `TeamsFetchService`（5 分钟缓存 + 兜底三站），本控制器只做
 * **数据权限过滤**后才下发。
 *
 * ⚠️ 两个必须保留的约束：
 *  1) **绝不可就地修改** `TeamsFetchService` 返回的缓存对象 —— 一次受限用户的请求会把共享
 *     缓存永久截断，之后连管理员也只能看到那个用户的站点（缓存投毒 / 可见性错乱）。
 *     故一律 `filter` 出**新数组**再返回。
 *  2) 作用域口径与 `ProxyController.scopeHeaders` 保持一致：**无会话（系统/iframe 持机器令牌）
 *     = 不受限**；有会话才按 `resolveAllowed(user, role, 'team')` 过滤。
 */
@Controller('api')
export class TeamsController {
  constructor(
    private readonly teams: TeamsFetchService,
    private readonly auth: AuthService,
    private readonly dataPerm: DataPermService,
  ) {}

  @Get('teams')
  async list(@Req() req: Request) {
    const payload = await this.teams.fetchAll();
    const allowed = this.allowedIds(req);
    if (!allowed) return payload; // null = 不受限，原样下发
    const keep = (arr?: TeamRef[]) => (arr || []).filter((t) => allowed.has(String(t.id)));
    return {
      ...payload,
      teams: keep(payload.teams),
      ...(payload.fallback ? { fallback: keep(payload.fallback) } : {}),
    };
  }

  /** 本次请求可见的站点 id 集合；null 表示不受限（与 ProxyController 的 x-scope='*' 同口径）。 */
  private allowedIds(req: Request): Set<string> | null {
    const t = extractToken(req);
    const s = this.auth.getSession(t);
    if (!s) return null; // 系统 / iframe（已过机器令牌闸门）→ 不受限
    const ids = this.dataPerm.resolveAllowed(s.user, s.role, 'team');
    return ids === null ? null : new Set([...ids].map(String));
  }
}
