import { Injectable } from '@nestjs/common';
import { QuarkCreds, QuarkCredsService } from '../creds/quark-creds.service';

/**
 * 电联 & IM 回复看板取数（Quark/Aeolus FBI 报表，reportId=473269）。
 *
 * 数据接口与 EquipmentFetchService 完全一致：WidgetAction（unifiedPivot 透视表）。
 * 凭证（DA cookie / 三件套 token）由 QuarkCredsService 统一兑换 —— 本服务只负责
 * 「构造该报表的 params → POST WidgetAction → 解析透视表」。
 *
 * 与装备报表的差异：
 *   · reportId=473269（装备是 860325）；QuarkCredsService.fetch(reportId) 据此取对应 token；
 *   · dataType=unifiedPivot（透视表，componentName=pivot-table），响应结构不同于
 *     unifiedTable，parse() 单独处理 crossTable 形态；
 *   · 字段 GUID / 条件（日期区间 + 大区 multiSelect）为电联&IM 专属。
 */
export const CONTACT_IM_REPORT_ID = '473269';
export const CONTACT_IM_DATASET_GUID = 77667002;

export const CONTACT_IM_URL =
  'https://quark.alibaba.com/fbi/.json' +
  '?action=report/WidgetAction&event_submit_doGetWidgetData=true' +
  '&componentName=pivot-table&_widgetId=24lbeuxm&_ts_=mvaejtzm';

const CONTACT_IM_WIDGET_ID = '24lbeuxm';
const CONTACT_IM_QUERY_ID = 'mmqqcbwty_ujfzj5';

/** 报表字段 GUID（行头 12 + 透视列头 __pivotsigma__ + 指标 7 = 20）。 */
const FIELD_GUIDS = [
  'mmrc33xf7_lxtdmy', 'mmrc33yik_9qeerd', 'mmrc33zop_qev3rw', 'mmrc341k8_rivyz2',
  'mmrc342wd_4os9k7', 'mmrc346js_29045u', 'mmrc3484f_z5r0ah', 'mmrc3497p_t9bdsu',
  'mmrc3991d_p2k03c', 'mmrc39ast_ksm2pu', 'mmrc395rr_snl2gy', 'mmrc397a1_57k8kl',
  '__pivotsigma__',
  'mmrc4qnhy_95364h', 'mmrc4qp10_whgdbq', 'mmrc34ep7_o7pn97', 'mmrc34h1f_qbyt0t',
  'mmrc34izr_rz8jhr', 'mmrc34l1c_w4xohp', 'mmrc34n13_ypu89r',
];

/** 字段类型映射（行头 / 透视列头 / 指标），与报表页 fieldType 配置一一对应。 */
const FIELD_TYPE_MAP: Record<string, string> = {
  mmrc33xf7_lxtdmy: 'rowHeader', mmrc33yik_9qeerd: 'rowHeader', mmrc33zop_qev3rw: 'rowHeader',
  mmrc341k8_rivyz2: 'rowHeader', mmrc342wd_4os9k7: 'rowHeader', mmrc346js_29045u: 'rowHeader',
  mmrc3484f_z5r0ah: 'rowHeader', mmrc3497p_t9bdsu: 'rowHeader', mmrc3991d_p2k03c: 'rowHeader',
  mmrc39ast_ksm2pu: 'rowHeader', mmrc395rr_snl2gy: 'rowHeader', mmrc397a1_57k8kl: 'rowHeader',
  '__pivotsigma__': 'columnHeader',
  mmrc4qnhy_95364h: 'indicator', mmrc4qp10_whgdbq: 'indicator', mmrc34ep7_o7pn97: 'indicator',
  mmrc34h1f_qbyt0t: 'indicator', mmrc34izr_rz8jhr: 'indicator', mmrc34l1c_w4xohp: 'indicator',
  mmrc34n13_ypu89r: 'indicator',
};

/**
 * 字段 GUID → 中文名（与 FBI 报表字段一一对应）。
 * 顺序依据字段配置（12 行维度 + 1 透视列头 + 7 指标），与看板导出的中文表头顺序一致。
 * 行维度/指标的中文按字段配置位置推断，首次跑真实接口后建议核对一遍。
 */
const FIELD_LABELS: Record<string, string> = {
  // —— 行维度（12）——
  mmrc33xf7_lxtdmy: '送达日期',
  mmrc33yik_9qeerd: '战区',
  mmrc33zop_qev3rw: '城市',
  mmrc341k8_rivyz2: '站点id',
  mmrc342wd_4os9k7: '站点名称',
  mmrc346js_29045u: '商圈id',
  mmrc3484f_z5r0ah: '商圈名称',
  mmrc3497p_t9bdsu: '运力线',
  mmrc3991d_p2k03c: '代理商id',
  mmrc39ast_ksm2pu: '代理商名称',
  mmrc395rr_snl2gy: '骑手id',
  mmrc397a1_57k8kl: '骑手姓名',
  // —— 透视列头（1，sigma 维度）——
  __pivotsigma__: '指标',
  // —— 指标（7）——
  mmrc4qnhy_95364h: '送达电联率',
  mmrc4qp10_whgdbq: 'IM及时回复率',
  mmrc34ep7_o7pn97: 'IM及时回复单量',
  mmrc34h1f_qbyt0t: 'IM咨询单量',
  mmrc34izr_rz8jhr: '电联剔除单量',
  mmrc34l1c_w4xohp: '剔除后接单量',
  mmrc34n13_ypu89r: '剔除后有效电联单量',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';

const HEADERS: Record<string, string> = {
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7',
  'bx-v': '2.5.37',
  'content-type': 'application/x-www-form-urlencoded',
  origin: 'https://quark.alibaba.com',
  priority: 'u=1, i',
  referer:
    'https://quark.alibaba.com/dashboard/view/report.htm?id=473269&DA_APP_NAME=lpd_meepo_ws',
  'sec-ch-ua': '"Microsoft Edge";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-storage-access': 'active',
  'user-agent': UA,
};

export interface ContactImReportView {
  headers: string[];
  rows: any[][];
  labels: Record<string, string>;
  /** 解析到的响应形态：列透视 / 交叉表 / 二维表 / 未知（未知时 raw 一定有内容，便于排查）。 */
  shape: 'columnPivot' | 'crossTable' | 'table' | 'unknown';
  raw: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 行头 / 指标的 GUID 序列（按报表字段配置顺序，用作响应缺 guid 时的位置兜底）。 */
const ROW_HEADER_GUIDS = FIELD_GUIDS.filter((g) => FIELD_TYPE_MAP[g] === 'rowHeader');
const INDICATOR_GUIDS = FIELD_GUIDS.filter((g) => FIELD_TYPE_MAP[g] === 'indicator');

@Injectable()
export class ContactImFetchService {
  constructor(private readonly creds: QuarkCredsService) {}

  /** 构造与浏览器抓包等价的 params（逐字段对照 curl）。 */
  buildPayload(
    reportToken: string,
    secure: string,
    metaTime: string,
    start: string,
    end: string,
    region: string[] = [],
  ): Record<string, any> {
    const ds = CONTACT_IM_DATASET_GUID;
    const cond = (id: string, name: string, value: unknown, valueType: string) => ({
      datasetGuid: ds,
      type: 'condition',
      config: { id, name, value, valueType },
    });
    return {
      widgetId: CONTACT_IM_WIDGET_ID,
      queryId: CONTACT_IM_QUERY_ID,
      dataType: 'unifiedPivot',
      configs: [
        { datasetGuid: ds, type: 'datasetId' },
        { datasetGuid: ds, type: 'count', config: { needCount: true } },
        { datasetGuid: ds, type: 'field', config: { guids: FIELD_GUIDS } },
        // 日期区间（必填）
        cond('wjnxa14p', 'en-wjnxa14p', { start, end }, 'dateTimeRange'),
        // 大区筛选（默认空 = 全部；可传 ['物流华东大区'] 等）
        cond('89wxs35j', 'en-89wxs35j', region, 'multiSelect'),
        cond('fqw59bvk', 'en-fqw59bvk', [], 'multiSelect'),
        cond('vniamld2', 'en-vniamld2', [], 'multiSelect'),
        cond('mmrje8j4m_322sw3', 'en-mmrje8j4m_3vh1da', [], 'multiSelect'),
        cond('bez1jtfa', 'en-bez1jtfa', [], 'multiSelect'),
        { datasetGuid: ds, type: 'drillDownExpandPath', config: { paths: [] } },
        { datasetGuid: ds, type: 'drillDownExpandPath', config: { paths: [] } },
        { datasetGuid: ds, type: 'fieldType', config: { guids: FIELD_TYPE_MAP } },
      ],
      reportIdToken: reportToken,
      secureParams: secure,
      metaTime: metaTime || '2026-07-15 12:18:07',
      needDebugInfo: false,
      reportId: Number(CONTACT_IM_REPORT_ID),
    };
  }

  private async post(
    cookie: string,
    reportToken: string,
    secure: string,
    metaTime: string,
    start: string,
    end: string,
    region: string[],
  ): Promise<string> {
    const payload = this.buildPayload(reportToken, secure, metaTime, start, end, region);
    const body = new URLSearchParams({ params: JSON.stringify(payload) }).toString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(CONTACT_IM_URL, {
        method: 'POST',
        headers: { ...HEADERS, cookie },
        body,
        signal: ctrl.signal,
      });
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 宽松 JSON 解析（供 pollKey 探测用，失败返回 null 而不抛）。 */
  private tryJson(raw: string): any | null {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** 解析 WidgetAction 响应：列透视（473269 实测形态）/ 交叉表 / 二维表 / 未知。 */
  parse(raw: string): ContactImReportView {
    let j: any;
    try {
      j = JSON.parse(raw);
    } catch {
      return { headers: [], rows: [], labels: {}, shape: 'unknown', raw };
    }
    const value = (j.data || {}).value || {};
    // 473269 实测形态（2026-10-17 用真实响应核对）：columns=7 个指标、rows=维度单元格、
    // values=每行指标值 {v}。必须优先于下面的 table 分支——两者都有 columns。
    if (Array.isArray(value.rows) && Array.isArray(value.values)) {
      return this.parseColumnPivot(value, raw);
    }
    if (value.crossTable || value.pivotTable) {
      return this.parsePivot(value.crossTable || value.pivotTable, raw);
    }
    if (value.columns) {
      return this.parseTable(value, raw);
    }
    return { headers: [], rows: [], labels: {}, shape: 'unknown', raw };
  }

  /**
   * 列透视形态（473269 实测，2026-10-17 核对）：
   *   value.columns[i].cells[0].props.{guid,label}   → 第 i 个**指标**（共 7 个）
   *   value.rows[i].cells[j].{value, props.guid}     → 第 i 行的**维度值**（共 12 个）
   *   value.values[i][j].v                           → 第 i 行第 j 个指标值
   * 展开成 headers(12 维度 guid + 7 指标 guid) + rows(19 宽扁平行)，labels 取 FIELD_LABELS
   * 的权威中文名——响应里的维度 label 不全可靠（如送达日期返回 "ds"），不能直接用。
   */
  private parseColumnPivot(value: any, raw: string): ContactImReportView {
    const cols: any[] = value.columns || [];
    const rowObjs: any[] = value.rows || [];
    // 维度 guid：优先用行单元格自带的 props.guid（实测与字段表逐字一致），缺失按位置兜底
    const rowGuids: string[] = ((rowObjs[0] || {}).cells || []).map(
      (c: any, i: number) => (c && c.props && c.props.guid) || ROW_HEADER_GUIDS[i] || `rowDim${i}`,
    );
    const colGuids: string[] = cols.map((c: any, i: number) => {
      const cell = (c.cells || [{}])[0];
      return (cell && cell.props && cell.props.guid) || INDICATOR_GUIDS[i] || `colDim${i}`;
    });
    const headers: string[] = [...rowGuids, ...colGuids];
    const labels: Record<string, string> = {};
    for (const g of headers) labels[g] = FIELD_LABELS[g] || g;
    const rows: any[][] = [];
    for (let i = 0; i < rowObjs.length; i++) {
      const cells: any[] = (rowObjs[i] || {}).cells || [];
      const dimVals = cells.map((c: any) =>
        c && typeof c === 'object' ? (c.value ?? c.v ?? c) : c);
      const valRow = value.values[i];
      const metrics = (Array.isArray(valRow) ? valRow : Object.values(valRow || {})).map(
        (c: any) => (c && typeof c === 'object' ? (c.v ?? c.value ?? c) : c));
      rows.push([...dimVals, ...metrics]);
    }
    return { headers, rows, labels, shape: 'columnPivot', raw };
  }

  private parseTable(value: any, raw: string): ContactImReportView {
    const cols: any[] = value.columns || [];
    const headers: string[] = [];
    const labels: Record<string, string> = {};
    for (const c of cols) {
      const cell = (c.cells || [{}])[0];
      const p = cell.props || {};
      const guid = p.guid || '';
      headers.push(guid);
      if (guid) labels[guid] = FIELD_LABELS[guid] || p.label || p.title || p.name || guid;
    }
    const rows: any[][] = [];
    for (const r of value.values || []) {
      if (Array.isArray(r)) {
        rows.push(r.map((cell) => (cell && typeof cell === 'object' ? cell.v : cell)));
      } else if (r && typeof r === 'object') {
        rows.push(headers.map((h) => r[h]));
      }
    }
    return { headers, rows, labels, shape: 'table', raw };
  }

  /** 透视表（crossTable）解析：rowKeys × colKeys 展开成二维矩阵。 */
  private parsePivot(ct: any, raw: string): ContactImReportView {
    const rowKeys: any[][] = ct.rowKeys || [];
    const colKeys: any[][] = ct.colKeys || [];
    const values: Record<string, any> = ct.values || {};
    const rows: any[][] = [];
    for (let r = 0; r < rowKeys.length; r++) {
      const row: any[] = [...(rowKeys[r] || [])];
      for (let c = 0; c < colKeys.length; c++) {
        const cell = values[`${r}_${c}`];
        row.push(cell && typeof cell === 'object' ? (cell.v ?? cell.value ?? cell) : cell);
      }
      rows.push(row);
    }
    const rowHeaderGuids = FIELD_GUIDS.filter((g) => FIELD_TYPE_MAP[g] === 'rowHeader');
    const indicatorGuids = FIELD_GUIDS.filter((g) => FIELD_TYPE_MAP[g] === 'indicator');
    const headers: string[] = [
      ...(rowKeys[0] || []).map((_, i) => `rowDim${i}`),
      ...(colKeys[0] || []).map((_, i) => `colDim${i}`),
    ];
    // 透视表没有逐字段 label，按字段配置位置映射中文：行维度 → 12 维度名，列维度 → 7 指标名。
    const labels: Record<string, string> = {};
    (rowKeys[0] || []).forEach((_, i) => {
      labels[`rowDim${i}`] = FIELD_LABELS[rowHeaderGuids[i]] || `维度${i}`;
    });
    (colKeys[0] || []).forEach((_, i) => {
      labels[`colDim${i}`] = FIELD_LABELS[indicatorGuids[i]] || `指标${i}`;
    });
    return { headers, rows, labels, shape: 'crossTable', raw };
  }

  /**
   * 一站式取数：拿凭证（按 reportId=473269 取 token）→ POST → 解析。
   * DA cookie 失效被踢回登录页 → 强制重兑凭证后重试。
   */
  async fetchReportView(opts: {
    startDate: string;
    endDate: string;
    region?: string[];
    maxAttempts?: number;
    log?: (s: string) => void;
  }): Promise<ContactImReportView> {
    const maxAttempts = opts.maxAttempts ?? 3;
    const log = opts.log ?? (() => undefined);
    const region = opts.region ?? [];
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let creds: QuarkCreds;
      try {
        creds = await this.creds.fetch(attempt > 1, CONTACT_IM_REPORT_ID);
      } catch (e) {
        lastErr = e;
        log(`  ! 凭证获取失败（第 ${attempt}/${maxAttempts} 次）：${(e as Error).message}`);
        await sleep(attempt * 3000);
        continue;
      }
      const raw = await this.post(
        creds.daCookie,
        creds.reportIdToken,
        creds.secureParams,
        creds.metaTime,
        opts.startDate,
        opts.endDate,
        region,
      );
      if (raw.trimStart().startsWith('<')) {
        lastErr = new Error('WidgetAction 被踢回登录页（DA cookie 失效）');
        log(`  ! ${(lastErr as Error).message}，强制重兑后重试`);
        continue;
      }
      try {
        // 异步计算：服务端算不完时返回 {data:{value:null, pollKey}} —— 同一请求重发即可
        // （算完后直接带数据返回）。不等会误判成「该区间无数据」。
        const j = this.tryJson(raw);
        if (j && j.data && j.data.value == null && j.data.pollKey) {
          for (let p = 1; p <= 5; p++) {
            log(`  ! 报表异步计算中（pollKey），${p * 2}s 后重发同一请求（${p}/5）`);
            await sleep(p * 2000);
            const raw2 = await this.post(
              creds.daCookie,
              creds.reportIdToken,
              creds.secureParams,
              creds.metaTime,
              opts.startDate,
              opts.endDate,
              region,
            );
            const j2 = this.tryJson(raw2);
            if (j2 && j2.data && j2.data.value != null) {
              return this.parse(raw2);
            }
            if (raw2.trimStart().startsWith('<')) break; // 等计算期间会话掉了，交给外层重兑
          }
        }
        return this.parse(raw);
      } catch (e) {
        lastErr = e;
        log(`  ! 响应解析失败：${(e as Error).message}`);
      }
    }
    throw new Error(
      `取数失败（尝试 ${maxAttempts} 次）：${(lastErr as Error)?.message ?? lastErr}`,
    );
  }
}
