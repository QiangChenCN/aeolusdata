import { Module } from '@nestjs/common';
import { DingtalkModule } from '../dingtalk/dingtalk.module';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

@Module({
  imports: [DingtalkModule],
  controllers: [GroupsController],
  providers: [GroupsService],
})
export class GroupsModule {}
