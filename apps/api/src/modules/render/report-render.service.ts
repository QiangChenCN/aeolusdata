import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as C from './theme-colors';
import {
  createCanvas,
  drawCenter,
  drawLeft,
  fitFontSize,
  fmtNow,
  fmtRate,
  hLine,
  maskMobile,
  newCanvas,
  pill,
  roundRect,
  savePng,
  fillRect,
  textW,
} from './canvas-util';

/** 站点项：[teamId, 站点名]。 */
export type TeamItem = [string, string];
/** 单站点统计六元组：[排班, 在线, 下线, 小休, 下线背单, 小休背单]。 */
export type TeamStat = [number, number, number, number, number, number];
export type TeamStats = Record<string, TeamStat>;

interface AllTeamsRow {
  knightName: string;
  site: string;
  state: string;
  delivering: number | string;
  slotFinish: number | string;
  slotValid: string;
  fullFinish: number | string;
  fullValid: string;
}

/**
 * 统一报表渲染（移植自 common/report_render.py，单一事实来源）。
 *
 * 布局语言：品牌色标题条 / BRAND_TINT 表头 + 2px 品牌底线 / 中性斑马纹 /
 * 语义色圆角药丸 / 关键数字品牌色。逐函数对照 Python 版复刻，保证视觉一致。
 */
@Injectable()
export class ReportRenderService {
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = path.resolve(
      config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
  }

  private out(rel: string): string {
    return path.join(this.root, rel);
  }

  // ───────────── 1. 实时考勤 · 有排班未出勤 ─────────────
  renderAttendanceAbsent(
    rows: Record<string, any>[],
    queryCode: string,
    queryName: string,
    teamId: string,
    totalRiders: number,
    outPath?: string,
  ): string {
    const out = outPath || this.out('apps/api/runtime/jobs/attendance/out/realtime_online.png');
    const timeStr = fmtNow();
    const cols: [string, number][] = [
      ['序号', 50],
      ['骑手姓名', 100],
      ['手机号', 120],
      ['排班时段', 200],
      ['出勤状态', 96],
      ['全天在线', 90],
      ['全天单量', 80],
      ['目标时长', 90],
      ['目标单量', 80],
    ];
    const [titleF, subF, headF, cellF] = [28, 14, 15, 14];
    const padX = 28;
    const padY = 18;
    const [rowH, headerH, titleH, footerH] = [48, 44, 66, 44];
    const tableW = cols.reduce((s, [, w]) => s + w, 0);
    const imgW = tableW + padX * 2;
    const nRows = Math.max(rows.length, 1);
    const imgH = padY * 2 + titleH + headerH + nRows * rowH + footerH;
    const { canvas, ctx } = newCanvas(imgW, imgH, C.WHITE);

    fillRect(ctx, 0, 0, imgW, titleH, C.BRAND);
    drawLeft(ctx, padX, 16, '实时考勤 · 有排班未出勤', titleF, C.WHITE);
    drawLeft(
      ctx,
      padX,
      46,
      `时段：${queryName}（${queryCode}）  ·  团队 ${teamId}  ·  ${timeStr}  ·  未出勤 ${rows.length} / 全队 ${totalRiders}`,
      subF,
      C.WHITE,
    );

    let y = padY * 2 + titleH;
    fillRect(ctx, padX, y, tableW, headerH, C.BRAND_TINT);
    let x = padX;
    for (const [name, w] of cols) {
      drawLeft(ctx, x + 10, y + (headerH - 18) / 2, name, headF, C.TEXT_PRIMARY);
      x += w;
    }
    hLine(ctx, padX, y + headerH, imgW - padX, C.BRAND, 2);
    y += headerH;

    if (rows.length) {
      rows.forEach((r, i) => {
        fillRect(ctx, padX, y, tableW, rowH, i % 2 === 0 ? C.WHITE : C.SURFACE);
        hLine(ctx, padX, y + rowH, imgW - padX, C.DIVIDER, 1);
        const values = [
          String(i + 1),
          String(r.knightName),
          maskMobile(r.mobile),
          String(r.schedule),
          String(r.workStatus),
          String(r.fullDayOnline),
          String(r.fullDayOrders),
          String(r.slotTarget),
          String(r.slotOrderTarget),
        ];
        let cx = padX;
        cols.forEach(([name, w], idx) => {
          const val = values[idx];
          if (name === '出勤状态') {
            const bad = val === '离线' || val === '小休';
            pill(ctx, cx + w / 2, y + rowH / 2, val, cellF, bad ? C.DANGER_TINT : C.SUCCESS_TINT, bad ? C.DANGER : C.SUCCESS);
          } else {
            const sz = fitFontSize(ctx, val, w - 20, cellF);
            drawLeft(ctx, cx + 10, y + (rowH - sz) / 2, val, sz, C.TEXT_REGULAR);
          }
          cx += w;
        });
        y += rowH;
      });
    } else {
      drawLeft(ctx, padX + 10, y + 12, '✓ 当前时段所有有排班骑手均已出勤', 16, C.SUCCESS);
      y += rowH;
    }

    drawLeft(ctx, padX, y + 12, '说明：仅显示有当前时段排班但在线时长为 0 的骑手', subF, C.TEXT_TERTIARY);
    return savePng(canvas, out);
  }

  // ───────────── 2. 实时在线（多站点汇总 + 明细） ─────────────
  renderAllTeams(
    allRows: AllTeamsRow[],
    queryName: string,
    rangeStr: string,
    teamItems: TeamItem[],
    stats: TeamStats,
    outPath?: string,
  ): string {
    const out = outPath || this.out('apps/api/runtime/jobs/attendance/out/attendance_absent.png');
    const timeStr = fmtNow();
    const cols: [string, number][] = [
      ['骑手姓名', 95],
      ['站点', 165],
      ['状态', 80],
      ['配送中单量', 85],
      ['当前时段完成单量', 130],
      ['当前时段有效在线时长', 150],
      ['全天完成单量', 95],
      ['全天有效在线时长', 130],
    ];
    const titleF = 28;
    const subF = 14;
    const siteF = 15;
    const statF = 13;
    const headF = 14;
    const cellF = 13;
    const padX = 28;
    const padY = 18;
    const rowH = 46;
    const headerH = 44;
    const titleH = 66;
    const footerH = 40;
    const cardH = 44;
    const cardGap = 12;
    const tableW = cols.reduce((s, [, w]) => s + w, 0);
    const imgW = tableW + padX * 2;
    const nRows = Math.max(allRows.length, 1);
    const cardsH = teamItems.length
      ? (teamItems.length + 1) * (cardH + cardGap) - cardGap
      : cardH + cardGap;
    const imgH = padY * 2 + titleH + cardsH + 12 + headerH + nRows * rowH + footerH;
    const { canvas, ctx } = newCanvas(imgW, imgH, C.WHITE);

    fillRect(ctx, 0, 0, imgW, titleH, C.BRAND);
    drawLeft(ctx, padX, 16, '实时在线', titleF, C.WHITE);
    drawLeft(ctx, padX, 46, `时段：${queryName}（${rangeStr}）  ·  ${timeStr}`, subF, C.WHITE);

    let y = padY * 2 + titleH;
    const tot: TeamStat = [0, 0, 0, 0, 0, 0];
    for (const [teamId, name] of teamItems) {
      const s = stats[teamId] || [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < 6; i++) tot[i] += s[i];
      const rate = fmtRate(s[1], s[0]);
      roundRect(ctx, padX, y, imgW - padX * 2, cardH, 10, { fill: C.SURFACE });
      drawLeft(ctx, padX + 14, y + (cardH - 18) / 2, name, siteF, C.TEXT_PRIMARY);
      const parts: [string, string][] = [
        ['排班 ', C.TEXT_SECONDARY],
        [String(s[0]), C.TEXT_PRIMARY],
        ['   在线 ', C.TEXT_SECONDARY],
        [String(s[1]), C.TEXT_PRIMARY],
        ['   在线率 ', C.TEXT_SECONDARY],
        [rate + '%', C.BRAND],
        ['   小休 ', C.TEXT_SECONDARY],
        [String(s[3]), C.TEXT_PRIMARY],
      ];
      let x = padX + 14 + textW(ctx, name, siteF) + 18;
      for (const [txt, col] of parts) {
        drawLeft(ctx, x, y + (cardH - 16) / 2, txt, statF, col);
        x += textW(ctx, txt, statF);
      }
      y += cardH + cardGap;
    }

    // 三站合计卡片（品牌色强调）
    const tRate = fmtRate(tot[1], tot[0]);
    roundRect(ctx, padX, y, imgW - padX * 2, cardH, 10, { fill: C.BRAND_TINT, stroke: C.BRAND, lineWidth: 1 });
    drawLeft(ctx, padX + 14, y + (cardH - 18) / 2, '三站合计', siteF, C.BRAND);
    const tParts: [string, string][] = [
      ['排班 ', C.TEXT_SECONDARY],
      [String(tot[0]), C.TEXT_PRIMARY],
      ['   在线 ', C.TEXT_SECONDARY],
      [String(tot[1]), C.TEXT_PRIMARY],
      ['   在线率 ', C.TEXT_SECONDARY],
      [tRate + '%', C.BRAND],
      ['   小休 ', C.TEXT_SECONDARY],
      [String(tot[3]), C.TEXT_PRIMARY],
      ['   下线 ', C.TEXT_SECONDARY],
      [String(tot[2]), C.TEXT_PRIMARY],
      ['   背单 ', C.TEXT_SECONDARY],
      [String(tot[4] + tot[5]), C.TEXT_PRIMARY],
    ];
    let tx = padX + 14 + textW(ctx, '三站合计', siteF) + 18;
    for (const [txt, col] of tParts) {
      drawLeft(ctx, tx, y + (cardH - 16) / 2, txt, statF, col);
      tx += textW(ctx, txt, statF);
    }
    y += cardH + cardGap;
    y += 12 - cardGap;

    fillRect(ctx, padX, y, tableW, headerH, C.BRAND_TINT);
    let x = padX;
    cols.forEach(([name, w], idx) => {
      const tx2 = idx === 0 || idx === 1 ? x + 10 : x + (w - textW(ctx, name, headF)) / 2;
      drawLeft(ctx, tx2, y + (headerH - 18) / 2, name, headF, C.TEXT_PRIMARY);
      x += w;
    });
    hLine(ctx, padX, y + headerH, imgW - padX, C.BRAND, 2);
    y += headerH;

    const cellIsZero = (idx: number, val: string): boolean => {
      if (idx === 3 || idx === 4 || idx === 6) {
        const n = Number(val);
        return Number.isFinite(n) && n === 0;
      }
      if (idx === 5 || idx === 7) return val === '0';
      return false;
    };

    if (allRows.length) {
      allRows.forEach((r, i) => {
        fillRect(ctx, padX, y, tableW, rowH, i % 2 === 0 ? C.WHITE : C.SURFACE);
        hLine(ctx, padX, y + rowH, imgW - padX, C.DIVIDER, 1);
        const values = [
          String(r.knightName),
          String(r.site),
          String(r.state),
          String(r.delivering),
          String(r.slotFinish),
          String(r.slotValid),
          String(r.fullFinish),
          String(r.fullValid),
        ];
        let cx = padX;
        cols.forEach(([name, w], idx) => {
          const val = values[idx];
          if (name === '状态') {
            pill(ctx, cx + w / 2, y + rowH / 2, val, cellF, C.DANGER_TINT, C.DANGER);
          } else {
            const sz = fitFontSize(ctx, val, w - 20, cellF);
            const ty = y + (rowH - sz) / 2;
            if (cellIsZero(idx, val)) {
              drawLeft(ctx, idx === 0 || idx === 1 ? cx + 10 : cx + (w - textW(ctx, val, sz)) / 2, ty, val, sz, C.TEXT_TERTIARY);
            } else if (idx === 0 || idx === 1) {
              drawLeft(ctx, cx + 10, ty, val, sz, C.TEXT_REGULAR);
            } else {
              drawLeft(ctx, cx + (w - textW(ctx, val, sz)) / 2, ty, val, sz, C.TEXT_REGULAR);
            }
          }
          cx += w;
        });
        y += rowH;
      });
    } else {
      drawLeft(ctx, padX + 10, y + 10, '✓ 当前时段所有有排班骑手均已在线配送', 16, C.SUCCESS);
      y += rowH;
    }

    drawLeft(
      ctx,
      padX,
      y + 10,
      '说明：在线(活跃)=上班/部分在线；小休=暂离(不计入在线)；下线=未在线装备。明细列出小休与下线骑手',
      subF,
      C.TEXT_TERTIARY,
    );
    return savePng(canvas, out);
  }

  // ───────────── 3. 不满意单申诉提醒 ─────────────
  renderAppeal(rows: Record<string, any>[], dateStr: string, outPath?: string): string {
    const out = outPath || this.out('apps/api/runtime/jobs/appeal/out/violation_detail.png');
    const cols: [string, number][] = [
      ['违规时间', 165],
      ['运单号', 200],
      ['骑手信息', 160],
      ['所属团队', 200],
      ['违规分类', 95],
      ['违规类型', 125],
      ['违规原因', 270],
      ['申诉状态', 95],
      ['申诉剩余时间', 135],
    ];
    const titleF = 28;
    const subF = 15;
    const headF = 15;
    const cellF = 14;
    const padX = 28;
    const padY = 18;
    const rowH = 64;
    const headerH = 50;
    const titleH = 66;
    const footerH = 48;
    const tableW = cols.reduce((s, [, w]) => s + w, 0);
    const imgW = tableW + padX * 2;
    const imgH = padY * 2 + titleH + headerH + rows.length * rowH + footerH;
    const { canvas, ctx } = newCanvas(imgW, imgH, C.WHITE);

    fillRect(ctx, 0, 0, imgW, titleH, C.BRAND);
    drawLeft(ctx, padX, 16, '不满意单申诉提醒', titleF, C.WHITE);
    drawLeft(ctx, padX, 46, `统计日期：${dateStr}    非超时 · 待申诉 共 ${rows.length} 条`, subF, C.WHITE);

    let y = padY * 2 + titleH;
    fillRect(ctx, padX, y, tableW, headerH, C.BRAND_TINT);
    let x = padX;
    for (const [name, w] of cols) {
      drawLeft(ctx, x + 10, y + (headerH - 18) / 2, name, headF, C.TEXT_PRIMARY);
      x += w;
    }
    hLine(ctx, padX, y + headerH, imgW - padX, C.BRAND, 2);
    y += headerH;

    rows.forEach((r, i) => {
      fillRect(ctx, padX, y, tableW, rowH, i % 2 === 0 ? C.WHITE : C.SURFACE);
      hLine(ctx, padX, y + rowH, imgW - padX, C.DIVIDER, 1);
      let cx = padX;
      for (const [name, w] of cols) {
        const text = String(r[name]);
        if (name === '申诉状态') {
          pill(ctx, cx + w / 2, y + rowH / 2, text, cellF, C.BRAND_TINT, C.BRAND_HOVER);
        } else {
          const sz = fitFontSize(ctx, text, w - 20, cellF);
          drawLeft(ctx, cx + 10, y + (rowH - sz) / 2, text, sz, C.TEXT_REGULAR);
        }
        cx += w;
      }
      y += rowH;
    });

    drawLeft(ctx, padX, y + 14, '请相关站点站长及时查看明细并处理申诉', subF, C.TEXT_TERTIARY);
    return savePng(canvas, out);
  }

  // ───────────── 4. 骑手装备未点亮明细 ─────────────
  renderEquipment(
    displayRows: (string | number)[][],
    totalRows: number,
    dateStr: string,
    outPath?: string,
  ): string {
    const out = outPath || this.out('apps/api/runtime/jobs/equipment/out/rider_equipment_warning.png');
    const titleF = 22;
    const headF = 15;
    const cellF = 14;
    const noteF = 13;
    const padX = 28;
    const [headerH, rowH, titleH, legendH, footerH] = [42, 38, 56, 30, 36];
    const headers = [
      '日期',
      '骑手ID',
      '骑手姓名',
      '站点ID',
      '站点名称',
      '入职天数',
      '应季制服是否点亮',
      '应季头盔是否点亮',
      '整体餐箱是否点亮',
    ];

    const measure = createCanvas(1, 1).getContext('2d');
    const colW = headers.map((h, i) => {
      let w = textW(measure, h, headF);
      for (const r of displayRows) w = Math.max(w, textW(measure, String(r[i]), cellF));
      return w + 24;
    });
    const tableW = colW.reduce((s, w) => s + w, 0);
    const imgW = tableW + padX * 2;
    const imgH = titleH + legendH + headerH + rowH * displayRows.length + footerH + 20;
    const { canvas, ctx } = newCanvas(imgW, imgH, C.WHITE);

    drawLeft(ctx, padX, 14, '骑手装备未点亮明细', titleF, C.BRAND);

    // 图例：× 未点亮 / √ 点亮
    const legendY = titleH + 16;
    const boxH = 20;
    roundRect(ctx, padX, legendY - boxH / 2, boxH, boxH, 5, { fill: C.DANGER_TINT });
    drawCenter(ctx, padX + boxH / 2, legendY, '×', cellF, C.DANGER);
    let lx = padX + boxH + 8;
    drawLeft(ctx, lx, legendY - 8, '未点亮', noteF, C.TEXT_SECONDARY);
    lx += textW(ctx, '未点亮', noteF) + 14;
    drawCenter(ctx, lx + 8, legendY, '√', cellF, C.SUCCESS);
    lx += 16;
    drawLeft(ctx, lx, legendY - 8, '点亮', noteF, C.TEXT_SECONDARY);
    lx += textW(ctx, '点亮', noteF) + 16;
    drawLeft(
      ctx,
      lx,
      legendY - 8,
      `日期：${dateStr}    共 ${displayRows.length} 条（总数据 ${totalRows} 行）`,
      noteF,
      C.TEXT_SECONDARY,
    );

    let y = titleH + legendH;
    fillRect(ctx, padX, y, tableW, headerH, C.BRAND_TINT);
    let cx = padX;
    headers.forEach((h, i) => {
      drawLeft(ctx, cx + (colW[i] - textW(ctx, h, headF)) / 2, y + (headerH - 16) / 2, h, headF, C.TEXT_PRIMARY);
      cx += colW[i];
    });
    hLine(ctx, padX, y + headerH, padX + tableW, C.BRAND, 2);
    y += headerH;

    displayRows.forEach((r, ri) => {
      fillRect(ctx, padX, y, tableW, rowH, ri % 2 === 0 ? C.WHITE : C.SURFACE);
      hLine(ctx, padX, y + rowH, padX + tableW, C.DIVIDER, 1);
      let cxx = padX;
      headers.forEach((_h, i) => {
        const val = String(r[i]);
        const isLitCol = i >= 6;
        if (isLitCol && val === '0') {
          roundRect(ctx, cxx + 6, y + 6, colW[i] - 12, rowH - 12, 6, { fill: C.DANGER_TINT });
          drawCenter(ctx, cxx + colW[i] / 2, y + rowH / 2, '×', cellF, C.DANGER);
        } else if (isLitCol) {
          drawCenter(ctx, cxx + colW[i] / 2, y + rowH / 2, '√', cellF, C.SUCCESS);
        } else {
          drawLeft(ctx, cxx + 12, y + (rowH - 14) / 2, val, cellF, C.TEXT_REGULAR);
        }
        cxx += colW[i];
      });
      y += rowH;
    });

    drawLeft(ctx, padX, y + 10, '数据来源：风神 Quark 报表', noteF, C.TEXT_TERTIARY);
    return savePng(canvas, out);
  }

  // ───────────── 5. 站长任务看板（进行中任务） ─────────────
  renderTasks(tasks: Record<string, any>[], outPath?: string): string {
    const out = outPath || this.out('apps/api/runtime/jobs/board/out/task_started.png');
    const nowStr = fmtNow();
    const columns: [string, string][] = [
      ['任务名称', 'taskName'],
      ['任务对象', 'taskObject'],
      ['状态', 'status'],
      ['有效期', 'taskExpireTime'],
      ['剩余时间', 'remaining'],
      ['执行人', 'executorName'],
    ];
    const titleF = 20;
    const headF = 13;
    const cellF = 12;
    const smallF = 11;
    const margin = 28;
    const rowH = 40;
    const headerH = 40;
    const titleH = 60;
    const gap = 16;
    const nRows = Math.max(tasks.length, 1);

    const measure = createCanvas(1, 1).getContext('2d');
    const colW: number[] = [];
    for (const [title, key] of columns) {
      let w = textW(measure, title, headF);
      for (const t of tasks) {
        const text = String(t[key] ?? '');
        w = Math.max(w, key === 'status' ? textW(measure, text, cellF) + 24 + 6 : textW(measure, text, cellF));
      }
      colW.push(w + 24);
    }
    const tableW = colW.reduce((s, w) => s + w, 0);
    const imgW = tableW + margin * 2;
    const colX: number[] = [margin];
    for (const w of colW) colX.push(colX[colX.length - 1] + w);
    const imgH = margin + titleH + gap + headerH + nRows * rowH + margin + 30;
    const { canvas, ctx } = newCanvas(imgW, imgH, C.WHITE);

    fillRect(ctx, 0, 0, imgW, titleH + margin, C.BRAND);
    drawLeft(ctx, margin, 16, '站长任务看板 · 进行中任务', titleF, C.WHITE);
    drawLeft(ctx, imgW - margin - 200, 24, `生成时间：${nowStr}`, smallF, C.WHITE);

    let y = margin + titleH + gap;
    fillRect(ctx, margin, y, tableW, headerH, C.BRAND_TINT);
    columns.forEach(([title], i) => drawLeft(ctx, colX[i] + 10, y + (headerH - 16) / 2, title, headF, C.TEXT_PRIMARY));
    hLine(ctx, margin, y + headerH, margin + tableW, C.BRAND, 2);
    y += headerH;

    tasks.forEach((task, idx) => {
      if (idx % 2 === 0) fillRect(ctx, margin, y, tableW, rowH, C.SURFACE);
      const statusText = String(task.status);
      const statusColor = statusText === '已开始' ? C.SUCCESS : C.TEXT_TERTIARY;
      const remainingText = String(task.remaining);
      const cells: [string, string][] = [
        [String(task.taskName), C.TEXT_REGULAR],
        [String(task.taskObject), C.TEXT_SECONDARY],
        [statusText, statusColor],
        [String(task.taskExpireTime), C.TEXT_REGULAR],
        [remainingText, remainingColor(remainingText)],
        [String(task.executorName), C.TEXT_REGULAR],
      ];
      cells.forEach(([text, color], i) => {
        if (columns[i][0] === '状态') {
          pill(ctx, colX[i] + colW[i] / 2, y + rowH / 2, text, cellF, statusText === '已开始' ? C.SUCCESS_TINT : C.SURFACE, statusColor);
        } else {
          drawLeft(ctx, colX[i] + 10, y + (rowH - 14) / 2, text, cellF, color);
        }
      });
      hLine(ctx, margin, y + rowH, margin + tableW, C.DIVIDER, 1);
      y += rowH;
    });

    drawLeft(ctx, margin, y + 10, `共 ${tasks.length} 条进行中任务`, smallF, C.TEXT_TERTIARY);
    return savePng(canvas, out);
  }
}

/** 剩余时间配色（对照 Python render_tasks 的语义重写）。 */
function remainingColor(remaining: string): string {
  if (remaining === '已过期') return C.DANGER;
  if (remaining === '无截止时间' || remaining === '时间格式异常') return C.TEXT_REGULAR;
  const m = remaining.match(/^(?:(\d+)天)?(?:(\d+)小时)?(?:(\d+)分钟)?$/);
  if (m) {
    const days = Number(m[1] || 0);
    const hours = Number(m[2] || 0);
    if (days * 24 + hours < 24) return C.DANGER;
  }
  return C.TEXT_REGULAR;
}
