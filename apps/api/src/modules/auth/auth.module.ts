import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { DataPermService } from './data-perm.service';
import { AuthController } from './auth.controller';
import { AccountController } from './account.controller';
import { AdminController } from './admin.controller';
import { DingtalkSsoService } from './dingtalk-sso.service';
import { AuthStoreService } from './auth-store.service';
import { ComputeModule } from '../compute/compute.module';

@Module({
  // /api/data-perms 需要站点「名称」，而名称只有 Python 侧有（风神站点接口），
  // 因此经 ComputePort 复用 /api/teams 的取数结果。
  imports: [ComputeModule],
  controllers: [AuthController, AccountController, AdminController],
  // AuthStoreService：RBAC 五份状态（账号/角色/策略/会话/审计）的持久层，已迁往 PostgreSQL
  providers: [AuthService, AuthStoreService, DataPermService, DingtalkSsoService],
  exports: [AuthService, AuthStoreService, DataPermService, DingtalkSsoService],
})
export class AuthModule {}
