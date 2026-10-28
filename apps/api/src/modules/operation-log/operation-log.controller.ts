import { Controller, Get, Query } from '@nestjs/common';
import { OperationLogService, OperationLogQuery } from './operation-log.service';

/**
 * 操作日志查询端点（受全局 AccessGuard 保护，需有效会话/机器令牌）。
 * GET /api/operation-log?limit=&actor=&action=&target=&from=&to=
 * 返回最近操作日志，供「谁在何时用什么代码操作了什么」的回溯排查。
 */
@Controller('api/operation-log')
export class OperationLogController {
  constructor(private readonly log: OperationLogService) {}

  @Get()
  async list(
    @Query('limit') limit?: string,
    @Query('actor') actor?: string,
    @Query('action') action?: string,
    @Query('target') target?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const q: OperationLogQuery = {
      limit: limit ? Number(limit) : 50,
      actor,
      action,
      target,
      from,
      to,
    };
    const logs = await this.log.list(q);
    return { ok: true, total: logs.length, logs };
  }
}
