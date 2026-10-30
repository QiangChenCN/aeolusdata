/**
 * 运单明细看板的「原始行 → 展示行」归一化（本看板私有，不与其它看板共享）。
 *
 * 原始行是风神导出的**宽表**（一份行同时带中文表头键与英文键，见
 * `infra/fetch/sources/delivery-export.service.ts` 的 CN2EN，共 70+ 列）。直接整行丢给前端
 * 有两个问题：单日全站动辄数千行 × 70 列，包体过大；且中英双键让前端无从下手。
 *
 * 因此这里把原始行投影成一份**固定列定义**的展示行：
 *   · 列定义（`DELIVERY_COLUMNS`）是唯一事实源，控制器把它一并返回，前端据此渲染表头；
 *   · 列定义直接由风神原始字段（`CN2EN`：中文表头 → 英文真名）全量生成，
 *     列名即字段名、不做任何美化重命名，看板开放风神导出的**全部列**，用户可在「列设置」里自行勾选；
 *   · 取值按 keys 顺序回落（英文键优先，兼容分页接口的纯英文行）；
 *   · 时间列统一成北京时间字符串 `YYYY-MM-DD HH:mm:ss`（字典序即时间序，排序无需特判）；
 *   · 布尔列统一成「是 / 否」，避免「否」这类字符串被当成真值。
 */

import { CN2EN, BOOL_EN, TIME_EN } from '../../infra/fetch/sources/delivery-export.service';

export type DeliveryColKind = 'text' | 'time' | 'bool' | 'num';

export interface DeliveryColumn {
  key: string;
  label: string;
  kind: DeliveryColKind;
  /** 取值键（按顺序回落）：英文键来自导出映射 CN2EN，中文键为导出表头原名。 */
  keys: string[];
}

/**
 * 分页/导出两套取数现已**统一字段名**：2026-10-27 起 CN2EN 的英文侧已对齐风神
 * queryTracking 的真实字段名（`infra/fetch/storage/delivery-columns.ts` 的 `FIELD_ORDER`），
 * 与分页接口返回键完全一致。因此不再需要「分页键 → 导出键」的反向桥接，PAGE_ALIAS 留空。
 * 列取值仍按 `keys` 顺序回落（英文真名优先 + 中文表头兜底），两种取数来源天然兼容。
 */
const PAGE_ALIAS: Record<string, string> = {};

/**
 * 枚举「分页编码 → 导出中文名」对照表（按**风神英文真名**做 key）。分页接口对部分枚举只回数字编码、
 * 导出回中文名，为让两路径显示一致（且回落分页时也有可读名），按列 key 做编码翻译。
 * 仅含实拉反推确认的一对一映射；未出现的编码原样透传（不猜测，避免翻错责任方等）。
 */
const ENUM_DICT: Record<string, Record<string, string>> = {
  deliverTypeName: { '1': '即时单', '2': '预订单' }, // 运单类型：分页 trackingType ↔ 导出 deliverTypeName
  weatherGradeName: { '0': '正常' }, // 天气等级：分页 weatherGrade=0 ↔ 导出 weatherGradeName=正常
  cancelSponsor: { '1': '用户' }, // 取消发起方：分页 cancelSponsor=1 ↔ 导出 cancelInitiator=用户
  cancelDuty: { '3': '用户责' }, // 取消责任方：分页 cancelDuty=3 ↔ 导出 cancelResponsible=用户责
};

/** 对文本列的取值做枚举编码 → 中文名翻译（无匹配则原样返回）。 */
function translateEnum(colKey: string, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  const dict = ENUM_DICT[colKey];
  if (!dict) return v;
  const s = String(v);
  return dict[s] !== undefined ? dict[s] : v;
}

/** 导出键 → 其分页别名键列表（构造列 keys 时展开）。 */
const PAGE_ALIAS_REV: Record<string, string[]> = {};
for (const [pg, en] of Object.entries(PAGE_ALIAS)) {
  (PAGE_ALIAS_REV[en] ||= []).push(pg);
}

/** 把列的基础 keys 扩展为「基础键 + 其分页别名键」，兼容两套取数 schema。 */
function expandKeys(keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    out.push(k);
    for (const pg of PAGE_ALIAS_REV[k] || []) out.push(pg);
  }
  return out;
}

/**
 * 时长类数字列（不在 TIME_EN 但应参与数值排序）：超平台期望送达时长 / 配送时长。
 */
const EXTRA_NUMERIC_EN = new Set(['overPlatfromExpecteTime', 'deliveryDuration']);

/**
 * 列定义直接由风神原始字段（`CN2EN`：中文表头 → 英文真名）全量生成：
 *   · 列名（label）= 风神中文表头（如「商名称」「运单完成时间」），key = 风神英文真名（如 agencyName / trackingFinishAt）；
 *   · 不做任何「美化重命名」，列名即字段名、所见即所得，避免列名与真实字段对不上的困惑；
 *   · 取值按 keys=[英文真名, 中文表头] 顺序回落（兼容分页接口的纯英文行）；
 *   · kind 由 BOOL_EN / TIME_EN / EXTRA_NUMERIC_EN 推断；
 *   · 看板开放风神导出的全部列，用户可在「列设置」里自行勾选。
 */
function buildColumns(): DeliveryColumn[] {
  const out: DeliveryColumn[] = [];
  for (const [cn, en] of Object.entries(CN2EN)) {
    let kind: DeliveryColKind = 'text';
    if (BOOL_EN.has(en)) kind = 'bool';
    else if (TIME_EN.has(en)) kind = 'time';
    else if (EXTRA_NUMERIC_EN.has(en)) kind = 'num';
    out.push({ key: en, label: cn, kind, keys: expandKeys([en, cn]) });
  }
  return out;
}

/** 看板列定义（唯一事实源）：风神导出的全部字段，直接由 CN2EN 生成。 */
export const DELIVERY_COLUMNS: DeliveryColumn[] = buildColumns();

/** 数值列（排序时按数值比大小，其余按字典序）。 */
export const DELIVERY_NUMERIC_KEYS = new Set(
  DELIVERY_COLUMNS.filter((c) => c.kind === 'num').map((c) => c.key),
);

/** 关键字搜索命中的列（运单号 / 骑手 / 商家 / 站点），用风神英文真名。 */
export const DELIVERY_SEARCH_KEYS = [
  'trackingId',
  'platformTrackingId',
  'teamId',
  'teamName',
  'knightId',
  'knightName',
  'agencyId',
  'agencyName',
];

export type DeliveryRow = Record<string, string | number | null>;

/** 按 keys 顺序取第一个非空值（对象 / 字符串均按 trim 后非空判定）。 */
function pick(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = raw?.[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return v;
  }
  return null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 时间戳 → 北京时间字符串 `YYYY-MM-DD HH:mm:ss`。
 * 输入可能是：毫秒时间戳（导出路径）、秒级时间戳、或已是格式化字符串。
 */
export function fmtOrderTime(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v === 0 ? '' : msToStr(v);
  const s = String(v).trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return Number(s) === 0 ? '' : msToStr(Number(s));
  return s; // 已是格式化时间，原样返回
}

function msToStr(v: number): string {
  const ms = v > 1e12 ? v : v * 1000; // 秒级时间戳兜底
  const d = new Date(ms + 8 * 3600 * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** 布尔列：导出是 true/false 或「是/否」，统一成「是 / 否」，缺值返回 ''。 */
function fmtBool(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'number') return v ? '是' : '否';
  const s = String(v).trim();
  if (s === '是' || s === 'true' || s === '1') return '是';
  return '否';
}

function fmtNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 原始行 → 展示行（键即 DELIVERY_COLUMNS 的 key）。 */
export function normalizeOrderRow(raw: Record<string, unknown>): DeliveryRow {
  const out: DeliveryRow = {};
  for (const col of DELIVERY_COLUMNS) {
    const v = translateEnum(col.key, pick(raw, expandKeys(col.keys)));
    if (col.kind === 'time') out[col.key] = fmtOrderTime(v);
    else if (col.kind === 'bool') out[col.key] = fmtBool(v);
    else if (col.kind === 'num') out[col.key] = fmtNum(v);
    else out[col.key] = v === null ? '' : String(v);
  }
  return out;
}
