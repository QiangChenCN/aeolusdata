import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 实时看板（违规处罚明细）持久层。
 *
 * 与 `violation-store.service.ts`（月累计）**完全分离**：
 *   · 月累计 → `data/violation.db`，唯一写入方是 ViolationSchedulerService（每日 03:00 回补）；
 *   · 实时   → `data/realtime.db`，唯一写入方是前端实时看板「刷新」按钮。
 * 两者互不影响，实时刷新不会污染月累计归档，月累计回补也不会覆盖实时快照。
 *
 * 每行原始 JSON 整体落库（raw_json），按 (stat_date, violation_no) 去重，重复刷新覆盖更新。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS realtime_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stat_date     TEXT NOT NULL,
  violation_no  TEXT NOT NULL,
  raw_json      TEXT NOT NULL,
  created_at    TEXT,
  UNIQUE(stat_date, violation_no)
);
CREATE INDEX IF NOT EXISTS idx_rt_date ON realtime_records(stat_date);
`;

@Injectable()
export class RealtimeStoreService {
  private readonly logger = new Logger(RealtimeStoreService.name);
  readonly dbPath: string;
  private readonly pad = (n: number) => String(n).padStart(2, '0');

  constructor(config: ConfigService) {
    const root = path.resolve(
      config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, 'realtime.db');
  }

  private nowStr(): string {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${this.pad(d.getUTCMonth() + 1)}-${this.pad(d.getUTCDate())} ${this.pad(
      d.getUTCHours(),
    )}:${this.pad(d.getUTCMinutes())}:${this.pad(d.getUTCSeconds())}`;
  }

  private open(): DatabaseSync {
    const db = new DatabaseSync(this.dbPath);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(DDL);
    return db;
  }

  /** 写入/更新某天记录（按 stat_date+violation_no 去重覆盖）。返回写入/更新条数。 */
  upsertDay(dateStr: string, rows: Record<string, any>[]): number {
    const db = this.open();
    let n = 0;
    try {
      const stmt = db.prepare(
        `INSERT INTO realtime_records (stat_date, violation_no, raw_json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(stat_date, violation_no)
         DO UPDATE SET raw_json=excluded.raw_json, created_at=excluded.created_at`,
      );
      const now = this.nowStr();
      for (const r of rows || []) {
        const no = String(r['violationOrderId'] ?? '');
        if (!no) continue;
        stmt.run(dateStr, no, JSON.stringify(r), now);
        n += 1;
      }
    } finally {
      db.close();
    }
    this.logger.log(`实时记录入库 ${dateStr}：写入/更新 ${n} 条`);
    return n;
  }

  /** 批量写入/更新（按违规时间日期自动分桶）。返回总写入/更新条数。 */
  upsertRows(rows: Record<string, any>[]): number {
    const buckets = new Map<string, Record<string, any>[]>();
    for (const r of rows || []) {
      const d = String(r['violationTime'] || '').slice(0, 10); // YYYY-MM-DD
      if (!d) continue;
      if (!buckets.has(d)) buckets.set(d, []);
      buckets.get(d)!.push(r);
    }
    let total = 0;
    for (const [d, rs] of buckets) total += this.upsertDay(d, rs);
    return total;
  }

  /** 该区间最近一次落盘时间（即"取数时间"），无数据返回空串。 */
  lastFetchedAt(start: string, end: string): string {
    const db = this.open();
    try {
      const r = db
        .prepare(
          `SELECT MAX(created_at) AS t FROM realtime_records WHERE stat_date >= ? AND stat_date <= ?`,
        )
        .get(start, end) as { t?: string };
      return r?.t || '';
    } finally {
      db.close();
    }
  }

  /** 取某日期区间 [start, end]（YYYY-MM-DD，含端点）全部记录原始行。 */
  getRange(start: string, end: string): Record<string, any>[] {
    const db = this.open();
    try {
      const rows = db
        .prepare(
          `SELECT raw_json FROM realtime_records WHERE stat_date >= ? AND stat_date <= ? ORDER BY stat_date, id`,
        )
        .all(start, end) as Record<string, any>[];
      return rows.map((r) => JSON.parse(r['raw_json'] as string));
    } finally {
      db.close();
    }
  }
}
