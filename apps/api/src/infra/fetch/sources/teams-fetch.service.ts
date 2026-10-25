import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AeolusCookieService } from '../creds/aeolus-cookie.service';
import { netError } from '../../../common/net-error';

/**
 * 站点目录取数（原 Python `get_data/teams.py::fetch_teams` + `server.py::_fetch_all_teams`）。
 *
 * 单一接口：POST `xtop.lpd.intelligentConfig.getTeamsAll/1.0`，返回当前账号可见的全部站点。
 * 5 分钟内存缓存（选择器反复开关不重打风神）；登录态失效 / 网络异常时降级到**上次落盘的站点
 * 目录文件**（`apps/api/runtime/teams.json`，每次成功获取后写入），绝不让选择器空白。
 *
 * 站点目录不再内置任何硬编码清单：主来源是风神接口，兜底来源是落盘文件（Nest 整体不可达时
 * 由计算层直接读同一份文件）。所有需要站点名 / 站点列表的读取都走这份落盘文件。
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

/**
 * 站点目录落盘文件路径（与订单落盘同根 apps/api/runtime）。Nest 每次成功获取站点目录后写入，
 * 计算层 / 前端在风神接口不可达时直接读这份文件。
 */
function teamsFilePath(): string {
  return path.join(process.cwd(), 'runtime', 'teams.json');
}

/** 读上次落盘的站点目录（Nest 每次成功获取后写入）。接口不可达时的末位兜底来源。 */
export function readKnownTeams(): TeamRef[] {
  try {
    const j = JSON.parse(fs.readFileSync(teamsFilePath(), 'utf-8'));
    if (j && Array.isArray(j.teams)) return j.teams as TeamRef[];
  } catch {
    /* 文件不存在 / 损坏：返回空，由上层决定 */
  }
  return [];
}

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
      // 不再硬编码兜底清单：读上次落盘的站点目录文件。
      out.fallback = readKnownTeams();
    } else {
      // 每次成功获取站点目录后落盘，供计算层 / 前端在接口不可达时读取。
      this.persist(out.teams);
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
      throw netError(e);
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

  /** 成功获取站点目录后落盘到 apps/api/runtime/teams.json。 */
  private persist(teams: TeamRef[]): void {
    try {
      fs.writeFileSync(
        teamsFilePath(),
        JSON.stringify({ updatedAt: new Date().toISOString(), teams }, null, 2),
        'utf-8',
      );
    } catch (e) {
      this.logger.warn(`落盘站点目录失败: ${(e as Error).message}`);
    }
  }
}
