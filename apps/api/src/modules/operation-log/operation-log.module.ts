import { Global, Module } from '@nestjs/common';
import { OperationLogService } from './operation-log.service';
import { OperationLogController } from './operation-log.controller';

/**
 * 操作日志模块（@Global）：只需在根 AppModule 里 import 一次，
 * OperationLogService 即全局可用，且本模块自带查询控制器与全局拦截器（在 AppModule 注册）。
 */
@Global()
@Module({
  controllers: [OperationLogController],
  providers: [OperationLogService],
  exports: [OperationLogService],
})
export class OperationLogModule {}
