import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { FetchModule } from '../../../fetch/fetch.module';
import { DeliveryTimeoutConfigService } from './delivery-timeout-config.service';
import { DeliveryTimeoutController } from './delivery-timeout.controller';

/**
 * 配送超时看板独立模块。
 *  - `DeliveryTimeoutConfigService`：「展示站点」配置读写（由 ProxyModule 的
 *    `delivery-timeout/{*path}` 通配改派 /teams 命中）。
 *  - `DeliveryTimeoutController`：看板自身 HTTP 入口（`/api/delivery-timeout/refresh`、
 *    `/api/delivery-timeout/raw`），随本模块被 ProxyModule 依赖而先于通配注册，
 *    故其具体路由不会被 `delivery-timeout/{*path}` 吞掉。
 *  取数与落盘依赖的服务（DeliveryTimeoutRefreshService、RawCacheService）由 FetchModule
 *  提供并导出，本模块仅 import 复用。
 */
@Module({
  imports: [ConfigModule, FetchModule],
  controllers: [DeliveryTimeoutController],
  providers: [DeliveryTimeoutConfigService],
  exports: [DeliveryTimeoutConfigService],
})
export class DeliveryTimeoutModule {}
