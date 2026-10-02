import { Injectable } from '@nestjs/common';
import { AeolusCookieService } from './aeolus-cookie.service';

/**
 * 橙色风暴（QC 抽检判定）取数（移植自 get_data/orange_storm.py，单一来源）。
 *
 * GET {API}?hitTimeStart=&hitTimeEnd=&pageIndex=&pageSize= 按时间范围分页拉全量。
 */
export const ORANGE_STORM_API =
  'https://httpizza.ele.me/alsc-lpd-omp-inspection-prod/qc/fs/judgement/queryQcList';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0';

@Injectable()
export class OrangeStormFetchService {
  constructor(private readonly cookies: AeolusCookieService) {}

  /** 单次 GET，失败重试（间隔 1.5*(i+1) 秒）。 */
  private async httpJson(
    url: string,
    cookie: string,
    timeoutMs = 60000,
    retries = 3,
  ): Promise<Record<string, any>> {
    let last: unknown;
    for (let i = 0; i < retries; i++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          headers: {
            accept: 'application/json, text/plain, */*',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7',
            cookie,
            origin: 'https://a.ele.me',
            referer: 'https://a.ele.me/',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-site',
            'user-agent': UA,
          },
          signal: ctrl.signal,
        });
        return (await res.json()) as Record<string, any>;
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`请求失败: ${(last as Error)?.message ?? last}`);
  }

  /** 分页拉取 [startMs, endMs] 的 QC 判定列表，返回 { rows, total }。 */
  async fetchAll(
    startMs: number,
    endMs: number,
    cookie?: string,
    pageSize = 200,
  ): Promise<{ rows: Record<string, any>[]; total: number }> {
    const ck = cookie || (await this.cookies.ensure());
    const rows: Record<string, any>[] = [];
    let page = 1;
    let total: number | null = null;
    for (;;) {
      const url = `${ORANGE_STORM_API}?hitTimeStart=${startMs}&hitTimeEnd=${endMs}&pageIndex=${page}&pageSize=${pageSize}`;
      const j = await this.httpJson(url, ck);
      if (Number(j.code) !== 200) {
        throw new Error(`接口返回异常: ${JSON.stringify(j).slice(0, 300)}`);
      }
      const d = j.data || {};
      if (total === null) total = Number(d.total ?? 0);
      const batch: Record<string, any>[] = d.data || [];
      if (!batch.length) break;
      rows.push(...batch);
      if (rows.length >= (total ?? 0) || batch.length < pageSize) break;
      page += 1;
      await new Promise((r) => setTimeout(r, 300));
    }
    return { rows, total: total ?? 0 };
  }
}
