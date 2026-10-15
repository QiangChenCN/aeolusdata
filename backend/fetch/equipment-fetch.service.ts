import { Injectable } from '@nestjs/common';
import { QuarkCreds, QuarkCredsService } from './quark-creds.service';

/**
 * 骑手装备点亮明细取数（移植自 get_data/rider_equipment.py 的取数/解析部分）。
 *
 * 数据接口：Quark/Aeolus FBI 平台报表（reportId=860325）。
 * 凭证（DA cookie / 三件套 token）由 QuarkCredsService 从 Python 取，
 * 本服务只负责「构造 params → POST WidgetAction → 解析二维表」。
 */
export const EQUIPMENT_URL =
  'https://quark.alibaba.com/fbi/.json' +
  '?action=report/WidgetAction&event_submit_doGetWidgetData=true' +
  '&componentName=fbi-common-table&_widgetId=mmds9k0ty_f1vr3j&_ts_=mszj2wz8';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0';

const HEADERS: Record<string, string> = {
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7',
  'bx-v': '2.5.37',
  'content-type': 'application/x-www-form-urlencoded',
  origin: 'https://quark.alibaba.com',
  priority: 'u=1, i',
  referer:
    'https://quark.alibaba.com/dashboard/view/report.htm?id=860325&DA_APP_NAME=lpd_meepo_ws',
  'sec-ch-ua': '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-storage-access': 'active',
  'user-agent': UA,
};

/** 报表字段 GUID（23 个）。 */
export const FIELD_GUIDS = [
  'mmnfu9wys_tq2q5i', 'mmnfua0qb_cmud56', 'mmnfua2z0_eblg08', 'mmnfua55j_iuvf9w',
  'mmsra17uw_p3tunm', 'mmsra1cb8_56lord', 'mmsra1a0z_unun6x', 'mmnfua9uu_bqesvu',
  'mmnfua77k_ebhal1', 'mmnfuacb4_z3od2g', 'mmnfuaehv_cbpd8o', 'mmnfuahwi_pon8s0',
  'mmnfuakka_ge7lod', 'mmssok5yk_j861s4', 'mmsr9wn6u_07b34l', 'mmnfuatyz_71s8d8',
  'mmnfuavkc_931ftd', 'mmsr8ao6r_yn6267', 'mmnfub79f_5xh68d', 'mmnfub8ut_qacogy',
  'mmnfube57_nxdxvv', 'mmnfubg2e_axyrus', 'mmnfubakc_1a8zaw',
];
export const EQUIPMENT_DATASET_GUID = 72835376;

export interface ReportView {
  headers: string[];
  rows: (string | number | null)[][];
  labels: Record<string, string>;
  raw: string;
}

/** T-1（昨天，本地日期）。 */
export function defaultDates(): { start: string; end: string; asOf: string } {
  const d = new Date(Date.now() - 86400000);
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return { start: s, end: s, asOf: s };
}

@Injectable()
export class EquipmentFetchService {
  constructor(private readonly creds: QuarkCredsService) {}

  /** 构造与 curl 等价的 params（逐字段对照 Python build_payload）。 */
  buildPayload(
    reportToken: string,
    secure: string,
    start: string,
    end: string,
    asOf: string,
    metaTime?: string,
  ): Record<string, any> {
    const ds = EQUIPMENT_DATASET_GUID;
    const cond = (id: string, name: string, value: unknown, valueType: string) => ({
      datasetGuid: ds,
      type: 'condition',
      config: { id, name, value, valueType },
    });
    return {
      widgetId: 'mmds9k0ty_f1vr3j',
      queryId: 'mmds9k3qv_ghzq3p',
      dataType: 'unifiedTable',
      configs: [
        { datasetGuid: ds, type: 'datasetId' },
        { datasetGuid: ds, type: 'count', config: { needCount: true } },
        { datasetGuid: ds, type: 'field', config: { guids: FIELD_GUIDS } },
        cond('mmssgewhx_gje4m4', 'en-mmssgewhx_pgoffv', { start, end }, 'dateTimeRange'),
        cond('mmssoknlt_3jm2vf', 'en-mmssoknlt_of1zox', ['否', '是'], 'multiSelect'),
        cond('mmsran1s0_f04dn1', 'en-mmsran1s0_wvzzr6', [], 'multiSelect'),
        cond('mmds9kgv3_iwguc9', 'en-mmds9kgv3_6kqowg', [], 'multiSelect'),
        cond('mmds9kqmb_kom0zo', 'en-mmds9kqmb_wdlpv4', '', 'text'),
        cond('mmds9kvu4_u86chn', 'en-mmds9kvu4_82uzf3', asOf, 'dateTimePicker'),
        cond('mmdsev418_hwdnol', 'en-mmdsev418_lqk1yu', '', 'text'),
        cond('mmdsevrn4_j6w16q', 'en-mmds9k0ty_8a3z2x', [], 'multiSelect'),
      ],
      reportIdToken: reportToken,
      secureParams: secure,
      metaTime: metaTime ?? `${asOf} 14:23:33`,
      needDebugInfo: false,
      reportId: 860325,
    };
  }

  /** 单次 POST WidgetAction，返回原始响应 body。 */
  private async post(
    cookie: string,
    reportToken: string,
    secure: string,
    metaTime: string,
    start: string,
    end: string,
    asOf: string,
  ): Promise<string> {
    const payload = this.buildPayload(reportToken, secure, start, end, asOf, metaTime);
    const body = new URLSearchParams({ params: JSON.stringify(payload) }).toString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(EQUIPMENT_URL, {
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

  /** 从响应里抽出二维表 → { headers, rows, labels }。 */
  parseRows(raw: string): { headers: string[]; rows: any[][]; labels: Record<string, string> } {
    const j = JSON.parse(raw);
    const val = (j.data || {}).value || {};
    const cols: any[] = val.columns || [];
    const headers: string[] = [];
    const labels: Record<string, string> = {};
    for (const c of cols) {
      const cell = (c.cells || [{}])[0];
      const p = cell.props || {};
      const guid = p.guid || '';
      const label = p.label || p.title || p.name || guid;
      headers.push(guid);
      if (guid) labels[guid] = label;
    }
    const rowsRaw: any[] = val.values || [];
    const rows: any[][] = [];
    for (const r of rowsRaw) {
      if (Array.isArray(r)) {
        rows.push(r.map((cell) => (cell && typeof cell === 'object' ? cell.v : cell)));
      } else if (r && typeof r === 'object') {
        rows.push(headers.map((h) => r[h]));
      }
    }
    return { headers, rows, labels };
  }

  /**
   * 一站式取数：拿凭证 → POST → 解析。
   * 若响应是 HTML（DA cookie 失效被踢回登录页）→ 强制重兑凭证后重试。
   */
  async fetchReportView(opts: {
    startDate: string;
    endDate: string;
    asOf: string;
    maxAttempts?: number;
    log?: (s: string) => void;
  }): Promise<ReportView> {
    const maxAttempts = opts.maxAttempts ?? 3;
    const log = opts.log ?? (() => undefined);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let creds: QuarkCreds;
      try {
        creds = await this.creds.fetch(attempt > 1);
      } catch (e) {
        lastErr = e;
        log(`  ! 凭证获取失败（第 ${attempt}/${maxAttempts} 次）：${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, attempt * 3000));
        continue;
      }
      const raw = await this.post(
        creds.daCookie,
        creds.reportIdToken,
        creds.secureParams,
        creds.metaTime,
        opts.startDate,
        opts.endDate,
        opts.asOf,
      );
      if (raw.trimStart().startsWith('<')) {
        lastErr = new Error('WidgetAction 被踢回登录页（DA cookie 失效）');
        log(`  ! ${(lastErr as Error).message}，强制重兑后重试`);
        continue;
      }
      try {
        const { headers, rows, labels } = this.parseRows(raw);
        return { headers, rows, labels, raw };
      } catch (e) {
        lastErr = e;
        log(`  ! 响应解析失败：${(e as Error).message}`);
      }
    }
    throw new Error(`取数失败（尝试 ${maxAttempts} 次）：${(lastErr as Error)?.message ?? lastErr}`);
  }
}
