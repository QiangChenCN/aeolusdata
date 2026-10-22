import { Module } from '@nestjs/common';
import { StreamingModule } from '../streaming/streaming.module';
import { JobsModule } from './jobs.module';
import { TaskEventMirrorService } from './task-event-mirror.service';

/**
 * API 侧任务模块：在共享 JobsModule 之上，补充「PG→SSE 镜像器」
 * （仅 API 进程需要，worker 不需要）。不含任何执行能力。
 */
@Module({
  imports: [JobsModule, StreamingModule],
  providers: [TaskEventMirrorService],
})
export class JobsUiModule {}
