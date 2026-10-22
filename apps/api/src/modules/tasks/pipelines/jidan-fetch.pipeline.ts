import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { TaskHandler, TaskRunContext, TaskStage } from '../task-handler';
import { Pipeline } from '../pipeline';
import { TaskHandlersService } from '../task-handlers.service';
import { RushFetchService, RushTeamResult } from '../../../infra/fetch/sources/rush-fetch.service';

/** 三站点 teamId（与考勤同体系）。 */
const TEAMS: [number, string][] = [
  [917521130, '黄江'],
  [917521136, '万科'],
  [917521139, '大岭山大学城'],
];

/** state 中文映射（已用户校正：30=待送达）。 */
const STATE_LABEL: Record<number, string> = {
  10: '待接单',
  20: '待到店',
  30: '待送达',
  40: '已完成',
  80: '已取消',
  90: '异常',
};

/** 急单类型 type -> 中文。 */
const RUSH_DEFINES: Record<number, string> = {
  1: '已超时',
  2: '即将超时',
  3: '特护订单特殊急单规则',
  4: '骑手到店异常',
  5: '骑手取餐慢',
  6: '高价值取餐慢',
  7: '到店慢超时风险',
  8: '取餐慢超时风险',
  9: '配送慢超时风险',
  10: '待指派运单智能调度超时',
};

const CSV_HEADERS = [
  '站点',
  '状态',
  '急单类型',
  '急单优先级',
  '运单号',
  '平台运单号',
  '商户',
  '商户地址',
  '商户电话',
  '顾客',
  '顾客地址',
  '顾客电话',
  '骑手',
  '骑手电话',
  '期望送达',
  '骑手取餐预计',
  '超时',
  '异常类型',
  '异常信息',
  '订单备注',
  '异常报备',
  '商品',
  '轨迹',
];

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 时间戳格式化（对照 Python fmt_time：>1e12 走 UTC，否则本地时区）。 */
function fmtTime(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (!n) return String(v);
  const d = new Date(n / 1000);
  const utc = n > 1e12;
  const M = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  const D = utc ? d.getUTCDate() : d.getDate();
  const H = utc ? d.getUTCHours() : d.getHours();
  const Mi = utc ? d.getUTCMinutes() : d.getMinutes();
  const S = utc ? d.getUTCSeconds() : d.getSeconds();
  return `${p2(M)}-${p2(D)} ${p2(H)}:${p2(Mi)}:${p2(S)}`;
}

/** 轨迹时间：本地时区 "%Y/%m/%d %H:%M:%S"。 */
function fmtTrackTime(ms: unknown): string {
  const d = new Date(Number(ms));
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function merge(data: RushTeamResult[]): Record<string, any>[] {
  const merged: Record<string, any>[] = [];
  for (const t of data) {
    for (const { order: o, detail: dt } of t.pairs) {
      const types: number[] = o.rushOrderDefineTypes || [];
      const ev: Record<string, any>[] = dt.eventList || dt.displayEventList || [];
      const track = ev
        .map((e) => {
          const name = e.eventName || e.name || '';
          const ts =
            typeof e.eventTime === 'number'
              ? fmtTrackTime(e.eventTime)
              : e.time || '';
          return `${name} ${ts}`;
        })
        .join(' | ');
      const goods = (dt.itemList || [])
        .map((it: Record<string, any>) => {
          const nm = it.name || it.itemName || '';
          const cnt = it.count ?? it.quantity ?? 1;
          return `${nm}x${cnt}`;
        })
        .join('; ');
      const abnormal: Record<string, any>[] = dt.reportAbnormalEventList || [];
      let abnormalReport = '暂无';
      if (abnormal.length) {
        abnormalReport = abnormal
          .map((a) => {
            const desc = a.feedbackDesc || a.reason || a.desc || a.remark || a.type || '';
            const at = a.adjustType;
            return desc && at ? `${desc} (${at})` : desc || at || '异常报备';
          })
          .join('; ');
      }

      merged.push({
        station: t.station,
        teamId: t.teamId,
        state: o.state,
        stateLabel: STATE_LABEL[Number(o.state)] ?? `state_${o.state}`,
        rushTypes: types.map((tp) => RUSH_DEFINES[Number(tp)] ?? `type_${tp}`),
        rushHighestPriority: o.rushOrderHighestPriority,
        trackingId: dt.trackingId || o.trackingId,
        platformTrackingId: dt.platformTrackingId || '',
        merchantName: dt.merchantName || o.mname || '',
        merchantAddress: dt.merchantAddress || o.maddress || '',
        merchantPhone: dt.merchantPhone || '',
        customerName: dt.customerName || o.customerName || '',
        customerAddress: dt.customerAddress || o.caddress || '',
        customerPhone: dt.customerPhone || '',
        riderName: dt.carrierDriverName || o.name || '',
        riderPhone: dt.carrierDriverPhone || o.knightPhone || '',
        customerExpectDeliveryAt: fmtTime(dt.customerExpectDeliveryAt),
        driverExamDeliveryAt: fmtTime(dt.driverExamDeliveryAt),
        overTime: dt.overTime ? fmtTime(dt.overTime) : '',
        errorType: dt.errorType || '',
        errorMsg: dt.errorMsg || '',
        customerRemark: dt.customerRemark || '',
        abnormalReport,
        goods,
        track,
      });
    }
  }
  return merged;
}

/**
 * 抓取三站在途急单（原 jobs/rush/fetch_jidan.py）。
 * 无出图 / 无图床 / 无钉钉 —— 纯取数 + 落盘，用于验证迁移后的任务框架。
 */
@Injectable()
export class JidanFetchPipeline implements TaskHandler {
  readonly id = 'jidan_fetch';
  readonly stages: TaskStage[] = [
    { id: 'fetch', name: '拉取三站在途急单' },
    { id: 'merge', name: '合并去重' },
    { id: 'write', name: '落盘 CSV/JSON' },
  ];
  private readonly outDir: string;

  constructor(
    private readonly handlers: TaskHandlersService,
    private readonly rush: RushFetchService,
    private readonly config: ConfigService,
  ) {
    this.handlers.register(this);
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.outDir = path.join(root, 'apps', 'api', 'runtime', 'jobs', 'rush', 'out');
  }

  async run(ctx: TaskRunContext): Promise<void> {
    const state: { data?: RushTeamResult[]; merged?: Record<string, any>[] } = {};
    const p = new Pipeline(ctx, state);

    p.stage('fetch', '拉取三站在途急单', async () => {
      const data: RushTeamResult[] = [];
      for (const [teamId, station] of TEAMS) {
        if (ctx.isStopped()) throw new Error('已请求终止');
        const t = await this.rush.fetchTeam(teamId, station);
        ctx.log(
          `[${t.station}] paging trackingId:${t.totalTids} | 订单:${t.totalOrders} | 急单(在途):${t.rushCount}`,
        );
        data.push(t);
      }
      state.data = data;
    });

    p.stage('merge', '合并去重', () => {
      state.merged = merge(state.data || []);
    });

    p.stage('write', '落盘 CSV/JSON', () => {
      this.writeOutputs(state.merged || [], state.data || [], ctx);
    });

    await p.run();
  }

  private writeOutputs(
    merged: Record<string, any>[],
    data: RushTeamResult[],
    ctx: TaskRunContext,
  ): void {
    fs.mkdirSync(this.outDir, { recursive: true });
    const stationStats = data.map((t) => ({
      station: t.station,
      teamId: t.teamId,
      rushCount: t.rushCount,
    }));
    const jsonPath = path.join(this.outDir, 'dispatcher_jidan_3stations.json');
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        { source: 'http-api', stationStats, totalRush: merged.length, orders: merged },
        null,
        2,
      ),
      'utf-8',
    );

    const rows = merged.map((o) => [
      o.station,
      o.stateLabel,
      (o.rushTypes || []).join('|'),
      o.rushHighestPriority,
      o.trackingId,
      o.platformTrackingId,
      o.merchantName,
      o.merchantAddress,
      o.merchantPhone,
      o.customerName,
      o.customerAddress,
      o.customerPhone,
      o.riderName,
      o.riderPhone,
      o.customerExpectDeliveryAt,
      o.driverExamDeliveryAt,
      o.overTime,
      o.errorType,
      o.errorMsg,
      o.customerRemark,
      o.abnormalReport,
      o.goods,
      o.track,
    ]);
    const csv = [CSV_HEADERS, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
    const csvPath = path.join(this.outDir, 'dispatcher_jidan_3stations.csv');
    fs.writeFileSync(csvPath, '\uFEFF' + csv + '\r\n', 'utf-8');

    ctx.log('已保存: dispatcher_jidan_3stations.json');
    ctx.log('已保存: dispatcher_jidan_3stations.csv');
  }
}
