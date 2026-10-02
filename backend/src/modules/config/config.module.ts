import { Module } from '@nestjs/common';
import { ConfigService } from './config.service';
import { FetchModule } from '../fetch/fetch.module';

/**
 * 配置层模块（看板配置读写，原 Python dashboard.standard.* / dashboard.realtime.config）。
 * 仅提供 ConfigService；路由仍在 ProxyController 中通过「配置路径改派」接管，
 * 以保证与 proxy 通配的注册顺序无关（见 proxy.controller.ts 说明）。
 */
@Module({
  imports: [FetchModule],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
