import { Injectable } from '@nestjs/common';
import { AeolusCookieService } from './aeolus-cookie.service';
import { STATIC_HEADERS, ViolationApiError } from './violation-fetch.service';

/**
 * 违规处罚明细列表取数（用户提供，独立于 `violation-fetch.service.ts` 的 CSV 下载）。
 *
 * 上游：风神 `violationOrderAeolusCenterApi.queryList/1.0`（分页 JSON 列表，区别于 download 的 CSV 导出）。
 * 入参：violationStartTime / violationEndTime（毫秒区间）+ pageNo / pageSize。
 * 错误语义复用 `ViolationApiError`（与 download 同源，便于上层统一区分会话失效与业务错误）。
 */
export const VIOLATION_LIST_URL =
  'https://httpizza.ele.me/xtop/xtop.lpd.quality.control.violation.violationOrderAeolusCenterApi.queryList/1.0';

@Injectable()
export class ViolationListFetchService {
  constructor(private readonly cookies: AeolusCookieService) {}

  /** 分页查询违规处罚明细，返回上游 result（含 data 列表与分页信息）。 */
  async queryList(
    startMs: number,
    endMs: number,
    pageNo = 1,
    pageSize = 10,
    cookie?: string,
  ): Promise<any> {
    const ck = cookie || (await this.cookies.ensure());
    const body = JSON.stringify({
      params: { request: { violationStartTime: startMs, violationEndTime: endMs, pageNo, pageSize } },
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let j: any;
    try {
      const res = await fetch(VIOLATION_LIST_URL, {
        method: 'POST',
        headers: { accept: 'application/json, text/plain, */*', ...STATIC_HEADERS, cookie: ck },
        body,
        signal: ctrl.signal,
      });
      j = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const result = j && typeof j === 'object' ? j.result : null;
    if (result === null || result === undefined) {
      const err = (j || {}).error || {};
      const code = String((j || {}).code || err.name || '');
      const msg = String(err.message || err.gracefulMsg || '');
      throw new ViolationApiError(`违规处罚明细列表接口返回空 result（code=${code} ${msg}）`, code);
    }
    const code = String(result.code || '');
    if (code && code !== '200') {
      throw new ViolationApiError(`违规处罚明细列表接口错误：code=${code} msg=${result.msg}`, code);
    }
    return result;
  }

  /**
   * 从上游 result 中递归找出"列表数组"与"总数"。
   * 不预设任何字段名：扫描整个响应体（深度≤3），把所有对象数组与含 total 的数字收集起来，
   * 取最大的对象数组作为列表、取最大的 total 数字作为总数。
   */
  private extractList(r: any): { list: any[]; total: number | null } {
    const arrays: any[][] = [];
    const totals: number[] = [];
    const walk = (node: any, depth: number) => {
      if (node == null || typeof node !== 'object' || depth > 3) return;
      if (Array.isArray(node)) {
        arrays.push(node);
        return;
      }
      for (const k of Object.keys(node)) {
        const v = (node as any)[k];
        if (Array.isArray(v)) arrays.push(v);
        else if (typeof v === 'number' && /total/i.test(k)) totals.push(v);
        else if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(r, 0);
    let list: any[] = [];
    for (const a of arrays) {
      if (a.length && a.every((x) => x && typeof x === 'object')) {
        if (a.length > list.length) list = a;
      }
    }
    const total = totals.length ? Math.max(...totals) : null;
    return { list, total };
  }

  /**
   * 拉取整段区间的全量明细（自动翻页），返回 `{total, rows, rawFirst}`。
   * 列表/总数通过 `extractList` 递归识别，兼容任意上游响应结构。
   * `rawFirst` 为首页原始 result，仅用于排查结构（确认后移除）。
   */
  async queryRange(
    startMs: number,
    endMs: number,
    pageSize = 200,
    cookie?: string,
  ): Promise<{ total: number; rows: any[] }> {
    const all: any[] = [];
    let page = 1;
    const MAX_PAGES = 200;
    while (page <= MAX_PAGES) {
      const r = await this.queryList(startMs, endMs, page, pageSize, cookie);
      const { list, total } = this.extractList(r);
      all.push(...list);
      if (total != null && total > 0 && all.length >= total) break;
      if (list.length < pageSize) break;
      page += 1;
    }
    return { total: all.length, rows: all };
  }
}
