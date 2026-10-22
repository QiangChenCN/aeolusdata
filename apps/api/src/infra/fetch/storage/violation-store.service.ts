import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../../modules/pg/pg.service';

/**
 * 违规处罚明细持久层（按月累计看板的数据底座）—— PostgreSQL only，不再保留 SQLite。
 *
 * 每行原始 JSON 整体落库（raw_json），按 (stat_date, violation_no) 去重覆盖。
 * 未配置 DATABASE_URL 时本服务方法会抛错（PgService 未启用）。
 */
const PG_DDL = `
CREATE TABLE IF NOT EXISTS violation_records (
  id          SERIAL PRIMARY KEY,
  stat_date   TEXT NOT NULL,
  violation_no TEXT NOT NULL,
  raw_json    TEXT NOT NULL,
  created_at  TEXT,
  UNIQUE(stat_date, violation_no));
CREATE INDEX IF NOT EXISTS idx_vr_date ON violation_records(stat_date);
`;

@Injectable()
export class ViolationStoreService {
  private readonly logger = new Logger(ViolationStoreService.name);
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
    this.logger.log('违规记录 PG 表已就绪');
  }

  /** 写入/更新某天违规记录（按 stat_date+violation_no 去重覆盖）。返回写入/更新条数。 */
  async upsertDay(dateStr: string, rows: Record<string, any>[]): Promise<number> {
    let n = 0;
    const now = this.nowStr();
    for (const r of rows || []) {
      const no = String(r['violationOrderId'] ?? '');
      if (!no) continue;
      await this.pg.query(
        'INSERT INTO violation_records (stat_date, violation_no, raw_json, created_at) ' +
          'VALUES ($1,$2,$3,$4) ' +
          'ON CONFLICT(stat_date, violation_no) DO UPDATE SET raw_json=excluded.raw_json, created_at=excluded.created_at',
        [dateStr, no, JSON.stringify(r), now],
      );
      n += 1;
    }
    this.logger.log(`违规记录入库 ${dateStr}：写入/更新 ${n} 条`);
    return n;
  }

  /** 取某月（YYYY-MM）全部违规记录原始行。 */
  async getMonth(month: string): Promise<Record<string, any>[]> {
    const rows = await this.pg.query<{ raw_json: string }>(
      'SELECT raw_json FROM violation_records WHERE stat_date LIKE $1 ORDER BY stat_date, id',
      [`${month}%`],
    );
    return rows.map((r) => JSON.parse(r.raw_json));
  }

  /** 取某天（YYYY-MM-DD）全部违规记录。 */
  async getDay(dateStr: string): Promise<Record<string, any>[]> {
    const rows = await this.pg.query<{ raw_json: string }>(
      'SELECT raw_json FROM violation_records WHERE stat_date=$1 ORDER BY id',
      [dateStr],
    );
    return rows.map((r) => JSON.parse(r.raw_json));
  }

  /** 该月已入库的天数。 */
  async monthDayCount(month: string): Promise<number> {
    const rows = await this.pg.query<{ c: number }>(
      'SELECT COUNT(DISTINCT stat_date) AS c FROM violation_records WHERE stat_date LIKE $1',
      [`${month}%`],
    );
    return rows[0]?.c ?? 0;
  }

  /** 取日期区间 [start, end]（YYYY-MM-DD，含两端）全部违规记录原始行。 */
  async getRange(start: string, end: string): Promise<Record<string, any>[]> {
    const rows = await this.pg.query<{ raw_json: string }>(
      'SELECT raw_json FROM violation_records WHERE stat_date >= $1 AND stat_date <= $2 ORDER BY stat_date, id',
      [start, end],
    );
    return rows.map((r) => JSON.parse(r.raw_json));
  }

  /** 日期区间内已入库的天数。 */
  async dayCountRange(start: string, end: string): Promise<number> {
    const rows = await this.pg.query<{ c: number }>(
      'SELECT COUNT(DISTINCT stat_date) AS c FROM violation_records WHERE stat_date >= $1 AND stat_date <= $2',
      [start, end],
    );
    return rows[0]?.c ?? 0;
  }
}
