import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 不满意单状态层（移植 jobs/unsat/store.py）。
 *
 * 表：orders（当日运单 + 状态机）、feedbacks（站长反馈）、reminders（提醒去重）。
 * 状态机 orders.status：pending → judging → rejected / done。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_date       TEXT NOT NULL,
    violation_no    TEXT NOT NULL,
    tracking_no     TEXT,
    rider_name      TEXT,
    team_name       TEXT,
    station         TEXT,
    sheet_row       INTEGER,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT,
    updated_at      TEXT,
    UNIQUE(stat_date, violation_no)
);
CREATE TABLE IF NOT EXISTS feedbacks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        INTEGER,
    sender          TEXT,
    reason          TEXT,
    action          TEXT,
    media_json      TEXT,
    raw_text        TEXT,
    judged          INTEGER DEFAULT 0,
    pass_flag       INTEGER,
    missing_json    TEXT,
    llm_reason      TEXT,
    created_at      TEXT
);
CREATE TABLE IF NOT EXISTS reminders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_date       TEXT,
    station         TEXT,
    remind_hour     INTEGER,
    created_at      TEXT,
    UNIQUE(stat_date, station, remind_hour)
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(stat_date, status);
CREATE INDEX IF NOT EXISTS idx_orders_station ON orders(station);
`;

@Injectable()
export class UnsatStoreService {
  private readonly logger = new Logger(UnsatStoreService.name);
  readonly dataDir: string;
  readonly dbPath: string;
  readonly imgPath: string;
  readonly csvPath: string;

  constructor(config: ConfigService) {
    const root = path.resolve(
      config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.dataDir = path.join(root, 'python', 'jobs', 'unsat', 'out', 'unsat_data');
    this.dbPath = path.join(this.dataDir, 'unsat.db');
    this.imgPath = path.join(this.dataDir, 'unsat_detail.png');
    this.csvPath = path.join(this.dataDir, 'violations.csv');
  }

  private nowStr(): string {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }

  private open(): DatabaseSync {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    db.exec('PRAGMA journal_mode=WAL');
    return db;
  }

  initDb(): void {
    const db = this.open();
    try {
      db.exec(DDL);
    } finally {
      db.close();
    }
    this.logger.log(`数据库就绪: ${this.dbPath}`);
  }

  /** 写入/更新当日运单（已存在则保留其状态与行号），返回 [新增数, 当日本全部行]。 */
  upsertOrders(
    rows: Record<string, any>[],
    statDate: string,
  ): [number, Record<string, any>[]] {
    this.initDb();
    const db = this.open();
    let added = 0;
    let all: Record<string, any>[] = [];
    try {
      const exists = db.prepare('SELECT id FROM orders WHERE stat_date=? AND violation_no=?');
      const insert = db.prepare(
        'INSERT INTO orders (stat_date, violation_no, tracking_no, rider_name, team_name, station, status, created_at, updated_at)' +
          " VALUES (?,?,?,?,?,?, 'pending', ?, ?)",
      );
      const now = this.nowStr();
      for (const r of rows) {
        const no = String(r['违规编号'] ?? '');
        if (exists.get(statDate, no)) continue;
        insert.run(
          statDate,
          no,
          String(r['运单号'] ?? ''),
          String(r['骑手名称'] ?? ''),
          String(r['团队名称'] ?? ''),
          String(r['站点'] ?? ''),
          now,
          now,
        );
        added += 1;
      }
      all = db
        .prepare('SELECT * FROM orders WHERE stat_date=? ORDER BY id')
        .all(statDate) as Record<string, any>[];
    } finally {
      db.close();
    }
    this.logger.log(`入库：新增 ${added} 条，当日共 ${all.length} 条`);
    return [added, all];
  }

  setSheetRow(violationNo: string, row: number): void {
    const db = this.open();
    try {
      db.prepare('UPDATE orders SET sheet_row=?, updated_at=? WHERE violation_no=?').run(
        row,
        this.nowStr(),
        violationNo,
      );
    } finally {
      db.close();
    }
  }

  setStatus(violationNo: string, status: string): void {
    const db = this.open();
    try {
      db.prepare('UPDATE orders SET status=?, updated_at=? WHERE violation_no=?').run(
        status,
        this.nowStr(),
        violationNo,
      );
    } finally {
      db.close();
    }
  }

  findBytracking(trackingNo: string, statDate?: string): Record<string, any> | null {
    this.initDb();
    const db = this.open();
    try {
      const r = (
        statDate
          ? db
              .prepare(
                'SELECT * FROM orders WHERE tracking_no=? AND stat_date=? ORDER BY id DESC',
              )
              .get(trackingNo, statDate)
          : db
              .prepare('SELECT * FROM orders WHERE tracking_no=? ORDER BY id DESC')
              .get(trackingNo)
      ) as Record<string, any> | undefined;
      return r ?? null;
    } finally {
      db.close();
    }
  }

  addFeedback(
    orderId: number | null,
    sender: string,
    reason: string,
    action: string,
    media: unknown[],
    rawText: string,
  ): number {
    const db = this.open();
    try {
      const res = db
        .prepare(
          'INSERT INTO feedbacks (order_id, sender, reason, action, media_json, raw_text, created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          orderId,
          sender,
          reason,
          action,
          JSON.stringify(media || []),
          rawText,
          this.nowStr(),
        );
      return Number(res.lastInsertRowid ?? 0);
    } finally {
      db.close();
    }
  }

  markJudged(fid: number, passFlag: boolean, missing: unknown[], llmReason: string): void {
    const db = this.open();
    try {
      db.prepare(
        'UPDATE feedbacks SET judged=1, pass_flag=?, missing_json=?, llm_reason=? WHERE id=?',
      ).run(passFlag ? 1 : 0, JSON.stringify(missing), llmReason, fid);
    } finally {
      db.close();
    }
  }
}
