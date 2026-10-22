import { Logger } from '@nestjs/common';

/**
 * 统一日志封装。禁止在业务中散用 console。
 * 预留：traceId 透传、结构化输出。
 */
export class AppLogger extends Logger {
  constructor(context: string) {
    super(context);
  }
}
