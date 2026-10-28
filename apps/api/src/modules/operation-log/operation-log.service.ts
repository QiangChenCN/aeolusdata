import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgService } from '../pg/pg.service';

/**
 * 通用操作日志（全项目级溯源）：记录「谁 + 时间 + 用什么代码 + 操作了什么」。
 *
 * 两条写入路径：
 *   1) 自动：全局 OperationLogMiddleware 监听每个 /api 请求的响应 finish 事件，零侵入地记录
 *      接口级操作（actor 来自请求身份、action 为 `METHOD path`、code 为匹配路由 path）。
 *   2) 手动：关键业务点在落库/强操作前后显式调用 record()，补充数据级细节
 *      （如「回补 delivery_history 7 天，入库 N 条」），code 精确到 Service.method。
 *
 * 设计要点：
 *   · 表 `operation_log` 由本服务 onModuleInit 幂等建表（TIMESTAMPTZ/带索引）。
 *   · record() 全程 fail-safe：审计写失败只告警，绝不拖累主业务。
 *   · 通过 @Global() 模块暴露，任意业务模块直接 inject 即可复用。
 */
const LOG_DDL = `
CREATE TABLE IF NOT EXISTS operation_log (
  id           SERIAL PRIMARY KEY,
  ts           TEXT NOT NULL,
  actor        TEXT NOT NULL DEFAULT 'anonymous',
  method       TEXT,
  action       TEXT NOT NULL,
  target       TEXT,
  code         TEXT,
  status       INTEGER,
  duration_ms  INTEGER,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_operation_log_ts ON operation_log(ts);
CREATE INDEX IF NOT EXISTS idx_operation_log_actor ON operation_log(actor);
CREATE INDEX IF NOT EXISTS idx_operation_log_action ON operation_log(action);
`;

/** 北京时间 `YYYY-MM-DD HH:mm:ss`（与业务落库时间同口径，便于人工核对）。 */
function beijingNowStr(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

export interface OperationLogInput {
  /** 谁：登录用户名 / 'machine'(机器令牌) / 'system'(内部调度) / 'script:xxx' / 'anonymous'。 */
  actor?: string;
  /** HTTP 方法（自动路径由拦截器填，手动路径可不填）。 */
  method?: string;
  /** 动作代码：HTTP 为 `GET /api/xxx`；业务为语义化如 `rollup.history`。 */
  action: string;
  /** 操作对象：HTTP 为路径；业务为表名/资源。 */
  target?: string;
  /** 哪段代码触发：`Controller.method` 或 `Service.method`。 */
  code: string;
  /** 结果状态码（HTTP 状态 / 业务 200·500）。 */
  status?: number;
  /** 耗时（毫秒）。 */
  durationMs?: number;
  /** 补充信息：参数摘要、影响行数、错误信息等（会被 JSON.stringify 截断）。 */
  detail?: unknown;
}

export interface OperationLogQuery {
  actor?: string;
  action?: string;
  target?: string;
  from?: string;
  to?: string;
  limit?: number;
}

@Injectable()
export class OperationLogService implements OnModuleInit {
  private readonly logger = new Logger(OperationLogService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    if (!this.pg.isEnabled) return;
    try {
      await this.pg.query(LOG_DDL);
      this.logger.log('操作日志表 operation_log 已就绪');
    } catch (e) {
      this.logger.error('操作日志表初始化失败：' + (e as Error).message);
    }
  }

  /**
   * 记录一条操作日志。fail-safe：任何异常（含表不存在、字段不符）只告警不抛出，
   * 确保审计逻辑绝不拖垮主业务流程。
   */
  async record(input: OperationLogInput): Promise<void> {
    if (!this.pg.isEnabled) return;
    let detail = '';
    try {
      detail = input.detail == null ? '' : JSON.stringify(input.detail);
      if (detail.length > 4000) detail = detail.slice(0, 4000) + '…(truncated)';
    } catch {
      detail = '[unserializable]';
    }
    const ts = beijingNowStr();
    await this.pg
      .query(
        `INSERT INTO operation_log (ts, actor, method, action, target, code, status, duration_ms, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          ts,
          input.actor ?? 'anonymous',
          input.method ?? null,
          input.action,
          input.target ?? null,
          input.code,
          input.status ?? null,
          input.durationMs ?? null,
          detail || null,
        ],
      )
      .catch((e) => this.logger.warn('操作日志写入失败（已忽略）：' + (e as Error).message));
  }

  /** 查询操作日志（倒序）。支持 actor/action/target 模糊过滤与时间范围 from/to（含端点）。 */
  async list(q: OperationLogQuery = {}): Promise<any[]> {
    if (!this.pg.isEnabled) return [];
    const lim = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
    const where: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (q.actor) {
      where.push(`actor = $${i++}`);
      params.push(q.actor);
    }
    if (q.action) {
      where.push(`action = $${i++}`);
      params.push(q.action);
    }
    if (q.target) {
      where.push(`target = $${i++}`);
      params.push(q.target);
    }
    if (q.from) {
      where.push(`ts >= $${i++}`);
      params.push(q.from);
    }
    if (q.to) {
      where.push(`ts <= $${i++}`);
      params.push(q.to);
    }
    const sql =
      `SELECT id, ts, actor, method, action, target, code, status, duration_ms, detail ` +
      `FROM operation_log` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY id DESC LIMIT $${i}`;
    params.push(lim);
    return this.pg.query(sql, params);
  }
}
