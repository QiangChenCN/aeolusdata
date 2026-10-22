import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AeolusCookieService } from '../../infra/fetch/creds/aeolus-cookie.service';
import { AssessmentHistoryStoreService } from './assessment-history-store.service';

/**
 * 考核看板 —— 商家拜访率（新专送拜访，15 分）取数。
 *
 * 数据源：风神 xtop 接口 `xtop.minos.core.IContactTaskService.querySubTaskPage/1.0`
 * （与 rider-query / 违规取数同一套 httpizza 范式，复用 AeolusCookieService 登录态）。
 * 鉴权复用项目既有的 AeolusCookieService（产出自 `AEOLUS_MOZI_TOKEN` 的会话 cookie），
 * 与现有违规/运单取数同一套，不另起登录。
 *
 * 落库：按 (mainTaskId, team_id='_all', date) 幂等 UPSERT 进 `assessment_history.db` 的
 * visit_history 表（商家拜访是「全公司批次」维度，非单站点，故 team_id 统一记 '_all'）。
 * Python `visit_source.fetch_visit_rate_period` 读取区间已拜访/总商家算拜访率。
 *
 * 注意：该接口真实响应结构（如何区「已拜访 / 总商家」）尚未在生产环境实测核实，本服务
 * 先落盘原始 payload 并做「尽力而为」的字段提取；提取不到时 visited/total 记 null，
 * 由 Python 侧按「缺失→降级为实时 +15 假设」处理，绝不臆造数字。
 */
const VISIT_API_URL =
  'https://httpizza.ele.me/xtop/xtop.minos.core.IContactTaskService.querySubTaskPage/1.0';

const VISIT_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json',
  origin: 'https://a.ele.me',
  referer:
    'https://a.ele.me/app/fnjp-gfe/pikipek-apps/aeolus/index.html?platform=fs',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0',
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 默认批次（当前月份的新专送拜访任务）；可通过 env VISIT_MAIN_TASK_ID 覆盖。 */
function defaultMainTaskId(): number {
  const v = process.env['VISIT_MAIN_TASK_ID'];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : 91467;
}

/**
 * 尽力而为地从响应里提取「已拜访 / 总商家」。
 * 先找常见聚合键（visitedCount / totalCount / visited / total / finishCount …），
 * 找不到且 data 是列表时，total=列表长度、visited=状态疑似「已拜访/已完成」的条目数；
 * 仍不行则都返回 null（让 Python 降级）。
 */
function extractVisitedTotal(j: any): { visited: number | null; total: number | null } {
  if (!j || typeof j !== 'object') return { visited: null, total: null };
  const result = j.result ?? j;
  const data = result?.data ?? {};
  // querySubTaskPage 结构：result.data.items[]（每项 status/statusDesc），result.data.totalCount。
  const items: any[] = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data)
      ? data
      : [];
  let total: number | null = null;
  if (data && data.totalCount != null && Number.isFinite(Number(data.totalCount))) {
    total = Number(data.totalCount);
  } else if (items.length) {
    total = items.length;
  }
  // 优先聚合口径（若接口直接给已拜访计数）。
  const pick = (...keys: string[]): number | null => {
    for (const k of keys) {
      const v = (data && data[k]) ?? (result && result[k]);
      if (v != null && !Array.isArray(v) && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
  };
  let visited = pick('visitedCount', 'visited', 'finishCount', 'finished', 'doneCount', 'contactCount');
  if (visited == null && items.length) {
    // 已拜访口径：status>=1（已建联/已拜访/已完成）；statusDesc 以「未」开头视为未拜访。
    let c = 0;
    for (const it of items) {
      const stn = Number(it?.status);
      const sd = String(it?.statusDesc ?? '');
      const contacted = (Number.isFinite(stn) && stn >= 1) || (sd !== '' && !sd.startsWith('未'));
      if (contacted) c += 1;
    }
    visited = c;
  }
  if (visited != null && total != null && visited > total) visited = total;
  return { visited, total };
}

@Injectable()
export class VisitFetchService {
  private readonly logger = new Logger(VisitFetchService.name);

  constructor(
    private readonly cookies: AeolusCookieService,
    private readonly config: ConfigService,
    private readonly history: AssessmentHistoryStoreService,
  ) {}

  /**
   * 拉取商家拜访明细并落历史库。
   * 入参：mainTaskId（缺省 VISIT_MAIN_TASK_ID / 91467）、date（YYYY-MM-DD，缺省今天）。
   * 出参：{ok, msg, visited, total}。
   */
  async fetchAndLand(mainTaskId?: number, date?: string): Promise<{
    ok: boolean;
    msg: string;
    visited?: number | null;
    total?: number | null;
  }> {
    const mid = mainTaskId && Number.isFinite(mainTaskId) ? mainTaskId : defaultMainTaskId();
    const d =
      date && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? date
        : new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

    let cookie = '';
    try {
      cookie = await this.cookies.ensure();
    } catch (e) {
      const msg = '风神登录失败: ' + (e as Error).message;
      this.logger.warn(msg);
      await this.history.upsertVisit(String(mid), '_all', d, null, null, { error: msg });
      return { ok: false, msg };
    }

    let last: { ok: boolean; msg: string; visited?: number | null; total?: number | null } | null =
      null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const body = { params: { param: { mainTaskId: mid, pageNo: 1, pageSize: 20 } } };
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(VISIT_API_URL, {
          method: 'POST',
          headers: { ...VISIT_HEADERS, cookie },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const j: any = await res.json();
        if (j?.code !== 200 && j?.result?.code != null && j.result.code !== 200) {
          const rc = j.result?.code;
          if (rc === 'REQUEST_TOO_FREQUENT' && attempt < 2) {
            await sleep(2000 * (attempt + 1));
            continue;
          }
          if (String(rc) === '401' || String(rc) === 'UNAUTHORIZED') {
            cookie = await this.cookies.relogin();
            continue;
          }
          const msg = '商家拜访接口返回异常 code=' + rc + ' msg=' + (j.result?.msg ?? '');
          this.logger.warn(msg);
          await this.history.upsertVisit(String(mid), '_all', d, null, null, j ?? {});
          return { ok: false, msg };
        }
        const { visited, total } = extractVisitedTotal(j);
        await this.history.upsertVisit(String(mid), '_all', d, visited, total, j ?? {});
        const msg = `商家拜访落库：visited=${visited}, total=${total}（mainTask=${mid}，${d}）`;
        this.logger.log('考核看板商家拜访取数：' + msg);
        return { ok: true, msg, visited, total };
      } catch (e) {
        if (attempt < 2) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        const msg = '商家拜访接口调用失败: ' + (e as Error).message;
        this.logger.error(msg);
        await this.history.upsertVisit(String(mid), '_all', d, null, null, { error: msg });
        return { ok: false, msg };
      }
    }
    return last ?? { ok: false, msg: '商家拜访取数重试后仍失败' };
  }
}
