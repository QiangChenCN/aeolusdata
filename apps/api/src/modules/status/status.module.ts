import { Module } from '@nestjs/common';
import { FetchModule } from '../../infra/fetch/fetch.module';
import { CookieStatusController } from './cookie-status.controller';

/**
 * 登录态状态端点（原生 `GET /api/cookies/status`）。
 *
 * 探针实现（风神 validToken + Quark DA 缓存）在 `FetchModule`，本模块只负责暴露 HTTP 入口。
 */
@Module({
  imports: [FetchModule],
  controllers: [CookieStatusController],
})
export class StatusModule {}
