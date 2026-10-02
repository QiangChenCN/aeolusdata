import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import * as fs from 'fs';
import * as path from 'path';
import { ensureFont } from './font';

export type C2D = SKRSContext2D;
export { createCanvas };
export type { Canvas };

export function newCanvas(w: number, h: number, bg = '#FFFFFF'): { canvas: Canvas; ctx: C2D } {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  return { canvas, ctx };
}

export function fontStr(size: number): string {
  return `${size}px ${ensureFont()}`;
}

export function setFont(ctx: C2D, size: number): void {
  ctx.font = fontStr(size);
}

export function textW(ctx: C2D, text: string, size: number): number {
  setFont(ctx, size);
  return ctx.measureText(String(text)).width;
}

/** 返回能让 text 在 maxW 内单行放下的字号（逐 1 递减到 minSize）。 */
export function fitFontSize(ctx: C2D, text: string, maxW: number, baseSize: number, minSize = 8): number {
  if (textW(ctx, text, baseSize) <= maxW) return baseSize;
  let sz = baseSize;
  while (sz > minSize) {
    sz -= 1;
    if (textW(ctx, text, sz) <= maxW) return sz;
  }
  return minSize;
}

/** 左对齐 + 顶部基线绘制。 */
export function drawLeft(ctx: C2D, x: number, yTop: number, text: string, size: number, color: string): void {
  setFont(ctx, size);
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(String(text), x, yTop);
}

/** 水平居中 + 垂直居中绘制（对应 Pillow 的 _centered_text）。 */
export function drawCenter(ctx: C2D, cx: number, cy: number, text: string, size: number, color: string): void {
  setFont(ctx, size);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(text), cx, cy);
}

/** 水平居中 + 顶部基线绘制。 */
export function drawTopCenter(ctx: C2D, cx: number, yTop: number, text: string, size: number, color: string): void {
  setFont(ctx, size);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(String(text), cx, yTop);
}

export function fillRect(ctx: C2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

export function hLine(ctx: C2D, x1: number, y: number, x2: number, color: string, width = 1): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
}

export function roundRect(
  ctx: C2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  opts: { fill?: string; stroke?: string; lineWidth?: number } = {},
): void {
  ctx.beginPath();
  if (typeof (ctx as unknown as { roundRect?: unknown }).roundRect === 'function') {
    (ctx as unknown as { roundRect: (a: number, b: number, c: number, d: number, e: number) => void }).roundRect(
      x,
      y,
      w,
      h,
      r,
    );
  } else {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
  if (opts.fill) {
    ctx.fillStyle = opts.fill;
    ctx.fill();
  }
  if (opts.stroke) {
    ctx.strokeStyle = opts.stroke;
    ctx.lineWidth = opts.lineWidth ?? 1;
    ctx.stroke();
  }
}

/** 在 (cx,cy) 居中绘制圆角药丸，返回其尺寸（对应 Pillow 的 _pill）。 */
export function pill(
  ctx: C2D,
  cx: number,
  cy: number,
  text: string,
  size: number,
  bg: string,
  fg: string,
  padX = 12,
  radius = 8,
): { w: number; h: number } {
  const tw = textW(ctx, text, size);
  const w = tw + padX * 2;
  const h = Math.max(size + 10, 24);
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, radius, { fill: bg });
  drawCenter(ctx, cx, cy, text, size, fg);
  return { w, h };
}

/** 写出 PNG（自动建目录）。 */
export function savePng(canvas: Canvas, outPath: string): string {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  return outPath;
}

/** 北京时间（UTC+8）。 */
export function bjNow(): Date {
  return new Date(Date.now() + 8 * 3600 * 1000);
}

/** 格式化为 "YYYY-MM-DD HH:mm"（用 UTC 字段读取，因为已加过 8 小时偏移）。 */
export function fmtNow(d = bjNow()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 在线率格式化（整数去小数点，否则最多 2 位小数）。 */
export function fmtRate(online: number, sched: number): string {
  if (!sched) return '0';
  const r = Math.round((online * 100) / sched * 100) / 100;
  if (r === Math.trunc(r)) return String(Math.trunc(r));
  return r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** 手机号脱敏：保留前 3 后 4，避免公开图床泄露隐私。 */
export function maskMobile(m: string): string {
  const s = String(m ?? '');
  if (!s || s.length < 7) return s;
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}
