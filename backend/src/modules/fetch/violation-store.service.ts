import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 违规处罚明细持久层（按月累计看板的数据底座）。
 *
 * 与 `unsat-store.service.ts`（站长反馈状态机）是两个独立场景，故单独建库 `violation.db`。
 * 每行原始 JSON 整体落库（raw_json），展示时的拆列 / 代码转中文沿用前端既有逻辑，
 * 避免后端重复维护字段口径。按 (stat_date, violation_no) 去重，重抓可覆盖更新。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS violation_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stat_date     TEXT NOT NULL,
  violation_no  TEXT NOT NULL,
  raw_json      TEXT NOT NULL,
  created_at    TEXT,
  UNIQUE(stat_date, violation_no)
);
CREATE INDEX IF NOT EXISTS idx_vr_date ON violation_records(stat_date);
`;

@Injectable()
export class ViolationStoreService {
  private readonly logger = new Logger(ViolationStoreService.name);
  readonly dbPath: string;
  private readonly pad = (n: number) => String(n).padStart(2, '0');

  constructor(config: ConfigService) {
    const root = path.resolve(
      config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    const dataDir = path.join(root, 'backend', 'data', 'db');
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, 'violation.db');
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

  /** 写入/更新某天违规记录（按 stat_date+violation_no 去重覆盖）。返回写入/更新条数。 */
  upsertDay(dateStr: string, rows: Record<string, any>[]): number {
    const db = this.open();
    let n = 0;
    try {
      const stmt = db.prepare(
        `INSERT INTO violation_records (stat_date, violation_no, raw_json, created_at)
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
    this.logger.log(`违规记录入库 ${dateStr}：写入/更新 ${n} 条`);
    return n;
  }


  /** 取某月（YYYY-MM）全部违规记录原始行。 */
  getMonth(month: string): Record<string, any>[] {
    const db = this.open();
    try {
      const rows = db
        .prepare(
          `SELECT raw_json FROM violation_records WHERE stat_date LIKE ? ORDER BY stat_date, id`,
        )
        .all(`${month}%`) as Record<string, any>[];
      return rows.map((r) => JSON.parse(r['raw_json'] as string));
    } finally {
      db.close();
    }
  }

  /** 取某天（YYYY-MM-DD）全部违规记录。 */
  getDay(dateStr: string): Record<string, any>[] {
    const db = this.open();
    try {
      const rows = db
        .prepare(`SELECT raw_json FROM violation_records WHERE stat_date=? ORDER BY id`)
        .all(dateStr) as Record<string, any>[];
      return rows.map((r) => JSON.parse(r['raw_json'] as string));
    } finally {
      db.close();
    }
  }

  /** 该月已入库的天数（前端可据此判断是否需要触发同步）。 */
  monthDayCount(month: string): number {
    const db = this.open();
    try {
      const r = db
        .prepare(`SELECT COUNT(DISTINCT stat_date) AS c FROM violation_records WHERE stat_date LIKE ?`)
        .get(`${month}%`) as { c: number };
      return r?.c ?? 0;
    } finally {
      db.close();
    }
  }

  /** 取日期区间 [start, end]（YYYY-MM-DD，含两端）全部违规记录原始行。 */
  getRange(start: string, end: string): Record<string, any>[] {
    const db = this.open();
    try {
      const rows = db
        .prepare(
          `SELECT raw_json FROM violation_records WHERE stat_date >= ? AND stat_date <= ? ORDER BY stat_date, id`,
        )
        .all(start, end) as Record<string, any>[];
      return rows.map((r) => JSON.parse(r['raw_json'] as string));
    } finally {
      db.close();
    }
  }

  /** 日期区间内已入库的天数。 */
  dayCountRange(start: string, end: string): number {
    const db = this.open();
    try {
      const r = db
        .prepare(
          `SELECT COUNT(DISTINCT stat_date) AS c FROM violation_records WHERE stat_date >= ? AND stat_date <= ?`,
        )
        .get(start, end) as { c: number };
      return r?.c ?? 0;
    } finally {
      db.close();
    }
  }
}
