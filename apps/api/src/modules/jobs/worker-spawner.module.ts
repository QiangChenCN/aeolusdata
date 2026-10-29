import { Module } from '@nestjs/common';
import { JobsModule } from './jobs.module';
import { WorkerSpawnerService } from './worker-spawner.service';

/**
 * 后端托管的 worker 拉起模块。
 *
 * 仅由 AppModule（API 进程）引入；**不要**在 WorkerModule 里引入，
 * 否则 worker 进程自身也会实例化 WorkerSpawnerService，进而去拉起另一个 worker（套娃）。
 */
@Module({
  imports: [JobsModule],
  providers: [WorkerSpawnerService],
})
export class WorkerSpawnerModule {}
