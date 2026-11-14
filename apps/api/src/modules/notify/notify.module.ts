import { Module } from '@nestjs/common';
import { DingtalkModule } from '../dingtalk/dingtalk.module';
import { StationManagersController } from './station-managers.controller';
import { StationManagersService } from './station-managers.service';

/** 通知配置模块：站点负责人映射（runtime JSON + UI 维护 + 按姓名自动解析 openid）。 */
@Module({
  imports: [DingtalkModule],
  controllers: [StationManagersController],
  providers: [StationManagersService],
  exports: [StationManagersService],
})
export class NotifyModule {}
