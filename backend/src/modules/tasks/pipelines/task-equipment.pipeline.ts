import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { TaskHandler, TaskRunContext, TaskStage, TaskStop } from '../task-handler';
import { Pipeline } from '../pipeline';
import { TaskHandlersService } from '../task-handlers.service';
import { EquipmentFetchService, defaultDates } from '../../../../fetch/equipment-fetch.service';
import { ReportRenderService } from '../../render/report-render.service';
import { MinioService } from '../../media/minio.service';
import { DingtalkService } from '../../dingtalk/dingtalk.service';
import {
  STATION_MANAGERS,
  resolveOpenIds,
  teamToStation,
} from '../../notify/notify-config';

/** 默认目标群（tasks.json 亦可给 cid）。 */
const DEFAULT_GROUP = '台账安全处理群';

/** 展示列：[展示名, CSV 源列, 是否点亮列]。 */
const DISPLAY_COLS: [string, string, boolean][] = [
  ['日期', '日期', false],
  ['骑手ID', '骑士id', false],
  ['骑手姓名', '骑士姓名', false],
  ['站点ID', '站点id', false],
  ['站点名称', '站点名称', false],
  ['入职天数', '入职天数', false],
  ['应季制服是否点亮', '应季制服是否点亮', true],
  ['应季头盔是否点亮', '应季头盔是否点亮', true],
  ['整体餐箱是否点亮', '整体餐箱是否点亮', true],
];
const LIT_COL_SRC = DISPLAY_COLS.filter(([, , lit]) => lit).map(([, src]) => src);

function isLit(v: unknown): boolean {
  return String(v ?? '').trim() === '1';
}

function formatDate(v: unknown): string {
  const s = String(v ?? '').trim();
  if (s.length === 8 && /^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

/** 骑手装备点亮提醒（原 jobs/equipment/task_equipment.py）。 */
@Injectable()
export class TaskEquipmentPipeline implements TaskHandler {
  readonly id = 'task_equipment';
  readonly stages: TaskStage[] = [
    { id: 'fetch', name: '取数' },
    { id: 'save', name: '落盘原始层+CSV' },
    { id: 'report', name: '打印摘要' },
    { id: 'filter', name: '筛选未点亮' },
    { id: 'render', name: '渲染明细图' },
    { id: 'upload', name: '上传 MinIO' },
    { id: 'send', name: '发送钉钉群' },
  ];
  private readonly outDir: string;

  constructor(
    private readonly handlers: TaskHandlersService,
    private readonly equipment: EquipmentFetchService,
    private readonly render: ReportRenderService,
    private readonly minio: MinioService,
    private readonly dingtalk: DingtalkService,
    config: ConfigService,
  ) {
    this.handlers.register(this);
    const root = path.resolve(
      config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.outDir = path.join(root, 'backend', 'data', 'jobs', 'equipment', 'out');
  }

  private get imgPath(): string {
    return path.join(this.outDir, 'rider_equipment_warning.png');
  }

  private resolveDates(a: Record<string, unknown>): { start: string; end: string; asOf: string } {
    const d = defaultDates();
    const date = a['--date'] ? String(a['--date']) : '';
    const sd = a['--start-date'] ? String(a['--start-date']) : '';
    const ed = a['--end-date'] ? String(a['--end-date']) : '';
    const asOf = a['--as-of'] ? String(a['--as-of']) : '';
    if (date) return { start: date, end: date, asOf: asOf || date };
    if (sd || ed) {
      const s = sd || ed;
      const e = ed || sd;
      return { start: s, end: e, asOf: asOf || e };
    }
    return { start: d.start, end: d.end, asOf: asOf || d.asOf };
  }

  private csvText(header: string[], rows: unknown[][]): string {
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return '\uFEFF' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  async run(ctx: TaskRunContext): Promise<void> {
    const a = ctx.args;
    const noSend = Boolean(a['--no-send']);
    const noAt = Boolean(a['--no-at']);
    const groupId = String(a['--group'] ?? '') || DEFAULT_GROUP;
    const { start, end, asOf } = this.resolveDates(a);

    const state: {
      names?: string[];
      rows?: unknown[][];
      records?: Record<string, any>[];
      kept?: Record<string, any>[];
      display?: string[][];
      imgUrl?: string;
    } = {};
    const p = new Pipeline(ctx, state);

    p.stage('fetch', '取数', async () => {
      ctx.log(`[fetch] 日期窗口 ${start} ~ ${end}（as_of=${asOf}）`);
      const rv = await this.equipment.fetchReportView({ startDate: start, endDate: end, asOf, log: (s) => ctx.log(s) });
      if (!rv.rows.length) throw new TaskStop('报表无数据，终止。');
      state.names = rv.headers.map((h) => rv.labels[h] || h);
      state.rows = rv.rows;
      ctx.log(`[fetch] 取到 ${rv.rows.length} 行 × ${rv.headers.length} 列`);
    });

    p.stage('save', '落盘原始层+CSV', () => {
      fs.mkdirSync(this.outDir, { recursive: true });
      const raw = { headers: state.names, rows: state.rows };
      fs.writeFileSync(
        path.join(this.outDir, 'rider_equipment_raw.json'),
        JSON.stringify(raw, null, 2),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(this.outDir, 'rider_equipment.csv'),
        this.csvText(state.names!, state.rows!),
        'utf-8',
      );
      ctx.log(`[save] 已写 rider_equipment_raw.json / rider_equipment.csv`);
    });

    p.stage('report', '打印摘要', () => {
      const names = state.names!;
      const first = state.rows![0] || [];
      ctx.log('==== 列 schema（官方中文名 -> 首行样例值）====');
      names.forEach((n, i) => {
        const v = first[i] === null || first[i] === undefined ? '' : first[i];
        ctx.log(`  ${n.padEnd(16)} | ${v}`);
      });
    });

    p.stage('filter', '筛选未点亮', () => {
      const names = state.names!;
      const records: Record<string, any>[] = state.rows!.map((r) => {
        const o: Record<string, any> = {};
        names.forEach((n, i) => (o[n] = r[i]));
        return o;
      });
      const kept = records.filter((row) => LIT_COL_SRC.some((c) => !isLit(row[c])));
      const sidKey = (row: Record<string, any>): [number, string] => {
        const v = String(row['站点id'] ?? '').trim();
        return /^\d+$/.test(v) ? [0, v.padStart(20, '0')] : [1, v];
      };
      kept.sort((x, y) => {
        const [gx, vx] = sidKey(x);
        const [gy, vy] = sidKey(y);
        return gx !== gy ? gx - gy : vx < vy ? -1 : vx > vy ? 1 : 0;
      });
      ctx.log(`[filter] 未点亮 ${kept.length} / 全量 ${records.length}`);
      if (!kept.length) throw new TaskStop('无未点亮记录，跳过渲染与发送。');
      state.kept = kept;
      state.records = records;
    });

    p.stage('render', '渲染明细图', () => {
      const kept = state.kept!;
      const display = kept.map((row) =>
        DISPLAY_COLS.map(([disp, src, isLitCol]) => {
          const val = row[src] ?? '';
          if (disp === '日期') return formatDate(val);
          if (isLitCol) return isLit(val) ? '1' : '0';
          return String(val);
        }),
      );
      state.display = display;
      const dateStr = start;
      const out = this.render.renderEquipment(display, state.records!.length, dateStr, this.imgPath);
      fs.writeFileSync(
        path.join(this.outDir, 'rider_equipment_unlit.csv'),
        this.csvText(DISPLAY_COLS.map(([d]) => d), display),
        'utf-8',
      );
      ctx.log(`[render] -> ${out}（${display.length} 条，总数据 ${state.records!.length} 行）`);
    });

    p.stage('upload', '上传 MinIO', async () => {
      state.imgUrl = await this.minio.upload(this.imgPath, 'equip');
      ctx.log(`[upload] 图片已上传：${state.imgUrl}`);
    });

    p.stage('send', '发送钉钉群', async () => {
      const kept = state.kept!;
      const names = new Set<string>();
      for (const r of kept) {
        const station = teamToStation(String(r['站点名称'] ?? ''));
        for (const m of STATION_MANAGERS[station] || []) names.add(m);
      }
      const { resolved } = resolveOpenIds(names);
      const ids = resolved.map(([, oid]) => oid);
      const atIds = ids.length && !noAt ? ids : [];
      const dateStr = start;
      const n = kept.length;
      const mentions = noAt ? '' : ids.map((i) => `<@${i}>`).join(' ');
      const text =
        `## 骑手装备未点亮明细\n` +
        `**统计日期：** ${dateStr}　**未点亮 共 ${n} 条**\n\n` +
        `![未点亮明细](${state.imgUrl})\n\n` +
        `请相关站点站长及时跟进装备点亮情况：${mentions}`;
      if (noSend) {
        ctx.log(`(--no-send) 未实际发送。目标群 ${groupId}；将 @ ${resolved.length} 人`);
        ctx.log(text);
        return;
      }
      const out = await this.dingtalk.sendMessage({ group: groupId, text, atOpenDingTalkIds: atIds });
      ctx.log(`[send] 发送完成：${JSON.stringify(out).slice(0, 200)}`);
    });

    await p.run();
  }
}
