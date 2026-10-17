import { Module } from '@nestjs/common';
import { FetchModule } from '../../../fetch/fetch.module';
import { AssessmentViolationFetchService } from './assessment-violation-fetch.service';
import { AssessmentDeliveryFetchService } from './assessment-delivery-fetch.service';
import { AssessmentCooldownService } from './assessment-cooldown.service';
import { AssessmentEventsService } from './assessment-events.service';
import { AssessmentAutoRefreshService } from './assessment-auto-refresh.service';
import { AssessmentController } from './assessment.controller';

/**
 * 考核看板模块（独立看板：取数 / 计算代码自管，不与其他看板共用）。
 *
 * 仅取数层在 Nest：违规处罚明细自有取数（全站合并落盘到 backend/data/违规处罚明细-实时.json，覆盖写）。
 * 计算层仍在 Python `analytics/assessment/`（其自身目录，基础库 cache/order_rules/
 * teams_config 保留共用）。
 *
 * 注入 `FetchModule` 仅为复用取数基础设施 `ViolationFetchService`（风神 HTTP + GBK 解码 primitive，
 * 等同数据层 cache 的角色）—— 解析 / 分组 / 落盘命名空间均为本模块独立实现。
 */
@Module({
  imports: [FetchModule],
  controllers: [AssessmentController],
  providers: [
    AssessmentViolationFetchService,
    AssessmentDeliveryFetchService,
    AssessmentCooldownService,
    AssessmentEventsService,
    AssessmentAutoRefreshService,
  ],
  exports: [
    AssessmentViolationFetchService,
    AssessmentDeliveryFetchService,
    AssessmentCooldownService,
    AssessmentEventsService,
    AssessmentAutoRefreshService,
  ],
})
export class AssessmentModule {}
