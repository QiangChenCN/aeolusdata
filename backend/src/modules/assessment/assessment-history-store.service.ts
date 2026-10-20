import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgService } from '../pg/pg.service';

/**
 * 考核看板 —— 历史明细落盘（PostgreSQL only，不再保留 SQLite）。
 *
 * 三张表（DDL 见 PG_DDL）：
 *   · delivery_history(order_id, team_id, date, payload)
 *   · violation_history(vid, team_id, date, payload)
 *   · visit_history(main_task_id, team_id, date, visited, total, payload)
 * 未配置 DATABASE_URL 时 onModuleInit 建表会抛错 → 启动失败（不再静默回退 SQLite）。
 */
const PG_DDL = `
CREATE TABLE IF NOT EXISTS delivery_history (
  order_id TEXT NOT NULL, team_id TEXT NOT NULL, date TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (order_id, date));
CREATE TABLE IF NOT EXISTS violation_history (
  vid TEXT NOT NULL, team_id TEXT NOT NULL, date TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (vid, date));
CREATE TABLE IF NOT EXISTS visit_history (
  main_task_id TEXT NOT NULL, team_id TEXT NOT NULL, date TEXT NOT NULL,
  visited TEXT, total TEXT, payload TEXT NOT NULL,
  PRIMARY KEY (main_task_id, team_id, date));
CREATE INDEX IF NOT EXISTS idx_delivery_team_date  ON delivery_history (team_id, date);
CREATE INDEX IF NOT EXISTS idx_violation_team_date ON violation_history (team_id, date);
CREATE INDEX IF NOT EXISTS idx_visit_date         ON visit_history (date);
`;

@Injectable()
export class AssessmentHistoryStoreService implements OnModuleInit {
  private readonly logger = new Logger(AssessmentHistoryStoreService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    await this.pg.query(PG_DDL);
    this.logger.log('考核历史 PG 表已就绪');
  }

  /** 批量 UPSERT 运单历史（幂等：同 order_id+date 覆盖写）。 */
  async upsertDeliveries(
    rows: { id: string; teamId: string; date: string; payload: unknown }[],
  ): Promise<void> {
    if (!rows.length) return;
    for (const r of rows) {
      await this.pg.query(
        'INSERT INTO delivery_history (order_id, team_id, date, payload) VALUES ($1,$2,$3,$4) ' +
          'ON CONFLICT(order_id, date) DO UPDATE SET team_id=excluded.team_id, payload=excluded.payload',
        [r.id, r.teamId, r.date, JSON.stringify(r.payload)],
      );
    }
  }

  /** 批量 UPSERT 违规历史（幂等：同 vid+date 覆盖写）。 */
  async upsertViolations(
    rows: { id: string; teamId: string; date: string; payload: unknown }[],
  ): Promise<void> {
    if (!rows.length) return;
    for (const r of rows) {
      await this.pg.query(
        'INSERT INTO violation_history (vid, team_id, date, payload) VALUES ($1,$2,$3,$4) ' +
          'ON CONFLICT(vid, date) DO UPDATE SET team_id=excluded.team_id, payload=excluded.payload',
        [r.id, r.teamId, r.date, JSON.stringify(r.payload)],
      );
    }
  }

  /** UPSERT 商家拜访历史（按 main_task_id × team × date 去重）。 */
  async upsertVisit(
    mainTaskId: string,
    teamId: string,
    date: string,
    visited: number | null,
    total: number | null,
    payload: unknown,
  ): Promise<void> {
    await this.pg.query(
      'INSERT INTO visit_history (main_task_id, team_id, date, visited, total, payload) ' +
        'VALUES ($1,$2,$3,$4,$5,$6) ' +
        'ON CONFLICT(main_task_id, team_id, date) DO UPDATE SET visited=excluded.visited, total=excluded.total, payload=excluded.payload',
      [
        mainTaskId,
        teamId,
        date,
        visited == null ? null : String(visited),
        total == null ? null : String(total),
        JSON.stringify(payload),
      ],
    );
  }
}
