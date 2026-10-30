import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgService } from '../pg/pg.service';
import { ORDER_NO_KEYS, TEAM_KEYS, beijingNowStr, pickCell } from './delivery-store.service';

/**
 * 运单明细看板 —— 历史明细持久层（PostgreSQL only）。
 *
 * 表 `delivery_history`（历史运单明细，行 = 一条运单原始行，按天整日覆盖写）只由本看板的
 * 「每天 04:00 滚动更新 T-1 ~ T-7」写入（`DeliveryHistoryService`），与实时表
 * `delivery_realtime` 结构同构、取值口径一致（同 ORDER_NO_KEYS / TEAM_KEYS）。
 *
 * 与实时表的分工：
 *   · `delivery_realtime` 服务于「看今天 / 手动刷新当天」；
 *   · `delivery_history`  服务于「过去 7 天滚动留档」，不随当天手动刷新变动，
 *     只被 04:00 的滚动任务（或手动回补）重写。
 *
 * 滚动写的是同一批日期（T-1 ~ T-7 随日期平移），所以「滚动」= 窗口滑动 + 整日覆盖：
 * 早于 T-7 的行不会被自动清理，需要时按 stat_date 手工清理即可。
 */
const PG_DDL = `
CREATE TABLE IF NOT EXISTS delivery_history (
  id          SERIAL PRIMARY KEY,
  stat_date   TEXT NOT NULL,
  team_id     TEXT NOT NULL,
  order_no    TEXT NOT NULL,
  raw_json    TEXT NOT NULL,
  captured_at TEXT,
  UNIQUE(stat_date, order_no));
CREATE INDEX IF NOT EXISTS idx_delivery_history_date_team ON delivery_history(stat_date, team_id);
CREATE TABLE IF NOT EXISTS delivery_history_meta (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at TEXT);
`;

/** 单批插入行数（与实时表一致，控制单条 SQL 的参数个数）。 */
const CHUNK = 200;

@Injectable()
export class DeliveryHistoryStoreService implements OnModuleInit {
  private readonly logger = new Logger(DeliveryHistoryStoreService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    if (!this.pg.isEnabled) {
      this.logger.warn('DATABASE_URL 未配置，历史运单明细表不可用');
      return;
    }
    // 历史表可能已存在但为旧结构（缺 stat_date 列）。先探测：结构不符则整体重建，
    // 否则 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS 会因表已存在而跳过，
    // 进而 CREATE INDEX 引用缺失列 → 启动崩溃（column "stat_date" does not exist）。
    const col = await this.pg.query<{ n: number }>(
      `SELECT 1 AS n FROM information_schema.columns
       WHERE table_name = 'delivery_history' AND column_name = 'stat_date' LIMIT 1`,
    );
    if (!col.length) {
      this.logger.warn('delivery_history 结构过旧（缺 stat_date 列），整体重建');
      await this.pg.query(
        'DROP TABLE IF EXISTS delivery_history CASCADE; DROP TABLE IF EXISTS delivery_history_meta;',
      );
    }
    await this.pg.query(PG_DDL);
    this.logger.log('运单明细·历史运单明细 PG 表已就绪（delivery_history）');
  }

  get ready(): boolean {
    return this.pg.isEnabled;
  }

  /** 整日覆盖写（先删当天再插，事务内完成）。返回写入行数。 */
  async replaceDay(
    date: string,
    rows: Record<string, unknown>[],
    capturedAt: string = beijingNowStr(),
  ): Promise<number> {
    if (!this.pg.isEnabled) throw new Error('PG 未启用：无法写入历史运单明细');
    const cols = 5;
    return this.pg.tx(async (c) => {
      await c.query('DELETE FROM delivery_history WHERE stat_date = $1', [date]);
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
            capturedAt,
          );
        });
        await c.query(
          'INSERT INTO delivery_history (stat_date, team_id, order_no, raw_json, captured_at) ' +
            `VALUES ${ph.join(',')} ON CONFLICT (stat_date, order_no) DO NOTHING`,
          vals,
        );
        n += chunk.length;
        chunk.length = 0;
      };
      for (const r of rows || []) {
        chunk.push(r);
        if (chunk.length >= CHUNK) await flush();
      }
      await flush();
      return n;
    });
  }

  /** 给定日期的覆盖情况（行数 + 最近一次写入时间）；未入库的日期 rows 为 0。 */
  async statsOf(
    dates: string[],
  ): Promise<{ date: string; rows: number; captured_at: string }[]> {
    if (!dates.length) return [];
    const rows = await this.pg.query<{ stat_date: string; c: string; t?: string }>(
      'SELECT stat_date, COUNT(*)::bigint AS c, MAX(captured_at) AS t FROM delivery_history ' +
        `WHERE stat_date = ANY($1::text[]) GROUP BY stat_date`,
      [dates],
    );
    const m = new Map(rows.map((r) => [r.stat_date, { rows: Number(r.c ?? 0), at: r.t || '' }]));
    return dates.map((d) => {
      const hit = m.get(d);
      return { date: d, rows: hit?.rows ?? 0, captured_at: hit?.at ?? '' };
    });
  }

  /** 历史窗口内的总行数（用于「7 天共 N 条」提示）。 */
  async countRange(dates: string[]): Promise<number> {
    if (!dates.length) return 0;
    const r = await this.pg.queryOne<{ c: string }>(
      'SELECT COUNT(*)::bigint AS c FROM delivery_history WHERE stat_date = ANY($1::text[])',
      [dates],
    );
    return Number(r?.c ?? 0);
  }

  /** 读 meta（滚动任务的运行状态快照），无则 null。 */
  async getMeta(key: string): Promise<string | null> {
    const r = await this.pg.queryOne<{ v: string }>(
      'SELECT v FROM delivery_history_meta WHERE k = $1',
      [key],
    );
    return r?.v ?? null;
  }

  /** 写 meta（UPSERT）。 */
  async setMeta(key: string, value: string): Promise<void> {
    await this.pg.query(
      'INSERT INTO delivery_history_meta (k, v, updated_at) VALUES ($1,$2,$3) ' +
        'ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
      [key, value, beijingNowStr()],
    );
  }

  /**
   * 读某天（可选某站点）的历史运单明细原始行。与实时表 `getDay` 同构，
   * 仅表名与时间列（captured_at）不同；列定义 / 排序 / 分页在 controller 复用同一套逻辑。
   */
  async getDay(date: string, team?: string[]): Promise<Record<string, unknown>[]> {
    const useTeam = team && team.length;
    const sql = useTeam
      ? 'SELECT raw_json FROM delivery_history WHERE stat_date = $1 AND team_id = ANY($2::text[]) ORDER BY id'
      : 'SELECT raw_json FROM delivery_history WHERE stat_date = $1 ORDER BY id';
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

  /** 整日各站点行数（站点下拉 / 覆盖统计用）。 */
  async countByTeam(date: string): Promise<{ team: string; rows: number }[]> {
    const rows = await this.pg.query<{ team_id: string; c: string }>(
      'SELECT team_id, COUNT(*)::bigint AS c FROM delivery_history WHERE stat_date = $1 ' +
        'GROUP BY team_id ORDER BY c DESC',
      [date],
    );
    return rows.map((r) => ({ team: r.team_id, rows: Number(r.c ?? 0) }));
  }

  /** 该日最近一次滚动写入时间（北京时间 captured_at）；指定站点则取该站点最新。 */
  async lastFetchedAt(date: string, team?: string[]): Promise<string> {
    const useTeam = team && team.length;
    const sql = useTeam
      ? 'SELECT MAX(captured_at) AS t FROM delivery_history WHERE stat_date = $1 AND team_id = ANY($2::text[])'
      : 'SELECT MAX(captured_at) AS t FROM delivery_history WHERE stat_date = $1';
    const r = useTeam
      ? await this.pg.queryOne<{ t: string }>(sql, [date, team])
      : await this.pg.queryOne<{ t: string }>(sql, [date]);
    return r?.t ?? '';
  }
}
