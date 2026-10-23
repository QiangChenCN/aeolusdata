import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgService } from '../pg/pg.service';

/**
 * 配送超时看板 —— 实时运单明细持久层（PostgreSQL only）。
 *
 * 背景（2026-10-21）：本看板的计算源原先是**落盘文件** —— 要么是标准达成那份
 * `apps/api/runtime/raw/orders_{team}_{date}.json`，要么实际被读的是考核看板的
 * `apps/api/runtime/运单明细-实时.json`。两条路都是文件，且跨看板耦合：
 *  · 文件被两个看板读写，改抓取/清洗口径会同时影响两边；
 *  · 全站单文件覆盖写没有并发保护，也没有历史留存。
 *
 * 现在改为**本看板自己的一张 PG 表**作为实时运单明细的计算源：
 *  写 —— `DeliveryTimeoutRefreshService`（本看板自有刷新，全站一次拉全）；
 *  读 —— `DeliveryTimeoutInternalController`（内部端点，机器令牌）→ Python 计算。
 * 这样页面上「配送超时刷新」与 Standard 链路彻底解耦，与其他看板零共享面。
 *
 * 语义：一天一份「实时快照」（同 date 整表覆盖），行=一条运单原始行，整体 JSON 存 raw_json。
 *
 * 表名 `delivery_realtime`（2026-10-23 由 `delivery_timeout_orders` 更名，统一「运单明细」命名；
 * 写入方仍是本看板的 DeliveryTimeoutRefreshService）。
 * 表发现 deploy/DEPLOY.md 第 9 节：DATABASE_URL 就绪即自动建表，无需手工 DDL。
 */
const PG_DDL = `
CREATE TABLE IF NOT EXISTS delivery_realtime (
  id          SERIAL PRIMARY KEY,
  stat_date   TEXT NOT NULL,
  team_id     TEXT NOT NULL,
  order_no    TEXT NOT NULL,
  raw_json    TEXT NOT NULL,
  created_at  TEXT,
  UNIQUE(stat_date, order_no));
CREATE INDEX IF NOT EXISTS idx_delivery_realtime_date_team ON delivery_realtime(stat_date, team_id);
`;

/** 运单号取值键（风神导出字段）：用于行去重键 `UNIQUE(stat_date, order_no)`。 */
const ORDER_NO_KEYS = ['orderNo', 'trackingId', 'merchantOrderSerial'];
/** 站点 id 取值键（与 Python order_rules.TEAM_KEYS 同口径）。 */
const TEAM_KEYS = ['teamId', '团队ID'];

@Injectable()
export class DeliveryTimeoutOrdersStoreService implements OnModuleInit {
  private readonly logger = new Logger(DeliveryTimeoutOrdersStoreService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    if (!this.pg.isEnabled) {
      this.logger.warn('DATABASE_URL 未配置，实时运单明细表不可用（刷新将返回 not_ready）');
      return;
    }
    await this.pg.query(PG_DDL);
    this.logger.log('配送超时·实时运单明细 PG 表已就绪');
  }

  get ready(): boolean {
    return this.pg.isEnabled;
  }

  private nowStr(now: Date = new Date()): string {
    const d = new Date(now.getTime() + 8 * 3600 * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
      `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    );
  }

  private cell(r: Record<string, unknown>, keys: string[]): string {
    for (const k of keys) {
      const v = r?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  /**
   * 覆盖写某天的实时运单明细（整日快照）。
   *
   * 为什么是「先删当天再插」而不是 upsert：这是一份**截至当前时刻**的全天快照，
   * 同一天重复刷新时，上一版里存在、本次抓不到的行（如已被撤回/改派出本页）必须消失，
   * 否则旧行会参与聚合，表现为「单量只增不减」。整个过程包在一个事务里，
   * 中途失败不会留下半份数据。
   */
  async replaceDay(date: string, rows: Record<string, unknown>[]): Promise<number> {
    if (!this.pg.isEnabled) throw new Error('PG 未启用：无法写入实时运单明细');
    const now = this.nowStr();
    const cols = 5;
    return this.pg.tx(async (c) => {
      await c.query('DELETE FROM delivery_realtime WHERE stat_date = $1', [date]);
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
            this.cell(r, TEAM_KEYS) || '_unknown',
            this.cell(r, ORDER_NO_KEYS) || `row_${n + i}`,
            JSON.stringify(r),
            now,
          );
        });
        await c.query(
          'INSERT INTO delivery_realtime (stat_date, team_id, order_no, raw_json, created_at) ' +
            `VALUES ${ph.join(',')} ON CONFLICT (stat_date, order_no) DO NOTHING`,
          vals,
        );
        n += chunk.length;
        chunk.length = 0;
      };
      for (const r of rows || []) {
        chunk.push(r);
        if (chunk.length >= 200) await flush();
      }
      await flush();
      return n;
    });
  }

  /** 取某站点某天的运单明细原始行；无数据返回 []。 */
  async getTeam(date: string, team: string): Promise<Record<string, unknown>[]> {
    const rows = await this.pg.query<{ raw_json: string }>(
      'SELECT raw_json FROM delivery_realtime WHERE stat_date = $1 AND team_id = $2 ORDER BY id',
      [date, String(team)],
    );
    return rows.map((r) => JSON.parse(r.raw_json));
  }

  /** 该天的行数（全站）。用于诊断「某天拉到多少条」。 */
  async countDay(date: string): Promise<number> {
    const r = await this.pg.queryOne<{ c: string }>(
      'SELECT COUNT(*)::bigint AS c FROM delivery_realtime WHERE stat_date = $1',
      [date],
    );
    return Number(r?.c ?? 0);
  }

  /** 该（天 → 站点）最近一次入库时间（北京时间），无数据返回 ''。 */
  async lastFetchedAt(date: string, team?: string): Promise<string> {
    const r = team
      ? await this.pg.queryOne<{ t?: string }>(
          'SELECT MAX(created_at) AS t FROM delivery_realtime WHERE stat_date = $1 AND team_id = $2',
          [date, String(team)],
        )
      : await this.pg.queryOne<{ t?: string }>(
          'SELECT MAX(created_at) AS t FROM delivery_realtime WHERE stat_date = $1',
          [date],
        );
    return r?.t || '';
  }
}
