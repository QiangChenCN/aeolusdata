import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { TaskHandler, TaskRunContext, TaskStage, TaskStop } from '../task-handler';
import { Pipeline } from '../pipeline';
import { TaskHandlersService } from '../task-handlers.service';
import { ViolationFetchService } from '../../../../fetch/sources/violation-fetch.service';
import { UnsatStoreService } from '../../../../fetch/storage/unsat-store.service';
import { DingtalkService } from '../../dingtalk/dingtalk.service';
import {
  PRODUCTION_GROUP_NAME,
  STATION_MANAGERS,
  resolveOpenIds,
  teamToStation,
} from '../../notify/notify-config';
import { csvToRecords } from '../../../common/csv';
import { drawLeft, fillRect, fitFontSize, hLine, newCanvas, savePng } from '../../render/canvas-util';

/** 明细区 15 列（与风神违规处罚 CSV 顺序 1:1，对应在线表 D:R）。 */
const DETAIL_COLUMNS = [
  '违规编号', '违规来源', '违规时间', '运单号', '骑手ID', '骑手名称',
  '团队ID', '团队名称', '商ID', '商名称', '违规分类', '违规类型',
  '处罚', '违规状态', '违规原因',
];

const FALLBACK_SHEET_URL =
  'https://alidocs.dingtalk.com/spreadsheetv2/AVy0mGPotLlLEXAk/edit?dentryKey=AVy0mGPotLlLEXAk';
const PROBE_MAX = 500;

/** 自绘渲染配色（对照 jobs/unsat/renderer.py）。 */
const BRAND = '#FF5000';
const BRAND_TINT = '#FFF0EA';
const WHITE = '#FFFFFF';
const SURFACE = '#FAFAFA';
const DIVIDER = '#EBEBEB';
const TEXT = '#212121';
const TEXT_SUB = '#6E6E6E';

/** 北京时间某天的 [00:00:00.000, 23:59:59.999]。 */
function dayRange(dateStr?: string): { startMs: number; endMs: number; dateStr: string } {
  let y: number;
  let m: number;
  let d: number;
  if (dateStr) {
    [y, m, d] = dateStr.split('-').map(Number);
  } else {
    const bj = new Date(Date.now() + 8 * 3600 * 1000 - 86400000);
    y = bj.getUTCFullYear();
    m = bj.getUTCMonth() + 1;
    d = bj.getUTCDate();
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    startMs: Date.UTC(y, m - 1, d, -8, 0, 0),
    endMs: Date.UTC(y, m - 1, d, 23 - 8, 59, 59, 999),
    dateStr: `${y}-${p(m)}-${p(d)}`,
  };
}

/** 不满意复盘反馈（原 jobs/unsat/，`python -m jobs.unsat.main run`）。 */
@Injectable()
export class UnsatRunPipeline implements TaskHandler {
  readonly id = 'unsat_run';
  readonly stages: TaskStage[] = [
    { id: 'fetch', name: '拉取不满意单' },
    { id: 'store', name: '落库去重' },
    { id: 'sheet', name: '填在线表' },
    { id: 'send', name: '渲染并发群' },
  ];
  private readonly dataDir: string;
  private readonly lastUrlFile: string;

  constructor(
    private readonly handlers: TaskHandlersService,
    private readonly violation: ViolationFetchService,
    private readonly store: UnsatStoreService,
    private readonly dingtalk: DingtalkService,
    private readonly config: ConfigService,
  ) {
    this.handlers.register(this);
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.dataDir = path.join(root, 'backend', 'data', 'jobs', 'unsat', 'out', 'unsat_data');
    this.lastUrlFile = path.join(this.dataDir, 'last_sheet_url.txt');
  }

  /** 在线表地址：--sheet-url > .env > 上次记住 > 内置兜底（并记住本次填写的）。 */
  private resolveSheetUrl(override: string): { url: string; source: string } {
    const u = (override || '').trim();
    if (u) {
      if (!/^https?:\/\//.test(u)) {
        throw new Error(
          `文档地址必须是完整 URL（http:// 或 https:// 开头），当前填的是：'${u}'\n` +
            '正确取法：打开钉钉在线表 → 复制浏览器地址栏的整条链接。',
        );
      }
      try {
        fs.mkdirSync(this.dataDir, { recursive: true });
        fs.writeFileSync(this.lastUrlFile, u, 'utf-8');
      } catch (e) {
        // 记不住不致命，下次重填即可
        void e;
      }
      return { url: u, source: 'cli' };
    }
    const envUrl = process.env.UNSAT_SHEET_URL;
    if (envUrl) return { url: envUrl, source: 'env' };
    try {
      const last = fs.readFileSync(this.lastUrlFile, 'utf-8').trim();
      if (last) return { url: last, source: 'last' };
    } catch {
      /* 无记录 */
    }
    return { url: FALLBACK_SHEET_URL, source: 'fallback' };
  }

  private sheetId(): string {
    return process.env.UNSAT_SHEET_ID || 's1';
  }

  /** 剔除「超时」（违规分类）与「不成立」（违规状态），保留全部 15 列。 */
  private filterRows(text: string, log: (s: string) => void): Record<string, string>[] {
    const kept: Record<string, string>[] = [];
    const dropped: [string, string][] = [];
    for (const r of csvToRecords(text)) {
      const rec: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) rec[k] = (v || '').trim();
      if (rec['违规分类'] === '超时') {
        dropped.push([rec['违规编号'] || '', '超时']);
        continue;
      }
      if (rec['违规状态'] === '不成立') {
        dropped.push([rec['违规编号'] || '', '不成立']);
        continue;
      }
      const team = rec['团队名称'] || '';
      rec['站点'] = teamToStation(team);
      kept.push(rec);
    }
    log(
      `筛选：保留 ${kept.length} 条，剔除 ${dropped.length} 条 ${dropped.length ? JSON.stringify(dropped) : ''}`,
    );
    return kept;
  }

  // ───────── 出图（自绘：按站点分组 + 反馈要求页脚）─────────
  private render(rows: Record<string, any>[], dateStr: string, outPath: string): string {
    const cols: [string, number][] = [
      ['站点', 100],
      ['违规时间', 150],
      ['运单号', 175],
      ['骑手', 80],
      ['违规分类', 85],
      ['违规类型', 150],
      ['违规原因', 300],
    ];
    const padX = 28;
    const padY = 18;
    const [rowH, headerH, titleH, groupH, footerH] = [62, 48, 70, 44, 78];
    const tableW = cols.reduce((s, [, w]) => s + w, 0);
    const imgW = tableW + padX * 2;

    const groups: Record<string, Record<string, any>[]> = {};
    for (const r of rows) {
      const k = String(r['站点'] ?? '未匹配');
      (groups[k] = groups[k] || []).push(r);
    }
    const stationKeys = Object.keys(groups).sort();
    const imgH =
      padY * 2 + titleH + headerH + rows.length * rowH + stationKeys.length * groupH + footerH;

    const { canvas, ctx } = newCanvas(imgW, imgH, WHITE);
    const titleF = 27;
    const subF = 15;
    const headF = 15;
    const cellF = 14;
    const grpF = 16;
    const footF = 14;

    fillRect(ctx, 0, 0, imgW, titleH, BRAND);
    drawLeft(ctx, padX, 15, '不满意单明细', titleF, WHITE);
    drawLeft(
      ctx,
      padX,
      46,
      `统计日期：${dateStr}    非超时 · 非不成立 共 ${rows.length} 条 / ${stationKeys.length} 个站点`,
      subF,
      WHITE,
    );

    let y = padY + titleH;
    fillRect(ctx, padX, y, tableW, headerH, BRAND_TINT);
    fillRect(ctx, padX, y + headerH - 2, tableW, 2, BRAND);
    let x = padX;
    for (const [name, w] of cols) {
      drawLeft(ctx, x + 10, y + (headerH - 18) / 2, name, headF, TEXT);
      x += w;
    }
    y += headerH;

    let idx = 0;
    for (const station of stationKeys) {
      const list = groups[station];
      fillRect(ctx, padX, y, tableW, groupH, SURFACE);
      drawLeft(ctx, padX + 10, y + 12, `${station}（${list.length} 条）`, grpF, BRAND);
      y += groupH;
      for (const r of list) {
        fillRect(ctx, padX, y, tableW, rowH, idx % 2 === 0 ? WHITE : SURFACE);
        const vals = [
          String(r['站点'] ?? ''),
          String(r['违规时间'] ?? ''),
          String(r['运单号'] ?? ''),
          String(r['骑手名称'] ?? ''),
          String(r['违规分类'] ?? ''),
          String(r['违规类型'] ?? ''),
          String(r['违规原因'] ?? ''),
        ];
        let cx = padX;
        cols.forEach(([, w], i) => {
          const v = vals[i];
          const sz = fitFontSize(ctx, v, w - 20, cellF, 9);
          drawLeft(ctx, cx + 10, y + (rowH - 18) / 2, v, sz, TEXT);
          cx += w;
        });
        hLine(ctx, padX, y + rowH, imgW - padX, DIVIDER, 1);
        y += rowH;
        idx += 1;
      }
    }

    fillRect(ctx, padX, y + 8, tableW, footerH, BRAND_TINT);
    drawLeft(ctx, padX + 10, y + 16, '请各站点站长于 24:00 前完成反馈（@本机器人 + 运单号）：', footF, TEXT);
    drawLeft(ctx, padX + 10, y + 38, '① 原因分析（A列）  ② 改善措施（B列）  ③ 培训图片/视频（C列）', footF, BRAND);
    drawLeft(ctx, padX + 10, y + 58, '三要素齐全方视为合格，未合格将每小时提醒一次。', 13, TEXT_SUB);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    return savePng(canvas, outPath);
  }

  private markdownTable(rows: Record<string, any>[], dateStr: string): string {
    const head =
      '| 站点 | 违规时间 | 运单号 | 骑手 | 违规分类 | 违规类型 | 违规原因 |\n' +
      '|' +
      ['---'].concat(Array(6).fill('---')).join('|') +
      '|';
    const body = [...rows]
      .sort((a, b) => String(a['站点'] ?? '').localeCompare(String(b['站点'] ?? '')))
      .map(
        (r) =>
          `| ${r['站点'] ?? ''} | ${r['违规时间'] ?? ''} | ${r['运单号'] ?? ''} | ${r['骑手名称'] ?? ''} | ${r['违规分类'] ?? ''} | ${r['违规类型'] ?? ''} | ${r['违规原因'] ?? ''} |`,
      );
    return `## 不满意单明细（${dateStr}）\n**共 ${rows.length} 条**\n\n${[head, ...body].join('\n')}`;
  }

  async run(ctx: TaskRunContext): Promise<void> {
    const a = ctx.args;
    const doSend = !a['--no-send'];
    const dateArg = a['--date'] ? String(a['--date']) : undefined;
    const { url: sheetUrl, source } = this.resolveSheetUrl(String(a['--sheet-url'] ?? ''));
    ctx.log(
      `在线表地址（${source}）: ${sheetUrl}${source === 'fallback' ? ' —— 首次使用请在「文档地址」填本月的在线表链接，填一次后会自动记住。' : ''}`,
    );

    const state: {
      rows?: Record<string, string>[];
      dateStr?: string;
      fileUrl?: string;
      matrix?: string[][];
    } = {};
    const p = new Pipeline(ctx, state);

    p.stage('fetch', '拉取不满意单', async () => {
      const { startMs, endMs, dateStr } = dayRange(dateArg);
      const { text, fileUrl } = await this.violation.downloadCsv(startMs, endMs);
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.store.csvPath, '\uFEFF' + text, 'utf-8');
      const rows = this.filterRows(text, (s) => ctx.log(s));
      ctx.log(`日期 ${dateStr} 命中（非超时 & 非不成立）: ${rows.length} 条`);
      if (!rows.length) throw new TaskStop('无符合条件的明细，结束。');
      state.rows = rows;
      state.dateStr = dateStr;
      state.fileUrl = fileUrl;
    });

    p.stage('store', '落库去重', async () => {
      const [added, all] = await this.store.upsertOrders(state.rows!, state.dateStr!);
      ctx.log(`落库：新增 ${added} 条，当日共 ${all.length} 条`);
    });

    p.stage('sheet', '填在线表', async () => {
      const sid = this.sheetId();
      // 1) 去重：读表格已有违规编号
      let exist = new Set<string>();
      try {
        const rows = await this.dingtalk.sheetReadRange({
          node: sheetUrl,
          sheetId: sid,
          range: `D2:D${2 + PROBE_MAX}`,
        });
        exist = new Set(rows.map((r) => r[0]).filter(Boolean));
      } catch (e) {
        ctx.log(`[warn] 读取已有违规编号失败，跳过去重: ${(e as Error).message}`);
      }
      const before = state.rows!.length;
      const rows = state.rows!.filter((r) => !exist.has(r['违规编号'] || ''));
      if (before !== rows.length) {
        ctx.log(`去重：跳过表格中已存在的 ${before - rows.length} 条，剩余 ${rows.length} 条`);
      }
      if (!rows.length) {
        ctx.log('表格已存在全部明细，跳过写表。');
        return;
      }
      // 2) 探测 D 列首空行
      const probe = await this.dingtalk.sheetReadRange({
        node: sheetUrl,
        sheetId: sid,
        range: `D2:D${2 + PROBE_MAX}`,
      });
      let emptyRow = -1;
      for (let i = 0; i < probe.length; i++) {
        const cell = probe[i]?.[0] ?? '';
        if (!cell) {
          emptyRow = 2 + i;
          break;
        }
      }
      if (emptyRow < 0) {
        throw new Error(`D 列 2~${2 + PROBE_MAX} 行均未找到空行，请增大探测范围`);
      }
      ctx.log(`D 列首个可用行: 第 ${emptyRow} 行（待写 ${rows.length} 行）`);
      // 3) 整块写入 D:R
      const matrix = rows.map((r) => DETAIL_COLUMNS.map((c) => String(r[c] ?? '')));
      const endRow = emptyRow + matrix.length - 1;
      await this.dingtalk.sheetUpdateRange({
        node: sheetUrl,
        sheetId: sid,
        range: `D${emptyRow}:R${endRow}`,
        values: matrix,
      });
      ctx.log(`已写入明细 ${matrix.length} 行 → D${emptyRow}:R${endRow}`);
      // 4) 回填 sheet_row
      for (let i = 0; i < rows.length; i++) {
        await this.store.setSheetRow(rows[i]['违规编号'] || '', emptyRow + i);
      }
      ctx.log(`已回填 ${rows.length} 条运单的表格行号`);
      state.matrix = matrix;
    });

    p.stage('send', '渲染并发群', async () => {
      let img: string | null = null;
      try {
        img = this.render(state.rows!, state.dateStr!, this.store.imgPath);
        ctx.log(`图片已生成: ${img}`);
      } catch (e) {
        ctx.log(`[warn] 图片渲染失败，降级为文字: ${(e as Error).message}`);
        img = null;
      }
      if (!doSend) {
        ctx.log(`(--no-send) 跳过发群。渲染预览：${img || this.markdownTable(state.rows!, state.dateStr!)}`);
        return;
      }
      const stations = new Set(state.rows!.map((r) => String(r['站点'] ?? '')));
      const names = new Set<string>();
      for (const s of stations) for (const m of STATION_MANAGERS[s] || []) names.add(m);
      const { resolved, missing } = resolveOpenIds(names);
      const ids = resolved.map(([, oid]) => oid);
      if (missing.length) ctx.log(`[warn] 以下站长未解析到 id，已跳过 @：${missing.join('、')}`);
      const mentions = resolved.length ? resolved.map(([, oid]) => `<@${oid}>`).join(' ') : '';
      const text =
        `## 不满意单明细（${state.dateStr}）\n` +
        `**非超时 · 非不成立 共 ${state.rows!.length} 条 / ${stations.size} 个站点**\n\n` +
        `请各站点站长于 **24:00 前** 完成反馈（@本机器人 + 运单号）：\n` +
        `① 原因分析（A列）　② 改善措施（B列）　③ **培训图片/视频（C列）**\n\n` +
        `三要素齐全方视为合格，未合格将每小时提醒一次。\n\n` +
        `📎 [下载原始数据](${state.fileUrl})\n\n${mentions}`;
      if (img && fs.existsSync(img)) {
        await this.dingtalk.sendFile({ group: PRODUCTION_GROUP_NAME, file: img });
        ctx.log(`文件发送成功: ${img}`);
      }
      const out = await this.dingtalk.sendMessage({
        group: PRODUCTION_GROUP_NAME,
        text,
        atOpenDingTalkIds: ids,
      });
      ctx.log(`markdown 发送成功（@${ids.length} 人）：${JSON.stringify(out).slice(0, 200)}`);
      ctx.log(`已发群，共 ${state.rows!.length} 条 / 日期 ${state.dateStr}`);
    });

    await p.run();
  }
}
