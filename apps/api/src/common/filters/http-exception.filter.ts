import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { UpstreamHttpException } from '../exceptions/upstream-http.exception';

/**
 * 全局异常过滤器：归一输出 { code, message, path, timestamp }。
 * 禁止向客户端泄漏堆栈。
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Python 计算服务的响应原样透传：状态码与 body 都不做 {code,message} 归一，
    // 否则 403 + {code:"DATA_SCOPE_DENIED"} 会被压成 {code:403, message:'Http Exception'}。
    if (exception instanceof UpstreamHttpException) {
      response.status(exception.getStatus()).json(exception.upstreamBody ?? { ok: false });
      return;
    }

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // 关键修复：当 HttpException 传入「对象响应」（如频控 429、数据权限 403 的
    // { ok:false, error:'...', code:'...' }）时，Nest 会把 exception.message 默认置为
    // 字面量 'Http Exception'，真正的错误信息在那个对象里。必须读 getResponse() 提取，
    // 否则前端只会看到无意义的 'Http Exception'。
    const message = HttpExceptionFilter.realMessage(exception);

    response.status(status).json({
      code: status,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  /** 从 HttpException 中取出可读的错误文案：优先 error → message → 序列化对象。 */
  private static realMessage(exception: unknown): string {
    if (!(exception instanceof HttpException)) return 'Internal server error';
    const resp = exception.getResponse();
    if (typeof resp === 'string') return resp;
    if (resp && typeof resp === 'object') {
      const r = resp as Record<string, unknown>;
      if (typeof r.error === 'string' && r.error) return r.error;
      if (typeof r.message === 'string' && r.message && r.message !== 'Http Exception')
        return r.message;
      try {
        return JSON.stringify(r);
      } catch {
        /* ignore */
      }
    }
    return 'Http Exception';
  }
}
