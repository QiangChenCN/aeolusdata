import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { DataPermService } from './data-perm.service';
import { AuthController } from './auth.controller';
import { AccountController } from './account.controller';
import { AdminController } from './admin.controller';
import { ComputeModule } from '../compute/compute.module';

@Module({
  // /api/data-perms 需要站点「名称」，而名称只有 Python 侧有（风神站点接口），
  // 因此经 ComputePort 复用 /api/teams 的取数结果。
  imports: [ComputeModule],
  controllers: [AuthController, AccountController, AdminController],
  providers: [AuthService, DataPermService],
  exports: [AuthService, DataPermService],
})
export class AuthModule {}
