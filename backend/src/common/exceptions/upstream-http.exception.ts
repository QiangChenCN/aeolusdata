import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Python 计算服务上游响应的「原样透传」异常。
 *
 * 背景：代理曾把上游 4xx/5xx 一律折叠成 `{ok:false, error:'upstream responded N'}`
 * 并以 200 返回，于是「无权访问该站点数据」（403 + code:DATA_SCOPE_DENIED）被粉饰成
 * 普通业务失败，前端无法区分「没权限」与「出错了」。
 *
 * 本异常携带上游状态码与响应体，由 HttpExceptionFilter 原样输出（不做 {code,message} 归一），
 * 确保前端拿到的状态码与 body 与 Python 侧完全一致。
 */
export class UpstreamHttpException extends HttpException {
  constructor(
    readonly upstreamBody: unknown,
    status: number,
  ) {
    super((upstreamBody as object) ?? { ok: false }, status || HttpStatus.BAD_GATEWAY);
  }
}
