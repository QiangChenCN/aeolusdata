import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { TaskHandler, TaskRunContext, TaskStage, TaskStop } from '../task-handler';
import { Pipeline } from '../pipeline';
import { TaskHandlersService } from '../task-handlers.service';
import { OrangeStormFetchService } from '../../fetch/orange-storm-fetch.service';

/** 毫秒时间戳字段（追加可读列 + 保留 <字段>_ms）。 */
const TS_FIELDS = new Set([
  'hitTime',
  'photoTime',
  'completeTime',
  'appealTime',
  'overTime',
  'checkTime',
  'firstAuditCompleteTime',
  'doubleAuditCompleteTime',
  'rejudgeTime',
  'finalStatusTime',
  'punishTime',
  'appealExpireTime',
  'appealMaxCheckTime',
]);

/** 东八区 wall time -> epoch ms。 */
function cstMs(y: number, m: number, d: number, hh = 0, mi = 0, ss = 0): number {
  return Date.UTC(y, m - 1, d, hh - 8, mi, ss);
}

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

/** ms -> 'YYYY-MM-DD HH:MM:SS'（东八区）；0/空/非法返回空串。 */
function fmtMs(v: unknown): string {
  let n = Number(v);
  if (!Number.isFinite(n)) return '';
  n = Math.trunc(n);
  if (n <= 0) return '';
  if (n > 1e14) n = Math.floor(n / 1000);
  const d = new Date(n + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

/** 嵌套 dict/list -> JSON 字符串；时间戳字段追加可读列。 */
function flatten(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && typeof v === 'object') {
      out[k] = Array.isArray(v) || Object.keys(v).length ? JSON.stringify(v) : '';
    } else if (v === null || v === undefined) {
      out[k] = '';
    } else {
      out[k] = v;
    }
    if (TS_FIELDS.has(k)) {
      out[k + '_ms'] = out[k];
      out[k] = fmtMs(v);
    }
  }
  return out;
}

/** 精简版列：[列名, (原始行, 扁平行) => 值]。 */
const SLIM_COLS: [string, (r: Record<string, any>, f: Record<string, any>) => unknown][] = [
  ['命中时间', (_r, f) => f.hitTime],
  ['日期', (_r, f) => String(f.hitTime).slice(0, 10)],
  ['团队', (_r, f) => f.teamName],
  ['骑手姓名', (_r, f) => f.knightName],
  ['骑手手机号', (_r, f) => f.knightMobile],
  ['骑手ID', (_r, f) => f.knightId],
  ['抽检类型', (_r, f) => f.qcTypeName],
  ['判定结果', (_r, f) => f.statusDesc],
  ['不通过原因', (r) => (r.reasons || []).map((x: Record<string, any>) => x.reasonName || '').join('；')],
  ['处罚', (_r, f) => f.punishment],
  ['处罚金额', (_r, f) => f.punishDecimalAmount],
  ['申诉状态', (_r, f) => f.appealStatusDesc],
  ['运单号', (_r, f) => f.trackingId],
  ['抽检ID', (_r, f) => f.qcId],
  ['配送模式', (_r, f) => f.shippingMode],
];

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 解析 --month / --start-date+--end-date；都不给默认「上个月」。 */
function resolveRange(args: Record<string, unknown>): {
  startMs: number;
  endMs: number;
  tag: string;
  sLabel: string;
  eLabel: string;
} {
  const startDate = args['--start-date'] ? String(args['--start-date']) : '';
  const endDate = args['--end-date'] ? String(args['--end-date']) : '';
  const month = args['--month'] ? String(args['--month']) : '';
  let sMs: number;
  let eMs: number;

  if (startDate && endDate) {
    const [sy, sm, sd] = startDate.split('-').map(Number);
    const [ey, em, ed] = endDate.split('-').map(Number);
    sMs = cstMs(sy, sm, sd, 0, 0, 0);
    eMs = cstMs(ey, em, ed, 23, 59, 59);
  } else if (month) {
    const [y, m] = month.split('-').map(Number);
    sMs = cstMs(y, m, 1, 0, 0, 0);
    const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
    eMs = cstMs(ny, nm, 1, 0, 0, 0) - 1000;
  } else {
    // 上个月：今天所在月的 1 号（东八区）往前推 1 秒
    const nowCst = new Date(Date.now() + 8 * 3600 * 1000);
    const firstThisMonth = cstMs(nowCst.getUTCFullYear(), nowCst.getUTCMonth() + 1, 1);
    eMs = firstThisMonth - 1000;
    const eCst = new Date(eMs + 8 * 3600 * 1000);
    sMs = cstMs(eCst.getUTCFullYear(), eCst.getUTCMonth() + 1, 1);
  }

  const label = (ms: number) => {
    const d = new Date(ms + 8 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} 00:00:00`;
  };
  const tagOf = (ms: number) => {
    const d = new Date(ms + 8 * 3600 * 1000);
    return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`;
  };
  return {
    startMs: sMs,
    endMs: eMs + 999,
    tag: `${tagOf(sMs)}_${tagOf(eMs)}`,
    sLabel: label(sMs),
    eLabel: label(eMs + 999),
  };
}

/** 橙色风暴明细抓取（原 jobs/orange_storm/fetch_orange_storm.py）。 */
@Injectable()
export class OrangeStormPipeline implements TaskHandler {
  readonly id = 'orange_storm';
  readonly stages: TaskStage[] = [
    { id: 'login', name: '登录风神' },
    { id: 'fetch', name: '分页拉取 QC 列表' },
    { id: 'write', name: '写出数据文件' },
  ];
  private readonly outDir: string;

  constructor(
    private readonly handlers: TaskHandlersService,
    private readonly fetchSvc: OrangeStormFetchService,
    private readonly config: ConfigService,
  ) {
    this.handlers.register(this);
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.outDir = path.join(root, 'python', 'jobs', 'orange_storm', 'out');
  }

  async run(ctx: TaskRunContext): Promise<void> {
    const r = resolveRange(ctx.args);
    const pageSize = Number(ctx.args['--page-size'] ?? 200) || 200;
    const t0 = Date.now();
    ctx.log(`时间范围（东八区）：${r.sLabel} ~ ${r.eLabel}`);
    ctx.log(`时间戳：${r.startMs} ~ ${r.endMs}`);

    const state: { rows?: Record<string, any>[]; total?: number } = {};
    const p = new Pipeline(ctx, state);

    p.stage('login', '登录风神', () => {
      ctx.log('[cookie] 复用本地 cookie（失效时由取数服务自动重登）');
    });

    p.stage('fetch', '分页拉取 QC 列表', async () => {
      const { rows, total } = await this.fetchSvc.fetchAll(r.startMs, r.endMs, undefined, pageSize);
      state.rows = rows;
      state.total = total;
      ctx.log(`拉取完成：${rows.length} 条（接口 total=${total}），耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    });

    p.stage('write', '写出数据文件', () => {
      const rows = state.rows;
      if (!rows || !rows.length) throw new TaskStop('无数据，未生成文件');
      this.write(rows, r.tag, ctx);
    });

    await p.run();
  }

  private write(rows: Record<string, any>[], tag: string, ctx: TaskRunContext): void {
    fs.mkdirSync(this.outDir, { recursive: true });
    const jsonPath = path.join(this.outDir, `orange_storm_${tag}.json`);
    const csvPath = path.join(this.outDir, `orange_storm_${tag}.csv`);
    const slimPath = path.join(this.outDir, `orange_storm_${tag}_slim.csv`);

    fs.writeFileSync(jsonPath, JSON.stringify(rows, null, 2), 'utf-8');

    const flat = rows.map(flatten);
    const cols: string[] = [];
    const seen = new Set<string>();
    for (const r of flat) {
      for (const k of Object.keys(r)) {
        if (!seen.has(k)) {
          seen.add(k);
          cols.push(k);
        }
      }
    }
    const fullCsv = [cols, ...flat.map((r) => cols.map((c) => r[c]))]
      .map((line) => line.map(csvCell).join(','))
      .join('\r\n');
    fs.writeFileSync(csvPath, '\uFEFF' + fullCsv + '\r\n', 'utf-8');

    const slimRows = rows.map((raw, i) => SLIM_COLS.map(([, fn]) => fn(raw, flat[i])));
    const slimCsv = [SLIM_COLS.map(([name]) => name), ...slimRows]
      .map((line) => line.map(csvCell).join(','))
      .join('\r\n');
    fs.writeFileSync(slimPath, '\uFEFF' + slimCsv + '\r\n', 'utf-8');

    ctx.log('已输出：');
    ctx.log(`  JSON  ${jsonPath}`);
    ctx.log(`  CSV   ${csvPath}（${cols.length} 列，全字段）`);
    ctx.log(`  CSV   ${slimPath}（${SLIM_COLS.length} 列，精简版）`);

    const tally = (fn: (r: Record<string, any>) => string) => {
      const m: Record<string, number> = {};
      for (const r of rows) {
        const k = fn(r) ?? '';
        m[k] = (m[k] || 0) + 1;
      }
      return JSON.stringify(m);
    };
    ctx.log(`\n状态分布： ${tally((r) => r.statusDesc || r.status)}`);
    ctx.log(`抽检类型： ${tally((r) => r.qcTypeName)}`);
    ctx.log(`覆盖团队： ${new Set(rows.map((r) => r.teamName)).size} 个`);
  }
}
