import { Request } from 'express';

/** 从 Cookie 头解析指定名称的值（与后端 Set-Cookie 对称）。 */
export function getCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      const v = part.slice(idx + 1).trim();
      try { return decodeURIComponent(v); } catch { return v; }
    }
  }
  return undefined;
}

/**
 * 统一抽取「会话令牌」，优先级：
 *   1) HttpOnly Cookie(wb_token) —— 浏览器同源自动携带，XSS 不可读（主力路径）
 *   2) X-Token 头            —— 保留兼容内部服务 / 旧调用
 *   3) ?token= 查询          —— EventSource / iframe / 内部服务
 *   4) Authorization: Bearer —— 标准 Bearer
 * 任一命中即可，确保前端切到 Cookie 后后端会话鉴权全链路一致。
 */
export function extractToken(req: Request): string | undefined {
  const ck = getCookie(req, 'wb_token');
  if (ck) return ck;
  const xt = req.headers['x-token'] as string | undefined;
  if (xt) return xt;
  const q = (req.query as Record<string, unknown>)['token'];
  if (typeof q === 'string') return q;
  const auth = req.headers['authorization'] as string | undefined;
  if (auth) {
    const bearer = auth.replace(/^Bearer\s+/i, '');
    if (bearer) return bearer;
  }
  return undefined;
}
