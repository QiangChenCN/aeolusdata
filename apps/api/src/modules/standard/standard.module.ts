import { Module } from '@nestjs/common';
import { FetchModule } from '../../infra/fetch/fetch.module';
import { RefreshController } from './refresh.controller';

/**
 * 标准达成看板模块。
 *
 * 承载看板自身的 HTTP 入口（RefreshController：`/api/standard/refresh-all`、
 * `-status`、`/api/standard/raw`）。取数与落盘编排依赖的服务（RefreshRunnerService、
 * RawCacheService）仍由 `FetchModule` 提供并导出，本模块仅 import 复用，不重复实现。
 *
 * 重要：本模块必须被 `ProxyModule` 依赖（见 proxy.module.ts），使 RefreshController 的
 * 具体路由先于 ProxyController 的 `standard/{*path}` 通配注册，避免刷新/写端点被通配吞掉。
 */
@Module({
  imports: [FetchModule],
  controllers: [RefreshController],
})
export class StandardModule {}
