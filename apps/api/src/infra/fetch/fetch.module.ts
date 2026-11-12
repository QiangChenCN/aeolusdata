import { Module } from '@nestjs/common';
import { AuthModule } from '../../modules/auth/auth.module';
import { ComputeModule } from '../../modules/compute/compute.module';
import { RefreshRunnerService } from './runners/refresh-runner.service';
import { FetchPaceService } from './runners/fetch-pace.service';
import { DeliveryQueryService } from './sources/delivery-query.service';
import { DeliveryExportService } from './sources/delivery-export.service';
import { AeolusCookieService } from './creds/aeolus-cookie.service';
import { AeolusLoginService } from './creds/aeolus-login.service';
import { AeolusCredentialsService } from './creds/aeolus-credentials.service';
import { OrdersFetchService } from './sources/orders-fetch.service';
import { RefreshAllService } from './runners/refresh-all.service';
import { FetchController } from './fetch.controller';
import { OrangeStormFetchService } from './sources/orange-storm-fetch.service';
import { RuledocFetchService } from './sources/ruledoc-fetch.service';
import { BoardFetchService } from './sources/board-fetch.service';
import { ViolationFetchService } from './sources/violation-fetch.service';
import { ViolationListFetchService } from './sources/violation-list-fetch.service';
import { ViolationStoreService } from './storage/violation-store.service';
import { RealtimeStoreService } from './storage/realtime-store.service';
import { ViolationSchedulerService } from './runners/violation-scheduler.service';
import { AttendanceFetchService } from './sources/attendance-fetch.service';
import { QuarkCredsService } from './creds/quark-creds.service';
import { EquipmentFetchService } from './sources/equipment-fetch.service';
import { ContactImFetchService } from './sources/contact-im-fetch.service';
import { TeamsFetchService } from './sources/teams-fetch.service';
import { CookieStatusService } from './runners/cookie-status.service';
import { ScheduleFetchService } from './sources/schedule-fetch.service';
import { RawCacheService } from './storage/raw-cache.service';

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
 *   · `POST /api/delivery-timeout/raw` / `POST /api/standard/raw` —— 原始层落盘（Nest 调用方直接写，
 *     不再经 Python 回调）；这两个写端点现已分别随 DeliveryTimeoutController / RefreshController
 *     迁到 `src/modules/delivery-timeout`、`src/modules/standard`，但落盘服务仍由本模块提供。
 *     注（2026-10-21）：配送超时看板的**刷新服务** `DeliveryTimeoutRefreshService` 也已迁到看板
 *     自有目录 `src/modules/delivery-timeout/`，本模块只保留它依赖的底层服务
 *     （OrdersFetchService / RawCacheService）—— 取数与落盘仍是共享基础设施。
 *   · `TeamsModule` / `StatusModule` 复用本模块的 TeamsFetchService / CookieStatusService
 *     提供前端用的 `GET /api/teams` / `GET /api/cookies/status`
 */
@Module({
  imports: [AuthModule, ComputeModule],
  controllers: [FetchController],
  providers: [
    FetchPaceService,
    DeliveryQueryService,
    DeliveryExportService,
    AeolusCookieService,
    AeolusLoginService,
    AeolusCredentialsService,
    OrdersFetchService,
    RefreshAllService,
    OrangeStormFetchService,
    RuledocFetchService,
    BoardFetchService,
    ViolationFetchService,
    AttendanceFetchService,
    QuarkCredsService,
    EquipmentFetchService,
    ContactImFetchService,
    TeamsFetchService,
    CookieStatusService,
    ScheduleFetchService,
    RefreshRunnerService,
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
    AeolusCredentialsService,
    OrdersFetchService,
    RefreshAllService,
    OrangeStormFetchService,
    RuledocFetchService,
    BoardFetchService,
    ViolationFetchService,
    AttendanceFetchService,
    QuarkCredsService,
    EquipmentFetchService,
    ContactImFetchService,
    TeamsFetchService,
    CookieStatusService,
    ScheduleFetchService,
    RefreshRunnerService,
    RawCacheService,
    ViolationListFetchService,
    ViolationStoreService,
    RealtimeStoreService,
    ViolationSchedulerService,
  ],
})
export class FetchModule {}
