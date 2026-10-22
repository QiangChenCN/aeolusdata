import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../../../modules/pg/pg.service';

/**
 * 不满意单状态层（移植 jobs/unsat/store.py）—— PostgreSQL only，不再保留 SQLite。
 *
 * 表：unsat_orders（当日运单 + 状态机）、unsat_feedbacks（站长反馈）、unsat_reminders（提醒去重）。
 * 状态机 unsat_orders.status：pending → judging → rejected / done。
 * PG 为异步驱动，所有方法均为 async。
 */
const PG_DDL = `
CREATE TABLE IF NOT EXISTS unsat_orders (
    id              SERIAL PRIMARY KEY,
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
CREATE TABLE IF NOT EXISTS unsat_feedbacks (
    id              SERIAL PRIMARY KEY,
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
CREATE TABLE IF NOT EXISTS unsat_reminders (
    id              SERIAL PRIMARY KEY,
    stat_date       TEXT,
    station         TEXT,
    remind_hour     INTEGER,
    created_at      TEXT,
    UNIQUE(stat_date, station, remind_hour)
);
CREATE INDEX IF NOT EXISTS idx_unsat_orders_status ON unsat_orders(stat_date, status);
CREATE INDEX IF NOT EXISTS idx_unsat_orders_station ON unsat_orders(station);
`;

type OrderRow = Record<string, any>;

@Injectable()
export class UnsatStoreService implements OnModuleInit {
  private readonly logger = new Logger(UnsatStoreService.name);
  readonly dataDir: string;
  readonly imgPath: string;
  readonly csvPath: string;

  constructor(
    private readonly pg: PgService,
    config: ConfigService,
  ) {
    const root = path.resolve(
      config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.dataDir = path.join(root, 'apps', 'api', 'runtime', 'jobs', 'unsat', 'out', 'unsat_data');
    this.imgPath = path.join(this.dataDir, 'unsat_detail.png');
    this.csvPath = path.join(this.dataDir, 'violations.csv');
  }

  private nowStr(): string {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }

  async onModuleInit(): Promise<void> {
    await this.initDb();
  }

  /** 幂等建表（onModuleInit 自动调用；保留方法签名供外部显式触发）。 */
  async initDb(): Promise<void> {
    await this.pg.query(PG_DDL);
    this.logger.log('不满意单 PG 表已就绪');
  }

  /** 写入/更新当日运单（已存在则保留其状态与行号），返回 [新增数, 当日本全部行]。 */
  async upsertOrders(
    rows: OrderRow[],
    statDate: string,
  ): Promise<[number, OrderRow[]]> {
    let added = 0;
    const now = this.nowStr();
    for (const r of rows || []) {
      const no = String(r['违规编号'] ?? '');
      if (!no) continue;
      const inserted = await this.pg.query(
        'INSERT INTO unsat_orders (stat_date, violation_no, tracking_no, rider_name, team_name, station, status, created_at, updated_at)' +
          " VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$7) " +
          'ON CONFLICT(stat_date, violation_no) DO NOTHING RETURNING id',
        [statDate, no, String(r['运单号'] ?? ''), String(r['骑手名称'] ?? ''),
          String(r['团队名称'] ?? ''), String(r['站点'] ?? ''), now],
      );
      if (inserted.length) added += 1;
    }
    const all = await this.pg.query<OrderRow>(
      'SELECT * FROM unsat_orders WHERE stat_date=$1 ORDER BY id',
      [statDate],
    );
    this.logger.log(`入库：新增 ${added} 条，当日共 ${all.length} 条`);
    return [added, all];
  }

  async setSheetRow(violationNo: string, row: number): Promise<void> {
    await this.pg.query(
      'UPDATE unsat_orders SET sheet_row=$1, updated_at=$2 WHERE violation_no=$3',
      [row, this.nowStr(), violationNo],
    );
  }

  async setStatus(violationNo: string, status: string): Promise<void> {
    await this.pg.query(
      'UPDATE unsat_orders SET status=$1, updated_at=$2 WHERE violation_no=$3',
      [status, this.nowStr(), violationNo],
    );
  }

  async findBytracking(trackingNo: string, statDate?: string): Promise<OrderRow | null> {
    const rows = statDate
      ? await this.pg.query<OrderRow>(
          'SELECT * FROM unsat_orders WHERE tracking_no=$1 AND stat_date=$2 ORDER BY id DESC LIMIT 1',
          [trackingNo, statDate],
        )
      : await this.pg.query<OrderRow>(
          'SELECT * FROM unsat_orders WHERE tracking_no=$1 ORDER BY id DESC LIMIT 1',
          [trackingNo],
        );
    return rows[0] ?? null;
  }

  async addFeedback(
    orderId: number | null,
    sender: string,
    reason: string,
    action: string,
    media: unknown[],
    rawText: string,
  ): Promise<number> {
    const rows = await this.pg.query<{ id: number }>(
      'INSERT INTO unsat_feedbacks (order_id, sender, reason, action, media_json, raw_text, created_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [orderId, sender, reason, action, JSON.stringify(media || []), rawText, this.nowStr()],
    );
    return Number(rows[0]?.id ?? 0);
  }

  async markJudged(fid: number, passFlag: boolean, missing: unknown[], llmReason: string): Promise<void> {
    await this.pg.query(
      'UPDATE unsat_feedbacks SET judged=1, pass_flag=$1, missing_json=$2, llm_reason=$3 WHERE id=$4',
      [passFlag ? 1 : 0, JSON.stringify(missing), llmReason, fid],
    );
  }
}
