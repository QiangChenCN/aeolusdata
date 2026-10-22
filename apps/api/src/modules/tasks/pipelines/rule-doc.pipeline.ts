import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { TaskHandler, TaskRunContext, TaskStage } from '../task-handler';
import { Pipeline } from '../pipeline';
import { TaskHandlersService } from '../task-handlers.service';
import { RuledocFetchService } from '../../../infra/fetch/sources/ruledoc-fetch.service';

const TAG_TO_DT: Record<string, string> = {
  h1: 'heading-1',
  h2: 'heading-2',
  h3: 'heading-3',
  h4: 'heading-4',
  h5: 'heading-5',
  h6: 'heading-6',
  p: 'paragraph',
};

const REF_FILES = ['rule_native_reference.html', 'rule_native_reference_6355.html'];

/**
 * 有序列表编号格式化（docx 多级列表 format 字段）。
 * 各级格式不同：decimal(1,2,3) / lowerLetter(a,b,c) / upperLetter(A,B,C) /
 * lowerRoman(i,ii,iii) / upperRoman(I,II,III)。源数据如 7107 的层级列表：
 * level0=decimal、level1=lowerLetter、level2=lowerRoman、level3=decimal。
 */
function toAlpha(n: number): string {
  if (n <= 0) return String(n);
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(97 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
function toRoman(n: number): string {
  if (n <= 0) return String(n);
  const map: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let s = '';
  for (const [v, sym] of map) {
    while (n >= v) {
      s += sym;
      n -= v;
    }
  }
  return s;
}
function formatListNumber(n: number, type: string): string {
  switch (type) {
    case 'lowerLetter': return toAlpha(n);
    case 'upperLetter': return toAlpha(n).toUpperCase();
    case 'lowerRoman': return toRoman(n);
    case 'upperRoman': return toRoman(n).toUpperCase();
    default: return String(n);
  }
}

interface BlockSpec {
  tag: string;
  class: string;
  style: string;
}

/** Python html.escape（quote=True）等价实现。 */
function H(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function styleOf(raw: string, pat: string): string {
  const m = raw.match(new RegExp(pat));
  return m ? m[1] : '';
}

function cleanStyle(s: string): string {
  if (!s) return '';
  let out = s;
  for (const prop of ['width', 'height', 'max-width', 'min-width', 'min-height']) {
    out = out.replace(new RegExp(`(?:^|;)\\s*${prop}:[^;]+;?`, 'g'), ';');
  }
  return out.replace(/;/g, ';').replace(/^;+|;+$/g, '').trim();
}

/**
 * 按 Slate 节点自身的对齐属性 `jc`（justification）覆盖参考样式里的 text-align。
 *
 * 规则正文每个标题/段落节点的 attrs 携带 `jc`（center/left/right/both），
 * 这是前台真实对齐的来源；而参考快照（rule_native_reference*.html）的 heading 样式
 * 可能整体是居中的（如 6355 的 heading-2），若直接套用会把本该左对齐的标题误居中。
 * 故：有 jc 用 jc 映射值，缺 jc 默认左对齐，并剔除参考样式的 text-align。
 */
function alignFromJc(style: string, attrs: Record<string, any>): string {
  const jcMap: Record<string, string> = {
    center: 'center',
    left: 'left',
    right: 'right',
    both: 'justify',
    distribute: 'justify',
  };
  const jc = attrs && attrs.jc !== undefined ? String(attrs.jc) : undefined;
  const align = jc !== undefined ? jcMap[jc] || 'left' : 'left';
  let s = (style || '')
    .replace(/text-align\s*:\s*[^;]+;?/gi, '')
    .replace(/;+/g, ';')
    .replace(/^;+|;+$/g, '');
  return s ? `${s};text-align:${align}` : `text-align:${align}`;
}

/**
 * 按 Slate 节点自身的缩进属性 `ind` 叠加 CSS 缩进。
 *
 * `ind` 字段（docx 风格）：left=左缩进、right=右缩进、firstLine=首行缩进(正)、
 * hanging=悬挂缩进(正，转为负 text-indent)。原前台（风神）的真实映射（见
 * rule_native_reference*.html）为：
 *   - `ind:{left:N}`     → `padding-left:Npx; text-indent:0px`（左缩进，无首行缩进）
 *   - `ind:{firstLine:N}`→ `padding-left:0px; text-indent:Npx`（无左缩进，首行缩进）
 *   - 无 `ind` 的块      → 沿用参考默认（正文标准首行缩进），**不**继承上下文左缩进。
 *
 * 每个块只渲染自己 `ind`，风神不会让无 ind 的段落去继承上一个标题的左缩进
 * （否则「（一）」下的正文会被错误左移，与「（二）」下的同类正文不一致）。
 * 参考段落默认带 `text-indent:32px`，故 `ind:{left:N}` 必须显式把 text-indent 置 0，
 * 否则会与残留的首行缩进叠加。
 */
function buildBlockStyle(baseStyle: string, attrs: Record<string, any>, ctxLeft = 0): string {
  const ind = attrs && attrs.ind;
  if (!ind || typeof ind !== 'object') {
    // 无 ind：若处于带左缩进的上下文（如「（一）」这类左缩进标题下的正文），
    // 原文该正文是顶格的（无左缩进、无首行缩进），需剥掉参考默认的首行缩进；
    // 否则沿用参考默认（正文标准首行缩进），避免影响其它文档。
    if (ctxLeft > 0) {
      let s = (baseStyle || '')
        .replace(/padding-left\s*:\s*[^;]+;?/gi, '')
        .replace(/text-indent\s*:\s*[^;]+;?/gi, '')
        .replace(/;+/g, ';')
        .replace(/^;+|;+$/g, '');
      return s ? `${s};padding-left:0px;text-indent:0px` : 'padding-left:0px;text-indent:0px';
    }
    return baseStyle;
  }
  const left = typeof ind.left === 'number' ? ind.left : 0;
  let textIndent = 0;
  if (typeof ind.firstLine === 'number') textIndent = ind.firstLine;
  else if (typeof ind.hanging === 'number' && ind.hanging > 0) textIndent = -ind.hanging;

  let s = (baseStyle || '')
    .replace(/padding-left\s*:\s*[^;]+;?/gi, '')
    .replace(/text-indent\s*:\s*[^;]+;?/gi, '')
    .replace(/;+/g, ';')
    .replace(/^;+|;+$/g, '');
  const add: string[] = [];
  if (left) add.push(`padding-left:${left}px`);
  if (textIndent) add.push(`text-indent:${textIndent}px`);
  return s ? (add.length ? `${s};${add.join(';')}` : s) : add.join(';');
}

function isSlateNode(x: unknown): x is any[] {
  return Array.isArray(x) && x.length > 0 && typeof x[0] === 'string' && (x.length === 1 || (typeof x[1] === 'object' && x[1] !== null && !Array.isArray(x[1])));
}

function extractText(children: unknown): string {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (typeof x === 'string') out.push(x);
    else if (isSlateNode(x)) for (const k of x.slice(2)) walk(k);
  };
  if (Array.isArray(children)) for (const c of children) walk(c);
  return out.join('');
}

function leafStyle(attrs: Record<string, any>): string {
  let style = '';
  if (attrs.bold) style += 'font-weight:bold;';
  if (attrs.sz) style += `font-size:${attrs.sz}pt;`;
  if (attrs.color) style += `color:${attrs.color};`;
  return style;
}

function renderLeaf(attrs: Record<string, any>, text: string): string {
  return `<span data-type="leaf" style="${leafStyle(attrs)}">${H(text)}</span>`;
}

function renderChildren(
  children: unknown,
  spec: Record<string, BlockSpec>,
  ctx?: RenderCtx,
): string {
  if (children === null || children === undefined) return '';
  if (typeof children === 'string') return H(children);
  if (!Array.isArray(children)) return '';
  if (!ctx) ctx = { left: 0 };
  const out: string[] = [];
  for (const ch of children) {
    if (typeof ch === 'string') out.push(H(ch));
    else if (isSlateNode(ch)) out.push(renderNode(ch, spec, ctx));
  }
  return out.join('');
}

function renderTable(
  type: string,
  children: any[],
  spec: Record<string, BlockSpec>,
  attrs: Record<string, any> = {},
): string {
  if (type === 'table') {
    const b = spec.table || { tag: 'div', class: '', style: '' };
    const inner = renderChildren(children, spec);
    // 表级缩进：attrs.ind.left → 容器 margin-left（原前台 data-type="table" 容器即用 margin-left）。
    // 先剥掉参考 spec 里固化的 margin-left，再按源数据重建。
    let style = cleanStyle(b.style).replace(/margin-left\s*:\s*[^;]+;?/gi, '');
    const indLeft =
      attrs && attrs.ind && typeof attrs.ind === 'object' && typeof attrs.ind.left === 'number'
        ? attrs.ind.left
        : 0;
    if (indLeft) style += `;margin-left:${indLeft}px`;
    // 列宽：attrs.colsWidth（px 数组）→ colgroup；表格总宽 = 各列之和。
    // 与原生（rule_native_reference_6355）一致：自动布局 + table width=列宽之和 +
    // col 宽度提示。单元格 white-space:pre-wrap（中文可在任意处断行），内容超出
    // 列宽即折行——这正是原文表格的折叠行为，需按列宽精确复刻而非自适应撑宽。
    // 不用 table-layout:fixed（原生无此属性），以免与原文渲染口径不一致。
    let colgroup = '';
    let tableStyle = 'border-collapse:collapse';
    if (Array.isArray(attrs.colsWidth) && attrs.colsWidth.length) {
      const ws = attrs.colsWidth.map((w: any) => (typeof w === 'number' && w > 0 ? w : 100));
      const total = ws.reduce((a: number, x: number) => a + x, 0);
      colgroup = `<colgroup>${ws.map((w: number) => `<col style="width:${w}px">`).join('')}</colgroup>`;
      tableStyle += `;width:${total}px`;
    }
    return `<div data-type="table" class="${b.class}" style="${style}"><table style="${tableStyle}">${colgroup}<tbody>${inner}</tbody></table></div>`;
  }
  if (type === 'tr') {
    // 行内单元格：保留所有非隐藏单元格（含行首 / 行中空格）。
    // 仅裁掉行尾的纯空单元格——浏览器会自动补齐行尾缺失单元格，裁掉可避免产生多余的尾列；
    // 但行首 / 行中空格必须保留，否则整行左移错位。例：骑士考核「实际值<T0」收尾行，
    // col2（目标区间）为空格，丢弃后本应在 col3 的「实际值<T0」会误落到 col2。
    const cells = (children || []).filter(
      (c: any) => isSlateNode(c) && (c[0] === 'td' || c[0] === 'tc'),
    );
    let lastKeep = cells.length - 1;
    while (lastKeep >= 0) {
      const a = (cells[lastKeep][1] || {}) as Record<string, any>;
      const t = extractText(cells[lastKeep].slice(2)).trim();
      const meaningful =
        t !== '' ||
        a.fill ||
        (a.colSpan as number) > 1 ||
        (a.rowSpan as number) > 1 ||
        a.hidden;
      if (meaningful) break;
      lastKeep--;
    }
    const keep = new Set(cells.slice(0, lastKeep + 1));
    const trimmed = (children || []).filter((c: any) => {
      if (isSlateNode(c) && (c[0] === 'td' || c[0] === 'tc')) return keep.has(c);
      return true;
    });
    return `<tr>${renderChildren(trimmed, spec)}</tr>`;
  }
  if (type === 'td' || type === 'tc') {
    // 合并格占位（hidden:true）：合并格除首格外会带 hidden 占位，前台不渲染（与参考 DOM 一致）。
    // 普通空格（非隐藏）必须渲染为 <td></td>：否则该列被后续单元格挤占，整行左移错位。
    if (attrs.hidden) return '';
    const b = spec['table-cell'] || { tag: 'td', class: '', style: '' };
    // 合并格：原生 td 恒带 rowspan/colspan（见参考快照 6355，缺省为 1）。
    // 此前漏掉该属性，「有效运力标准等级」这类 colSpan:5 的格只占 1 列，整表错位。
    const cs = typeof attrs.colSpan === 'number' && attrs.colSpan > 0 ? attrs.colSpan : 1;
    const rs = typeof attrs.rowSpan === 'number' && attrs.rowSpan > 0 ? attrs.rowSpan : 1;
    // fill / vAlign：单元格背景色与垂直对齐（docx 风格属性，原前台会应用）
    let style = cleanStyle(b.style);
    if (attrs.fill) style += `;background-color:${String(attrs.fill)}`;
    const vaMap: Record<string, string> = { top: 'top', center: 'middle', middle: 'middle', bottom: 'bottom' };
    const va = vaMap[String(attrs.vAlign || '').toLowerCase()];
    if (va) style += `;vertical-align:${va}`;
    // bdr：单元格显式边框（docx 风格）。源数据指定 #000000 single 时覆盖参考 spec 的
    // 默认浅色边框，否则表格没有原文的黑色网格线（7107 实际缺陷）。
    const bdr = attrs.bdr && typeof attrs.bdr === 'object' ? attrs.bdr : null;
    if (bdr) {
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const v = (bdr as Record<string, any>)[side];
        if (!v || typeof v !== 'object') continue;
        const val = String(v.val || 'single');
        const sz = typeof v.sz === 'number' && v.sz > 0 ? v.sz : 1;
        const color = v.color ? String(v.color) : '#000000';
        style +=
          val === 'none'
            ? `;border-${side}:none`
            : `;border-${side}:${sz}px ${val === 'single' ? 'solid' : val} ${color}`;
      }
    }
    return `<td data-type="table-cell" rowspan="${rs}" colspan="${cs}" class="${b.class}" style="${style}">${renderChildren(children, spec, { left: 0, inCell: true })}</td>`;
  }
  return '';
}

/** 渲染上下文：left=当前继承的左缩进；counters=列表计数器（ordered 为 number[] 多级计数）；
 *  inCell=处于表格单元格内（原生强制 text-indent/padding-left 为 0）。 */
interface RenderCtx {
  left: number;
  counters?: Map<string, number | number[]>;
  inCell?: boolean;
}

/**
 * 列表项渲染（块 attrs.list：listId/level/listStyle，对应原前台 data-testid="list"）。
 *
 * 原前台（见 rule_native_reference_6355.html）把带 list 属性的块渲染为：
 *   <div style="display:flex;padding-left:{缩进}">
 *     <span class="list-symbol-wrapper">…<span class="list-symbol">●</span></span>
 *     <内容块 style="…;flex-grow:1;text-indent:0px;padding-left:0px">…</内容块>
 *   </div>
 * 缩进 = ind.left + level*32（快照实测：level0→0/32、level1→32/96、level2→64/128、
 * level3→96，步长恒为 32，基准即块自身的 ind.left）。
 *
 * 若忽略 list 属性，这些块会被拍平成顶格段落：多级 bullet 与缩进全丢，
 * 「（2）xxx」标题下的条目看起来就像一堆独立段落（rule 7107 实际缺陷）。
 */
function renderListItem(
  list: Record<string, any>,
  dt: string,
  b: BlockSpec,
  attrs: Record<string, any>,
  children: unknown[],
  spec: Record<string, BlockSpec>,
  ctx?: RenderCtx,
): string {
  const level = typeof list.level === 'number' ? list.level : 0;
  const indLeft =
    attrs && attrs.ind && typeof attrs.ind === 'object' && typeof attrs.ind.left === 'number'
      ? attrs.ind.left
      : 0;
  if (ctx && attrs && attrs.ind && typeof attrs.ind === 'object' && typeof attrs.ind.left === 'number') {
    ctx.left = attrs.ind.left;
  }
  const pad = indLeft + level * 32;

  let symbol = '';
  if (!list.hideSymbol) {
    const ls = list.listStyle && typeof list.listStyle === 'object' ? list.listStyle : {};
    if (list.isOrdered) {
      const listId = String(list.listId || '');
      if (!ctx) ctx = { left: 0 };
      if (!ctx.counters) ctx.counters = new Map();
      // 多级有序列表：同一 listId 下按 level 维护独立计数器，进入条目时
      // 当前层级 +1 并把更深层级计数清零（docx 多级编号语义）。
      // 此前按 listId 平铺累加，导致层级 0-3 的条目连成 1..20+，层级丢失。
      const key = `ol:${listId}`;
      let arr = ctx.counters.get(key);
      if (!Array.isArray(arr)) {
        arr = [];
        ctx.counters.set(key, arr);
      }
      arr[level] = (arr[level] || 0) + 1;
      for (let i = level + 1; i < arr.length; i++) arr[i] = 0;
      // 符号：listStyle.text 为编号模板（如 "%1."），%k 取第 k 级计数器；
      // 各级模板只引用自身层级（level0→%1、level1→%2…），即各级独立编号。
      const fmt =
        list.listStyle && typeof list.listStyle === 'object' && typeof list.listStyle.text === 'string'
          ? String(list.listStyle.text)
          : '';
      const fmtType =
        list.listStyle && typeof list.listStyle === 'object' && typeof list.listStyle.format === 'string'
          ? String(list.listStyle.format)
          : 'decimal';
      if (fmt.includes('%')) {
        symbol = fmt.replace(/%(\d+)/g, (_m, k) => {
          const idx = Number(k) - 1;
          const v = idx >= 0 && idx < arr!.length && arr![idx] ? arr![idx] : arr![level] || 1;
          // 模板 %N（N=level+1）引用自身层级计数器，用本条目 listStyle.format 渲染；
          // 各级 format 不同：decimal(1)/lowerLetter(a)/lowerRoman(i) 等（见 7107 源数据）。
          return formatListNumber(v, fmtType);
        });
      } else {
        symbol = fmt || `${formatListNumber(arr[level], fmtType)}.`;
      }
    } else {
      symbol = String(ls.text || '•');
    }
  }
  const symFonts =
    list.listStyle &&
    list.listStyle.symbolStyle &&
    typeof list.listStyle.symbolStyle === 'object' &&
    list.listStyle.symbolStyle.fonts
      ? String(list.listStyle.symbolStyle.fonts)
      : 'Arial';
  const sym = symbol
    ? `<span class="list-symbol-wrapper" style="font-weight:700;margin-right:6px;white-space:nowrap;">` +
      `<span class="list-symbol" style="font-family:${H(symFonts)};font-size:16px;font-weight:700;">${H(symbol)}</span></span>`
    : '';

  // 内容块：沿用参考样式与 jc 对齐，但缩进由外层 flex 容器负责，内层强制置 0（与原生一致）
  let inner = alignFromJc(cleanStyle(b.style), attrs)
    .replace(/padding-left\s*:\s*[^;]+;?/gi, '')
    .replace(/text-indent\s*:\s*[^;]+;?/gi, '')
    .replace(/;+/g, ';')
    .replace(/^;+|;+$/g, '');
  inner = inner ? `${inner};padding-left:0px;text-indent:0px;flex-grow:1` : 'padding-left:0px;text-indent:0px;flex-grow:1';
  return (
    `<div data-type="list-item" style="display:flex;padding-left:${pad}px">` +
    `${sym}<${b.tag} data-type="${dt}" class="${b.class}" style="${inner}">${renderChildren(children, spec, ctx)}</${b.tag}>` +
    `</div>`
  );
}

function renderNode(node: any[], spec: Record<string, BlockSpec>, ctx?: RenderCtx): string {
  if (!isSlateNode(node)) return '';
  const type = node[0];
  const attrs: Record<string, any> =
    node.length > 1 && typeof node[1] === 'object' && node[1] !== null && !Array.isArray(node[1])
      ? node[1]
      : {};
  const children = node.slice(2);
  if (type === 'span') {
    if (children.length === 1 && typeof children[0] === 'string') {
      return renderLeaf(attrs, children[0]);
    }
    const inner = renderChildren(children, spec);
    const style = leafStyle(attrs);
    return style ? `<span data-type="leaf" style="${style}">${inner}</span>` : inner;
  }
  // 图片节点：Slate 表示为 ["img", { src, name, width, height, ... }]，没有子节点。
  // 原实现（含 Python 原版）漏掉该类型，落入默认 <div> 分支被整段丢弃，图片从不进文档。
  if (type === 'img' || type === 'image' || type === 'picture') {
    const src = attrs.src || attrs.url || attrs.dataUrl || '';
    if (!src) return '';
    const alt = String(attrs.name || attrs.alt || '');
    const width = Number(attrs.width);
    const maxW = Number.isFinite(width) && width > 0 ? `max-width:${width}px;` : '';
    return (
      `<div data-type="image" style="margin:14px 0;${maxW}">` +
      `<img src="${H(src)}" alt="${H(alt)}" style="max-width:100%;height:auto;border-radius:4px;" />` +
      `</div>`
    );
  }
  if (type === 'table' || type === 'tr' || type === 'tc') {
    return renderTable(type, children, spec, attrs);
  }
  const dt = TAG_TO_DT[type];
  if (dt === undefined) return `<div>${renderChildren(children, spec)}</div>`;
  const b = spec[dt];
  if (!b) return `<div data-type="${dt}">${renderChildren(children, spec)}</div>`;
  const ind = attrs && attrs.ind;
  // 列表项：attrs.list 携带 listId/level/listStyle，必须按原前台 flex 列表渲染，
  // 否则多级 bullet 与缩进丢失，标题下的条目会被拍平成独立段落。
  const list = attrs && attrs.list && typeof attrs.list === 'object' ? attrs.list : null;
  if (list) return renderListItem(list, dt, b, attrs, children, spec, ctx);
  let st = buildBlockStyle(alignFromJc(cleanStyle(b.style), attrs), attrs, ctx ? ctx.left : 0);
  // 表格单元格内：原生（6355 快照 td 内段落）一律 text-indent:0px;padding-left:0px，
  // 且无 margin-bottom（快照实测 None）。若沿用参考默认（首行缩进 32px / margin-bottom 8px）：
  // 缩进会压小首行可用宽度（表头折行），margin 会让行高比原生每段多 8px（7107 实际缺陷）。
  let inner = renderChildren(children, spec, ctx && ctx.inCell ? ctx : undefined);
  if (ctx && ctx.inCell) {
    st = st
      .replace(/padding-left\s*:\s*[^;]+;?/gi, '')
      .replace(/text-indent\s*:\s*[^;]+;?/gi, '')
      .replace(/margin-bottom\s*:\s*[^;]+;?/gi, '')
      .replace(/;+/g, ';')
      .replace(/^;+|;+$/g, '');
    st = st ? `${st};padding-left:0px;text-indent:0px;margin-bottom:0px` : 'padding-left:0px;text-indent:0px;margin-bottom:0px';
    // 单元格内空段落：原生按整行高渲染（docx 常用空段落给合并格做垂直占位，
    // 如 7107「麦当劳」格 = 22 个空段落 + 1 个文本段，原文文字因此被推到格中部）。
    // 空 div 无行盒高度会塌陷为 0，插入 <br> 撑出一行行高（line-height:24.93px）。
    if (!extractText(children).trim()) inner = '<br>';
  }
  // 维护上下文左缩进：仅当块自身携带显式 left（含 0）时更新，供后续 ind:null 块继承，
  // 使「（一）」这类左缩进标题下的正文与之对齐。
  if (ctx && ind && typeof ind === 'object' && typeof ind.left === 'number') ctx.left = ind.left;
  return `<${b.tag} data-type="${dt}" class="${b.class}" style="${st}">${inner}</${b.tag}>`;
}

// ───────── 元数据 ─────────
// 注意：生效时间只在 header（rule-details__header-update-time）展示，与真实前台对齐；
// 这里不再重复放「生效时间」（原 meta 栏用了 effectiveStartTime 与 header 的 effectiveTime 不一致，会出两个不同值）。
const META_FIELDS: [string, (d: Record<string, any>) => string][] = [
  ['更新时间', (d) => trunc(d.updatedAt)],
  ['文件组号', (d) => String(d.ruleSerialId ?? '').trim()],
  ['文件类型', (d) => String(d.ruleTypeDesc ?? '').trim()],
  ['文件版本号', (d) => String(d.ruleVesion ?? '').trim()],
  ['查看历史版本', (d) => `当前快照 v${d.ruleVesion || '?'} · ${trunc(d.updatedAt)}`],
  ['文件发文部门', (d) => String(d.bizOwnerDept ?? '').trim()],
  ['业务模块', (d) => String(d.ruleCategoryName ?? '').trim()],
  ['文件负责人', (d) => String(d.bizOwnerName ?? '').trim()],
];

function trunc(v: unknown, n = 10): string {
  if (v === null || v === undefined) return '';
  return String(v).slice(0, n);
}

function metaPairs(data: Record<string, any>): [string, string][] {
  const out: [string, string][] = [];
  for (const [label, fn] of META_FIELDS) {
    const v = String(fn(data) ?? '').trim();
    if (!v) continue;
    out.push([label, v]);
  }
  return out;
}

function buildMetaRow(data: Record<string, any>): string {
  const pairs = metaPairs(data);
  if (!pairs.length) return '';
  const [firstLabel, firstVal] = pairs[0];
  const effHtml = `<div style="margin-bottom:6px;"><strong style="color:#555;">${H(firstLabel)}：</strong>${H(firstVal)}</div>`;
  const parts = pairs
    .slice(1)
    .map(
      ([label, v]) =>
        `<span style="margin-right:18px;white-space:nowrap;"><strong style="color:#555;">${H(label)}：</strong>${H(v)}</span>`,
    );
  return `<div class="rule-details__meta" style="flex:0 0 100%;margin-top:12px;padding:0;font-size:13px;color:#555;line-height:1.9;">${effHtml}<div>${parts.join('')}</div></div>`;
}

function padLeft(style: string): number {
  const m = (style || '').match(/padding-left\s*:\s*(\d+)px/);
  return m ? Number(m[1]) : 0;
}

/**
 * 文末「附件：」区块（对应原前台 rule-details__bottom，见 6355 快照）：
 * 位于可编辑内容区末尾，带 border-top:1px solid #eee 分隔线 + padding:20px，
 * 内含 h1「附件：」与附件列表。原前台恒渲染该区块（无附件时列表为空），
 * 不能因 attachments 为空而整个省略（7107 实际缺陷：缺分隔线与附件区块）。
 */
function buildBottomHtml(data: Record<string, any>): string {
  const atts: Record<string, any>[] = data.attachments || [];
  const valid = atts.filter((a) => a.url && a.name);
  const items = valid
    .map(
      (a) =>
        `<li style="margin-bottom:6px;"><a href="${H(a.url)}" target="_blank" rel="noopener noreferrer" style="color:#1677ff;text-decoration:none;">${H(a.name)}</a></li>`,
    )
    .join('');
  const list = items ? `<ul style="margin:8px 0 0;padding-left:20px;line-height:1.9;">${items}</ul>` : '';
  return (
    `<div class="rule-details__bottom" style="border-top:1px solid #eeeeee;padding:20px;font-size:16px;">` +
    `<h1 style="font-size:16px;font-weight:700;margin:0;">附件：</h1>${list}` +
    `</div>`
  );
}

function buildHeader(raw: string, ruleName: string, eff: string, metaHtml = ''): string {
  let hStyle = cleanStyle(styleOf(raw, 'class="rule-details__header"[^>]*style="([^"]*)"'));
  const tStyle = cleanStyle(styleOf(raw, 'class="rule-details__header-title"[^>]*style="([^"]*)"'));
  const h1Style = cleanStyle(styleOf(raw, 'class="text-limit-two-lines"[^>]*style="([^"]*)"'));
  const timeStyle = cleanStyle(
    styleOf(raw, 'class="rule-details__header-update-time"[^>]*style="([^"]*)"'),
  );
  const aStyle = cleanStyle(styleOf(raw, 'class="rule-details__header-actions"[^>]*style="([^"]*)"'));
  const btnStyle = cleanStyle(
    styleOf(raw, 'class="ant-btn css-w18tjb ant-btn-default"[^>]*style="([^"]*)"'),
  );
  const timeHtml = eff
    ? `<div class="rule-details__header-update-time" style="${timeStyle}">生效时间：${H(eff)} </div>`
    : '';
  if (metaHtml) hStyle = hStyle ? `${hStyle};flex-wrap:wrap` : 'flex-wrap:wrap';
  return (
    `<div class="rule-details__header" style="${hStyle}">` +
    `<div class="rule-details__header-title" style="${tStyle}">` +
    `<h1 class="text-limit-two-lines" style="${h1Style}">${H(ruleName)}</h1>${timeHtml}</div>` +
    `<div class="rule-details__header-actions" style="${aStyle}">` +
    `<button type="button" class="ant-btn css-w18tjb ant-btn-default" style="${btnStyle}">` +
    `<span>最新版本</span></button></div>` +
    `${metaHtml}</div>`
  );
}

const HEAD_MD: Record<string, string> = {
  h1: '# ',
  h2: '## ',
  h3: '### ',
  h4: '#### ',
  h5: '##### ',
  h6: '###### ',
};

/** Markdown 渲染上下文：listCounters 维护有序列表多级计数器（与 HTML renderListItem 同级语义）。 */
interface MdCtx {
  counters: Map<string, number[]>;
}

/** 行内（叶子/span/img）转 Markdown：加粗包 **，图片转 ![alt](src)。 */
function mdInline(node: any, ctx: MdCtx): string {
  if (typeof node === 'string') return node;
  if (!isSlateNode(node)) return '';
  const type = node[0];
  const attrs =
    node.length > 1 && typeof node[1] === 'object' && node[1] !== null && !Array.isArray(node[1])
      ? node[1]
      : {};
  const children = node.slice(2);
  if (type === 'span') {
    const inner = mdInlineChildren(children, ctx);
    return attrs.bold ? `**${inner}**` : inner;
  }
  if (type === 'img' || type === 'image' || type === 'picture') {
    const src = attrs.src || attrs.url || attrs.dataUrl || '';
    if (!src) return '';
    return `![${attrs.name || attrs.alt || 'image'}](${src})`;
  }
  return mdInlineChildren(children, ctx);
}

function mdInlineChildren(children: any, ctx: MdCtx): string {
  if (children === null || children === undefined) return '';
  if (typeof children === 'string') return children;
  if (!Array.isArray(children)) return '';
  return children.map((c) => mdInline(c, ctx)).join('');
}

/**
 * 列表项 Markdown 前缀（与 HTML renderListItem 同语义）：
 * 有序列表按 listId+level 维护计数器，套用 listStyle.text 模板（%k 取第 k 级）与 format
 * （decimal/lowerLetter/lowerRoman…）；无序列表取 listStyle.text 或默认 •。
 * 缩进按 level 每级 2 空格（Markdown 嵌套列表惯例），对应原生 padding-left 层级递进。
 */
function listPrefixMd(
  list: Record<string, any>,
  ctx: MdCtx,
): { symbol: string; pad: number } {
  const level = typeof list.level === 'number' ? list.level : 0;
  const pad = level * 2;
  let symbol = '';
  if (!list.hideSymbol) {
    const ls = list.listStyle && typeof list.listStyle === 'object' ? list.listStyle : {};
    if (list.isOrdered) {
      const listId = String(list.listId || '');
      const key = `ol:${listId}`;
      let arr = ctx.counters.get(key);
      if (!Array.isArray(arr)) {
        arr = [];
        ctx.counters.set(key, arr);
      }
      arr[level] = (arr[level] || 0) + 1;
      for (let i = level + 1; i < arr.length; i++) arr[i] = 0;
      const fmt = ls.text && typeof ls.text === 'string' ? String(ls.text) : '';
      const fmtType = ls.format && typeof ls.format === 'string' ? String(ls.format) : 'decimal';
      if (fmt.includes('%')) {
        symbol = fmt.replace(/%(\d+)/g, (_m, k) => {
          const idx = Number(k) - 1;
          const v = idx >= 0 && idx < arr.length && arr[idx] ? arr[idx] : arr[level] || 1;
          return formatListNumber(v, fmtType);
        });
      } else {
        symbol = fmt || `${formatListNumber(arr[level], fmtType)}.`;
      }
    } else {
      symbol = String(ls.text || '•');
    }
  }
  return { symbol, pad };
}

/** 单元格内联文本（转义管道符与换行，避免破坏 GFM 表格）。 */
function mdCellText(node: any, ctx: MdCtx): string {
  const a = node.length > 1 && typeof node[1] === 'object' && node[1] !== null ? node[1] : {};
  if (a.hidden) return '';
  return mdInlineChildren(node.slice(2), ctx)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** 表格转 GFM：首行作表头并补分隔行；保留中间空单元格维持列对齐，仅裁行尾空单元格。 */
function mdTable(node: any, ctx: MdCtx): string[] {
  const rows = (node.slice(2) || []).filter((c: any) => isSlateNode(c) && c[0] === 'tr');
  if (!rows.length) return [];
  const rowCells = (tr: any): string[] => {
    const cells = (tr.slice(2) || [])
      .filter((c: any) => isSlateNode(c) && (c[0] === 'td' || c[0] === 'tc'))
      .map((c: any) => mdCellText(c, ctx));
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    return cells;
  };
  const all = rows.map(rowCells);
  let ncols = 0;
  for (const r of all) ncols = Math.max(ncols, r.length);
  const renderRow = (cells: string[]): string => {
    const padded: string[] = [];
    for (let i = 0; i < ncols; i++) padded.push(cells[i] ?? '');
    return `| ${padded.join(' | ')} |`;
  };
  const out: string[] = [];
  all.forEach((cells: string[], idx: number) => {
    out.push(renderRow(cells));
    if (idx === 0) out.push(`| ${Array(ncols).fill('---').join(' | ')} |`);
  });
  return out;
}

/**
 * Slate 树 → Markdown 行数组（与 HTML 结构对齐：标题 / 列表编号符号 / 表格 / 加粗 / 图片）。
 * 块级之间用空行分隔，保证 Markdown 把相邻段落正确拆开、表格被识别为表格。
 */
/** 块级节点类型（与行内 span/字符串区分）：命中则递归展开其子块。 */
const BLOCK_TYPES = new Set<string>([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'table', 'tr', 'td', 'tc',
  'ul', 'ol', 'li', 'img', 'image', 'picture',
]);

function mdBlocks(nodes: any[], ctx: MdCtx, out: string[] = []): string[] {
  const sep = (): void => {
    if (out.length && out[out.length - 1] !== '') out.push('');
  };
  if (!Array.isArray(nodes)) return out;
  for (const ch of nodes) {
    if (typeof ch === 'string') {
      const t = ch.trim();
      if (t) {
        sep();
        out.push(t);
      }
      continue;
    }
    if (!isSlateNode(ch)) continue;
    const type = ch[0];
    const attrs =
      ch.length > 1 && typeof ch[1] === 'object' && ch[1] !== null && !Array.isArray(ch[1])
        ? ch[1]
        : {};
    const children = ch.slice(2);
    if (type === 'img' || type === 'image' || type === 'picture') {
      const src = attrs.src || attrs.url || attrs.dataUrl || '';
      if (src) {
        sep();
        out.push(`![${attrs.name || attrs.alt || 'image'}](${src})`);
      }
      continue;
    }
    if (type === 'table') {
      sep();
      out.push(...mdTable(ch, ctx));
      continue;
    }
    // 列表项优先于标题判断：HTML 把带 list 属性的块（含标题标签）渲染为 list-item。
    const list = attrs.list && typeof attrs.list === 'object' ? attrs.list : null;
    if (list) {
      const { symbol, pad } = listPrefixMd(list, ctx);
      const content = mdInlineChildren(children, ctx).trim();
      const indent = ' '.repeat(Math.max(0, pad));
      sep();
      out.push(`${indent}${symbol}${symbol ? ' ' : ''}${content}`);
      continue;
    }
    if (HEAD_MD[type]) {
      const line = mdInlineChildren(children, ctx).trim();
      if (line) {
        sep();
        out.push(HEAD_MD[type] + line);
      }
      continue;
    }
    // 普通段落 / 容器：若子节点里含块级节点（标题/段落/表格/列表项等）则递归展开，
    // 否则取行内文本为一段（含加粗）。避免把多段内容挤成一行而与 HTML 错位。
    if ((children as any[]).some((c) => isSlateNode(c) && BLOCK_TYPES.has(c[0]))) {
      mdBlocks(children, ctx, out);
    } else {
      const text = mdInlineChildren(children, ctx).trim();
      if (text) {
        sep();
        out.push(text);
      }
    }
  }
  return out;
}

/** 规则文档生成（原 jobs/ruledoc/gen_rule_doc.py）。 */
@Injectable()
export class RuleDocPipeline implements TaskHandler {
  readonly id = 'rule_doc';
  readonly stages: TaskStage[] = [
    { id: 'login', name: '登录风神' },
    { id: 'query', name: '查询规则' },
    { id: 'build', name: '组装文档' },
    { id: 'write', name: '写出 HTML' },
  ];
  private readonly refDir: string;
  private readonly outDir: string;

  constructor(
    private readonly handlers: TaskHandlersService,
    private readonly fetchSvc: RuledocFetchService,
    private readonly config: ConfigService,
  ) {
    this.handlers.register(this);
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.refDir = path.join(root, 'apps', 'api', 'runtime', 'jobs', 'ruledoc');
    this.outDir = path.join(root, 'apps', 'api', 'runtime', 'jobs', 'ruledoc', 'out');
  }

  private readRefs(): string[] {
    const out: string[] = [];
    for (const f of REF_FILES) {
      const p = path.join(this.refDir, f);
      if (!fs.existsSync(p)) {
        throw new Error(
          `参考快照缺失，无法提取前台原生样式：${p}\n（快照应位于 ${this.refDir}；若目录改名或被移动，请同步修改引用路径）`,
        );
      }
      out.push(fs.readFileSync(p, 'utf-8'));
    }
    if (!out.length) throw new Error(`REFS 为空，无法提取前台原生样式：${REF_FILES.join(', ')}`);
    return out;
  }

  private blockSpec(): Record<string, BlockSpec> {
    const spec: Record<string, BlockSpec> = {};
    for (const raw of this.readRefs()) {
      const re = /<([a-zA-Z0-9]+)[^>]*?\bdata-type="([a-z0-9-]+)"[^>]*>/g;
      for (const m of raw.matchAll(re)) {
        const dt = m[2];
        if (spec[dt]) continue;
        const whole = m[0];
        const cm = whole.match(/class="([^"]*)"/);
        const sm = whole.match(/style="([^"]*)"/);
        spec[dt] = { tag: m[1], class: cm ? cm[1] : '', style: sm ? sm[1] : '' };
      }
    }
    return spec;
  }

  private buildDoc(data: Record<string, any>, spec: Record<string, BlockSpec>, raw: string): string {
    const tree = JSON.parse(data.ruleContent);
    const body = renderChildren(tree.slice(2), spec, { left: 0 });
    const ruleName = data.ruleName || '未命名规则';
    let eff = String(data.effectiveTime || data.effectiveStartTime || data.publishEndTime || '');
    eff = eff.slice(0, 10);
    const rdStyle = cleanStyle(styleOf(raw, 'class="rule-details"(?:\\s[^>]*)?style="([^"]*)"'));
    let contStyle = cleanStyle(styleOf(raw, 'class="rule-details-container"[^>]*style="([^"]*)"'));
    contStyle = contStyle ? `${contStyle};padding-top:0` : 'padding-top:0';
    const prevStyle = cleanStyle(
      styleOf(raw, 'class="ruleDetail-preview ruleDetail-preview-withToc"[^>]*style="([^"]*)"'),
    );
    let ccStyle = cleanStyle(styleOf(raw, 'data-cangjie-content="true"[^>]*style="([^"]*)"'));
    ccStyle = ccStyle
      ? `${ccStyle};-webkit-user-select:text;-moz-user-select:text;user-select:text`
      : 'user-select:text';
    const ceStyle = cleanStyle(styleOf(raw, 'data-cangjie-editable="true"[^>]*style="([^"]*)"'));
    const metaRow = buildMetaRow(data);
    const bottomHtml = buildBottomHtml(data);
    const header = buildHeader(raw, ruleName, eff, metaRow);
    return (
      `<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">\n` +
      `<title>${H(ruleName)}</title>\n<style>html,body{margin:0;padding:0;background:#fff;}</style>\n` +
      `</head>\n<body>\n` +
      `<div class="rule-details" style="${rdStyle}">\n${header}\n` +
      `<div class="rule-details-container" style="${contStyle}">\n` +
      `<div class="ruleDetail-preview ruleDetail-preview-withToc" style="${prevStyle}">\n` +
      `<div data-cangjie-content="true" data-zoom="1" style="${ccStyle}">\n` +
      `<div data-cangjie-editable="true" style="${ceStyle}">\n${body}\n${bottomHtml}\n` +
      `</div></div></div></div>\n</div>\n</body></html>`
    );
  }

  private buildMarkdown(data: Record<string, any>): string {
    const ruleName = data.ruleName || '未命名规则';
    let eff = String(data.effectiveTime || data.effectiveStartTime || data.publishEndTime || '');
    eff = eff.slice(0, 10);
    let tree: any[];
    try {
      tree = JSON.parse(data.ruleContent);
    } catch (e) {
      throw new Error(`ruleContent 不是合法 JSON，无法生成 Markdown：${(e as Error).message}`);
    }
    const lines: string[] = [`# ${ruleName}`, ''];
    if (eff) lines.push(`生效时间：${eff}`, '');
    lines.push('（正文完整排版详见同名 .html）', '');

    const pairs = metaPairs(data);
    if (pairs.length) {
      lines.push('## 元数据', '');
      for (const [label, v] of pairs) lines.push(`${label}：${v}`);
      lines.push('');
    }
    const mdCtx: MdCtx = { counters: new Map() };
    lines.push(...mdBlocks(tree.slice(2), mdCtx));

    const atts = (data.attachments || []).filter((a: Record<string, any>) => a.url && a.name);
    if (atts.length) {
      lines.push('', '## 附件', '');
      for (const a of atts) lines.push(`- [${a.name}](${a.url})`);
    }
    return lines.join('\n').replace(/\s+$/, '') + '\n';
  }

  async run(ctx: TaskRunContext): Promise<void> {
    const ruleArg = ctx.args['--rule'];
    if (ruleArg === undefined || ruleArg === null || ruleArg === '') {
      throw new Error('缺少必填参数 --rule');
    }
    const ruleId = Number(ruleArg);
    const history = !ctx.args['--no-history'];

    const state: { data?: Record<string, any>; doc?: string; md?: string } = {};
    const p = new Pipeline(ctx, state);

    p.stage('login', '登录风神', () => {
      ctx.log('[cookie] 复用本地 cookie（失效时由取数服务自动重登）');
    });

    p.stage('query', '查询规则', async () => {
      state.data = await this.fetchSvc.queryRule(ruleId, history, undefined);
    });

    p.stage('build', '组装文档', () => {
      const raw = this.readRefs()[0];
      const spec = this.blockSpec();
      state.doc = this.buildDoc(state.data!, spec, raw);
      state.md = this.buildMarkdown(state.data!);
    });

    p.stage('write', '写出 HTML', () => {
      fs.mkdirSync(this.outDir, { recursive: true });
      const htmlPath = path.join(this.outDir, `rule_doc_${ruleId}.html`);
      fs.writeFileSync(htmlPath, state.doc!, 'utf-8');
      ctx.log(`[save] ${htmlPath} (${Math.floor(Buffer.byteLength(state.doc!, 'utf-8') / 1024)} KB)`);
      if (!state.md) throw new Error('build 节点未产出 markdown 内容，拒绝写出空 .md');
      const mdPath = path.join(this.outDir, `rule_doc_${ruleId}.md`);
      fs.writeFileSync(mdPath, state.md, 'utf-8');
      ctx.log(`[save] ${mdPath} (${Math.floor(Buffer.byteLength(state.md, 'utf-8') / 1024)} KB)`);
    });

    await p.run();
  }
}
