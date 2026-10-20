import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../src/modules/pg/pg.service';

/**
 * IM 电联看板持久层 —— PostgreSQL only，不再保留 SQLite。
 *
 * 原始 JSON 整体落库（raw_json），键为 Quark 报表字段中文名。PG 为异步驱动，所有方法均为 async。
 */
const PG_DDL = `
CREATE TABLE IF NOT EXISTS im_contact_records (
  id          SERIAL PRIMARY KEY,
  stat_date   TEXT NOT NULL,
  rider_id    TEXT NOT NULL,
  raw_json    TEXT NOT NULL,
  fetched_at  TEXT,
  UNIQUE(stat_date, rider_id));
CREATE INDEX IF NOT EXISTS idx_ic_date ON im_contact_records(stat_date);
CREATE TABLE IF NOT EXISTS im_contact_meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

/** 扁平行里的日期 / 骑手主键字段（中文键，与 Quark 报表 / Nest 落盘一致）。 */
const F_DATE = '送达日期';
const F_RIDER_ID = '骑手id';

@Injectable()
export class ImContactStoreService {
  private readonly logger = new Logger(ImContactStoreService.name);
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
    this.logger.log('IM 电联 PG 表已就绪');
  }

  /** 写入/更新一批原始行（按 stat_date+rider_id 去重覆盖）。同时刷新 meta。返回写入/更新条数。 */
  async upsertRows(rows: Record<string, any>[], fetchedAt?: string): Promise<number> {
    let n = 0;
    const now = fetchedAt || this.nowStr();
    for (const r of rows || []) {
      const date = String(r?.[F_DATE] ?? '').slice(0, 10);
      const rider = String(r?.[F_RIDER_ID] ?? '');
      if (!date || !rider) continue;
      await this.pg.query(
        'INSERT INTO im_contact_records (stat_date, rider_id, raw_json, fetched_at) ' +
          'VALUES ($1,$2,$3,$4) ' +
          'ON CONFLICT(stat_date, rider_id) DO UPDATE SET raw_json=excluded.raw_json, fetched_at=excluded.fetched_at',
        [date, rider, JSON.stringify(r), now],
      );
      n += 1;
    }
    await this.setMeta('last_fetched_at', now);
    await this.setMeta('last_fetch_ok', '1');
    await this.setMeta('last_fetch_error', '');
    this.logger.log(`IM 电联入库：写入/更新 ${n} 条`);
    return n;
  }

  /** 取某日期区间 [start, end]（YYYY-MM-DD，含端点）全部记录原始行。 */
  async getRange(start: string, end: string): Promise<Record<string, any>[]> {
    const rows = await this.pg.query<{ raw_json: string }>(
      'SELECT raw_json FROM im_contact_records WHERE stat_date >= $1 AND stat_date <= $2 ORDER BY stat_date, rider_id',
      [start, end],
    );
    return rows.map((r) => JSON.parse(r.raw_json));
  }

  /** 全量记录（计算侧按站/骑手过滤 + 区间聚合用）。无数据返回空数组。 */
  async allRows(): Promise<Record<string, any>[]> {
    const rows = await this.pg.query<{ raw_json: string }>(
      'SELECT raw_json FROM im_contact_records ORDER BY stat_date, rider_id',
    );
    return rows.map((r) => JSON.parse(r.raw_json));
  }

  /** 库内已落盘数据的最小/最大 stat_date；空库返回 {start:'', end:''}。 */
  async statRange(): Promise<{ start: string; end: string }> {
    const rows = await this.pg.query<{ a?: string; b?: string }>(
      'SELECT MIN(stat_date) AS a, MAX(stat_date) AS b FROM im_contact_records',
    );
    const r = rows[0];
    return { start: r?.a || '', end: r?.b || '' };
  }

  /** 该区间最近一次落盘时间（取数时间），无数据返回空串。 */
  async lastFetchedAt(start: string, end: string): Promise<string> {
    const rows = await this.pg.query<{ t?: string }>(
      'SELECT MAX(fetched_at) AS t FROM im_contact_records WHERE stat_date >= $1 AND stat_date <= $2',
      [start, end],
    );
    return rows[0]?.t || '';
  }

  /** 读 meta（im_contact_meta.k → v）；缺省返回 fallback。 */
  async meta(k: string, fallback = ''): Promise<string> {
    const rows = await this.pg.query<{ v?: string }>(
      'SELECT v FROM im_contact_meta WHERE k=$1',
      [k],
    );
    return rows[0]?.v ?? fallback;
  }

  async setMeta(k: string, v: string): Promise<void> {
    await this.pg.query(
      'INSERT INTO im_contact_meta (k, v) VALUES ($1,$2) ON CONFLICT(k) DO UPDATE SET v=excluded.v',
      [k, v],
    );
  }

  /** 取数失败：置位 meta（不写入行，保留历史数据）。 */
  async markFailed(error: string): Promise<void> {
    await this.setMeta('last_fetch_ok', '0');
    await this.setMeta('last_fetch_error', String(error).slice(0, 300));
    await this.setMeta('last_fetched_at', this.nowStr());
  }

  /** 库是否存在且有记录（用于判断"是否从未拉取"）。 */
  async hasData(): Promise<boolean> {
    const rows = await this.pg.query<{ c: number }>(
      'SELECT COUNT(*) AS c FROM im_contact_records',
    );
    return (rows[0]?.c ?? 0) > 0;
  }

  /** 全库记录总数（status 展示用）。 */
  async countAll(): Promise<number> {
    const rows = await this.pg.query<{ c: number }>(
      'SELECT COUNT(*) AS c FROM im_contact_records',
    );
    return rows[0]?.c ?? 0;
  }
}
