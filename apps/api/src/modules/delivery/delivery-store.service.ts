import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgService } from '../pg/pg.service';

/**
 * 运单明细看板 —— 明细持久层（PostgreSQL only）。
 *
 * 表 `delivery_realtime`（实时运单明细，行 = 一条运单原始行，整日覆盖写）由多个看板写入：
 *   · 配送超时刷新 `DeliveryTimeoutRefreshService`
 *   · 考核看板取数 `AssessmentDeliveryFetchService`
 *   · 本看板刷新   `DeliveryRefreshService`
 * 三方的写入语义一致（全站全天快照，时间维度固定 trackingFinish），落同一张表即
 * 「运单明细只有一份」。本服务是**运单明细看板侧唯一的读写方**：与其它看板不共享代码
 * （见 `scripts/check-arch.mjs` 的看板隔离约定），只共享表。
 *
 * 建表语句与其它写入方逐字一致且幂等（`CREATE TABLE IF NOT EXISTS`），重复执行不会改写
 * 已存在的表 —— 谁先初始化都得到同一份结构。
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
`;

/** 运单号取值键（与 Python order_rules 同口径），用于行去重键 `UNIQUE(stat_date, order_no)`。
 * 风神真名 platformTrackingId / trackingId；旧数据可能带 orderNo / merchantOrderSerial。 */
export const ORDER_NO_KEYS = ['trackingId', '运单id', 'platformTrackingId', '订单号', 'platformMerchantSeq', 'orderNo', 'merchantOrderSerial'];
/** 站点 id 取值键。 */
export const TEAM_KEYS = ['teamId', '站点id', '团队ID'];

/** 北京时间 `YYYY-MM-DD HH:mm:ss`（历史明细落库时间与页面「入库时间」同口径）。 */
export function beijingNowStr(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** 按给定键序取第一个非空值（trim 后）；全空返回 ''。 */
export function pickCell(r: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = r?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

@Injectable()
export class DeliveryStoreService implements OnModuleInit {
  private readonly logger = new Logger(DeliveryStoreService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    if (!this.pg.isEnabled) {
      this.logger.warn('DATABASE_URL 未配置，运单明细表不可用（页面将提示 PG 未启用）');
      return;
    }
    await this.pg.query(PG_DDL);
    this.logger.log('运单明细·实时运单明细 PG 表已就绪（delivery_realtime）');
  }

  get ready(): boolean {
    return this.pg.isEnabled;
  }

  /**
   * 读某天（可选某站点）的运单明细原始行。
   *
   * 整日读取而非下推过滤：本看板要在同一份数据上同时算「站点覆盖」与「状态枚举」，
   * 下推反而要多次往返；单日全站是千级行数，内存里过滤/排序/分页足够。
   */
  async getDay(date: string, team?: string[]): Promise<Record<string, unknown>[]> {
    const useTeam = team && team.length;
    const sql = useTeam
      ? 'SELECT raw_json FROM delivery_realtime WHERE stat_date = $1 AND team_id = ANY($2::text[]) ORDER BY id'
      : 'SELECT raw_json FROM delivery_realtime WHERE stat_date = $1 ORDER BY id';
    const rows = useTeam
      ? await this.pg.query<{ raw_json: string }>(sql, [date, team])
      : await this.pg.query<{ raw_json: string }>(sql, [date]);
    const out: Record<string, unknown>[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.raw_json));
      } catch {
        /* 单行损坏不应让整页 500：跳过即可 */
      }
    }
    return out;
  }

  /** 整日覆盖写（先删当天再插，事务内完成）。返回写入行数。 */
  async replaceDay(date: string, rows: Record<string, unknown>[]): Promise<number> {
    if (!this.pg.isEnabled) throw new Error('PG 未启用：无法写入实时运单明细');
    const now = beijingNowStr();
    const cols = 5;
    return this.pg.tx(async (c) => {
      await c.query('DELETE FROM delivery_realtime WHERE stat_date = $1', [date]);
      let n = 0;
      const chunk: Record<string, unknown>[] = [];
      const flush = async () => {
        if (!chunk.length) return;
        const vals: unknown[] = [];
        const ph: string[] = [];
        chunk.forEach((r, i) => {
          const base = i * cols;
          ph.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`);
          vals.push(
            date,
            pickCell(r, TEAM_KEYS) || '_unknown',
            pickCell(r, ORDER_NO_KEYS) || `row_${n + i}`,
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

  /** 该天各站点的行数（用于「有数据站点」提示与站点下拉）。 */
  async countByTeam(date: string): Promise<{ team: string; rows: number }[]> {
    const rows = await this.pg.query<{ team_id: string; c: string }>(
      'SELECT team_id, COUNT(*)::bigint AS c FROM delivery_realtime ' +
        'WHERE stat_date = $1 GROUP BY team_id ORDER BY team_id',
      [date],
    );
    return rows.map((r) => ({ team: r.team_id, rows: Number(r.c ?? 0) }));
  }

  /** 该天的行数（全站）。 */
  async countDay(date: string): Promise<number> {
    const r = await this.pg.queryOne<{ c: string }>(
      'SELECT COUNT(*)::bigint AS c FROM delivery_realtime WHERE stat_date = $1',
      [date],
    );
    return Number(r?.c ?? 0);
  }

  /** 该（天 → 站点）最近一次入库时间（北京时间），无数据返回 ''。 */
  async lastFetchedAt(date: string, team?: string[]): Promise<string> {
    const useTeam = team && team.length;
    const sql = useTeam
      ? 'SELECT MAX(created_at) AS t FROM delivery_realtime WHERE stat_date = $1 AND team_id = ANY($2::text[])'
      : 'SELECT MAX(created_at) AS t FROM delivery_realtime WHERE stat_date = $1';
    const r = useTeam
      ? await this.pg.queryOne<{ t?: string }>(sql, [date, team])
      : await this.pg.queryOne<{ t?: string }>(sql, [date]);
    return r?.t || '';
  }

  /**
   * 清掉实时表中所有「非今天」的旧行。实时表只保留当天快照，
   * 历史（T-1~T-7）由每天 4 点的滚动任务维护在 `delivery_history`，二者不重复。
   * 每次刷新当天后调用，使实时表始终是单日、避免遗留往日行与历史表混淆。
   */
  async purgeOtherDays(today: string): Promise<number> {
    if (!this.pg.isEnabled) return 0;
    const r = await this.pg.query<{ n: string }>(
      'DELETE FROM delivery_realtime WHERE stat_date <> $1 RETURNING 1',
      [today],
    );
    return r.length;
  }

  /**
   * 读某日期段（含端点）的运单明细原始行，联合实时表（当天）与历史表（T-1~T-7）。
   * 两张表的 stat_date 不重叠（实时表仅今天、历史表不含今天），UNION ALL 不产生重复行。
   */
  async getRange(start: string, end: string, team?: string[]): Promise<Record<string, unknown>[]> {
    const useTeam = team && team.length;
    const sql = useTeam
      ? `SELECT raw_json FROM delivery_realtime WHERE stat_date BETWEEN $1 AND $2 AND team_id = ANY($3::text[])
         UNION ALL
         SELECT raw_json FROM delivery_history WHERE stat_date BETWEEN $1 AND $2 AND team_id = ANY($3::text[])`
      : `SELECT raw_json FROM delivery_realtime WHERE stat_date BETWEEN $1 AND $2
         UNION ALL
         SELECT raw_json FROM delivery_history WHERE stat_date BETWEEN $1 AND $2`;
    const rows = useTeam
      ? await this.pg.query<{ raw_json: string }>(sql, [start, end, team])
      : await this.pg.query<{ raw_json: string }>(sql, [start, end]);
    const out: Record<string, unknown>[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.raw_json));
      } catch {
        /* 单行损坏跳过 */
      }
    }
    return out;
  }

  /** 日期段内各站点行数（联合两表聚合）。 */
  async rangeCountByTeam(start: string, end: string): Promise<{ team: string; rows: number }[]> {
    const rows = await this.pg.query<{ team_id: string; c: string }>(
      `SELECT team_id, SUM(c)::bigint AS c FROM (
         SELECT team_id, COUNT(*) AS c FROM delivery_realtime WHERE stat_date BETWEEN $1 AND $2 GROUP BY team_id
         UNION ALL
         SELECT team_id, COUNT(*) AS c FROM delivery_history WHERE stat_date BETWEEN $1 AND $2 GROUP BY team_id
       ) s GROUP BY team_id ORDER BY SUM(c) DESC`,
      [start, end],
    );
    return rows.map((r) => ({ team: r.team_id, rows: Number(r.c ?? 0) }));
  }

  /** 日期段内最近一次写入时间（联合两表取最大）。 */
  async rangeLastFetchedAt(start: string, end: string, team?: string[]): Promise<string> {
    const useTeam = team && team.length;
    const sql = useTeam
      ? `SELECT MAX(t) AS t FROM (
           SELECT MAX(created_at) AS t FROM delivery_realtime WHERE stat_date BETWEEN $1 AND $2 AND team_id = ANY($3::text[])
           UNION ALL
           SELECT MAX(captured_at) AS t FROM delivery_history WHERE stat_date BETWEEN $1 AND $2 AND team_id = ANY($3::text[])
         ) s`
      : `SELECT MAX(t) AS t FROM (
           SELECT MAX(created_at) AS t FROM delivery_realtime WHERE stat_date BETWEEN $1 AND $2
           UNION ALL
           SELECT MAX(captured_at) AS t FROM delivery_history WHERE stat_date BETWEEN $1 AND $2
         ) s`;
    const r = useTeam
      ? await this.pg.queryOne<{ t: string }>(sql, [start, end, team])
      : await this.pg.queryOne<{ t: string }>(sql, [start, end]);
    return r?.t ?? '';
  }
}
