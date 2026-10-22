import { Request } from 'express';
import { AuthService } from '../modules/auth/auth.service';
import { DataPermService } from '../modules/auth/data-perm.service';
import { ComputeService } from '../modules/compute/compute.service';
import { ComputeResult } from '../modules/compute/compute.port';
import { UpstreamHttpException } from './exceptions/upstream-http.exception';
import { extractToken } from './token.util';

/**
 * 「Python 生态端点转发」的无状态工具 —— 语义与 `ProxyController` 的私有方法逐字一致。
 *
 * 背景：配送超时看板把 `delivery-timeout/{*path}` 通配路由从共享的 `ProxyController`
 * 收回自己的模块（看板独立原则：改自己的转发规则不必动网关）。转发语义
 *（x-scope 下发 / 会话透传 / upstream 错误透传）必须与网关完全一致，否则会出现
 *「看板 A 能读、看板 B 403」的分叉，故抽成本工具供两边共用 ——
 * 它没有任何 DI 与状态，所以不会引入「模块循环依赖」（ProxyModule ↔ 看板模块）。
 *
 * 约定：
 *  · 鉴权与数据权限裁决在 Nest（唯一网关），本工具只负责「算好的 x-scope 下发」；
 *  · Python 计算服务只算、不鉴权（详情见 proxy.controller.ts 头部注释）。
 */

/** 当前调用者的数据可见范围 + 会话令牌（透传给 8900，供它回调 Nest 取数时用）。 */
export function forwardHeaders(
  req: Request,
  auth: AuthService,
  dataPerm: DataPermService,
): Record<string, string> {
  const t = extractToken(req);
  const s = auth.getSession(t);
  let scope = '*';
  if (s) {
    const ids = dataPerm.resolveAllowed(s.user, s.role, 'team');
    scope = ids === null ? '*' : JSON.stringify([...ids]);
  }
  const headers: Record<string, string> = { 'x-scope': scope, 'x-user': s?.user || '' };
  // 透传用户会话令牌给计算服务（8900）：8900 会用它作为 nest_client 会话令牌去 Nest
  // 取风神数据。缺省为空会导致下游 /api/fetch/* 取数被 401，表现为「看板无数据」。
  if (t) headers['x-token'] = t;
  return headers;
}

/** 已登录会话 + 可见站点集合；未登录返回 null（调用方据此返回「未登录」）。 */
export function forwardSession(
  req: Request,
  auth: AuthService,
  dataPerm: DataPermService,
): { user: string; allowed: Set<string> | null } | null {
  const t = extractToken(req);
  const s = auth.getSession(t);
  if (!s) return null;
  return { user: s.user, allowed: dataPerm.resolveAllowed(s.user, s.role, 'team') };
}

/** 转发一次请求到 Python 计算服务，并拆包（含上游状态码透传）。 */
export async function forwardToCompute(
  req: Request,
  method: 'GET' | 'POST',
  compute: ComputeService,
  auth: AuthService,
  dataPerm: DataPermService,
  body?: unknown,
): Promise<unknown> {
  const r: ComputeResult = await compute.proxy({
    endpoint: req.url,
    method,
    body,
    headers: forwardHeaders(req, auth, dataPerm),
  });
  if (!r.ok) {
    // 上游有明确状态码（403/404/500…）时原样透传，保留 body 里的 code
    //（如 DATA_SCOPE_DENIED），让前端能区分「没权限」与「出错了」。
    // 网络不可达等拿不到状态码的场景维持旧行为（200 + ok:false），
    // 避免计算服务宕机时前端到处弹错误。
    if (r.status) throw new UpstreamHttpException(r.data, r.status);
    return { ok: false, error: r.error || 'compute upstream unavailable' };
  }
  return r.data;
}
