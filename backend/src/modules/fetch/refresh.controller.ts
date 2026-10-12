import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { RefreshRunnerService } from './refresh-runner.service';

/**
 * 全量刷新入口（`/api/standard/refresh-all` + `-status`）。
 *
 * 原先由 Nest 代理给 Python `dashboard/standard/refresh_all.py`，现已原生化：
 * 编排在 `RefreshRunnerService`（阶段调度 / 状态机 / 日志 / 单飞），计算在 Python
 * （`/api/compute/{violations,rider-dimension,achievement}`）。
 *
 * 频控（60s/用户 + 15s 全局间隔）、数据权限收敛（受限用户只刷可见站点，收敛为空必须 403）
 * 与单飞语义都实现在 runner 里 —— 因为 `ProxyController` 的 `standard/{*path}` 通配也会
 * 命中这个路径，两处必须走同一份逻辑。本控制器只做 HTTP 粘合。
 */
@Controller('api')
export class RefreshController {
  constructor(private readonly runner: RefreshRunnerService) {}

  @Post('standard/refresh-all')
  start(
    @Req() req: Request,
    @Body() body: { teams?: unknown; start?: string; end?: string },
  ) {
    return this.runner.startFromRequest(req, body);
  }

  @Get('standard/refresh-all-status')
  status(@Req() req: Request) {
    return { ok: true, status: this.runner.status(req) };
  }
}
