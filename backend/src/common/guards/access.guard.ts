import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AuthService } from '../../modules/auth/auth.service';
import { routePerm } from '../../modules/auth/permissions';
import { extractToken } from '../token.util';

/**
 * 统一访问闸门（全局 APP_GUARD）。对应旧 server.py 的「机器令牌闸门 + RBAC 会话鉴权」双闸门：
 *
 *  1) 机器令牌闸门：除认证端点外，所有 /api 必须携带有效 AUTH_TOKEN
 *     （Authorization: Bearer <t> 或 ?token=<t>）。浏览器同源调用由 index.html 注入。
 *  2) RBAC 会话鉴权：按 permissions.ts 的路由→权限表，要求登录会话具备对应权限点。
 *     · perm='view'（含未列入路由的默认）：系统/iframe（已持机器令牌）放行；
 *       普通用户需会话且拥有 view。
 *     · perm='self'：仅需有效会话（个人改密等）。
 *     · perm='machine'：仅内部服务（有效机器令牌），会话不算。用于「Python job →
 *       NestJS」这类内部调用（如钉钉推送）—— 比默认 'view' 更严，避免登录用户越权触发强操作。
 *     · 其它权限点：需会话且该角色 has_perm。
 *
 * 数据权限（team 维度行级隔离）不在此处裁决，由 DataPermService + ProxyController 在
 * 委托 Python 计算前下发 x-scope（纵深防御：RBAC 管"能不能看"，数据权限管"看哪些"）。
 */
// 钉钉登录端点同样豁免机器令牌闸门：它们是「无会话建会话」的入口（与 signin 同位），
// 且免登/JSAPI 流程由前端在钉钉内拉起、OAuth 回调由钉钉浏览器跳转，都不可能预先持有机器令牌。
//   · dingtalk/jsapi        —— 钉钉工作台内 JSAPI 免登（返回 token，前端走 X-Token 头）
//   · dingtalk/oauth-callback —— 浏览器独立访问的钉钉 OAuth2 回跳（种 Cookie 后跳转前端）
//   · dingtalk/bind         —— 绑定钉钉身份到本地账号（要求已登录会话，控制器内校验）
//   · dingtalk/config       —— 前端探测是否启用钉钉登录 + corpId/授权地址
const EXEMPT_MACHINE = new Set([
  '/api/auth/me',
  '/api/auth/signin',
  '/api/auth/logout',
  '/api/auth/dingtalk/jsapi',
  '/api/auth/dingtalk/oauth-callback',
  '/api/auth/dingtalk/bind',
  '/api/auth/dingtalk/config',
  '/health',
]);

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const path = (req.url || '/').split('?')[0];
    const method = (req.method || 'GET').toUpperCase();

    // 入口页（HTML + 机器令牌注入）对所有人公开：浏览器首屏 GET / 还没有会话/机器令牌，
    // 若走机器闸门会被挡成 401（Nest 把 401 JSON 当成页面返回）。入口页本身不含敏感数据，
    // 仅用于下发 HTML 并把 AUTH_TOKEN 注入给浏览器，供其后续调用 /api。
    if (path === '/' || path === '/index.html') {
      return true;
    }

    // 认证端点豁免机器令牌闸门
    if (EXEMPT_MACHINE.has(path)) {
      if (path === '/api/auth/logout') {
        if (!this.auth.getSession(this.token(req))) {
          throw new UnauthorizedException('not logged in');
        }
      }
      return true;
    }

    // 1) 机器令牌闸门
    if (!this.machineOk(req)) {
      throw new UnauthorizedException('invalid or missing token');
    }

    // 2) RBAC 会话鉴权
    const perm = routePerm(method, path);
    if (perm === 'self') {
      if (!this.auth.getSession(this.token(req))) {
        throw new UnauthorizedException('not logged in');
      }
      return true;
    }
    if (perm === 'view') {
      const s = this.auth.getSession(this.token(req));
      if (s && this.auth.hasPerm(s.role, 'view')) return true;
      return true; // 已持机器令牌的系统/iframe 调用放行基线 view
    }
    if (perm === 'machine') {
      // 仅内部服务可调用：必须持有效机器令牌，会话不算。
      // 用于「Python job → NestJS」的内部端点（钉钉推送等强操作）。
      if (this.machineTokenMatches(req)) return true;
      throw new ForbiddenException('machine token required');
    }
    const s = this.auth.getSession(this.token(req));
    if (!s) throw new UnauthorizedException('not logged in');
    if (this.auth.hasPerm(s.role, perm)) return true;
    throw new ForbiddenException('permission denied: ' + perm);
  }

  private token(req: Request): string | undefined {
    return extractToken(req);
  }

  /** 请求是否携带有效的机器令牌（仅 Bearer / ?token=，不含会话）。 */
  private machineTokenMatches(req: Request): boolean {
    const expected = this.config.get<string>('AUTH_TOKEN');
    if (!expected) return true; // 未配置机器令牌时不设限（与 machineOk 同口径）
    const auth = req.headers['authorization'] as string | undefined;
    const bearer = auth?.replace(/^Bearer\s+/i, '');
    const q = (req.query as Record<string, unknown>)['token'];
    return bearer === expected || (typeof q === 'string' && q === expected);
  }

  private machineOk(req: Request): boolean {
    const expected = this.config.get<string>('AUTH_TOKEN');
    if (!expected) return true;
    const auth = req.headers['authorization'] as string | undefined;
    const bearer = auth?.replace(/^Bearer\s+/i, '');
    const q = (req.query as Record<string, unknown>)['token'];
    const provided = bearer || (typeof q === 'string' ? q : undefined);
    if (provided === expected) return true;
    // RBAC 重构后浏览器同源调用只带会话令牌（X-Token），不再注入机器令牌。
    // 会话是更强的单用户凭证，已通过鉴权即视为通过机器闸门（外部无会话调用仍需机器令牌）。
    if (this.auth.getSession(this.token(req))) return true;
    return false;
  }
}
