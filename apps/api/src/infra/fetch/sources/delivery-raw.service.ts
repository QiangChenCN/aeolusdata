import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { AeolusCookieService } from '../creds/aeolus-cookie.service';
import { AuthError, DeliveryQueryService, PAGE_SIZE } from './delivery-query.service';

/**
 * 运单原始层抓取（移植 jobs/delivery/raw_fetch.py）。
 *
 * 负责按天切片、JSONL 落盘、断点续传、自动重登、限流退避 —— 这些是**任务编排**，
 * 不属于 get_data 的「纯取数」；纯 HTTP 仍在 DeliveryQueryService。
 */

// ── 限速 / 退避常量（与 Python 逐字一致，改动需两边同步）──
export const SLEEP_MIN = 0.3;
export const SLEEP_MAX = 0.9;
export const SLEEP_COARSE_MIN = 0.8;
export const SLEEP_COARSE_MAX = 2.2;
export const BACKOFF_JITTER: [number, number] = [1.0, 1.5];
export const PAGE_INDEX_CAP = 190;
export const SEG_SPLIT_THRESHOLD = 9000;
export const FULL_DAY = '0-86400';
export const SEGMENTS_4 = ['0-21600', '21600-43200', '43200-64800', '64800-86400'];

export type LogFn = (msg: string) => void;

function randSleep(lo: number, hi: number): Promise<number> {
  if (hi < lo) [lo, hi] = [hi, lo];
  const s = lo + Math.random() * (hi - lo);
  return new Promise((r) => setTimeout(r, s * 1000)).then(() => s);
}

/** 失败退避：等满 base，再乘 1.0~1.5 的向上抖动。 */
export function backoffSleep(base: number): Promise<number> {
  return randSleep(base * BACKOFF_JITTER[0], base * BACKOFF_JITTER[1]);
}

/** 页间间隔：[SLEEP_MIN, sleepMax] 均匀随机。 */
export async function pageSleep(sleepMax?: number): Promise<number> {
  const hi = sleepMax == null ? SLEEP_MAX : Number(sleepMax);
  return randSleep(SLEEP_MIN, hi);
}

/** 时段间 / 天间粗粒度间隔：[0.8, 2.2]。 */
export function coarseSleep(): Promise<number> {
  return randSleep(SLEEP_COARSE_MIN, SLEEP_COARSE_MAX);
}

/** 北京时间某天的 [00:00:00, 23:59:59] 毫秒区间。 */
export function dayBounds(y: number, m: number, d: number): [number, number] {
  const s = Date.UTC(y, m - 1, d, -8, 0, 0);
  const e = Date.UTC(y, m - 1, d, 23 - 8, 59, 59);
  return [s, e];
}

export interface DayMeta {
  date: string;
  total: number;
  fetched: number;
  raw_rows: number;
  segments: Record<string, number>;
  ok: boolean;
  fetched_at: string;
  skipped?: boolean;
}

@Injectable()
export class DeliveryRawService {
  private readonly logger = new Logger(DeliveryRawService.name);
  readonly rawDir: string;
  private cookie = '';

  constructor(
    private readonly config: ConfigService,
    private readonly cookies: AeolusCookieService,
    private readonly query: DeliveryQueryService,
  ) {
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.rawDir = path.join(root, 'apps', 'api', 'runtime', 'jobs', 'delivery', 'out', 'delivery_raw');
  }

  private ts(): string {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }

  /** 初始化 cookie（对应 Python Session.__init__）。异步：登录现在要走 HTTP 探针 / SSO。 */
  async initCookie(): Promise<string> {
    this.cookie = await this.cookies.ensure();
    return this.cookie;
  }

  /** 单次分页请求 + 重试 + 会话失效重登（最多 5 次）。 */
  private async call(
    startMs: number,
    endMs: number,
    current: number,
    pageSize: number,
    period: string,
    log: LogFn,
  ): Promise<{ rows: Record<string, any>[]; total: number }> {
    let relogin = 0;
    for (;;) {
      let lastErr: Error | null = null;
      let authErr: Error | null = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          return await this.query.query({
            startMs,
            endMs,
            current,
            pageSize,
            period,
            cookie: this.cookie,
          });
        } catch (e) {
          const err = e as Error;
          if (e instanceof AuthError) {
            authErr = err;
            break;
          }
          const msg = err.message || '';
          if (msg.startsWith('net ') || /频繁|FREQUENT/i.test(msg)) {
            lastErr = err;
            continue;
          }
          throw err;
        }
      }
      if (authErr) {
        if (relogin >= 5) throw new Error(`会话连续失效 5 次: ${authErr.message}`);
        relogin += 1;
        log(`会话失效(${authErr.message})，重新登录 第${relogin}次`);
        this.cookie = await this.cookies.relogin();
        await backoffSleep(2);
        continue;
      }
      throw new Error(`重试 8 次仍失败: ${lastErr?.message}`);
    }
  }

  private async fetchSegment(
    sMs: number,
    eMs: number,
    period: string,
    sleep: number,
    log: LogFn,
  ): Promise<{ rows: Record<string, any>[]; total: number }> {
    const rows: Record<string, any>[] = [];
    const first = await this.call(sMs, eMs, 1, PAGE_SIZE, period, log);
    const total = first.total;
    if (total === 0) return { rows: [], total: 0 };
    const pages = Math.ceil(total / PAGE_SIZE);
    if (pages > PAGE_INDEX_CAP) {
      log(`  !! 时段 ${period} total=${total} 超页码上限，需更细切片`);
    }
    for (let cur = 1; cur <= Math.min(pages, PAGE_INDEX_CAP); cur++) {
      const { rows: page, total: t } = await this.call(sMs, eMs, cur, PAGE_SIZE, period, log);
      if (!page.length) break;
      rows.push(...page);
      if (cur % 20 === 0 || cur === pages) {
        log(`  ${period} 第${cur}/${pages}页 累计${rows.length}/${t}`);
      }
      await pageSleep(sleep);
    }
    return { rows, total };
  }

  /** 抓单日全部运单明细，落 JSONL（断点续传：已完成标记则跳过）。 */
  async fetchDay(
    dateStr: string,
    sleep: number,
    force: boolean,
    log: LogFn,
  ): Promise<DayMeta> {
    fs.mkdirSync(this.rawDir, { recursive: true });
    const key = dateStr;
    const out = path.join(this.rawDir, `${key}.jsonl`);
    const metaP = path.join(this.rawDir, `${key}.meta.json`);
    if (!force && fs.existsSync(metaP)) {
      try {
        const m = JSON.parse(fs.readFileSync(metaP, 'utf-8')) as DayMeta;
        if (m.ok) {
          log(`${key} 已完成(${m.fetched}条)，跳过`);
          return { ...m, skipped: true };
        }
      } catch {
        /* meta 损坏：当作未完成，重抓 */
      }
    }
    const [y, mo, d] = key.split('-').map(Number);
    const [sMs, eMs] = dayBounds(y, mo, d);
    const head = await this.call(sMs, eMs, 1, 1, FULL_DAY, log);
    const total = head.total;
    log(`${key} 接口 total=${total}`);
    const segs = total > SEG_SPLIT_THRESHOLD ? SEGMENTS_4 : [FULL_DAY];
    if (segs.length > 1) log(`${key} 单量超 ${SEG_SPLIT_THRESHOLD}，按 4 时段切片抓取`);

    const allRows: Record<string, any>[] = [];
    const segTotals: Record<string, number> = {};
    for (const seg of segs) {
      const r = await this.fetchSegment(sMs, eMs, seg, sleep, log);
      segTotals[seg] = r.total;
      allRows.push(...r.rows);
      await coarseSleep();
    }

    const seen = new Set<unknown>();
    const dedup: Record<string, any>[] = [];
    for (const r of allRows) {
      const tid = r.trackingId;
      if (seen.has(tid)) continue;
      seen.add(tid);
      dedup.push(r);
    }
    fs.writeFileSync(out, dedup.map((r) => JSON.stringify(r)).join('\n') + (dedup.length ? '\n' : ''), 'utf-8');
    const meta: DayMeta = {
      date: key,
      total,
      fetched: dedup.length,
      raw_rows: allRows.length,
      segments: segTotals,
      ok: dedup.length >= total * 0.995,
      fetched_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '').slice(0, 19),
    };
    fs.writeFileSync(metaP, JSON.stringify(meta, null, 2), 'utf-8');
    log(`${key} ${meta.ok ? 'OK' : '!! 缺量'} 落盘 ${dedup.length}/${total} -> ${out}`);
    return meta;
  }

  log(msg: string, sink: LogFn): void {
    sink(`[${this.ts()}] ${msg}`);
  }
}
