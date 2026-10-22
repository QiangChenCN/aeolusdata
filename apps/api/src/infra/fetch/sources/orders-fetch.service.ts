import { Injectable, Logger } from '@nestjs/common';
import { FetchPaceService, MAX_RETRIES, RELOGIN_MAX, RELOGIN_BACKOFF_BASE, BACKOFF_BASE } from '../runners/fetch-pace.service';
import { DeliveryQueryService, AuthError, PAGE_SIZE } from './delivery-query.service';
import { AeolusCookieService } from '../creds/aeolus-cookie.service';
import { DeliveryExportService } from './delivery-export.service';

/** 单站单日超过此量则按时段切片（避免单段页码超限 / 长时间占用配额）。 */
export const SEG_SPLIT_THRESHOLD = 8000;
export const FULL_DAY = '0-86400';
export const SEGMENTS_4 = ['0-21600', '21600-43200', '43200-64800', '64800-86400'];
/** current*50 需 <10000，留余量。 */
export const PAGE_INDEX_CAP = 190;

// ---- 完整性校验（对应 Python 的 VERIFY_EXPORT_TOTAL / TOTAL_SHORT_TOLERANCE*）----
// 为什么必须有：运单接口**成功不等于完整**。2026-09-17 实测导出拿回 5793 行、
// 同期接口 total=5820，静默少 27 行且全程无报错 —— 下游「标准达成」按单量判定，
// 少几行就表现为个别骑手少算一单。因此固定做一次「行数 vs 接口 total」对账。
// 容忍 = 比例容忍(0) + 绝对行数豁免(20)：导出是异步快照、total 是实时值，
// 二者天然有 ±几行的边界差额（抓取期间新增的运单），这种缺口不该触发重取。
export const VERIFY_TOTAL = true;
export const TOTAL_SHORT_TOLERANCE = 0.0;
export const TOTAL_SHORT_TOLERANCE_MIN = 20;

function shortTolerance(total: number): number {
  return Math.floor(total * TOTAL_SHORT_TOLERANCE) + TOTAL_SHORT_TOLERANCE_MIN;
}

export type OrderRow = Record<string, unknown>;

/**
 * 运单抓取编排层（移植自 dashboard/standard/orders_fetch.py 的 Session + fetch_orders）。
 *
 * 职责边界：分页循环、时段切片、去重、页间节奏、限流退避、会话重登 —— 全在这里；
 * 单次 HTTP 在 DeliveryQueryService（只打 1 次，不连冲）。
 */
@Injectable()
export class OrdersFetchService {
  private readonly logger = new Logger(OrdersFetchService.name);
  private cookie = '';
  private reloginCount = 0;

  constructor(
    private readonly pace: FetchPaceService,
    private readonly query: DeliveryQueryService,
    private readonly cookies: AeolusCookieService,
    private readonly exportSvc: DeliveryExportService,
  ) {}

  /**
   * 懒取 cookie：登录现在是异步的（validToken 探针 + 必要时 SSO），不能在构造函数里做。
   * 每次抓取入口调一次即可 —— 服务内已有进程内缓存，重复调用不产生额外请求。
   */
  private async ensureCookie(): Promise<string> {
    if (!this.cookie) this.cookie = await this.cookies.ensure();
    return this.cookie;
  }

  /**
   * 打一次接口：AuthError → 自动重登；其它失败（限流/网络）→ 指数退避重试。
   * 与 Python Session.call 逐一对应。
   */
  private async call(
    startMs: number,
    endMs: number,
    current: number,
    pageSize: number,
    period: string,
    timeField?: string,
  ): Promise<{ rows: OrderRow[]; total: number }> {
    let attempt = 0;
    for (;;) {
      try {
        this.pace.bump('requests');
        const out = await this.query.query({
          startMs, endMs, current, pageSize, period, cookie: this.cookie, timeField,
        });
        this.pace.reward(); // 成功一页 → 间隔往小调（慢慢探快）
        this.pace.bump('ok');
        return out;
      } catch (e) {
        if (e instanceof AuthError) {
          if (this.reloginCount >= RELOGIN_MAX) {
            throw new Error(`会话连续失效 ${RELOGIN_MAX} 次: ${e.message}`);
          }
          this.reloginCount += 1;
          this.pace.bump('relogin');
          this.logger.warn(`会话失效(${e.message})，重新登录 第${this.reloginCount}次`);
          this.cookie = await this.cookies.relogin();
          await this.pace.backoffSleep(RELOGIN_BACKOFF_BASE, this.reloginCount - 1);
          attempt = 0; // 新会话，退避计数归零
          continue;
        }
        this.pace.penalize(); // 被限流/失败 → 间隔往大调（乘性退让）
        if (this.pace.isThrottle(e)) this.pace.bump('throttle');
        else this.pace.bump('failed');
        if (attempt >= MAX_RETRIES) throw e;
        this.pace.bump('retries');
        await this.pace.backoffSleep(BACKOFF_BASE, attempt);
        attempt += 1;
      }
    }
  }

  /** 抓单个时段切片的全部页，页间 pageSleep。 */
  private async fetchSegment(
    startMs: number,
    endMs: number,
    period: string,
    timeField?: string,
    firstRows?: OrderRow[],
    firstTotal?: number,
  ): Promise<{ rows: OrderRow[]; total: number }> {
    let rows: OrderRow[] = [];
    let total = firstTotal;
    let first = firstRows;
    if (first == null || total == null) {
      const p1 = await this.call(startMs, endMs, 1, PAGE_SIZE, period, timeField);
      first = p1.rows;
      total = p1.total;
    }
    if (!total || !first || !first.length) return { rows: [], total: total || 0 };
    rows = rows.concat(first);
    const pages = Math.ceil(total / PAGE_SIZE);
    if (pages > PAGE_INDEX_CAP) {
      this.logger.warn(`时段 ${period} total=${total} 超页码上限(${PAGE_INDEX_CAP})，需更细切片`);
    }
    for (let cur = 2; cur <= Math.min(pages, PAGE_INDEX_CAP); cur++) {
      const p = await this.call(startMs, endMs, cur, PAGE_SIZE, period, timeField);
      if (!p.rows || !p.rows.length) break;
      rows = rows.concat(p.rows);
      await this.pace.pageSleep();
    }
    return { rows, total };
  }

  /** 按 trackingId 去重（时段切片边界可能重复）。 */
  private dedup(rows: OrderRow[]): OrderRow[] {
    const seen = new Set<string>();
    const out: OrderRow[] = [];
    for (const r of rows) {
      const tid = r['trackingId'];
      if (tid == null) {
        out.push(r);
        continue;
      }
      const k = String(tid);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out;
  }

  /**
   * 拉时间窗内全部运单明细（自动切片 + 去重），返回去重后的行。
   *
   * **导出优先**：先走风神异步导出（一次性拿全站全量，零分页请求、无限流风险）；
   * 导出失败 / 返回空 / 完整性核对发现残缺，才回落到分页 fetchOrdersViaQuery。
   * 两种来源产出结构一致（dict 列表，teamId/trackingId 等英文键齐备），下游零改动。
   */
  async fetchOrders(startMs: number, endMs: number, timeField?: string): Promise<OrderRow[]> {
    this.pace.reset(); // 新一次抓取重置节奏，不继承上次的惩罚/加速状态
    await this.ensureCookie(); // 登录是异步的（探针 + 必要时 SSO），在抓取前拿到会话

    // ── 导出优先（异步导出，替代 ~125 页分页，零限流风险）──
    try {
      this.logger.log('尝试运单导出（异步导出，替代分页，零限流风险）...');
      const rows = await this.exportSvc.exportOrders(startMs, endMs, timeField, this.cookie);
      if (rows.length) {
        const deduped = this.dedup(rows);
        this.logger.log(`导出成功：拿回 ${deduped.length} 行（0 次分页请求）`);
        // 完整性核对（与接口 total 对账）：导出成功 ≠ 数据完整，残缺则回落分页。
        try {
          const total = await this.queryTotal(startMs, endMs, timeField);
          if (total != null) {
            const gap = Math.max(0, total - deduped.length);
            const tol = shortTolerance(total);
            this.logger.log(
              `完整性核对：导出 ${deduped.length} 行 / 接口 total=${total}，差 ${gap} 行`,
            );
            if (gap > tol) {
              this.logger.warn(`导出残缺（少 ${gap} 行），回落分页重取`);
              return this.fetchOrdersViaQuery(startMs, endMs, timeField);
            }
            this.logger.log(`差 ${gap} 行在容忍范围内（≤${tol}），沿用导出结果`);
          }
        } catch (e) {
          this.logger.warn(`导出后 total 核对失败，沿用导出结果：${(e as Error).message}`);
        }
        this.pace.bump('requests');
        this.pace.bump('ok');
        this.pace.persistFloor(); // 本次学到的下限存下来，下次刷新直接沿用
        return deduped;
      }
      this.logger.warn('导出返回空，回落分页取数');
    } catch (e) {
      this.logger.warn(
        `导出失败，回落分页取数：${(e as Error).name}: ${(e as Error).message}`,
      );
    }

    // ── 兜底：分页路径（带 AIMD 限流退避 + 自动重登）──
    return this.fetchOrdersViaQuery(startMs, endMs, timeField);
  }

  /** 只拿接口 total（一次第 1 页请求），供导出后完整性核对。失败返回 null。 */
  private async queryTotal(
    startMs: number,
    endMs: number,
    timeField?: string,
  ): Promise<number | null> {
    try {
      const p1 = await this.call(startMs, endMs, 1, PAGE_SIZE, FULL_DAY, timeField);
      return p1.total;
    } catch {
      return null;
    }
  }

  /** 分页拉全量运单（原 fetchOrders 主体）：自动切片 + 去重 + 完整性对账。 */
  private async fetchOrdersViaQuery(
    startMs: number,
    endMs: number,
    timeField?: string,
  ): Promise<OrderRow[]> {
    const first = await this.call(startMs, endMs, 1, PAGE_SIZE, FULL_DAY, timeField);
    const total = first.total;
    this.logger.log(`接口 total=${total}`);
    if (!total) return [];

    const segs = total > SEG_SPLIT_THRESHOLD ? SEGMENTS_4 : [FULL_DAY];
    let allRows: OrderRow[] = [];
    if (segs.length > 1) {
      this.logger.log(`单量超 ${SEG_SPLIT_THRESHOLD}，按 ${segs.length} 时段切片抓取`);
      for (const seg of segs) {
        const r = await this.fetchSegment(startMs, endMs, seg, timeField);
        allRows = allRows.concat(r.rows);
        await this.pace.coarseSleep(); // 时段之间
      }
    } else {
      // 单段：第 1 页（探总数那次）已拿到，直接续拉，不重复请求
      const r = await this.fetchSegment(startMs, endMs, FULL_DAY, timeField, first.rows, total);
      allRows = allRows.concat(r.rows);
    }
    const rows = this.dedup(allRows);
    this.logger.log(`抓取完成 ${rows.length}/${total} 条`);
    this.pace.persistFloor(); // 本次学到的下限存下来，下次刷新直接沿用

    // 完整性对账：行数比接口 total 少到容忍之外，必须显式告警 —— 静默少行会让
    // 下游按单量判定系统性少计（见文件头注释），绝不能悄悄放行。
    if (VERIFY_TOTAL) {
      const tol = shortTolerance(total);
      const shortBy = total - rows.length;
      if (shortBy > tol) {
        this.logger.warn(
          `!! 数据可能残缺：抓到 ${rows.length} 行，接口 total=${total}，` +
            `缺 ${shortBy} 行（超过容忍 ${tol} 行）`,
        );
      }
    }
    return rows;
  }
}
