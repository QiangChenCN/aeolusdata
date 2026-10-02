import { Module } from '@nestjs/common';
import { ComputeModule } from '../compute/compute.module';
import { AuthModule } from '../auth/auth.module';
import { FetchModule } from '../fetch/fetch.module';
import { ConfigModule } from '../config/config.module';
import { ProxyController } from './proxy.controller';

/**
 * 委托边界：把仍在 Python 的端点转发给计算服务。
 *
 * `FetchModule` 只为一处：`standard/{*path}` 通配与已原生化的
 * `/api/standard/refresh-all` / `-status` 同路径冲突，需在通配里显式改派到
 * `RefreshRunnerService`（见 ProxyController 注释）。
 */
@Module({
  imports: [ComputeModule, AuthModule, FetchModule, ConfigModule],
  controllers: [ProxyController],
})
export class ProxyModule {}
