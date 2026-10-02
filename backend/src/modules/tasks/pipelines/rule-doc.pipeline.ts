import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { TaskHandler, TaskRunContext, TaskStage } from '../task-handler';
import { Pipeline } from '../pipeline';
import { TaskHandlersService } from '../task-handlers.service';
import { RuledocFetchService } from '../../fetch/ruledoc-fetch.service';

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

function renderChildren(children: unknown, spec: Record<string, BlockSpec>): string {
  if (children === null || children === undefined) return '';
  if (typeof children === 'string') return H(children);
  if (!Array.isArray(children)) return '';
  const out: string[] = [];
  for (const ch of children) {
    if (typeof ch === 'string') out.push(H(ch));
    else if (isSlateNode(ch)) out.push(renderNode(ch, spec));
  }
  return out.join('');
}

function renderTable(type: string, children: any[], spec: Record<string, BlockSpec>): string {
  if (type === 'table') {
    const b = spec.table || { tag: 'div', class: '', style: '' };
    const inner = renderChildren(children, spec);
    return `<div data-type="table" class="${b.class}" style="${cleanStyle(b.style)}"><table><tbody>${inner}</tbody></table></div>`;
  }
  if (type === 'tr') return `<tr>${renderChildren(children, spec)}</tr>`;
  if (type === 'td' || type === 'tc') {
    // 前台不渲染空单元格：与参考 DOM 保持一致
    if (extractText(children).trim() === '') return '';
    const b = spec['table-cell'] || { tag: 'td', class: '', style: '' };
    return `<td data-type="table-cell" class="${b.class}" style="${cleanStyle(b.style)}">${renderChildren(children, spec)}</td>`;
  }
  return '';
}

function renderNode(node: any[], spec: Record<string, BlockSpec>): string {
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
  if (type === 'table' || type === 'tr' || type === 'tc') {
    return renderTable(type, children, spec);
  }
  const dt = TAG_TO_DT[type];
  if (dt === undefined) return `<div>${renderChildren(children, spec)}</div>`;
  const b = spec[dt];
  if (!b) return `<div data-type="${dt}">${renderChildren(children, spec)}</div>`;
  const st = cleanStyle(b.style);
  return `<${b.tag} data-type="${dt}" class="${b.class}" style="${st}">${renderChildren(children, spec)}</${b.tag}>`;
}

// ───────── 元数据 ─────────
const META_FIELDS: [string, (d: Record<string, any>) => string][] = [
  ['生效时间', (d) => trunc(d.effectiveStartTime || d.effectiveEndTime || d.publishStartTime)],
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

function buildAttachmentsHtml(data: Record<string, any>, indent = 0): string {
  const atts: Record<string, any>[] = data.attachments || [];
  const valid = atts.filter((a) => a.url && a.name);
  if (!valid.length) return '';
  const items = valid
    .map(
      (a) =>
        `<li style="margin-bottom:6px;"><a href="${H(a.url)}" target="_blank" rel="noopener noreferrer" style="color:#1677ff;text-decoration:none;">${H(a.name)}</a></li>`,
    )
    .join('');
  return `<div class="rule-details__attachments" style="margin:16px ${indent}px 24px;padding:0;font-size:13px;color:#333;line-height:1.9;"><div style="font-weight:bold;margin-bottom:8px;">附件</div><ul style="margin:0;padding-left:0;list-style:none;line-height:1.9;">${items}</ul></div>`;
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

function mdLines(children: any[]): string[] {
  const out: string[] = [];
  for (const ch of children || []) {
    if (!isSlateNode(ch)) continue;
    if (ch[0] === 'table') {
      for (const tr of ch.slice(2)) {
        if (!isSlateNode(tr) || tr[0] !== 'tr') continue;
        let cells = tr
          .slice(2)
          .filter((tc: unknown) => isSlateNode(tc))
          .map((tc: any) => extractText(tc.slice(2)).trim());
        cells = cells.filter((c: string) => c);
        if (cells.length) out.push(cells.join(' | '));
      }
      continue;
    }
    const line = extractText(ch.slice(2)).trim();
    if (line) out.push((HEAD_MD[ch[0]] || '') + line);
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
    this.refDir = path.join(root, 'python', 'jobs', 'ruledoc');
    this.outDir = path.join(root, 'python', 'jobs', 'ruledoc', 'out');
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
    const body = renderChildren(tree.slice(2), spec);
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
    const attIndent = padLeft(contStyle) + padLeft(ccStyle);
    const attachmentsHtml = buildAttachmentsHtml(data, attIndent);
    const header = buildHeader(raw, ruleName, eff, metaRow);
    return (
      `<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">\n` +
      `<title>${H(ruleName)}</title>\n<style>html,body{margin:0;padding:0;background:#fff;}</style>\n` +
      `</head>\n<body>\n` +
      `<div class="rule-details" style="${rdStyle}">\n${header}\n` +
      `<div class="rule-details-container" style="${contStyle}">\n` +
      `<div class="ruleDetail-preview ruleDetail-preview-withToc" style="${prevStyle}">\n` +
      `<div data-cangjie-content="true" data-zoom="1" style="${ccStyle}">\n` +
      `<div data-cangjie-editable="true" style="${ceStyle}">\n${body}\n` +
      `</div></div></div></div>${attachmentsHtml}\n</div>\n</body></html>`
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
    lines.push(...mdLines(tree.slice(2)));

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
