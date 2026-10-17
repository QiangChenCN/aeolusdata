import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * IM 电联看板持久层（SQLite，node:sqlite）。
 *
 * 与 `realtime-store.service.ts`（实时违规明细）同构，但服务于「累计历史数据」：
 *   · 唯一写入方是 ImContactFetchService（前端「刷新数据」按钮，默认取 T-1 所在月）；
 *   · 按 (stat_date, rider_id) 去重 upsert —— 同天同骑手重复刷新覆盖更新，跨月自然累计；
 *   · 计算侧（Python analytics.im_contact）按前端传入的区间 getRange 读取，支持跨月查询。
 *
 * 默认 DELETE 日志模式（非 WAL）：该表写入频次极低、且需要被 Python 进程跨进程直读，
 * 单文件最稳，避免 -wal/-shm 残留带来的跨语言读取歧义。
 *
 * 行原始 JSON 整体落库（raw_json），键为 Quark 报表字段中文名（与 Nest 落盘/Python 读侧一致）。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS im_contact_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  stat_date   TEXT NOT NULL,
  rider_id    TEXT NOT NULL,
  raw_json    TEXT NOT NULL,
  fetched_at  TEXT,
  UNIQUE(stat_date, rider_id)
);
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
  readonly dbPath: string;
  private readonly pad = (n: number) => String(n).padStart(2, '0');

  constructor(config: ConfigService) {
    const root = path.resolve(
      config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    const dataDir = path.join(root, 'backend', 'data', 'db');
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, 'im_contact.db');
  }

  private nowStr(): string {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${this.pad(d.getUTCMonth() + 1)}-${this.pad(d.getUTCDate())} ${this.pad(
      d.getUTCHours(),
    )}:${this.pad(d.getUTCMinutes())}:${this.pad(d.getUTCSeconds())}`;
  }

  private open(): DatabaseSync {
    const db = new DatabaseSync(this.dbPath);
    db.exec('PRAGMA journal_mode=DELETE');
    db.exec(DDL);
    return db;
  }

  /** 写入/更新一批原始行（按 stat_date+rider_id 去重覆盖）。同时刷新 meta。返回写入/更新条数。 */
  upsertRows(rows: Record<string, any>[], fetchedAt?: string): number {
    const db = this.open();
    let n = 0;
    try {
      const stmt = db.prepare(
        `INSERT INTO im_contact_records (stat_date, rider_id, raw_json, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(stat_date, rider_id)
         DO UPDATE SET raw_json=excluded.raw_json, fetched_at=excluded.fetched_at`,
      );
      const now = fetchedAt || this.nowStr();
      for (const r of rows || []) {
        const date = String(r?.[F_DATE] ?? '').slice(0, 10); // YYYY-MM-DD
        const rider = String(r?.[F_RIDER_ID] ?? '');
        if (!date || !rider) continue;
        stmt.run(date, rider, JSON.stringify(r), now);
        n += 1;
      }
      this.setMeta('last_fetched_at', now);
      this.setMeta('last_fetch_ok', '1');
      this.setMeta('last_fetch_error', '');
    } finally {
      db.close();
    }
    this.logger.log(`IM 电联入库：写入/更新 ${n} 条 → ${this.dbPath}`);
    return n;
  }

  /** 取某日期区间 [start, end]（YYYY-MM-DD，含端点）全部记录原始行。 */
  getRange(start: string, end: string): Record<string, any>[] {
    const db = this.open();
    try {
      const rows = db
        .prepare(
          `SELECT raw_json FROM im_contact_records WHERE stat_date >= ? AND stat_date <= ? ORDER BY stat_date, rider_id`,
        )
        .all(start, end) as Record<string, any>[];
      return rows.map((r) => JSON.parse(r['raw_json'] as string));
    } finally {
      db.close();
    }
  }

  /** 全量记录（计算侧按站/骑手过滤 + 区间聚合用）。无数据返回空数组。 */
  allRows(): Record<string, any>[] {
    const db = this.open();
    try {
      const rows = db
        .prepare(`SELECT raw_json FROM im_contact_records ORDER BY stat_date, rider_id`)
        .all() as Record<string, any>[];
      return rows.map((r) => JSON.parse(r['raw_json'] as string));
    } finally {
      db.close();
    }
  }

  /** 库内已落盘数据的最小/最大 stat_date（即"已落盘区间"）；空库返回 {start:'', end:''}。 */
  statRange(): { start: string; end: string } {
    const db = this.open();
    try {
      const r = db
        .prepare(`SELECT MIN(stat_date) AS a, MAX(stat_date) AS b FROM im_contact_records`)
        .get() as { a?: string; b?: string };
      return { start: r?.a || '', end: r?.b || '' };
    } finally {
      db.close();
    }
  }

  /** 该区间最近一次落盘时间（取数时间），无数据返回空串。 */
  lastFetchedAt(start: string, end: string): string {
    const db = this.open();
    try {
      const r = db
        .prepare(
          `SELECT MAX(fetched_at) AS t FROM im_contact_records WHERE stat_date >= ? AND stat_date <= ?`,
        )
        .get(start, end) as { t?: string };
      return r?.t || '';
    } finally {
      db.close();
    }
  }

  /** 读 meta（im_contact_meta.k → v）；缺省返回 fallback。 */
  meta(k: string, fallback = ''): string {
    const db = this.open();
    try {
      const r = db.prepare(`SELECT v FROM im_contact_meta WHERE k = ?`).get(k) as
        | { v?: string }
        | undefined;
      return r?.v ?? fallback;
    } finally {
      db.close();
    }
  }

  setMeta(k: string, v: string): void {
    const db = this.open();
    try {
      db.prepare(
        `INSERT INTO im_contact_meta (k, v) VALUES (?, ?)
         ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
      ).run(k, v);
    } finally {
      db.close();
    }
  }

  /** 取数失败：置位 meta（不写入行，保留历史数据）。 */
  markFailed(error: string): void {
    this.setMeta('last_fetch_ok', '0');
    this.setMeta('last_fetch_error', String(error).slice(0, 300));
    this.setMeta('last_fetched_at', this.nowStr());
  }

  /** 库是否存在且有记录（用于判断"是否从未拉取"）。 */
  hasData(): boolean {
    if (!fs.existsSync(this.dbPath)) return false;
    const db = this.open();
    try {
      const r = db.prepare(`SELECT COUNT(*) AS c FROM im_contact_records`).get() as {
        c: number;
      };
      return r.c > 0;
    } finally {
      db.close();
    }
  }

  /** 全库记录总数（status 展示用）。 */
  countAll(): number {
    if (!fs.existsSync(this.dbPath)) return 0;
    const db = this.open();
    try {
      const r = db.prepare(`SELECT COUNT(*) AS c FROM im_contact_records`).get() as {
        c: number;
      };
      return r.c;
    } finally {
      db.close();
    }
  }
}
