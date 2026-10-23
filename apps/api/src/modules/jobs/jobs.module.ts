import { Module } from '@nestjs/common';
import { PgModule } from '../pg/pg.module';
import { JobQueueService } from './job-queue.service';
import { WorkerHeartbeatService } from './worker-heartbeat.service';

/**
 * 共享任务队列模块（API 与 worker 都依赖）。
 * 仅提供 JobQueueService（PG 队列表的读写）+ WorkerHeartbeatService（worker 在线状态），
 * 不绑定 HTTP、不绑定 SSE。
 */
@Module({
  imports: [PgModule],
  providers: [JobQueueService, WorkerHeartbeatService],
  exports: [JobQueueService, WorkerHeartbeatService],
})
export class JobsModule {}
