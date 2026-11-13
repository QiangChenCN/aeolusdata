import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AssessmentDeliveryFetchService } from './assessment-delivery-fetch.service';

/**
 * 考核看板历史运单回补定时任务。
 *
 * 手动 / 自动刷新只写实时表 `delivery_realtime`（时间窗 = 今日 00:00 ~ 刷新时刻，
 * 属残缺快照），历史表 `delivery` 不再随刷新写入；本任务每日 04:00（北京时间）统一
 * 回补前 7 天（T-1 ~ T-7）的全天运单明细，historyOnly 只写历史表、不碰今日实时表。
 *
 * 设计要点：
 *   · 回补 7 天而非仅 T-1：容忍某天回补失败 / 服务停机跨天，次日自动重补；
 *     UPSERT 按 order_id + date 幂等，重复回补无副作用；
 *   · 逐日串行取数，避免并发触发风神限流；单日失败不中断其余日期；
 *   · 取数窗口由 fetchAndLand 对过去日自动取全天（00:00 ~ 23:59:59），数据完结后才入库，
 *     历史聚合不再混入「截至刷新时刻」的残缺口径。
 */
@Injectable()
export class AssessmentDeliveryHistorySchedulerService implements OnModuleInit {
  private readonly logger = new Logger(AssessmentDeliveryHistorySchedulerService.name);
  private readonly pad = (n: number) => String(n).padStart(2, '0');

  /** 回补深度：前 7 天（T-1 ~ T-7）。 */
  private static readonly BACKFILL_DAYS = 7;

  constructor(private readonly delivery: AssessmentDeliveryFetchService) {}

  onModuleInit(): void {
    this.logger.log('考核历史运单回补已就绪（每日 04:00 北京时间回补前 7 天 → delivery）');
  }

  /** 北京时间 YYYY-MM-DD。 */
  private beijingDate(d: Date): string {
    const b = new Date(d.getTime() + 8 * 3600 * 1000);
    return `${b.getUTCFullYear()}-${this.pad(b.getUTCMonth() + 1)}-${this.pad(b.getUTCDate())}`;
  }

  /** 每天 04:00（北京时间）回补前 7 天的全天运单明细到历史表。 */
  @Cron('0 4 * * *', { timeZone: 'Asia/Shanghai' })
  async dailyBackfill(): Promise<void> {
    const days = AssessmentDeliveryHistorySchedulerService.BACKFILL_DAYS;
    this.logger.log(`历史运单回补开始：T-1 ~ T-${days}`);
    let okDays = 0;
    for (let i = 1; i <= days; i++) {
      const ds = this.beijingDate(new Date(Date.now() - i * 86400000));
      try {
        const r = await this.delivery.fetchAndLand(ds, { historyOnly: true });
        if (r.ok) {
          okDays += 1;
          this.logger.log(`历史运单回补 ${ds}：${r.msg}`);
        } else {
          this.logger.warn(`历史运单回补 ${ds} 失败：${r.msg}（保留原数据，次日重补）`);
        }
      } catch (e) {
        this.logger.error(`历史运单回补 ${ds} 异常：${(e as Error).message}（继续后续日期）`);
      }
    }
    this.logger.log(`历史运单回补完成：成功 ${okDays}/${days} 天`);
  }
}
