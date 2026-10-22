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
import { JidanFetchPipeline } from './pipelines/jidan-fetch.pipeline';
import { OrangeStormPipeline } from './pipelines/orange-storm.pipeline';
import { RuleDocPipeline } from './pipelines/rule-doc.pipeline';
import { DeliveryPipeline } from './pipelines/delivery-pipeline.pipeline';
import { TaskBoardPipeline } from './pipelines/task-board.pipeline';
import { AppealReminderPipeline } from './pipelines/appeal-reminder.pipeline';
import { AttendancePipeline } from './pipelines/attendance.pipeline';
import { TaskEquipmentPipeline } from './pipelines/task-equipment.pipeline';
import { UnsatRunPipeline } from './pipelines/unsat-run.pipeline';

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
    JidanFetchPipeline,
    OrangeStormPipeline,
    RuleDocPipeline,
    DeliveryPipeline,
    TaskBoardPipeline,
    AppealReminderPipeline,
    AttendancePipeline,
    TaskEquipmentPipeline,
    UnsatRunPipeline,
  ],
  exports: [TaskRunnerService, TaskRegistryService, TaskHandlersService],
})
export class TasksModule {}
