import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../../modules/pg/pg.service';

/**
 * 实时看板（违规处罚明细）持久层 —— PostgreSQL only，不再保留 SQLite。
 *
 * 每行原始 JSON 整体落库（raw_json），按 (stat_date, violation_no) 去重覆盖。
 * 注意：PG 为异步驱动，本服务所有方法均为 async（调用方需 await）。
 */
const PG_DDL = `
CREATE TABLE IF NOT EXISTS realtime_records (
  id            SERIAL PRIMARY KEY,
  stat_date     TEXT NOT NULL,
  violation_no  TEXT NOT NULL,
  raw_json      TEXT NOT NULL,
  created_at    TEXT,
  UNIQUE(stat_date, violation_no));
CREATE INDEX IF NOT EXISTS idx_rt_date ON realtime_records(stat_date);
`;

@Injectable()
export class RealtimeStoreService {
  private readonly logger = new Logger(RealtimeStoreService.name);
  private readonly pad = (n: number) => String(n).padStart(2, '0');

  constructor(private readonly pg: PgService) {}

  private nowStr(): string {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${this.pad(d.getUTCMonth() + 1)}-${this.pad(d.getUTCDate())} ${this.pad(
      d.getUTCHours(),
    )}:${this.pad(d.getUTCMinutes())}:${this.pad(d.getUTCSeconds())}`;
  }

  async onModuleInit(): Promise<void> {
    await this.pg.query(PG_DDL);
    this.logger.log('实时记录 PG 表已就绪');
  }

  /** 写入/更新某天记录（按 stat_date+violation_no 去重覆盖）。返回写入/更新条数。 */
  async upsertDay(dateStr: string, rows: Record<string, any>[]): Promise<number> {
    let n = 0;
    const now = this.nowStr();
    for (const r of rows || []) {
      const no = String(r['violationOrderId'] ?? '');
      if (!no) continue;
      await this.pg.query(
        'INSERT INTO realtime_records (stat_date, violation_no, raw_json, created_at) ' +
          'VALUES ($1,$2,$3,$4) ' +
          'ON CONFLICT(stat_date, violation_no) DO UPDATE SET raw_json=excluded.raw_json, created_at=excluded.created_at',
        [dateStr, no, JSON.stringify(r), now],
      );
      n += 1;
    }
    this.logger.log(`实时记录入库 ${dateStr}：写入/更新 ${n} 条`);
    return n;
  }

  /** 批量写入/更新（按违规时间日期自动分桶）。返回总写入/更新条数。 */
  async upsertRows(rows: Record<string, any>[]): Promise<number> {
    const buckets = new Map<string, Record<string, any>[]>();
    for (const r of rows || []) {
      const d = String(r['violationTime'] || '').slice(0, 10); // YYYY-MM-DD
      if (!d) continue;
      if (!buckets.has(d)) buckets.set(d, []);
      buckets.get(d)!.push(r);
    }
    let total = 0;
    for (const [d, rs] of buckets) total += await this.upsertDay(d, rs);
    return total;
  }

  /** 该区间最近一次落盘时间（取数时间），无数据返回空串。 */
  async lastFetchedAt(start: string, end: string): Promise<string> {
    const rows = await this.pg.query<{ t?: string }>(
      'SELECT MAX(created_at) AS t FROM realtime_records WHERE stat_date >= $1 AND stat_date <= $2',
      [start, end],
    );
    return rows[0]?.t || '';
  }

  /** 取某日期区间 [start, end]（YYYY-MM-DD，含端点）全部记录原始行。 */
  async getRange(start: string, end: string): Promise<Record<string, any>[]> {
    const rows = await this.pg.query<{ raw_json: string }>(
      'SELECT raw_json FROM realtime_records WHERE stat_date >= $1 AND stat_date <= $2 ORDER BY stat_date, id',
      [start, end],
    );
    return rows.map((r) => JSON.parse(r.raw_json));
  }
}
