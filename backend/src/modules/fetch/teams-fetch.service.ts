import { Injectable, Logger } from '@nestjs/common';
import { AeolusCookieService } from './aeolus-cookie.service';

/**
 * 站点目录取数（原 Python `get_data/teams.py::fetch_teams` + `server.py::_fetch_all_teams`）。
 *
 * 单一接口：POST `xtop.lpd.intelligentConfig.getTeamsAll/1.0`，返回当前账号可见的全部站点。
 * 5 分钟内存缓存（选择器反复开关不重打风神）；登录态失效 / 网络异常时降级到写死的三站兜底
 * 清单，绝不让选择器空白。
 *
 * ⚠️ 兜底清单 `FALLBACK_TEAMS` 现为**唯一来源**：原 Python
 * `dashboard/standard/teams_config.py::TEAM_NAMES` 的「站点名」用途已改为回调本服务
 * （`GET /api/fetch/teams`，见 `compute_service/handlers.py::_fetch_all_teams`）。
 * 前端另有一份末位兜底副本见 `web/src/teams.js` —— **新增 / 改名站点需同步这两处**。
 */
export const TEAMS_API =
  'https://httpizza.ele.me/xtop/xtop.lpd.intelligentConfig.getTeamsAll/1.0';

/** 与 Python `get_data/teams.py::STATIC_HEADERS` 逐字对应（上游对请求头敏感，勿随意精简）。 */
const STATIC_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7',
  'content-type': 'application/json',
  origin: 'https://r.ele.me',
  referer: 'https://r.ele.me/pikipek/schedule.html?platform=fs&subType=ub',
  'sec-ch-ua': '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0',
};

/** 兜底三站（-UB）。风神不可达时保底，绝不让选择器空白。 */
export const FALLBACK_TEAMS: TeamRef[] = [
  { id: '917521130', name: '东莞市黄江镇站-UB' },
  { id: '917521136', name: '东莞市长安万科站-UB' },
  { id: '917521139', name: '东莞市大岭山大学城站-UB' },
];

export interface TeamRef {
  id: string;
  name: string;
}

export interface TeamsPayload {
  ok: boolean;
  teams: TeamRef[];
  source: 'xtop' | 'fallback';
  stale: boolean;
  fetched_at: number;
  error?: string;
  fallback?: TeamRef[];
}

/** 与 Python `_TEAMS_CACHE_TTL = 300` 一致。 */
const CACHE_TTL_SEC = 300;
/** 与 Python `timeout=30` 一致。 */
const REQ_TIMEOUT_MS = 30_000;

@Injectable()
export class TeamsFetchService {
  private readonly logger = new Logger(TeamsFetchService.name);
  private cache: { data: TeamsPayload | null; ts: number } = { data: null, ts: 0 };

  constructor(private readonly aeolus: AeolusCookieService) {}

  /**
   * 全部站点（5 分钟内存缓存）。
   *
   * 注意：**失败结果同样进缓存**（与 Python 原实现一致）—— 风神抖动时选择器会在 TTL 内
   * 稳定停留在兜底清单，不会每次开弹窗都重打接口。要立刻重试请传 force=true。
   */
  async fetchAll(force = false): Promise<TeamsPayload> {
    const nowSec = Date.now() / 1000;
    if (!force && this.cache.data && nowSec - this.cache.ts < CACHE_TTL_SEC) {
      return this.cache.data;
    }

    const out: TeamsPayload = {
      ok: true,
      teams: [],
      source: 'xtop',
      stale: false,
      fetched_at: nowSec,
    };
    let err: string | null = null;
    try {
      out.teams = await this.fetchFromXtop();
    } catch (e) {
      const x = e as Error;
      err = `${x.name || 'Error'}: ${x.message}`;
    }

    if (err || !out.teams.length) {
      out.ok = false;
      out.source = 'fallback';
      out.error = err || '风神接口未返回任何站点';
      out.fallback = FALLBACK_TEAMS.map((t) => ({ ...t }));
    }

    this.cache = { data: out, ts: nowSec };
    return out;
  }

  /** 打 xtop 取全量站点；失败抛错，由 fetchAll 决定回落兜底。 */
  private async fetchFromXtop(): Promise<TeamRef[]> {
    // 复用共享 cookie（缺失才触发 Python 重登）—— 与其它取数同一份登录态。
    const cookie = await this.aeolus.ensure();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    let j: any;
    try {
      const res = await fetch(TEAMS_API, {
        method: 'POST',
        headers: { ...STATIC_HEADERS, cookie },
        body: '{}',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      j = await res.json();
    } catch (e) {
      throw new Error(`net ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    const data = (j?.result?.data as any[]) || [];
    const out: TeamRef[] = [];
    for (const t of data) {
      // 只保留有效站点（teamStatus 为 1 或缺省）；停运/已下线站点跳过。
      const status = t?.teamStatus;
      if (status != null && status !== 1) continue;
      const id = t?.id;
      const name = t?.team_name;
      if (id && name) out.push({ id: String(id), name: String(name) });
    }
    this.logger.log(`xtop 站点目录：${out.length} 个`);
    return out;
  }
}
