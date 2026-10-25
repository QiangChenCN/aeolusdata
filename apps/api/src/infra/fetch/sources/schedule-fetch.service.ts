import { Injectable, Logger } from '@nestjs/common';
import { AeolusCookieService } from '../creds/aeolus-cookie.service';
import { netError } from '../../../common/net-error';

/**
 * 排班目标（排班统计）取数 —— 原 Python `get_data/schedule_statistics.py`。
 *
 * 单一接口：POST `xtop.fs.special.schedule.listScheduleStatistics/1.0`，
 * 返回按天列表（每天含 `timeList` 时段明细）。
 *
 * 保留 Python 原有的退避策略（这是被限流打过之后的经验值，别改）：
 *   · 网络异常 → 退避 `2 + attempt*2` 秒后重试
 *   · 被限流（code 含 FREQUENT / msg 含「频繁」）→ 退避 `3 + attempt*3` 秒后重试
 *   · 会话失效（result 为 null / 401 / 账户下线）→ **立即抛 SchedAuthError**，
 *     交由上层（`get_data.auth.call_with_relogin`）强制重登后重试
 */
export const SCHEDULE_API =
  'https://httpizza.ele.me/xtop/xtop.fs.special.schedule.listScheduleStatistics/1.0';

/** 与 Python `HEADERS_BASE` 逐字对应（上游对来源头敏感）。 */
const HEADERS_BASE: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json',
  origin: 'https://r.ele.me',
  referer: 'https://r.ele.me/pikipek/schedule.html?platform=fs&subType=ub',
};

const REQ_TIMEOUT_MS = 40_000;

/** 会话失效（与 Python `get_data.auth.AuthError` 同语义，带 code 以便上游判定）。 */
export class SchedAuthError extends Error {
  readonly code: string;
  constructor(message: string, code = '401') {
    super(message);
    this.name = 'SchedAuthError';
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class ScheduleFetchService {
  private readonly logger = new Logger(ScheduleFetchService.name);

  constructor(private readonly cookies: AeolusCookieService) {}

  /** `YYYY-MM-DD`（也接受 Date）。与 Python `_as_date_str` 同口径。 */
  private asDateStr(d: string | Date): string {
    if (d instanceof Date) {
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    return String(d);
  }

  /**
   * 单站排班统计 → `result.data`（按天列表）。
   *
   * @param retries 网络/限流的重试次数（沿用 Python 默认 8）
   * @param cookie  可选；不传则用共享 cookie（缺失才触发 Python 重登）
   */
  async query(
    teamId: number | string,
    startDate: string | Date,
    endDate: string | Date,
    retries = 8,
    cookie?: string,
  ): Promise<any[]> {
    const ck = cookie || (await this.cookies.ensure());
    const body = JSON.stringify({
      params: {
        request: {
          teamId: parseInt(String(teamId), 10),
          startDate: this.asDateStr(startDate),
          endDate: this.asDateStr(endDate),
        },
      },
    });

    let last = '';
    for (let attempt = 0; attempt < retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
      let j: any;
      try {
        const res = await fetch(SCHEDULE_API, {
          method: 'POST',
          headers: { ...HEADERS_BASE, cookie: ck },
          body,
          signal: ctrl.signal,
        });
        j = await res.json();
      } catch (e) {
        last = netError(e).message;
        this.logger.warn(`排班取数网络异常（第 ${attempt + 1}/${retries} 次）：${last}`);
        await sleep((2 + attempt * 2) * 1000);
        continue;
      } finally {
        clearTimeout(timer);
      }

      const result = j?.result;
      if (result == null) throw new SchedAuthError('result is null（会话被顶号）');
      const code = String(result.code);
      const msg = String(result.msg ?? '');
      if (code !== '200') {
        if (code === '401' || msg.includes('下线') || msg.includes('账户')) {
          throw new SchedAuthError(`${code} ${msg}`, code);
        }
        if (code.toUpperCase().includes('FREQUENT') || msg.includes('频繁')) {
          last = msg || code;
          this.logger.warn(`排班取数被限流（第 ${attempt + 1}/${retries} 次）：${last}`);
          await sleep((3 + attempt * 3) * 1000);
          continue;
        }
        throw new Error(`code=${code} msg=${msg}`);
      }
      return (result.data as any[]) || [];
    }
    throw new Error(`重试 ${retries} 次仍失败: ${last}`);
  }
}
