import { Injectable } from '@nestjs/common';

/**
 * 运单明细接口单次请求（移植自 get_data/delivery.py 的 query）。
 *
 * 注意 retry 语义：Python 版编排层调用时固定传 retries=1（只打一次），
 * 失败交由 orders-fetch 的 Session 层做指数退避重试 —— 因为 query 内部遇到
 * 「请求太频繁」是立即 continue 连冲，实测会制造 2.8s/页均值、最长 40.9s 长尾。
 * 所以这里**不做重试循环**，只负责「发一次 + 判别错误类型」。
 */

export class AuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AuthError';
  }
}

export const API = 'https://httpizza.ele.me/xtop/xtop.agencyTrackingFs.queryTracking/2.0';
export const PAGE_SIZE = 50;
export const TIME_FIELD = 'trackingFinish';
export const TIME_FIELDS = ['trackingCreated', 'platformBooked', 'trackingFinish'];
export const REQ_TIMEOUT_MS = 40000;

const HEADERS_BASE: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json',
  origin: 'https://aeolus.ele.me',
  referer: 'https://aeolus.ele.me/',
};

export interface QueryResult {
  rows: Record<string, unknown>[];
  total: number;
}

function checkTimeField(f?: string): string {
  const t = f || TIME_FIELD;
  if (!TIME_FIELDS.includes(t)) {
    throw new Error(`未知 time_field: ${t}（可用 ${TIME_FIELDS.join('/')}）`);
  }
  return t;
}

/** 组装单次分页请求体（与 Python build_body 逐字段一致）。 */
export function buildBody(
  startMs: number,
  endMs: number,
  current: number,
  pageSize: number,
  period = '0-86400',
  timeField?: string,
) {
  const f = checkTimeField(timeField);
  return {
    params: {
      request: {
        [`${f}Start`]: startMs,
        [`${f}End`]: endMs,
        merchantConsumerDistanceStart: '0',
        merchantConsumerDistanceEnd: '999999',
        payAmountStart: '0',
        payAmountEnd: '999999',
        weightStart: '0',
        weightEnd: '999999',
        current,
        pageSize,
        trackingStateKey: 'all',
        trackingLabelKey: 'all',
        [`${f}TimePeriodList`]: [period],
      },
    },
  };
}

@Injectable()
export class DeliveryQueryService {
  /** 单次分页请求，返回 (rows, total)。
   *  会话失效抛 AuthError；限流抛含「频繁」/FREQUENT 的 Error，交由上层退避。 */
  async query(opts: {
    startMs: number;
    endMs: number;
    current: number;
    pageSize?: number;
    period?: string;
    cookie: string;
    timeField?: string;
  }): Promise<QueryResult> {
    const body = buildBody(
      opts.startMs,
      opts.endMs,
      opts.current,
      opts.pageSize || PAGE_SIZE,
      opts.period || '0-86400',
      opts.timeField,
    );
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    let j: any;
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { ...HEADERS_BASE, cookie: opts.cookie },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      j = await res.json();
    } catch (e) {
      throw new Error(`net ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    const result = j && j.result;
    if (result == null) throw new AuthError('result is null（会话被顶号）');
    const code = String(result.code);
    const msg = String(result.msg ?? '');
    if (code !== '200') {
      if (code.toUpperCase().includes('FREQUENT') || msg.includes('频繁')) {
        throw new Error(msg || 'FREQUENT');
      }
      if (code === '401' || msg.includes('下线') || msg.includes('账户')) {
        throw new AuthError(`${code} ${msg}`);
      }
      throw new Error(`code=${code} msg=${msg}`);
    }
    const d = result.data || {};
    return { rows: d.data || [], total: Number(d.total || 0) };
  }
}
