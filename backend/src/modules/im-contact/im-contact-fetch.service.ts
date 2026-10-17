import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { ContactImFetchService } from '../../../fetch/sources/contact-im-fetch.service';

/**
 * IM 电联看板 —— 自有取数落盘（2026-10-17 新建，独立看板）。
 *
 * 数据源：Quark/Aeolus FBI 报表 473269「电联 & IM 回复」（透视表，行维度到骑手），
 * 取数复用底层 primitive `ContactImFetchService`（QuarkCredsService 兑换凭证 +
 * WidgetAction POST + 透视表解析，属取数基础设施，等同数据层 cache 的角色）。
 *
 * 本服务独立实现的部分：
 *   · 透视表 → 扁平行（按字段中文名建键，指标 coercion 成数字）；
 *   · 落盘到自有命名空间 `backend/data/im-contact-实时.json`（全站单文件、覆盖写），
 *     payload 形态与考核看板违规明细同构：{ start, end, fetched_at, fetch_ok,
 *     fetch_error, total, rows } —— 读侧（Python analytics/im_contact）按 fetch_ok
 *     判定可用性，失败不把盘上旧数据当有效数据。
 *
 * 与考核看板 / 配送超时看板**不共用任何取数或计算代码**。
 */

/** 指标字段（7 个）： coercion 成数字；两个比率为报表原值，一并转数字供参考。 */
const INDICATOR_FIELDS = [
  '送达电联率',
  'IM及时回复率',
  'IM及时回复单量',
  'IM咨询单量',
  '电联剔除单量',
  '剔除后接单量',
  '剔除后有效电联单量',
] as const;

/** 计数类指标（落盘为整数）；两个比率为浮点。 */
const COUNT_FIELDS = new Set([
  'IM及时回复单量',
  'IM咨询单量',
  '电联剔除单量',
  '剔除后接单量',
  '剔除后有效电联单量',
]);

/**
 * 比率类指标：Quark 返回的是 0~1 小数（实测 2026-10-17：0.8163… = 81.63%），
 * 落盘统一换算成百分数与计数字段同库；原始串带 '%' 时按原值（不再乘）。
 */
const RATE_FIELDS = new Set(['送达电联率', 'IM及时回复率']);

/** 扁平行必须出现的维度键（缺失说明透视表解析形态与预期不符，直接失败而非落脏数据）。 */
const REQUIRED_DIMS = ['站点id', '骑手id'] as const;

/** 北京时间 `YYYY-MM-DD HH:MM:SS`（与 Python 同口径）。 */
function nowStamp(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** 宽松数值化：'1,234' / '85.3%' / '12' → number；空 / 非法 → null。 */
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/,/g, '').replace(/%$/, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**  JSON 里某个值的紧凑形态描述（类型 + 长度/键数），用于失败诊断。 */
function shapeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') return `object{${Object.keys(v as object).slice(0, 8).join(',')}}`;
  return typeof v;
}

/**
 * 解析出 0 行时的**结构指纹**：把 Quark 响应的真实形态压缩成一行，随错误信息返回前端 /
 * 记入后端日志，用于判断「该区间真没数据」还是「请求形态与报表当前配置不符」。
 * （电联报表的解析是从抓包推断的，首次真实响应必须核对——本指纹就是为这次核对准备的。）
 */
function describeRaw(raw: string): string {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return `非 JSON 响应（长度 ${raw.length}，开头：${raw.slice(0, 80).replace(/\s+/g, ' ')}）`;
  }
  const parts: string[] = [`len=${raw.length}`, `top=${shapeOf(j)}`];
  const data = j && typeof j === 'object' ? (j as any).data : undefined;
  if (data !== undefined) parts.push(`data=${shapeOf(data)}`);
  const value = data && typeof data === 'object' ? (data as any).value : undefined;
  if (value !== undefined) {
    parts.push(`value=${shapeOf(value)}`);
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) {
        const v = (value as any)[k];
        if (Array.isArray(v)) {
          const first = v[0];
          parts.push(`${k}[${v.length}]{${first && typeof first === 'object' ? Object.keys(first).slice(0, 6).join('|') : typeof first}}`);
        } else if (v && typeof v === 'object') {
          parts.push(`${k}{${Object.keys(v).slice(0, 8).join('|')}}`);
        } else {
          parts.push(`${k}=${JSON.stringify(v)}`);
        }
      }
    }
  }
  return parts.join(' | ').slice(0, 700);
}

@Injectable()
export class ImContactFetchService {
  private readonly logger = new Logger(ImContactFetchService.name);
  private readonly dataDir: string;

  constructor(
    config: ConfigService,
    private readonly contactIm: ContactImFetchService,
  ) {
    const root = path.resolve(
      config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.dataDir = path.join(root, 'backend', 'data');
  }

  /** 单文件落盘路径。 */
  filePath(): string {
    return path.join(this.dataDir, 'im-contact-实时.json');
  }

  /**
   * 拉取 [startDate, endDate] 全站 IM 电联明细 → 扁平化 → 覆盖写落盘。
   * date 缺省今天。失败写 fetch_ok=false（保留旧 rows 便于回查），返回 {ok:false}。
   */
  async fetchAndLand(
    startDate: string,
    endDate: string,
  ): Promise<{ ok: boolean; msg: string }> {
    fs.mkdirSync(this.dataDir, { recursive: true });
    let view;
    try {
      view = await this.contactIm.fetchReportView({ startDate, endDate, region: [] });
    } catch (e) {
      const err = `IM 电联取数失败：${(e as Error).message}`;
      this.logger.warn(err);
      this.writeFailed(startDate, endDate, err);
      return { ok: false, msg: err };
    }
    if (view.shape === 'unknown' || !view.rows.length) {
      // 区分两种 0 行：表头在但没有数据行 = 该区间无数据（Quark 报表通常滞后一天）；
      // 连表头都没有 / 形态未知 = 请求或解析问题，此时才带结构指纹便于排查。
      const noData =
        view.headers.length > 0 &&
        (view.shape === 'columnPivot' || view.shape === 'table');
      const err = noData
        ? `该区间（${startDate}~${endDate}）暂无 IM 电联数据——Quark 报表数据通常滞后一天，可改选昨天或更早的区间`
        : `IM 电联报表解析出 0 行（shape=${view.shape}，headers=${view.headers.length}）` +
          `——可能是该区间无数据，也可能是请求形态与报表当前配置不符。响应结构：${describeRaw(view.raw)}`;
      this.logger.warn(err);
      this.writeFailed(startDate, endDate, err);
      return { ok: false, msg: err };
    }
    let rows: Record<string, unknown>[];
    try {
      rows = this.flatten(view);
    } catch (e) {
      const err = `IM 电联扁平化失败：${(e as Error).message}`;
      this.logger.error(err);
      this.writeFailed(startDate, endDate, err);
      return { ok: false, msg: err };
    }
    this.writeOk(startDate, endDate, rows);
    const msg = `IM 电联 ${rows.length} 行（${startDate}~${endDate}，全站落盘）`;
    this.logger.log(`IM 电联看板取数：${msg}`);
    return { ok: true, msg };
  }

  /**
   * 透视表 view → 扁平行列表：按 view.labels 把表头映射成字段中文名建键，
   * 指标 coercion 成数字（计数取整、比率保留浮点）。维度键缺失即抛错。
   */
  private flatten(view: {
    headers: string[];
    rows: unknown[][];
    labels: Record<string, string>;
  }): Record<string, unknown>[] {
    const nameOf = (h: string) => view.labels[h] || h;
    const out: Record<string, unknown>[] = [];
    for (const r of view.rows) {
      if (!Array.isArray(r)) continue;
      const obj: Record<string, unknown> = {};
      view.headers.forEach((h, i) => {
        obj[nameOf(h)] = r[i] ?? null;
      });
      // 指标数值化（维度值保持原样）：计数取整；比率由 0~1 小数换算成百分数
      for (const f of INDICATOR_FIELDS) {
        if (!(f in obj)) continue;
        const rawV = obj[f];
        const hadPct = typeof rawV === 'string' && rawV.trim().endsWith('%');
        const n = toNum(rawV);
        if (n === null) {
          obj[f] = null;
        } else if (RATE_FIELDS.has(f) && !hadPct) {
          obj[f] = Math.round(n * 10000) / 100;
        } else if (COUNT_FIELDS.has(f)) {
          obj[f] = Math.round(n);
        } else {
          obj[f] = n;
        }
      }
      for (const d of REQUIRED_DIMS) {
        if (obj[d] === undefined || obj[d] === null || obj[d] === '') {
          throw new Error(`行缺少维度「${d}」：${JSON.stringify(obj).slice(0, 200)}`);
        }
      }
      out.push(obj);
    }
    if (!out.length) throw new Error('透视表解析出 0 行有效数据');
    return out;
  }

  private writeOk(start: string, end: string, rows: Record<string, unknown>[]): void {
    const payload = {
      start,
      end,
      fetched_at: nowStamp(),
      fetch_ok: true,
      fetch_error: null,
      total: rows.length,
      rows,
    };
    fs.writeFileSync(this.filePath(), JSON.stringify(payload), 'utf-8');
  }

  /** 取数失败：整份写 fetch_ok=false，保留旧 rows（便于回查），使读侧视为不可用。 */
  private writeFailed(start: string, end: string, error: string): void {
    let oldRows: Record<string, unknown>[] = [];
    try {
      const prev = JSON.parse(fs.readFileSync(this.filePath(), 'utf-8'));
      if (prev && Array.isArray(prev.rows)) oldRows = prev.rows;
    } catch {
      /* 无旧文件则 rows 为空 */
    }
    const payload = {
      start,
      end,
      fetched_at: nowStamp(),
      fetch_ok: false,
      fetch_error: String(error).slice(0, 300) || null,
      total: oldRows.length,
      rows: oldRows,
    };
    fs.writeFileSync(this.filePath(), JSON.stringify(payload), 'utf-8');
  }
}
