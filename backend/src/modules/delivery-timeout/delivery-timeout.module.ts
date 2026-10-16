import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { FetchModule } from '../../../fetch/fetch.module';
import { DeliveryTimeoutConfigService } from './delivery-timeout-config.service';

/**
 * 配送超时看板独立模块。
 * 仅提供 DeliveryTimeoutConfigService（「展示站点」配置读写）；
 * 路由由 ProxyModule 的 `delivery-timeout/{*path}` 通配改派（配置端点）
 * 或转发 Python（计算端点 /data），不在此注册独立控制器，避免与通配路由冲突。
 */
@Module({
  imports: [ConfigModule, FetchModule],
  providers: [DeliveryTimeoutConfigService],
  exports: [DeliveryTimeoutConfigService],
})
export class DeliveryTimeoutModule {}
