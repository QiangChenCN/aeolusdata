import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FetchModule } from '../../infra/fetch/fetch.module';
import { TeamsController } from './teams.controller';

/**
 * 站点目录（原生 `GET /api/teams`）。
 *
 * 只做「取数结果 + 数据权限过滤」的下发；取数实现与缓存都在 `FetchModule.TeamsFetchService`，
 * 与 Python 计算侧回调的 `GET /api/fetch/teams` 共用同一份缓存。
 */
@Module({
  imports: [FetchModule, AuthModule],
  controllers: [TeamsController],
})
export class TeamsModule {}
