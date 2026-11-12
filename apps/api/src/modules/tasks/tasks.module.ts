import { Module } from '@nestjs/common';
import { StreamingModule } from '../streaming/streaming.module';
import { FetchModule } from '../../infra/fetch/fetch.module';
import { DingtalkModule } from '../dingtalk/dingtalk.module';
import { MediaModule } from '../media/media.module';
import { RenderModule } from '../render/render.module';
import { JobsModule } from '../jobs/jobs.module';
import { TaskRunnerService } from './task-runner.service';
import { TaskRegistryService } from './task-registry.service';
import { TaskHandlersService } from './task-handlers.service';
import { TasksController } from './tasks.controller';
import { OrangeStormPipeline } from './pipelines/orange-storm.pipeline';
import { RuleDocPipeline } from './pipelines/rule-doc.pipeline';
import { TaskBoardPipeline } from './pipelines/task-board.pipeline';
import { AppealReminderPipeline } from './pipelines/appeal-reminder.pipeline';
import { AttendancePipeline } from './pipelines/attendance.pipeline';
import { TaskEquipmentPipeline } from './pipelines/task-equipment.pipeline';

@Module({
  imports: [
    StreamingModule,
    FetchModule,
    DingtalkModule,
    MediaModule,
    RenderModule,
    JobsModule,
  ],
  controllers: [TasksController],
  providers: [
    TaskRunnerService,
    TaskRegistryService,
    TaskHandlersService,
    OrangeStormPipeline,
    RuleDocPipeline,
    TaskBoardPipeline,
    AppealReminderPipeline,
    AttendancePipeline,
    TaskEquipmentPipeline,
  ],
  exports: [TaskRunnerService, TaskRegistryService, TaskHandlersService],
})
export class TasksModule {}
