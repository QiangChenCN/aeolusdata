import { Module } from '@nestjs/common';
import { StreamingModule } from '../streaming/streaming.module';
import { TasksModule } from '../tasks/tasks.module';
import { CronStoreService } from './cron-store.service';
import { CronSchedulerService } from './cron-scheduler.service';
import { CronController } from './cron.controller';

@Module({
  imports: [StreamingModule, TasksModule],
  controllers: [CronController],
  providers: [CronStoreService, CronSchedulerService],
  exports: [CronStoreService, CronSchedulerService],
})
export class CronModule {}
