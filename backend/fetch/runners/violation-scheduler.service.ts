import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ViolationStoreService } from '../storage/violation-store.service';
import { ViolationListFetchService } from '../sources/violation-list-fetch.service';

/**
 * 违规处罚明细定时同步。
 *
 *  · 每日 03:00（北京时间）回补当月 1 号至 T-1（昨天）的全量明细，写入 `violation.db`；
 *    跨天/漏抓/会话失效后次日会自动补齐整月缺失日期。
 * 取数复用 `ViolationListFetchService.queryRange`，会话失效时由 AeolusCookieService 自动重登。
 */
@Injectable()
export class ViolationSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(ViolationSchedulerService.name);
  private readonly pad = (n: number) => String(n).padStart(2, '0');

  constructor(
    private readonly store: ViolationStoreService,
    private readonly violation: ViolationListFetchService,
  ) {}

  onModuleInit(): void {
    this.logger.log('违规记录定时同步已就绪（每日 03:00 北京时间抓取 T-1）');
  }

  /** 北京时间 YYYY-MM-DD（默认入参为 T-1）。 */
  private beijingDate(d: Date): string {
    const b = new Date(d.getTime() + 8 * 3600 * 1000);
    return `${b.getUTCFullYear()}-${this.pad(b.getUTCMonth() + 1)}-${this.pad(b.getUTCDate())}`;
  }

  /** 抓取并写入某天（默认 T-1）的违规明细，返回入库条数。 */
  async syncDay(dateStr?: string): Promise<number> {
    const ds = dateStr || this.beijingDate(new Date(Date.now() - 86400000));
    const start = Date.parse(`${ds}T00:00:00.000+08:00`);
    const end = Date.parse(`${ds}T23:59:59.999+08:00`);
    try {
      const r = await this.violation.queryRange(start, end, 200);
      const rows = r.rows || [];
      const n = this.store.upsertDay(ds, rows);
      this.logger.log(`同步 ${ds}：接口返回 ${rows.length} 条，入库 ${n} 条`);
      return n;
    } catch (e) {
      this.logger.error(`同步 ${ds} 失败：${(e as Error).message}`);
      throw e;
    }
  }

  /** 每天 03:00（北京时间）回补当月 1 号至 T-1（昨天）写入数据库。 */
  @Cron('0 3 * * *', { timeZone: 'Asia/Shanghai' })
  async dailyTMinus1(): Promise<void> {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1; // 1-12
    // T-1（昨天，北京时间）
    const t1 = new Date(now.getTime() - 86400000);
    const ty = t1.getFullYear();
    const tm = t1.getMonth() + 1;
    const td = t1.getDate();
    // 只回补与当前同月的日期（跨年时 T-1 可能落在去年 12 月，跳过）
    if (ty !== y || tm !== m) {
      this.logger.log('今日 T-1 不在当前月份，跳过本月回补');
      return;
    }
    let total = 0;
    for (let d = 1; d <= td; d++) {
      const ds = `${y}-${this.pad(m)}-${this.pad(d)}`;
      total += await this.syncDay(ds);
    }
    this.logger.log(`本月回补（1 号 ~ T-1）完成：共入库 ${total} 条`);
  }
}
