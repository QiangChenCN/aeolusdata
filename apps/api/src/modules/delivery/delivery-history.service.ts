import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrdersFetchService } from '../../infra/fetch/sources/orders-fetch.service';
import { DeliveryHistoryStoreService } from './delivery-history-store.service';
import { beijingNowStr } from './delivery-store.service';
import { OperationLogService } from '../operation-log/operation-log.service';

/** 滚动窗口天数：T-1 ~ T-7。 */
export const HISTORY_WINDOW_DAYS = 7;
/** 手动回补时允许的最大天数（防止一次传 365 天把风神打爆）。 */
const MAX_DATES = 31;
/** 天与天之间的间隔：连续 7 次全站导出，留出节奏余量避免触发限流。 */
const GAP_MS = 1200;

/** 某天 00:00:00.000 ~ 23:59:59.999（北京时间）的毫秒区间。 */
function dayRangeMs(date: string): [number, number] {
  return [Date.parse(`${date}T00:00:00.000+08:00`), Date.parse(`${date}T23:59:59.999+08:00`)];
}
const pad = (n: number) => String(n).padStart(2, '0');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DeliveryHistoryDayResult {
  date: string;
  /** ok = 已写入；skipped = 取数为空，保留历史表原数据；failed = 取数或写库失败。 */
  status: 'ok' | 'skipped' | 'failed';
  /** 风神返回的总行数（全站，未过滤前）。 */
  total: number;
  /** 实际写入历史表的行数。 */
  saved: number;
  error?: string | null;
}

export interface DeliveryRollupResult {
  ok: boolean;
  started_at: string;
  finished_at: string;
  dates: string[];
  days: DeliveryHistoryDayResult[];
  saved_total: number;
  error?: string | null;
}

/**
 * 历史运单明细滚动更新（每天 04:00 北京时间，T-1 ~ T-7）。
 *
 * 为什么是「滚动」而不是「只补昨天」：风神侧前几天的数据会持续变动（运单状态流转、
 * 申诉改判、迟到补录），单次抓取不是终态。每天把最近 7 天重刷一遍，历史表始终等于
 * 「窗口内日期的最新快照」，看板查历史不需要再做去重或补洞。
 *
 * 取数复用共享底座 `OrdersFetchService.fetchOrders`（一次拉全站，时间维度固定
 * trackingFinish），落库走 `DeliveryHistoryStoreService.replaceDay` 整日覆盖写。
 *
 * 保护：某天取数为 0 行或取数失败时**不动历史表**（标记 skipped / failed），
 * 避免一次抖动把已经存好的历史清空 —— 这是整日覆盖写唯一的真实风险点。
 */
@Injectable()
export class DeliveryHistoryService implements OnModuleInit {
  private readonly logger = new Logger(DeliveryHistoryService.name);
  private running = false;

  constructor(
    private readonly orders: OrdersFetchService,
    private readonly store: DeliveryHistoryStoreService,
    private readonly opLog: OperationLogService,
  ) {}

  onModuleInit(): void {
    this.logger.log(`历史运单明细滚动更新已就绪（每日 04:00 北京时间刷新 T-1 ~ T-${HISTORY_WINDOW_DAYS}）`);
  }

  /** 滚动窗口日期（北京时间，最近的在前）：T-1 ... T-7。 */
  windowDates(base: Date = new Date()): string[] {
    const out: string[] = [];
    for (let i = 1; i <= HISTORY_WINDOW_DAYS; i++) {
      const d = new Date(base.getTime() - i * 86400000 + 8 * 3600 * 1000);
      out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
    }
    return out;
  }

  /** 每天 04:00（北京时间）滚动更新 T-1 ~ T-7 到 `delivery_history`。 */
  @Cron('0 4 * * *', { timeZone: 'Asia/Shanghai' })
  async dailyRollup(): Promise<void> {
    try {
      const r = await this.rollup(undefined, {
        source: 'DeliveryHistoryService.dailyRollup[@Cron 0 4 * * *]',
        operator: 'system',
      });
      this.logger.log(
        `历史运单明细滚动完成：${r.dates[0]} ~ ${r.dates[r.dates.length - 1]}，` +
          `共入库 ${r.saved_total} 条（${r.days.filter((d) => d.status === 'ok').length}/${r.days.length} 天成功）`,
      );
    } catch (e) {
      this.logger.error(`历史运单明细滚动失败：${(e as Error).message}`);
    }
  }

  /** 滚动更新指定日期（默认 T-1 ~ T-7）。串行逐天，单天失败不影响其它天。 */
  async rollup(
    dates?: string[],
    ctx?: { source?: string; operator?: string },
  ): Promise<DeliveryRollupResult> {
    const started = beijingNowStr();
    const list = (dates && dates.length ? dates : this.windowDates()).slice(0, MAX_DATES);
    const fail = (error: string): DeliveryRollupResult => ({
      ok: false, started_at: started, finished_at: beijingNowStr(),
      dates: list, days: [], saved_total: 0, error,
    });

    if (!this.store.ready) {
      const why = 'DATABASE_URL 未配置，PG 未启用：无法写入历史运单明细';
      this.logger.error(why);
      return fail(why);
    }
    if (this.running) return fail('上一轮滚动更新仍在进行中');

    this.running = true;
    this.logger.log(`历史运单明细滚动开始：${list.join(', ')}`);
    const days: DeliveryHistoryDayResult[] = [];
    try {
      for (const d of list) {
        try {
          const [startMs, endMs] = dayRangeMs(d);
          const rows = await this.orders.fetchOrders(startMs, endMs, 'trackingFinish');
          const withTeam = rows.filter((r) => String(r['teamId'] ?? '').trim() !== '');
          if (!withTeam.length) {
            // 空结果不覆盖：可能是会话抖动而非真的没单，保住已有历史
            days.push({ date: d, status: 'skipped', total: rows.length, saved: 0, error: '该日取数为空，已保留历史原数据' });
            this.logger.warn(`历史滚动 ${d}：取数为空（${rows.length} 行），跳过写入`);
          } else {
            const saved = await this.store.replaceDay(d, withTeam);
            days.push({ date: d, status: 'ok', total: rows.length, saved, error: null });
            this.logger.log(`历史滚动 ${d}：入库 ${saved} 条`);
          }
        } catch (e) {
          const why = (e as Error).message;
          days.push({ date: d, status: 'failed', total: 0, saved: 0, error: why });
          this.logger.error(`历史滚动 ${d} 失败：${why}`);
        }
        await sleep(GAP_MS);
      }
    } finally {
      this.running = false;
    }

    const savedTotal = days.reduce((s, d) => s + d.saved, 0);
    const result: DeliveryRollupResult = {
      ok: !days.some((d) => d.status === 'failed'),
      started_at: started,
      finished_at: beijingNowStr(),
      dates: list,
      days,
      saved_total: savedTotal,
      error: null,
    };
    try {
      await this.store.setMeta('last_run', JSON.stringify(result));
    } catch (e) {
      this.logger.error(`写入滚动运行状态失败：${(e as Error).message}`);
    }
    // 操作日志：记录「谁用哪段代码写了 delivery_history」（非 HTTP，拦截器覆盖不到）
    try {
      await this.opLog.record({
        actor: ctx?.operator ?? 'system',
        action: ctx?.source ?? 'rollup.history',
        target: 'delivery_history',
        code: 'DeliveryHistoryService.rollup',
        status: result.ok ? 200 : 500,
        detail: {
          dates: result.dates,
          saved_total: result.saved_total,
          days: result.days.map((d) => ({ date: d.date, status: d.status, saved: d.saved })),
        },
      });
    } catch {
      /* 审计失败不影响主流程 */
    }
    return result;
  }

  /** 上次滚动运行的快照（重启后仍可读，用于页面展示）。 */
  async lastRun(): Promise<DeliveryRollupResult | null> {
    try {
      const raw = await this.store.getMeta('last_run');
      return raw ? (JSON.parse(raw) as DeliveryRollupResult) : null;
    } catch {
      return null;
    }
  }
}
