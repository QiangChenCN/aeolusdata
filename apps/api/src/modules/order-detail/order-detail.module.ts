import { Module } from '@nestjs/common';
import { FetchModule } from '../../infra/fetch/fetch.module';
import { OrderDetailStoreService } from './order-detail-store.service';
import { OrderDetailHistoryStoreService } from './order-detail-history-store.service';
import { OrderDetailRefreshService } from './order-detail-refresh.service';
import { OrderDetailHistoryService } from './order-detail-history.service';
import { OrderDetailController } from './order-detail.controller';

/**
 * 运单明细看板独立模块（2026-10-24 新建）。
 *
 * 看板定位：把「实时运单明细」这一份原始层数据直接摊开给人看 —— 按天 / 站点 / 关键字
 * 查单，不再经过任何聚合计算。因此这里**没有** Python 计算依赖，也没有内部读端点：
 *   · `OrderDetailStoreService`   `delivery_realtime` 表的本看板侧读写方（代码不跨看板共享）；
 *   · `OrderDetailRefreshService` 刷新取数（复用共享底座 `OrdersFetchService`，落同一张表）；
 *   · `OrderDetailController`     看板 HTTP 入口（`/orders` 查询、`/refresh` 刷新）。
 *
 * 依赖：PgModule 是 @Global，PgService 直接注入；`FetchModule` 提供底层取数与
 * 原始层缓存失效通知（RawCacheService）。
 */
@Module({
  imports: [FetchModule],
  controllers: [OrderDetailController],
  providers: [
    OrderDetailStoreService,
    OrderDetailHistoryStoreService,
    OrderDetailRefreshService,
    OrderDetailHistoryService,
  ],
  exports: [OrderDetailStoreService],
})
export class OrderDetailModule {}
