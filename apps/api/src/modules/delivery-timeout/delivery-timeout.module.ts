import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { ComputeModule } from '../compute/compute.module';
import { AuthModule } from '../auth/auth.module';
import { FetchModule } from '../../infra/fetch/fetch.module';
import { DeliveryTimeoutConfigService } from './delivery-timeout-config.service';
import { DeliveryTimeoutRefreshService } from './delivery-timeout-refresh.service';
import { DeliveryTimeoutOrdersStoreService } from './delivery-timeout-orders-store.service';
import { DeliveryTimeoutInternalController } from './delivery-timeout-internal.controller';
import { DeliveryTimeoutController } from './delivery-timeout.controller';
import { DeliveryTimeoutProxyController } from './delivery-timeout-proxy.controller';

/**
 * 配送超时看板独立模块。
 *
 * 2026-10-21 收口：本看板的**全部后端文件**都在本目录 ——
 *   · `DeliveryTimeoutOrdersStoreService`  实时运单明细 PG 表（本看板计算源，
 *     取代原先跨看板共用的落盘 JSON）；
 *   · `DeliveryTimeoutRefreshService`      刷新取数（全站一次拉全 → 写自有表）；
 *   · `DeliveryTimeoutInternalController`  内部读端点（机器令牌，供 Python 计算读明细）；
 *   · `DeliveryTimeoutConfigService`       「展示站点」配置（落 `services/compute/dashboard/delivery-timeout/`）；
 *   · `DeliveryTimeoutController`          看板 HTTP 入口（`/refresh` / `/raw`）；
 *   · `DeliveryTimeoutProxyController`     命名空间通配（`/data` 转发 Python、`/teams` 改派配置）。
 *
 * 计算链路：**前端 → /api/delivery-timeout/data → Python → /api/delivery-timeout-internal/orders
 * → PG 表**。与 standard / assessment 等看板零共享面：改本看板的取数、落库、字段、
 * 路由都只动本目录，不会波及其它看板。
 *
 * 依赖说明：`PgModule` 是 @Global，`PgService` 直接注入即可（见 store 服务）。
 */
@Module({
  imports: [ConfigModule, FetchModule, ComputeModule, AuthModule],
  // 顺序有意义：具体路由 controller 必须先于通配 controller 挂载
  //（见 DeliveryTimeoutProxyController 头部注释）。
  controllers: [
    DeliveryTimeoutInternalController,
    DeliveryTimeoutController,
    DeliveryTimeoutProxyController,
  ],
  providers: [
    DeliveryTimeoutConfigService,
    DeliveryTimeoutOrdersStoreService,
    DeliveryTimeoutRefreshService,
  ],
  exports: [DeliveryTimeoutConfigService],
})
export class DeliveryTimeoutModule {}
