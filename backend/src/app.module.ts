import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as path from 'path';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { envValidationSchema } from './config/configuration';
import { AccessGuard } from './common/guards/access.guard';
import { AuthModule } from './modules/auth/auth.module';
import { ComputeModule } from './modules/compute/compute.module';
import { StreamingModule } from './modules/streaming/streaming.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { TodoModule } from './modules/todo/todo.module';
import { ServeModule } from './modules/serve/serve.module';
import { ProxyModule } from './modules/proxy/proxy.module';
import { FetchModule } from '../fetch/fetch.module';
import { DingtalkModule } from './modules/dingtalk/dingtalk.module';
import { GroupsModule } from './modules/groups/groups.module';
import { MediaModule } from './modules/media/media.module';
import { RenderModule } from './modules/render/render.module';
import { TeamsModule } from './modules/teams/teams.module';
import { StatusModule } from './modules/status/status.module';
import { ConfigModule as AppConfigModule } from './modules/config/config.module';
import { BotsModule } from './modules/bots/bots.module';
import { AssessmentModule } from './modules/assessment/assessment.module';

@Module({
  imports: [
    // 全局配置：启动时校验 env
    // 单一配置来源 = 仓库根 .env（如 /opt/aeolusdata/.env）。systemd 的 EnvironmentFile 注入同一份，
    // 这里显式读取它，不再读 backend/.env，避免两份漂移。数组第二项是本地开发的优雅回退
    // （若根 .env 缺席、仍有 backend/.env 时可用），根 .env 存在时它永不生效。
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      envFilePath: [
        path.resolve(process.cwd(), '..', '.env'),
        path.resolve(process.cwd(), '.env'),
      ],
    }),
    ScheduleModule.forRoot(),
    // 频控（内存态；多实例需换 Redis 存储）
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60000, limit: 60 }] }),
    AuthModule,
    ComputeModule,
    StreamingModule,
    TasksModule,
    TodoModule,
    ServeModule,
    ProxyModule,
    FetchModule,
    AppConfigModule,
    DingtalkModule,
    GroupsModule,
    MediaModule,
    RenderModule,
    TeamsModule,
    StatusModule,
    BotsModule,
    AssessmentModule,
  ],
  // 统一访问闸门：机器令牌闸门 + RBAC 会话鉴权（见 AccessGuard）
  providers: [{ provide: APP_GUARD, useClass: AccessGuard }],
})
export class AppModule {}
