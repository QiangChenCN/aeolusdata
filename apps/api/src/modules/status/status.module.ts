import { Module } from '@nestjs/common';
import { FetchModule } from '../../infra/fetch/fetch.module';
import { JobsModule } from '../jobs/jobs.module';
import { CookieStatusController } from './cookie-status.controller';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * 状态类端点：
 *   · 登录态（`GET /api/cookies/status`）—— 探针实现在 `FetchModule`；
 *   · 系统健康（`GET /api/health`）—— 后端 / Python / worker 三者状态。
 * 本模块只负责暴露 HTTP 入口。
 */
@Module({
  imports: [FetchModule, JobsModule],
  controllers: [CookieStatusController, HealthController],
  providers: [HealthService],
})
export class StatusModule {}
