import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { RootConfigModule } from './config/root-config.module';
import { AccessGuard } from './common/guards/access.guard';
import { AuthModule } from './modules/auth/auth.module';
import { ComputeModule } from './modules/compute/compute.module';
import { StreamingModule } from './modules/streaming/streaming.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { CronModule } from './modules/cron/cron.module';
import { JobsUiModule } from './modules/jobs/jobs-ui.module';
import { WorkerSpawnerModule } from './modules/jobs/worker-spawner.module';
import { ServeModule } from './modules/serve/serve.module';
import { ProxyModule } from './modules/proxy/proxy.module';
import { FetchModule } from './infra/fetch/fetch.module';
import { DingtalkModule } from './modules/dingtalk/dingtalk.module';
import { GroupsModule } from './modules/groups/groups.module';
import { MediaModule } from './modules/media/media.module';
import { RenderModule } from './modules/render/render.module';
import { TeamsModule } from './modules/teams/teams.module';
import { StatusModule } from './modules/status/status.module';
import { ConfigModule as AppConfigModule } from './modules/config/config.module';
import { BotsModule } from './modules/bots/bots.module';
import { AssessmentModule } from './modules/assessment/assessment.module';
import { StandardModule } from './modules/standard/standard.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { PgModule } from './modules/pg/pg.module';
import { OperationLogModule } from './modules/operation-log/operation-log.module';
import { OperationLogMiddleware } from './modules/operation-log/operation-log.middleware';

@Module({
  imports: [
    // 全局配置：启动时校验 env（与 worker 进程共用 RootConfigModule，勿再内联 forRoot）
    RootConfigModule,
    ScheduleModule.forRoot(),
    // 频控（内存态；多实例需换 Redis 存储）
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60000, limit: 60 }] }),
    AuthModule,
    ComputeModule,
    StreamingModule,
    TasksModule,
    CronModule,
    JobsUiModule,
    WorkerSpawnerModule,
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
    StandardModule,
    DeliveryModule,
    PgModule,
    OperationLogModule,
  ],
  // 统一访问闸门：机器令牌闸门 + RBAC 会话鉴权（见 AccessGuard）
  providers: [{ provide: APP_GUARD, useClass: AccessGuard }],
})
export class AppModule implements NestModule {
  // 全局操作日志中间件（替代原先 APP_INTERCEPTOR：拦截器会包裹 SSE 长连接流导致其秒断）
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(OperationLogMiddleware).forRoutes('*');
  }
}
