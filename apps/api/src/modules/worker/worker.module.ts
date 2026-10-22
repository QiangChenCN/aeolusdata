import { Module } from '@nestjs/common';
import { PgModule } from '../pg/pg.module';
import { JobsModule } from '../jobs/jobs.module';
import { TaskExecutorService } from '../jobs/task-executor.service';
import { WorkerService } from '../jobs/worker.service';
// 复用 TasksModule：提供 TaskRegistryService / TaskHandlersService / 各流水线 provider
// （流水线依赖 Fetch/Dingtalk/Media/Render 等模块，TasksModule 已装配好）。
// TasksController / TaskRunnerService(产物) 一并被实例化但本进程不监听 HTTP，无副作用。
import { TasksModule } from '../tasks/tasks.module';

/**
 * worker 进程装配体：只含「抢任务 + 执行」所需依赖，不暴露 HTTP、不含 CronModule
 * （避免与 API 的 CronScheduler 重复点火）。
 */
@Module({
  imports: [PgModule, JobsModule, TasksModule],
  providers: [TaskExecutorService, WorkerService],
})
export class WorkerModule {}
