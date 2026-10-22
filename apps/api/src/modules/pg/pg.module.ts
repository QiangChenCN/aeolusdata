import { Global, Module } from '@nestjs/common';
import { PgService } from './pg.service';

/**
 * PostgreSQL 直连接入模块（骨架）。设为 @Global：PgService 是共享基础设施，
 * 任何模块直接注入即可，无需各自 imports。
 */
@Global()
@Module({
  providers: [PgService],
  exports: [PgService],
})
export class PgModule {}
