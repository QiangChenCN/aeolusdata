import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ComputeModule } from '../compute/compute.module';
import { RefreshController } from './refresh.controller';
import { RefreshRunnerService } from './refresh-runner.service';
import { DeliveryTimeoutController } from './delivery-timeout.controller';
import { DeliveryTimeoutRefreshService } from './delivery-timeout-refresh.service';
import { FetchPaceService } from './fetch-pace.service';
import { DeliveryQueryService } from './delivery-query.service';
import { DeliveryExportService } from './delivery-export.service';
import { AeolusCookieService } from './aeolus-cookie.service';
import { AeolusLoginService } from './aeolus-login.service';
import { OrdersFetchService } from './orders-fetch.service';
import { RefreshAllService } from './refresh-all.service';
import { FetchController } from './fetch.controller';
import { RushFetchService } from './rush-fetch.service';
import { OrangeStormFetchService } from './orange-storm-fetch.service';
import { RuledocFetchService } from './ruledoc-fetch.service';
import { DeliveryRawService } from './delivery-raw.service';
import { DeliveryDbService } from './delivery-db.service';
import { DeliveryCsvService } from './delivery-csv.service';
import { BoardFetchService } from './board-fetch.service';
import { ViolationFetchService } from './violation-fetch.service';
import { ViolationListFetchService } from './violation-list-fetch.service';
import { ViolationStoreService } from './violation-store.service';
import { RealtimeStoreService } from './realtime-store.service';
import { ViolationSchedulerService } from './violation-scheduler.service';
import { AttendanceFetchService } from './attendance-fetch.service';
import { QuarkCredsService } from './quark-creds.service';
import { EquipmentFetchService } from './equipment-fetch.service';
import { UnsatStoreService } from './unsat-store.service';
import { TeamsFetchService } from './teams-fetch.service';
import { CookieStatusService } from './cookie-status.service';
import { ScheduleFetchService } from './schedule-fetch.service';
import { RawCacheService } from './raw-cache.service';
import { CacheController } from './cache.controller';

/**
 * 取数模块（原属 Python：get_data.* + dashboard/standard/orders_fetch）。
 *
 * 分工（按本次迁移决定）：
 *   · 取数（分页请求 / 反爬节奏 / 限流退避 / 会话重登 / 时段切片去重 / 站点目录 / 登录态探针）
 *     → 本模块（Node）
 *   · 风神 SSO 登录 / 重登 → 本模块（AeolusLoginService + AeolusCookieService）——
 *     2026-09-23 已从 Python `aeolus_sdk` 迁来，取数不再依赖 Python 运行时
 *   · 原始层落盘 → 本模块（RawCacheService，唯一写入方）
 *   · 大数据计算 → 仍走 Python（ComputePort 委托接口保留）
 *
 * 对外出口：
 *   · `GET /api/fetch/*`  —— 内部取数接口（机器令牌；`teams` 同时供 Python 回调）
 *   · `POST /api/cache/raw` —— Python 计算侧把原始 payload 交回落盘（见 CacheController）
 *   · `TeamsModule` / `StatusModule` 复用本模块的 TeamsFetchService / CookieStatusService
 *     提供前端用的 `GET /api/teams` / `GET /api/cookies/status`
 */
@Module({
  imports: [AuthModule, ComputeModule],
  controllers: [FetchController, RefreshController, CacheController, DeliveryTimeoutController],
  providers: [
    FetchPaceService,
    DeliveryQueryService,
    DeliveryExportService,
    AeolusCookieService,
    AeolusLoginService,
    OrdersFetchService,
    RefreshAllService,
    RushFetchService,
    OrangeStormFetchService,
    RuledocFetchService,
    DeliveryRawService,
    DeliveryDbService,
    DeliveryCsvService,
    BoardFetchService,
    ViolationFetchService,
    AttendanceFetchService,
    QuarkCredsService,
    EquipmentFetchService,
    UnsatStoreService,
    TeamsFetchService,
    CookieStatusService,
    ScheduleFetchService,
    RefreshRunnerService,
    DeliveryTimeoutRefreshService,
    RawCacheService,
    ViolationListFetchService,
    ViolationStoreService,
    RealtimeStoreService,
    ViolationSchedulerService,
  ],
  exports: [
    FetchPaceService,
    DeliveryQueryService,
    DeliveryExportService,
    AeolusCookieService,
    AeolusLoginService,
    OrdersFetchService,
    RefreshAllService,
    RushFetchService,
    OrangeStormFetchService,
    RuledocFetchService,
    DeliveryRawService,
    DeliveryDbService,
    DeliveryCsvService,
    BoardFetchService,
    ViolationFetchService,
    AttendanceFetchService,
    QuarkCredsService,
    EquipmentFetchService,
    UnsatStoreService,
    TeamsFetchService,
    CookieStatusService,
    ScheduleFetchService,
    RefreshRunnerService,
    DeliveryTimeoutRefreshService,
    RawCacheService,
    ViolationListFetchService,
    ViolationStoreService,
    RealtimeStoreService,
    ViolationSchedulerService,
  ],
})
export class FetchModule {}
