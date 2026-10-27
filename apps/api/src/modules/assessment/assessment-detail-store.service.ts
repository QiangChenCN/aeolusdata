import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { PgService } from '../pg/pg.service';

/**
 * 考核看板 —— 明细数据读写（PostgreSQL only，取代原先的落盘 JSON）。
 *
 * 2026-10-23：考核看板的运单 / 违规明细不再落 `apps/api/runtime/*.json`，改为读写明细表
 * （表与其它看板共用，但**代码不共用** —— 本服务是考核侧唯一读写方）：
 *
 *   · `delivery_realtime`  实时运单明细（当天快照，整日覆盖写；与配送超时看板同口径）
 *   · `violation_realtime` 实时违规处罚明细（按 violation_no 幂等 UPSERT）
 *   · `violation`          历史违规处罚明细（同上，供历史区间聚合）
 *
 * 两表不加额外列（`team_id` / `source` 都不加）：明细行本身自带站点 ID（运单 `teamId`、
 * 违规「团队ID」），按站点过滤在读侧解析 JSON 完成，与文件时代的口径一致。
 *
 * 违规写语义：**按业务主键 UPSERT**（同 `(stat_date, violation_no)` 覆盖）而非整日删除 ——
 * 这两张表还有别的写入方（前端违规看板写 violation_realtime、每日 03:00 定时任务回补
 * violation），整日删除会连带删掉它们的行。同站点 + 同运单 + 同类型 + 同原因 → 同一条违规，
 * 状态翻转时覆盖同一行。
 */
const PG_DDL = `
CREATE TABLE IF NOT EXISTS delivery_realtime (
  id          SERIAL PRIMARY KEY,
  stat_date   TEXT NOT NULL,
  team_id     TEXT NOT NULL,
  order_no    TEXT NOT NULL,
  raw_json    TEXT NOT NULL,
  created_at  TEXT,
  UNIQUE(stat_date, order_no));
CREATE INDEX IF NOT EXISTS idx_delivery_realtime_date_team ON delivery_realtime(stat_date, team_id);

CREATE TABLE IF NOT EXISTS violation_realtime (
  id           SERIAL PRIMARY KEY,
  stat_date    TEXT NOT NULL,
  violation_no TEXT NOT NULL,
  raw_json     TEXT NOT NULL,
  created_at   TEXT,
  UNIQUE(stat_date, violation_no));

CREATE TABLE IF NOT EXISTS violation (
  id           SERIAL PRIMARY KEY,
  stat_date    TEXT NOT NULL,
  violation_no TEXT NOT NULL,
  raw_json     TEXT NOT NULL,
  created_at   TEXT,
  UNIQUE(stat_date, violation_no));
`;

/** 运单号取值键（与 Python order_rules 同口径）。风神真名 platformTrackingId / trackingId；旧数据或带 orderNo。 */
const ORDER_NO_KEYS = ['trackingId', '运单id', 'platformTrackingId', '订单号', 'orderNo', 'orderId'];
/** 站点 id 取值键。 */
const TEAM_KEYS = ['teamId', '站点id', 'teamID', '团队ID'];
/** 违规稳定主键的构成键（同站点 + 同运单 + 同类型 + 同原因 → 同一条违规）。 */
const VIOLATION_KEY_FIELDS = ['团队ID', '运单号', '违规类型', '违规原因'];

@Injectable()
export class AssessmentDetailStoreService implements OnModuleInit {
  private readonly logger = new Logger(AssessmentDetailStoreService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    if (!this.pg.isEnabled) {
      this.logger.warn('DATABASE_URL 未配置，考核明细表不可用（刷新将失败）');
      return;
    }
    await this.pg.query(PG_DDL);
    this.logger.log('考核明细 PG 表已就绪（delivery_realtime / violation_realtime / violation）');
  }

  get ready(): boolean {
    return this.pg.isEnabled;
  }

  private nowStr(now: Date = new Date()): string {
    const d = new Date(now.getTime() + 8 * 3600 * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
      `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    );
  }

  private cell(r: Record<string, unknown>, keys: string[]): string {
    for (const k of keys) {
      const v = r?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  /** 违规明细按业务主键 UPSERT（事务）；不删除当天别人的行。返回写入条数。 */
  private async upsertViolation(
    table: string,
    date: string,
    rows: Record<string, unknown>[],
  ): Promise<number> {
    const now = this.nowStr();
    return this.pg.tx(async (c) => {
      let n = 0;
      const cols = 4;
      const chunk: Record<string, unknown>[] = [];
      const flush = async () => {
        if (!chunk.length) return;
        const vals: unknown[] = [];
        const ph: string[] = [];
        chunk.forEach((r, i) => {
          const b = i * cols;
          ph.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`);
          vals.push(date, this.violationNo(r), JSON.stringify(r), now);
        });
        await c.query(
          `INSERT INTO ${table} (stat_date, violation_no, raw_json, created_at) ` +
            `VALUES ${ph.join(',')} ON CONFLICT (stat_date, violation_no) ` +
            'DO UPDATE SET raw_json = excluded.raw_json, created_at = excluded.created_at',
          vals,
        );
        n += chunk.length;
        chunk.length = 0;
      };
      for (const r of rows || []) {
        chunk.push(r);
        if (chunk.length >= 200) await flush();
      }
      await flush();
      return n;
    });
  }

  // ───────────────────────── 实时运单明细 delivery_realtime ─────────────────────────

  /** 覆盖写某天的考核运单明细（全站当天快照）。 */
  async replaceDeliveryDay(date: string, rows: Record<string, unknown>[]): Promise<number> {
    if (!this.pg.isEnabled) throw new Error('PG 未启用：无法写入实时运单明细');
    const now = this.nowStr();
    return this.pg.tx(async (c) => {
      // 运单是全站快照：与配送超时看板同口径（同一 OrdersFetchService），直接覆盖当天。
      await c.query('DELETE FROM delivery_realtime WHERE stat_date = $1', [date]);
      let n = 0;
      const cols = 5;
      const chunk: Record<string, unknown>[] = [];
      const flush = async () => {
        if (!chunk.length) return;
        const vals: unknown[] = [];
        const ph: string[] = [];
        chunk.forEach((r, i) => {
          const b = i * cols;
          ph.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
          vals.push(
            date,
            this.cell(r, TEAM_KEYS) || '_unknown',
            this.cell(r, ORDER_NO_KEYS) || `row_${n + i}`,
            JSON.stringify(r),
            now,
          );
        });
        await c.query(
          'INSERT INTO delivery_realtime (stat_date, team_id, order_no, raw_json, created_at) ' +
            `VALUES ${ph.join(',')} ON CONFLICT (stat_date, order_no) DO NOTHING`,
          vals,
        );
        n += chunk.length;
        chunk.length = 0;
      };
      for (const r of rows || []) {
        chunk.push(r);
        if (chunk.length >= 200) await flush();
      }
      await flush();
      return n;
    });
  }

  /** 读某站点某天的实时运单明细原始行；无数据返回 []。 */
  async getDeliveryTeam(date: string, team: string): Promise<Record<string, unknown>[]> {
    const rows = await this.pg.query<{ raw_json: string }>(
      'SELECT raw_json FROM delivery_realtime WHERE stat_date = $1 AND team_id = $2 ORDER BY id',
      [date, String(team)],
    );
    return rows.map((r) => JSON.parse(r.raw_json));
  }

  // ───────────────────────── 实时违规处罚明细 violation_realtime ─────────────────────────

  /** 写入某天的考核违规明细（按 violation_no 幂等 UPSERT）。 */
  async replaceViolationDay(date: string, rows: Record<string, unknown>[]): Promise<number> {
    if (!this.pg.isEnabled) throw new Error('PG 未启用：无法写入实时违规处罚明细');
    return this.upsertViolation('violation_realtime', date, rows);
  }

  /** 读某天全站违规明细原始行（站点过滤在读侧按行内「团队ID」完成）；无数据返回 []。 */
  async getViolationDay(date: string): Promise<Record<string, unknown>[]> {
    const rows = await this.pg.query<{ raw_json: string }>(
      'SELECT raw_json FROM violation_realtime WHERE stat_date = $1 ORDER BY id',
      [date],
    );
    return rows.map((r) => JSON.parse(r.raw_json));
  }

  // ───────────────────────── 历史违规处罚明细 violation ─────────────────────────

  /** 写入某天的考核违规历史（按 violation_no 幂等 UPSERT）。 */
  async replaceViolationHistoryDay(date: string, rows: Record<string, unknown>[]): Promise<number> {
    if (!this.pg.isEnabled) throw new Error('PG 未启用：无法写入历史违规处罚明细');
    return this.upsertViolation('violation', date, rows);
  }

  /** 读某天全站历史违规明细原始行；无数据返回 []。 */
  async getViolationHistoryDay(date: string): Promise<Record<string, unknown>[]> {
    const rows = await this.pg.query<{ raw_json: string }>(
      'SELECT raw_json FROM violation WHERE stat_date = $1 ORDER BY id',
      [date],
    );
    return rows.map((r) => JSON.parse(r.raw_json));
  }

  // ───────────────────────── 状态 ─────────────────────────

  /** 某天某类明细最近一次入库时间（北京时间）；无数据返回 ''。 */
  async lastFetchedAt(
    kind: 'delivery' | 'violation',
    date: string,
    team?: string,
  ): Promise<string> {
    const table = kind === 'delivery' ? 'delivery_realtime' : 'violation_realtime';
    // 运单表有 team_id 列可按站点过滤；违规两表没有该列，按天统计即可。
    const where = kind === 'delivery' && team ? 'WHERE stat_date = $1 AND team_id = $2' : 'WHERE stat_date = $1';
    const params = kind === 'delivery' && team ? [date, team] : [date];
    const r = await this.pg.queryOne<{ t?: string }>(
      `SELECT MAX(created_at) AS t FROM ${table} ${where}`,
      params,
    );
    return r?.t || '';
  }

  /** 某天全站行数（诊断用）。 */
  async countDay(kind: 'delivery' | 'violation', date: string): Promise<number> {
    const table = kind === 'delivery' ? 'delivery_realtime' : 'violation_realtime';
    const r = await this.pg.queryOne<{ c: string }>(
      `SELECT COUNT(*)::bigint AS c FROM ${table} WHERE stat_date = $1`,
      [date],
    );
    return Number(r?.c ?? 0);
  }

  /** 违规稳定主键：同站点 + 同运单 + 同类型 + 同原因 → 同一条（状态翻转覆盖而非新增）。 */
  private violationNo(r: Record<string, unknown>): string {
    const base = VIOLATION_KEY_FIELDS.map((k) => String(r?.[k] ?? '').trim()).join('|');
    return createHash('sha1').update(base).digest('hex').slice(0, 24);
  }
}
