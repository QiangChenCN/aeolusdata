import { Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { AeolusCookieService } from './aeolus-cookie.service';
import { AuthError, TIME_FIELDS, TIME_FIELD } from './delivery-query.service';

/**
 * 运单明细「导出优先」取数（移植自 Python `get_data/delivery_export.py`）。
 *
 * 为什么不用分页 queryTracking：分页拉全量（约 125 页）会撞服务端按分钟请求数配额墙，
 * 触发「请求太频繁」限流（实测一次刷新被拒 12 次、耗时翻倍）。风神运单数据页自带「导出」
 * 能力，本质是异步导出：触发 → 服务端异步生成 xlsx → 返回签名下载链接。一次导出拿全站全量，
 * 彻底绕开分页限流。与 violation 的 download/1.0 同构（下载免 cookie）。
 *
 * 三段式（均为纯 HTTP）：
 *   1. exportTracking/2.0     触发导出（body 同 queryTracking 查询条件，无 teamId=全站）
 *   2. queryExportTask/2.0    轮询导出任务列表（**双 agencyTrackingFs 前缀**，单形式 404）
 *   3. queryTaskUrl/2.0       用 taskId 取 OSS 签名 fileUrl（约1h有效期）
 *   4. 下载 fileUrl（无 cookie，免鉴权）
 *
 * 归属算法：触发前记 max_id，触发后轮询到 id>max_id 且 status=1 即认领（taskId 服务端自增唯一）。
 *
 * 字段映射：xlsx 中文表头 → 双写中文原名 + 英文键，对齐 queryTracking 返回值，
 * 使下游 order_rules / rider_dimension / achievement 零改动（含时间列转毫秒、布尔「是/否」转布尔）。
 *
 * 注意前缀差异（已验证）：exportTracking 单 agencyTrackingFs；queryExportTask/queryTaskUrl 双形式。
 */
const EXPORT_URL =
  'https://httpizza.ele.me/xtop/xtop.merchant.agencyTrackingFs.exportTracking/2.0';
const TASK_URL =
  'https://httpizza.ele.me/xtop/xtop.merchant.agencyTrackingFs.agencyTrackingFs.queryExportTask/2.0';
const URL_URL =
  'https://httpizza.ele.me/xtop/xtop.merchant.agencyTrackingFs.agencyTrackingFs.queryTaskUrl/2.0';

const HEADERS_BASE: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json',
  origin: 'https://aeolus.ele.me',
  referer: 'https://aeolus.ele.me/',
};

const POLL_INTERVAL = 3.0;
const DEFAULT_POLL_TIMEOUT = 180.0;

// 中文表头 → 英文键（对齐 queryTracking 返回值；重点覆盖 order_rules 依赖的键）
const CN2EN: Record<string, string> = {
  商id: 'merchantId',
  商名称: 'merchantName',
  站点id: 'teamId',
  站点名称: 'teamName',
  商圈id: 'zoneId',
  商圈名称: 'zoneName',
  运单id: 'trackingId',
  订单号: 'orderNo',
  骑手id: 'knightId',
  骑手名称: 'knightName',
  平台商家id: 'platformMerchantId',
  平台商家名称: 'platformMerchantName',
  商家订单流水号: 'merchantOrderSerial',
  运单类型: 'trackingType',
  运单状态: 'stateDesc',
  配送标品: 'deliveryStandard',
  订单来源: 'orderSource',
  '订单距离(km)': 'orderDistanceKm',
  '订单金额(元)': 'orderAmount',
  '订单重量(kg)': 'orderWeightKg',
  '用户下单时间': 'userOrderAt',
  '用户支付时间': 'userPayAt',
  '运单创建时间': 'trackingCreatedAt',
  '团队接单时间': 'teamAcceptAt',
  '骑手接单时间': 'acceptAtLast',
  '骑手到店时间': 'riderArriveAt',
  '实际出餐时间': 'actualMealReadyAt',
  '骑手取餐时间': 'pickupAt',
  '骑手送达时间': 'deliverAt',
  '运单完成时间': 'trackingFinishAt',
  '用户期望时间': 'userExpectAt',
  '骑手考核时间': 'riderAssessAt',
  '运单取消时间': 'trackingCancelAt',
  '平台期望时间': 'platformExpectAt',
  '是否超平台期望时间': 'isOverPlatformExpect',
  '超平台期望送达时长': 'overPlatformExpectDuration',
  '是否超用户T': 'isOverUserT',
  '是否超骑手T': 'isOverRiderT',
  配送时长: 'deliveryDuration',
  天气等级: 'weatherLevel',
  天气: 'weather',
  欺诈是否成立: 'isCheat',
  违规取餐是否成立: 'isViolatePickup',
  违规到店是否成立: 'isViolateArrive',
  违规送达是否成立: 'isViolateDeliver',
  是否逆向单: 'isReverse',
  是否发生转单: 'isTransfer',
  是否发生改派: 'isReassign',
  索赔是否成立: 'isClaim',
  索赔原因: 'claimReason',
  是否异常报备: 'isAbnormalReport',
  异常报备项: 'abnormalReportItem',
  是否异常标记: 'isAbnormalMark',
  异常标记项: 'abnormalMarkItem',
  虚假报备是否成立: 'isFalseReport',
  虚假报备项: 'falseReportItem',
  虚假标记是否成立: 'isFalseMark',
  虚假标记项: 'falseMarkItem',
  取消发起方: 'cancelInitiator',
  取消发起原因: 'cancelReason',
  取消责任方: 'cancelResponsible',
  用户投诉是否成立: 'isUserComplaint',
  用户投诉内容: 'userComplaintContent',
  用户投诉责任方: 'userComplaintResponsible',
  商户投诉是否成立: 'isMerchantComplaint',
  商户投诉内容: 'merchantComplaintContent',
  商户投诉责任方: 'merchantComplaintResponsible',
  用户评价责任方: 'userEvalResponsible',
  用户评价等级: 'userEvalLevel',
  商户评价责任方: 'merchantEvalResponsible',
  商户评价等级: 'merchantEvalLevel',
  是否高笔单: 'isHighValue',
  是否二呼单: 'isSecondCall',
};

// 中文布尔列：导出用「是/否」，下游只认 0/false/空，需标准化为布尔。
const BOOL_EN = new Set<string>([
  'isCheat',
  'isReverse',
  'isReassign',
  'isTransfer',
  'isAbnormalReport',
  'isAbnormalMark',
  'isViolatePickup',
  'isViolateArrive',
  'isViolateDeliver',
  'isClaim',
  'isFalseReport',
  'isFalseMark',
  'isOverPlatformExpect',
  'isOverUserT',
  'isOverRiderT',
  'isHighValue',
  'isSecondCall',
]);

// 时间列：导出是「YYYY-MM-DD HH:MM:SS」(北京时间) 字符串，下游期望毫秒时间戳整数。
const TIME_EN = new Set<string>([
  'trackingCreatedAt',
  'teamAcceptAt',
  'acceptAtLast',
  'riderArriveAt',
  'actualMealReadyAt',
  'pickupAt',
  'deliverAt',
  'trackingFinishAt',
  'userOrderAt',
  'userPayAt',
  'trackingCancelAt',
  'userExpectAt',
  'riderAssessAt',
  'platformExpectAt',
]);

type TaskRow = { id?: unknown; status?: unknown; [k: string]: unknown };

function checkTimeField(f?: string): string {
  const t = f || TIME_FIELD;
  if (!TIME_FIELDS.includes(t)) {
    throw new Error(`未知 time_field: ${t}（可用 ${TIME_FIELDS.join('/')}）`);
  }
  return t;
}

/** 字符串时间 → 毫秒时间戳（北京时间）。非时间值原样返回。 */
function toMs(v: unknown): unknown {
  if (typeof v === 'number') return Math.floor(v);
  if (v instanceof Date) return v.getTime();
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s) return v;
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(
    /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (m) {
    const d = Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      m[6] ? Number(m[6]) : 0,
    );
    // 北京时间是 UTC+8：把"北京时间数字"当 UTC 算出的 epoch 多 8h，减去即得真实 UTC epoch。
    return d - 8 * 3600 * 1000;
  }
  return v;
}

@Injectable()
export class DeliveryExportService {
  private readonly logger = new Logger(DeliveryExportService.name);

  constructor(private readonly cookies: AeolusCookieService) {}

  /**
   * 完整链路：触发 → 轮询认领 → 拿URL → 下载 → 解析，返回 dict 列表（中文+英文双键）。
   * cookie 可选（不传则 ensure）；会话失效自动重登重试一次。
   * 其它失败（任务超时/网络/触发未受理）抛异常，由调用方回落分页。
   */
  async exportOrders(
    startMs: number,
    endMs: number,
    timeField?: string,
    cookie?: string,
  ): Promise<Record<string, unknown>[]> {
    let ck = cookie || (await this.cookies.ensure());
    try {
      return await this.run(ck, startMs, endMs, timeField);
    } catch (e) {
      if (e instanceof AuthError) {
        this.logger.warn('运单导出会话失效，重登后重试一次');
        ck = await this.cookies.relogin();
        return await this.run(ck, startMs, endMs, timeField);
      }
      throw e;
    }
  }

  private async run(
    cookie: string,
    startMs: number,
    endMs: number,
    timeField?: string,
  ): Promise<Record<string, unknown>[]> {
    const f = checkTimeField(timeField);
    // 1) 记录当前最大 taskId，用于认领本次导出（历史任务 id<=max_id 自动排除）
    let maxId = 0;
    try {
      const tasks = await this.listTasks(cookie);
      for (const t of tasks) {
        const id = Number((t as TaskRow).id);
        if (id > maxId) maxId = id;
      }
    } catch {
      maxId = 0;
    }
    // 2) 触发导出
    const body = this.buildExportBody(startMs, endMs, f);
    if (!(await this.triggerExport(body, cookie))) {
      throw new Error('运单导出触发未受理（data 非 true）');
    }
    // 3) 轮询认领 id>maxId 且 status=1 的任务
    const deadline = Date.now() + DEFAULT_POLL_TIMEOUT * 1000;
    let myId: number | null = null;
    while (Date.now() < deadline) {
      const tasks = await this.listTasks(cookie);
      for (const t of tasks) {
        const id = Number((t as TaskRow).id) || 0;
        const status = Number((t as TaskRow).status) || 0;
        if (id > maxId && status === 1) {
          myId = id;
          break;
        }
      }
      if (myId != null) break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL * 1000));
    }
    if (myId == null) {
      throw new Error(`运单导出任务超时未完成（${DEFAULT_POLL_TIMEOUT}s）`);
    }
    // 4) 拿 URL → 下载 → 解析
    const url = await this.taskUrl(myId, cookie);
    const buf = await this.download(url);
    return parseXlsxBytes(buf);
  }

  private buildExportBody(startMs: number, endMs: number, f: string) {
    return {
      params: {
        request: {
          [`${f}Start`]: startMs,
          [`${f}End`]: endMs,
          merchantConsumerDistanceStart: '0',
          merchantConsumerDistanceEnd: '999999',
          payAmountStart: '0',
          payAmountEnd: '999999',
          weightStart: '0',
          weightEnd: '999999',
          trackingStateKey: 'all',
          trackingLabelKey: 'all',
          [`${f}TimePeriodList`]: ['0-86400'],
        },
      },
    };
  }

  private async post(
    url: string,
    payload: unknown,
    cookie: string,
  ): Promise<any> {
    const h: Record<string, string> = { ...HEADERS_BASE, cookie };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 40000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: h,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private async triggerExport(body: unknown, cookie: string): Promise<boolean> {
    const j = await this.post(EXPORT_URL, body, cookie);
    const res = j && j.result;
    if (res == null) throw new AuthError('导出触发 result is null（会话被顶号）');
    const code = String(res.code);
    if (code !== '200') {
      throw new Error(`导出触发失败 code=${code} msg=${res.msg}`);
    }
    return Boolean(res.data);
  }

  private async listTasks(cookie: string): Promise<TaskRow[]> {
    const j = await this.post(
      TASK_URL,
      { params: { request: { activeTabKey: '1' } } },
      cookie,
    );
    const res = j && j.result;
    if (res == null) throw new AuthError('任务列表 result is null（会话被顶号）');
    const data = res.data || {};
    if (Array.isArray(data)) return data as TaskRow[];
    return (data.list || data.records || data.data || []) as TaskRow[];
  }

  private async taskUrl(taskId: number, cookie: string): Promise<string> {
    const j = await this.post(
      URL_URL,
      { params: { request: { taskId } } },
      cookie,
    );
    const res = j && j.result;
    if (res == null) throw new AuthError('任务URL result is null（会话被顶号）');
    const url = res.data;
    if (typeof url !== 'string' || !url.startsWith('http')) {
      throw new Error(`任务URL无效 taskId=${taskId} data=${url}`);
    }
    return url;
  }

  /** 下载文件（无 cookie，免鉴权，同 violation.download/1.0）。返回 Buffer。 */
  private async download(url: string): Promise<Buffer> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: ctrl.signal,
      });
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** xlsx bytes → dict 列表（中文表头**双写**英文键）。 */
function parseXlsxBytes(data: Buffer): Record<string, unknown>[] {
  const wb = XLSX.read(data, { type: 'buffer', cellDates: true, raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: null,
    raw: true,
  }) as unknown[][];
  if (!rows.length) return [];
  const headers = (rows[0] || []).map((h) =>
    h == null ? '' : String(h).trim(),
  );
  const out: Record<string, unknown>[] = [];
  for (let ri = 1; ri < rows.length; ri++) {
    const r = rows[ri];
    const d: Record<string, unknown> = {};
    let has = false;
    for (let i = 0; i < headers.length; i++) {
      if (i >= r.length) break;
      const h = headers[i];
      const v = r[i];
      if (v == null || v === '') continue;
      has = true;
      const en = CN2EN[h];
      // 中文布尔「是/否」统一转布尔（中英文键都转），否则「否」会被误判为真值。
      if (typeof v === 'string' && (v.trim() === '是' || v.trim() === '否')) {
        const b = v.trim() === '是';
        d[h] = b;
        if (en) d[en] = b;
        continue;
      }
      d[h] = v; // 保留中文原名
      if (en) d[en] = TIME_EN.has(en) ? toMs(v) : v; // 英文键（时间列转毫秒）
    }
    if (has) out.push(d);
  }
  return out;
}
