import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { OperationLogService } from './operation-log.service';

/**
 * 全局操作日志中间件（替代原先的 APP_INTERCEPTOR 实现）。
 *
 * 为什么从「全局拦截器」改成「中间件」：
 * 全局 APP_INTERCEPTOR 会包裹每个路由处理结果 observable，而 @Sse（Server-Sent-Events）
 * 端点返回的是长连接流——拦截器一旦介入，哪怕只是透传（return next.handle()），也会破坏
 * SSE 流的投递（实测：透传仍秒断 → 浏览器「重连中」）。中间件运行在 Express 层、只监听
 * res 的 finish 事件做审计，绝不会触碰响应流本身，因此对 SSE 完全无影响。
 *
 * - actor：取自 AccessGuard 在请求生命周期内挂到 req.actor 的解析结果（finish 时守卫已执行完）。
 * - 仅记录 /api 下的接口；跳过 OPTIONS 预检与 SSE 长连接（EventSource 固定带
 *   Accept: text/event-stream，据此跳过，既不审计也不包裹响应流）。
 */
@Injectable()
export class OperationLogMiddleware implements NestMiddleware {
  constructor(private readonly log: OperationLogService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const url = ((req.originalUrl || req.url || '') as string).split('?')[0];
    const method = (req.method || 'GET').toUpperCase();
    if (!url.startsWith('/api')) return next();
    if (method === 'OPTIONS') return next();
    // SSE 长连接：浏览器 EventSource 固定带 Accept: text/event-stream，跳过审计
    if (req.headers.accept === 'text/event-stream') return next();

    const start = Date.now();
    res.on('finish', () => {
      const actor = (req as unknown as { actor?: string }).actor ?? 'anonymous';
      const detail: Record<string, unknown> = { query: req.query };
      if (method !== 'GET') {
        try {
          const body = JSON.stringify(req.body);
          detail.body = body.length > 2000 ? body.slice(0, 2000) + '…(truncated)' : body;
        } catch {
          detail.body = '[unserializable]';
        }
      }
      void this.log.record({
        actor,
        method,
        action: `${method} ${url}`,
        target: url,
        code: (req as unknown as { route?: { path?: string } }).route?.path ?? 'HTTP',
        status: res.statusCode,
        durationMs: Date.now() - start,
        detail,
      });
    });
    next();
  }
}
