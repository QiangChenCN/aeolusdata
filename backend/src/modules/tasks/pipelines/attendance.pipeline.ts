import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { TaskHandler, TaskRunContext, TaskStage } from '../task-handler';
import { Pipeline } from '../pipeline';
import { TaskHandlersService } from '../task-handlers.service';
import { AttendanceFetchService } from '../../fetch/attendance-fetch.service';
import { AeolusCookieService } from '../../fetch/aeolus-cookie.service';
import { ReportRenderService, TeamItem } from '../../render/report-render.service';
import { MinioService } from '../../media/minio.service';
import { DingtalkService } from '../../dingtalk/dingtalk.service';
import { ALL_MANAGER_IDS, PRODUCTION_GROUP_NAME } from '../../notify/notify-config';
import { readKnownTeams } from '../../fetch/teams-fetch.service';

const REST_STATES = new Set([2]);
const OFFLINE_STATES = new Set([3]);
const DETAIL_STATES = new Set([2, 3]);
const STATE_LABEL: Record<number, string> = { 2: '小休', 3: '下线' };

const TEST_GROUP_QUERY = '机器人测试';

// 站点名兜底不再硬编码：接口挂了时由 readKnownTeams()（落盘站点目录文件）补名。

/** 时段映射（含区间）。 */
const TIME_SLOTS: [number, number, string, string][] = [
  [0, 100, '凌晨1', '00:00-06:00'],
  [360, 111, '早餐1', '06:00-08:00'],
  [480, 112, '早餐2', '08:00-10:30'],
  [630, 120, '午高峰', '10:30-13:30'],
  [810, 130, '下午茶1', '13:30-15:30'],
  [930, 131, '下午茶2', '15:30-17:30'],
  [1050, 140, '晚高峰', '17:30-20:00'],
  [1200, 150, '夜宵1', '20:00-22:00'],
  [1320, 151, '夜宵2', '22:00-24:00'],
];

function fmtDuration(sec: unknown): string {
  const n = Number(sec ?? 0);
  if (!n) return '0';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

/** 在线率：最多 2 位小数；整数则按整数展示。 */
function fmtRate(online: number, sched: number): string {
  if (!sched) return '0';
  const r = Math.round((online * 100) / sched * 100) / 100;
  if (r === Math.trunc(r)) return String(Math.trunc(r));
  return r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

type TeamStat = [number, number, number, number, number, number];

/** 单站点统计 → [排班, 在线, 下线, 小休, 下线背单, 小休背单]。 */
function teamStats(data: Record<string, any>, queryCode: number): TeamStat {
  const riders: Record<string, any>[] = data.result?.data ?? [];
  const sched = riders.filter((r) => (r.timeCode || []).includes(queryCode));
  const online = sched.filter((r) => !REST_STATES.has(r.workStatus) && !OFFLINE_STATES.has(r.workStatus));
  const offline = sched.filter((r) => OFFLINE_STATES.has(r.workStatus));
  const rest = sched.filter((r) => REST_STATES.has(r.workStatus));
  const offDeliv = offline.filter((r) => (r.deliveryOrder || 0) > 0);
  const restDeliv = rest.filter((r) => (r.deliveryOrder || 0) > 0);
  return [sched.length, online.length, offline.length, rest.length, offDeliv.length, restDeliv.length];
}

interface DetailRow {
  knightName: string;
  site: string;
  state: string;
  delivering: number;
  slotFinish: number;
  slotValid: string;
  fullFinish: number;
  fullValid: string;
}

/** 从不在线骑手里抽明细行。 */
function filterDetail(
  data: Record<string, any>,
  queryCode: number,
  siteName: string,
  teamId: string | number,
): DetailRow[] {
  void teamId;
  const riders: Record<string, any>[] = data.result?.data ?? [];
  const rows: DetailRow[] = [];
  for (const r of riders) {
    if (!(r.timeCode || []).includes(queryCode)) continue;
    const ws = r.workStatus;
    if (!DETAIL_STATES.has(ws)) continue;
    const isRest = REST_STATES.has(ws);
    rows.push({
      knightName: r.knightName,
      site: siteName,
      state: STATE_LABEL[ws] ?? String(ws),
      delivering: r.deliveryOrder || 0,
      slotFinish: r.timeFinishOrder || 0,
      slotValid: isRest ? '0' : fmtDuration(r.timeValidOnlineTime),
      fullFinish: r.fullDayFinishOrder || 0,
      fullValid: isRest ? '0' : fmtDuration(r.fullDayValidOnlineTime),
    });
  }
  return rows;
}

interface Summary {
  query_time: string;
  slot_code: number;
  slot_name: string;
  slot_range: string;
  teams: Record<string, any>[];
  total: Record<string, any>;
}

/** 实时在线播报（原 jobs/attendance/attendance.py）。 */
@Injectable()
export class AttendancePipeline implements TaskHandler {
  readonly id = 'attendance';
  readonly stages: TaskStage[] = [
    { id: 'fetch', name: '拉取实时考勤' },
    { id: 'render', name: '渲染图片' },
    { id: 'upload', name: '上传图片到MinIO' },
    { id: 'send', name: '发送消息到钉钉' },
  ];
  private readonly outDir: string;
  private readonly rawDir: string;

  constructor(
    private readonly handlers: TaskHandlersService,
    private readonly fetchSvc: AttendanceFetchService,
    private readonly cookies: AeolusCookieService,
    private readonly render: ReportRenderService,
    private readonly minio: MinioService,
    private readonly dingtalk: DingtalkService,
    config: ConfigService,
  ) {
    this.handlers.register(this);
    const root = path.resolve(
      config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.outDir = path.join(root, 'python', 'jobs', 'attendance', 'out');
    this.rawDir = path.join(this.outDir, 'attendance_raw');
  }

  private get imgPath(): string {
    return path.join(this.outDir, 'attendance_absent.png');
  }
  private get summaryPath(): string {
    return path.join(this.outDir, 'attendance_summary.json');
  }
  private get lastTeamsFile(): string {
    return path.join(this.outDir, 'last_teams.txt');
  }

  // ── 时段 ──
  private currentTimeSlot(): [number, string, string] {
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
    let sel = TIME_SLOTS[0];
    for (const s of TIME_SLOTS) {
      if (mins >= s[0]) sel = s;
      else break;
    }
    return [sel[1], sel[2], sel[3]];
  }

  // ── 站点列表 ──
  private parseTeamsArg(s: string): TeamItem[] {
    const out: TeamItem[] = [];
    for (const raw of (s || '').split(',')) {
      const part = raw.trim();
      if (!part) continue;
      const sep = part.includes('=') ? '=' : part.includes('：') ? '：' : null;
      if (sep) {
        const [tid, name] = part.split(sep);
        out.push([String(Number(tid.trim())), name.trim()]);
      } else {
        out.push([String(Number(part)), part]);
      }
    }
    if (!out.length) throw new Error('--teams 没解析到任何站点');
    return out;
  }

  private loadLastTeams(): TeamItem[] {
    if (!fs.existsSync(this.lastTeamsFile)) return [];
    try {
      const s = fs.readFileSync(this.lastTeamsFile, 'utf-8').trim();
      if (!s) return [];
      return this.parseTeamsArg(s);
    } catch {
      return [];
    }
  }

  private saveLastTeams(items: TeamItem[]): void {
    try {
      fs.mkdirSync(this.outDir, { recursive: true });
      fs.writeFileSync(this.lastTeamsFile, items.map(([t, n]) => `${t}=${n}`).join(','), 'utf-8');
    } catch (e) {
      this.logger(`  ⚠ 写入上次站点记录失败：${(e as Error).message}`);
    }
  }

  private logger(msg: string): void {
    // 无 ctx 场景（saveLastTeams）时的兜底输出
    console.log(msg);
  }

  /** 只给纯 ID 时，用本地记录 + 兜底清单补名（不联网）。 */
  private fillTeamNames(items: TeamItem[], log: (s: string) => void): TeamItem[] {
    const need = items.some(([tid, nm]) => String(nm) === String(tid));
    if (!need) return items;
    const mapping: Record<string, string> = {};
    for (const t of readKnownTeams()) mapping[t.id] = t.name;
    for (const [tid, nm] of this.loadLastTeams()) mapping[tid] = nm;
    const out: TeamItem[] = items.map(([tid, nm]) => [tid, mapping[tid] || nm]);
    const still = out.filter(([t, n]) => String(n) === String(t)).map(([t]) => t);
    if (still.length) {
      log(`  ⚠ 有 ${still.length} 个站点 ID 查不到名字（图片上会显示 ID）：${still.join(',')}`);
      log(`     在界面上重新勾选一次站点，即可把名称写入 ${this.lastTeamsFile}`);
    }
    return out;
  }

  /** 风神返回是否为有效数据；401/未登录/无 result 直接抛，触发上层重登重试。 */
  private assertAttendanceData(data: Record<string, any>, name: string): void {
    const code = data?.code;
    if (
      code === 401 ||
      String(code) === '401' ||
      data?.error?.name === 'UNAUTHORIZED' ||
      (data?.error?.message || '').includes('未登录')
    ) {
      throw new Error(`风神未登录/会话失效（${name}）`);
    }
    if (!data || data.result == null) {
      throw new Error(`风神返回异常（${name}）：缺少 result`);
    }
  }

  /** 判断异常是否由风神登录态失效引起（决定是否触发重登重试）。 */
  private isAuthError(e: unknown): boolean {
    const m = (e as Error)?.message || '';
    return /未登录|会话失效|UNAUTHORIZED|401/.test(m);
  }

  async run(ctx: TaskRunContext): Promise<void> {
    const a = ctx.args;
    const testMode = Boolean(a['--test']);
    const noAt = testMode || Boolean(a['--no-at']);
    const groupArg = String(a['--group'] ?? a['--group-name'] ?? '');
    const teamArg = a['--teams'] ? this.parseTeamsArg(String(a['--teams'])) : null;

    const state: {
      teamItems?: TeamItem[];
      stats?: Record<string, TeamStat>;
      allRows?: DetailRow[];
      summary?: Summary;
      imgUrl?: string;
    } = {};
    const p = new Pipeline(ctx, state);

    p.stage('fetch', '拉取实时考勤', async () => {
      const [queryCode, queryName, rangeStr] = this.currentTimeSlot();
      const cookie = await this.cookies.ensure();

      let teamItems: TeamItem[];
      if (teamArg) {
        teamItems = this.fillTeamNames(teamArg, (s) => ctx.log(s));
        ctx.log(`[fetch] 站点来源：界面勾选 / 命令行指定，共 ${teamItems.length} 个`);
      } else {
        teamItems = this.loadLastTeams();
        if (teamItems.length) {
          ctx.log(`[fetch] 站点来源：沿用上次选择（${this.lastTeamsFile}），共 ${teamItems.length} 个`);
        } else {
          teamItems = readKnownTeams().map((t) => [t.id, t.name] as TeamItem);
          ctx.log(`  ⚠ 没有上次选择记录，回落落盘站点目录（${teamItems.length} 个）`);
        }
      }
      this.saveLastTeams(teamItems);
      fs.mkdirSync(this.rawDir, { recursive: true });
      ctx.log(`[fetch] 时段：${queryName}（${queryCode}，${rangeStr}），站点 ${teamItems.length} 个：`);
      for (const [tid, nm] of teamItems) ctx.log(`    - ${nm} (${tid})`);

      const stats: Record<string, TeamStat> = {};
      const allRows: DetailRow[] = [];
      const results = await Promise.all(
        teamItems.map(async ([teamId, name]) => {
          try {
            const data = await this.fetchSvc.fetchTeam(teamId, queryCode, cookie);
            this.assertAttendanceData(data, name);
            return { teamId, name, data, err: null as string | null };
          } catch (e1) {
            // 风神登录态可能已失效（401/未登录/会话失效）：强制重登后重试一次
            if (!this.isAuthError(e1)) throw e1;
            try {
              const cookie2 = await this.cookies.relogin();
              const data = await this.fetchSvc.fetchTeam(teamId, queryCode, cookie2);
              this.assertAttendanceData(data, name);
              return { teamId, name, data, err: null as string | null };
            } catch (e2) {
              return { teamId, name, data: null, err: (e2 as Error).message };
            }
          }
        }),
      );
      for (const { teamId, name, data, err } of results) {
        if (err || !data) {
          ctx.log(`  ✗ [${name}] 查询失败：${err}`);
          continue;
        }
        const st = teamStats(data, queryCode);
        stats[teamId] = st;
        const rows = filterDetail(data, queryCode, name, teamId);
        ctx.log(
          `  [${name}] 排班 ${st[0]} | 在线 ${st[1]} | 在线率 ${fmtRate(st[1], st[0])}% | 小休 ${st[3]} | 下线 ${st[2]} | 下线背单 ${st[4]} | 小休背单 ${st[5]} | 明细 ${rows.length} 人`,
        );
        for (const r of rows) {
          ctx.log(
            `    - ${r.knightName} 状态=${r.state} 配送中=${r.delivering} 本时段完成=${r.slotFinish} 本时段有效在线=${r.slotValid}`,
          );
        }
        allRows.push(...rows);
        fs.writeFileSync(
          path.join(this.rawDir, `team_${teamId}_${queryCode}.json`),
          JSON.stringify(data, null, 2),
          'utf-8',
        );
      }
      ctx.log(`[fetch] 汇总：明细 ${allRows.length} 人（小休+下线）`);
      // 全部站点都查不到（多半登录态失效）→ 显式失败，避免渲染空图还标记成功
      if (Object.keys(stats).length === 0) {
        throw new Error('所有站点考勤查询均失败（风神登录态可能已失效，请重登后重试）');
      }

      let tSched = 0;
      let tOnline = 0;
      let tRest = 0;
      let tOffline = 0;
      let tOffDeliv = 0;
      let tRestDeliv = 0;
      const teamsSummary: Record<string, any>[] = [];
      for (const [teamId, name] of teamItems) {
        if (!(teamId in stats)) continue;
        const [sched, online, offline, rest, offDeliv, restDeliv] = stats[teamId];
        teamsSummary.push({
          team_id: teamId,
          name,
          sched,
          online,
          rate: fmtRate(online, sched),
          offline,
          rest,
          offline_deliv: offDeliv,
          rest_deliv: restDeliv,
          detail_count: allRows.filter((r) => r.site === name).length,
        });
        tSched += sched;
        tOnline += online;
        tRest += rest;
        tOffline += offline;
        tOffDeliv += offDeliv;
        tRestDeliv += restDeliv;
      }
      const bj = new Date(Date.now() + 8 * 3600 * 1000);
      const pp = (n: number) => String(n).padStart(2, '0');
      const summary: Summary = {
        query_time: `${bj.getUTCFullYear()}-${pp(bj.getUTCMonth() + 1)}-${pp(bj.getUTCDate())} ${pp(bj.getUTCHours())}:${pp(bj.getUTCMinutes())}`,
        slot_code: queryCode,
        slot_name: queryName,
        slot_range: rangeStr,
        teams: teamsSummary,
        total: {
          sched: tSched,
          online: tOnline,
          rate: fmtRate(tOnline, tSched),
          offline: tOffline,
          rest: tRest,
          offline_deliv: tOffDeliv,
          rest_deliv: tRestDeliv,
          detail_count: allRows.length,
        },
      };
      fs.writeFileSync(this.summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
      ctx.log(`[fetch] summary 已落盘：${this.summaryPath}`);

      state.teamItems = teamItems;
      state.stats = stats;
      state.allRows = allRows;
      state.summary = summary;
    });

    p.stage('render', '渲染图片', () => {
      const summary = this.loadSummary();
      const { allRows, teamItems, stats } = this.rebuild(summary);
      ctx.log(`[render] 节点数：${allRows.length} | 站点数：${teamItems.length}`);
      const out = this.render.renderAllTeams(
        allRows as never,
        summary.slot_name,
        summary.slot_range,
        teamItems,
        stats as never,
        this.imgPath,
      );
      ctx.log(`[render] PNG 已生成：${out}`);
    });

    p.stage('upload', '上传图片到MinIO', async () => {
      if (!fs.existsSync(this.imgPath)) {
        throw new Error(`找不到图片：${this.imgPath}；先跑 render 节点`);
      }
      state.imgUrl = await this.minio.upload(this.imgPath, 'attendance');
      ctx.log(`[upload] 图片已上传：${state.imgUrl}`);
    });

    p.stage('send', '发送消息到钉钉', async () => {
      let groupId = groupArg;
      if (!groupId) {
        groupId = PRODUCTION_GROUP_NAME;
        ctx.log(`⚠ 未指定 --group / --group-name，回落到默认群「${PRODUCTION_GROUP_NAME}」（生产）`);
        ctx.log(`  试跑请加 --test（自动切「${TEST_GROUP_QUERY}」群且不 @ 真人）`);
      }
      if (!fs.existsSync(this.imgPath)) {
        throw new Error(`找不到图片：${this.imgPath}；先跑 render 节点`);
      }
      if (!fs.existsSync(this.summaryPath)) {
        throw new Error(`找不到汇总：${this.summaryPath}；先跑 fetch 节点`);
      }
      const summary = this.loadSummary();
      // send 节点自己负责上传（兼容单独跑 send）
      const imgUrl = state.imgUrl || (await this.minio.upload(this.imgPath, 'attendance'));
      const ids = noAt ? [] : ALL_MANAGER_IDS;
      const mentions = ids.length ? ids.map((i) => `<@${i}>`).join(' ') : '';
      const tot = summary.total;
      const text =
        `## 实时在线\n` +
        `**时段：** ${summary.slot_name}（${summary.slot_range}）　**查询时间：** ${summary.query_time}\n\n` +
        `![实时在线明细](${imgUrl})\n\n` +
        `请各站长关注当前时段有排班但未在线的人员（共 ${tot.detail_count} 人）：${mentions}`;
      const out = await this.dingtalk.sendMessage({ group: groupId, text, atOpenDingTalkIds: ids });
      ctx.log(`[send] 消息发送：${JSON.stringify(out).slice(0, 300)}`);
    });

    await p.run();
  }

  private loadSummary(): Summary {
    if (!fs.existsSync(this.summaryPath)) {
      throw new Error(`找不到汇总：${this.summaryPath}；请先跑 fetch 节点`);
    }
    return JSON.parse(fs.readFileSync(this.summaryPath, 'utf-8')) as Summary;
  }

  /** render 单独跑时从磁盘重建 all_rows / team_items / stats。 */
  private rebuild(summary: Summary): {
    allRows: DetailRow[];
    teamItems: TeamItem[];
    stats: Record<string, TeamStat>;
  } {
    const teamsSummary = summary.teams || [];
    const teamItems: TeamItem[] = teamsSummary.map((t) => [String(t.team_id), String(t.name)]);
    const stats: Record<string, TeamStat> = {};
    for (const t of teamsSummary) {
      stats[String(t.team_id)] = [
        t.sched,
        t.online,
        t.offline,
        t.rest,
        t.offline_deliv,
        t.rest_deliv,
      ];
    }
    const allRows: DetailRow[] = [];
    for (const [tid, name] of teamItems) {
      const rawPath = path.join(this.rawDir, `team_${tid}_${summary.slot_code}.json`);
      if (!fs.existsSync(rawPath)) continue;
      const data = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
      allRows.push(...filterDetail(data, summary.slot_code, name, tid));
    }
    return { allRows, teamItems, stats };
  }
}
