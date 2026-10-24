/**
 * 运单明细看板的「原始行 → 展示行」归一化（本看板私有，不与其它看板共享）。
 *
 * 原始行是风神导出的**宽表**（一份行同时带中文表头键与英文键，共 80+ 列：
 * 见 `infra/fetch/sources/delivery-export.service.ts` 的 CN2EN）。直接整行丢给前端
 * 有两个问题：单日全站动辄数千行 × 80 列，包体过大；且中英双键让前端无从下手。
 *
 * 因此这里把原始行投影成一份**固定列定义**的展示行：
 *   · 列定义（`ORDER_DETAIL_COLUMNS`）是唯一事实源，控制器把它一并返回，前端据此渲染表头；
 *   · 取值按 keys 顺序回落（英文键优先，兼容分页接口的纯英文行）；
 *   · 时间列统一成北京时间字符串 `YYYY-MM-DD HH:mm:ss`（字典序即时间序，排序无需特判）；
 *   · 布尔列统一成「是 / 否」，避免「否」这类字符串被当成真值。
 */

export type OrderDetailColKind = 'text' | 'time' | 'bool' | 'num';

export interface OrderDetailColumn {
  key: string;
  label: string;
  kind: OrderDetailColKind;
  /** 取值键（按顺序回落）：英文键来自导出映射 CN2EN，中文键为导出表头原名。 */
  keys: string[];
}

export const ORDER_DETAIL_COLUMNS: OrderDetailColumn[] = [
  { key: 'order_id', label: '运单ID', kind: 'text', keys: ['trackingId', '运单id', '运单ID'] },
  { key: 'order_no', label: '订单号', kind: 'text', keys: ['orderNo', '订单号', 'merchantOrderSerial', '商家订单流水号'] },
  { key: 'team_id', label: '站点ID', kind: 'text', keys: ['teamId', '站点id', '团队ID'] },
  { key: 'team_name', label: '站点名称', kind: 'text', keys: ['teamName', '站点名称'] },
  { key: 'rider_id', label: '骑手ID', kind: 'text', keys: ['knightId', '骑手id'] },
  { key: 'rider_name', label: '骑手姓名', kind: 'text', keys: ['knightName', '骑手名称'] },
  { key: 'merchant_id', label: '商家ID', kind: 'text', keys: ['merchantId', '商id'] },
  { key: 'merchant_name', label: '商家名称', kind: 'text', keys: ['merchantName', '商名称'] },
  { key: 'zone_name', label: '商圈', kind: 'text', keys: ['zoneName', '商圈名称'] },
  { key: 'state', label: '运单状态', kind: 'text', keys: ['stateDesc', '运单状态'] },
  { key: 'tracking_type', label: '运单类型', kind: 'text', keys: ['trackingType', '运单类型'] },
  { key: 'order_source', label: '订单来源', kind: 'text', keys: ['orderSource', '订单来源'] },
  { key: 'weather', label: '天气', kind: 'text', keys: ['weather', '天气'] },
  { key: 'distance_km', label: '订单距离(km)', kind: 'num', keys: ['orderDistanceKm', '订单距离(km)'] },
  { key: 'amount', label: '订单金额(元)', kind: 'num', keys: ['orderAmount', '订单金额(元)'] },
  { key: 'weight_kg', label: '订单重量(kg)', kind: 'num', keys: ['orderWeightKg', '订单重量(kg)'] },
  { key: 'user_order_at', label: '用户下单时间', kind: 'time', keys: ['userOrderAt', '用户下单时间'] },
  { key: 'tracking_created_at', label: '运单创建时间', kind: 'time', keys: ['trackingCreatedAt', '运单创建时间'] },
  { key: 'team_accept_at', label: '团队接单时间', kind: 'time', keys: ['teamAcceptAt', '团队接单时间'] },
  { key: 'accept_at', label: '骑手接单时间', kind: 'time', keys: ['acceptAtLast', '骑手接单时间'] },
  { key: 'arrive_at', label: '骑手到店时间', kind: 'time', keys: ['riderArriveAt', '骑手到店时间'] },
  { key: 'meal_ready_at', label: '实际出餐时间', kind: 'time', keys: ['actualMealReadyAt', '实际出餐时间'] },
  { key: 'pickup_at', label: '骑手取餐时间', kind: 'time', keys: ['pickupAt', '骑手取餐时间'] },
  { key: 'deliver_at', label: '骑手送达时间', kind: 'time', keys: ['deliverAt', '骑手送达时间'] },
  { key: 'finish_at', label: '运单完成时间', kind: 'time', keys: ['trackingFinishAt', '运单完成时间'] },
  { key: 'platform_expect_at', label: '平台期望时间', kind: 'time', keys: ['platformExpectAt', '平台期望时间'] },
  { key: 'user_expect_at', label: '用户期望时间', kind: 'time', keys: ['userExpectAt', '用户期望时间'] },
  { key: 'rider_assess_at', label: '骑手考核时间', kind: 'time', keys: ['riderAssessAt', '骑手考核时间'] },
  { key: 'cancel_at', label: '运单取消时间', kind: 'time', keys: ['trackingCancelAt', '运单取消时间'] },
  { key: 'over_platform', label: '超平台期望', kind: 'bool', keys: ['isOverPlatformExpect', '是否超平台期望时间'] },
  { key: 'over_user_t', label: '超用户T', kind: 'bool', keys: ['isOverUserT', '是否超用户T'] },
  { key: 'over_rider_t', label: '超骑手T', kind: 'bool', keys: ['isOverRiderT', '是否超骑手T'] },
  { key: 'is_transfer', label: '转单', kind: 'bool', keys: ['isTransfer', '是否发生转单'] },
  { key: 'is_reassign', label: '改派', kind: 'bool', keys: ['isReassign', '是否发生改派'] },
  { key: 'is_reverse', label: '逆向单', kind: 'bool', keys: ['isReverse', '是否逆向单'] },
  { key: 'is_abnormal_report', label: '异常报备', kind: 'bool', keys: ['isAbnormalReport', '是否异常报备'] },
  { key: 'is_cheat', label: '欺诈', kind: 'bool', keys: ['isCheat', '欺诈是否成立'] },
  { key: 'is_high_value', label: '高笔单', kind: 'bool', keys: ['isHighValue', '是否高笔单'] },
];

/** 数值列（排序时按数值比大小，其余按字典序）。 */
export const ORDER_DETAIL_NUMERIC_KEYS = new Set(
  ORDER_DETAIL_COLUMNS.filter((c) => c.kind === 'num').map((c) => c.key),
);

/** 关键字搜索命中的列（运单号 / 骑手 / 商家 / 站点）。 */
export const ORDER_DETAIL_SEARCH_KEYS = [
  'order_id',
  'order_no',
  'team_id',
  'team_name',
  'rider_id',
  'rider_name',
  'merchant_id',
  'merchant_name',
];

export type OrderDetailRow = Record<string, string | number | null>;

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
  if (typeof v === 'number') return msToStr(v);
  const s = String(v).trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return msToStr(Number(s));
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

/** 原始行 → 展示行（键即 ORDER_DETAIL_COLUMNS 的 key）。 */
export function normalizeOrderRow(raw: Record<string, unknown>): OrderDetailRow {
  const out: OrderDetailRow = {};
  for (const col of ORDER_DETAIL_COLUMNS) {
    const v = pick(raw, col.keys);
    if (col.kind === 'time') out[col.key] = fmtOrderTime(v);
    else if (col.kind === 'bool') out[col.key] = fmtBool(v);
    else if (col.kind === 'num') out[col.key] = fmtNum(v);
    else out[col.key] = v === null ? '' : String(v);
  }
  return out;
}
