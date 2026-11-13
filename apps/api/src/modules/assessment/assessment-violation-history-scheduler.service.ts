import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AssessmentViolationFetchService } from './assessment-violation-fetch.service';

/**
 * 考核看板历史违规处罚明细回补定时任务。
 *
 * 手动 / 自动刷新只写实时表 `violation_realtime`（当天最后一次刷新前的处罚明细，
 * 属残缺快照），历史表 `violation` 不再随刷新写入；本任务每日 04:00（北京时间）
 * 统一回补前 7 天（T-1 ~ T-7）的全天违规明细，historyOnly 只写历史表、不碰今日实时表。
 *
 * 设计要点（与运单回补 AssessmentDeliveryHistorySchedulerService 同构）：
 *   · 回补 7 天而非仅 T-1：容忍某天回补失败 / 服务停机跨天，次日自动重补；
 *   · 逐日串行取数，避免并发触发风神限流；单日失败不中断其余日期；
 *   · 取数窗口为全天（00:00 ~ 23:59:59），处罚明细在次日回补时已完结，历史聚合
 *     不再混入「截至刷新时刻」的残缺口径。
 */
@Injectable()
export class AssessmentViolationHistorySchedulerService implements OnModuleInit {
  private readonly logger = new Logger(AssessmentViolationHistorySchedulerService.name);
  private readonly pad = (n: number) => String(n).padStart(2, '0');

  /** 回补深度：前 7 天（T-1 ~ T-7）。 */
  private static readonly BACKFILL_DAYS = 7;

  constructor(private readonly violation: AssessmentViolationFetchService) {}

  onModuleInit(): void {
    this.logger.log('考核历史违规回补已就绪（每日 04:00 北京时间回补前 7 天 → violation）');
  }

  /** 北京时间 YYYY-MM-DD。 */
  private beijingDate(d: Date): string {
    const b = new Date(d.getTime() + 8 * 3600 * 1000);
    return `${b.getUTCFullYear()}-${this.pad(b.getUTCMonth() + 1)}-${this.pad(b.getUTCDate())}`;
  }

  /** 每天 04:00（北京时间）回补前 7 天的全天违规明细到历史表。 */
  @Cron('0 4 * * *', { timeZone: 'Asia/Shanghai' })
  async dailyBackfill(): Promise<void> {
    const days = AssessmentViolationHistorySchedulerService.BACKFILL_DAYS;
    this.logger.log(`历史违规回补开始：T-1 ~ T-${days}`);
    let okDays = 0;
    for (let i = 1; i <= days; i++) {
      const ds = this.beijingDate(new Date(Date.now() - i * 86400000));
      try {
        // 违规取数为全站口径，fetchAndLand 忽略 teams 入参，这里传空即可。
        const r = await this.violation.fetchAndLand([], ds, { historyOnly: true });
        if (r.ok) {
          okDays += 1;
          this.logger.log(`历史违规回补 ${ds}：${r.msg}`);
        } else {
          this.logger.warn(`历史违规回补 ${ds} 失败：${r.msg}（保留原数据，次日重补）`);
        }
      } catch (e) {
        this.logger.error(`历史违规回补 ${ds} 异常：${(e as Error).message}（继续后续日期）`);
      }
    }
    this.logger.log(`历史违规回补完成：成功 ${okDays}/${days} 天`);
  }
}
