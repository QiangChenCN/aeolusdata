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

    const message =
      exception instanceof HttpException
        ? exception.message
        : 'Internal server error';

    response.status(status).json({
      code: status,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
