import { Injectable } from '@nestjs/common';
import { AeolusCookieService } from './aeolus-cookie.service';

/**
 * 站长任务看板取数（移植自 get_data/board.py，单一来源）。
 *
 * POST xtop.ryze.fs.agency.team.task.listByPage/1.0，按 status 分页拉全量。
 */
export const BOARD_API =
  'https://httpizza.ele.me/xtop/xtop.ryze.fs.agency.team.task.listByPage/1.0';

const HEADERS_BASE: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json',
  origin: 'https://a.ele.me',
  referer: 'https://a.ele.me/',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0',
};

@Injectable()
export class BoardFetchService {
  constructor(private readonly cookies: AeolusCookieService) {}

  /**
   * 分页拉取站长任务（默认按 status='started' 服务端过滤，拿到「已开始」任务）。
   *
   * ⚠️ 实测：该接口 status 枚举值为英文 `'started'`；若传中文 `'已开始'` 会被误过滤成 0 条，
   * 故这里固定用 `'started'`。原始 task_board 也用此值，请求本身没问题。
   * 真正的「抓不到数据」根因是登录态过期 + `ensure()` 缓存短路永不重登（见
   * aeolus-cookie.service.ts 修复）；本方法额外加了 401 重登自愈与错误抛出。
   */
  async fetch(
    cookie?: string,
    status = 'started',
    pageSize = 100,
  ): Promise<Record<string, any>[]> {
    let ck = cookie || (await this.cookies.ensure());
    const all: Record<string, any>[] = [];
    let page = 1;
    let total = 0;
    let relogged = false; // 仅允许重登自愈一次，避免 401 死循环
    for (;;) {
      const payload = JSON.stringify({
        params: { queryVO: { pageSize, pageIndex: page, status } },
      });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let res: Response;
      let j: Record<string, any>;
      try {
        res = await fetch(BOARD_API, {
          method: 'POST',
          headers: { ...HEADERS_BASE, cookie: ck },
          body: payload,
          signal: ctrl.signal,
        });
        // 登录态失效（HTTP 401 / 未登录）：重登一次后重试当前页，避免静默返回空数组
        if (res.status === 401 && !relogged) {
          ck = await this.cookies.relogin();
          relogged = true;
          continue;
        }
        j = (await res.json()) as Record<string, any>;
      } finally {
        clearTimeout(timer);
      }
      // 即便 HTTP 200，业务层也可能返回 code=401 表示未登录
      if (j && j.code === 401 && !relogged) {
        ck = await this.cookies.relogin();
        relogged = true;
        continue;
      }
      if (j && j.code != null && j.code !== 200 && j.code !== '200') {
        throw new Error(
          `风神接口返回错误 code=${j.code}：${JSON.stringify(j.error ?? '')}`.slice(0, 300),
        );
      }
      const data = ((j.result || {}).data || {}) as Record<string, any>;
      const tasks: Record<string, any>[] = data.data || [];
      total = Number(data.total || 0);
      all.push(...tasks);
      if (all.length >= total || !tasks.length) break;
      page += 1;
    }
    return all;
  }
}
