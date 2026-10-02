import { Module } from '@nestjs/common';
import { StreamingModule } from '../streaming/streaming.module';
import { TasksModule } from '../tasks/tasks.module';
import { TodoStoreService } from './todo-store.service';
import { TodoSchedulerService } from './scheduler.service';
import { TodoController } from './todo.controller';

@Module({
  imports: [StreamingModule, TasksModule],
  controllers: [TodoController],
  providers: [TodoStoreService, TodoSchedulerService],
  exports: [TodoStoreService, TodoSchedulerService],
})
export class TodoModule {}
