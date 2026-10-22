import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../pg/pg.service';

type Row = Record<string, unknown>;

export type JobStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'stopped'
  | 'cancelled';

export interface EnqueueItem {
  task_id: string;
  args?: Record<string, unknown>;
  timeout?: number;
  source?: 'cron' | 'manual';
  cronRunId?: string | null;
  name?: string;
  group?: string;
}

export interface HistoryEntry {
  run_id: string;
  task_id: string;
  name: string;
  group: string;
  status: JobStatus;
  exit_code: number | null;
  start: string;
  duration: number;
  error_kind?: string;
  error_advice?: string;
  args: Record<string, unknown>;
}

/**
 * PG 任务队列（任务执行与 API 进程解耦的核心）。
 *
 * 设计要点（对齐 CronStore 的自建 PG 持久化范式，不引入 Redis/BullMQ）：
 *  · 入队（API 的调度器 / 手动触发）只 INSERT 一行 `task_job`（status='queued'）；
 *  · 独立 worker 进程用「原子 UPDATE ... WHERE id=(SELECT ... LIMIT 1) AND status='queued'」
 *    抢占，多个 worker 并发安全（只有一个能拿到同一行）；
 *  · 执行状态 / 日志路径全部落 PG，API 侧只读 PG 即可服务前端，前端零改动；
 *  · 心跳（heartbeat_at）+ 陈旧回收，使 worker 崩溃后其 running 任务可被重新排队 ——
 *    即「跨进程恢复」，且天然支持多 worker 横向扩展。
 */
@Injectable()
export class JobQueueService implements OnModuleInit {
  private readonly logger = new Logger(JobQueueService.name);
  private logDir = '';

  constructor(
    private readonly config: ConfigService,
    private readonly pg: PgService,
  ) {}

  async onModuleInit(): Promise<void> {
    const wb = this.config.get<string>('WORKBENCH_DIR') || '';
    this.logDir = path.join(wb || process.cwd(), 'logs');
    fs.mkdirSync(this.logDir, { recursive: true });
    await this.initDb();
  }

  // ------------------------------------------------------------ DDL
  private async initDb(): Promise<void> {
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS task_job (
        id              TEXT PRIMARY KEY,
        source          TEXT NOT NULL DEFAULT 'manual',
        cron_run_id     TEXT,
        task_id         TEXT NOT NULL,
        name            TEXT NOT NULL DEFAULT '',
        "group"         TEXT NOT NULL DEFAULT '',  -- group 是 PG 保留字（GROUP BY），必须引号
        args_json       TEXT NOT NULL DEFAULT '{}',
        status          TEXT NOT NULL DEFAULT 'queued',
        exit_code       INTEGER,
        attempt         INTEGER NOT NULL DEFAULT 1,
        worker_id       TEXT,
        claimed_at      TEXT,
        started_at      TEXT,
        finished_at     TEXT,
        heartbeat_at    TEXT,
        message         TEXT NOT NULL DEFAULT '',
        error_kind      TEXT,
        error_advice    TEXT,
        timeout_sec     INTEGER,
        log_path        TEXT,
        stop_requested  INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        CONSTRAINT task_job_status_chk CHECK (status IN ('queued','running','success','failed','stopped','cancelled'))
      );
      CREATE INDEX IF NOT EXISTS idx_job_active ON task_job(status) WHERE status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS idx_job_cron ON task_job(cron_run_id);
      CREATE INDEX IF NOT EXISTS idx_job_created ON task_job(created_at DESC);
    `);
  }

  // ------------------------------------------------------------ 工具
  private nowStr(): string {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }

  private newId(): string {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ------------------------------------------------------------ 入队（API 侧）
  async enqueue(items: EnqueueItem[]): Promise<string[]> {
    const ids: string[] = [];
    for (const it of items) {
      const id = this.newId();
      const logPath = path.join(this.logDir, id + '.log');
      await this.pg.query(
        `INSERT INTO task_job(id,source,cron_run_id,task_id,name,"group",args_json,status,attempt,timeout_sec,log_path,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'queued',1,$8,$9,$10)`,
        [
          id,
          it.source || 'manual',
          it.cronRunId ?? null,
          it.task_id,
          it.name ?? it.task_id,
          it.group ?? '',
          JSON.stringify(it.args || {}),
          it.timeout && it.timeout > 0 ? it.timeout : null,
          logPath,
          this.nowStr(),
        ],
      );
      ids.push(id);
    }
    return ids;
  }

  // ------------------------------------------------------------ 抢占（worker 侧，原子）
  async claim(workerId: string): Promise<Row | null> {
    const now = this.nowStr();
    const rows = await this.pg.query(
      `UPDATE task_job
         SET status='running', worker_id=$1, claimed_at=$2, started_at=$2, heartbeat_at=$2
       WHERE id=(SELECT id FROM task_job WHERE status='queued' ORDER BY created_at ASC, id ASC LIMIT 1)
         AND status='queued'
       RETURNING *`,
      [workerId, now],
    );
    return rows[0] ?? null;
  }

  async heartbeat(id: string): Promise<void> {
    await this.pg.query(
      `UPDATE task_job SET heartbeat_at=$2 WHERE id=$1 AND status='running'`,
      [id, this.nowStr()],
    );
  }

  /**
   * 崩溃恢复：把「running 但心跳陈旧超过 timeout+120s」的任务退回队列，
   * 由任意 worker 重新抢占。worker 进程崩溃即触发此路径，实现跨进程恢复。
   */
  async recoverStale(): Promise<number> {
    const rows = await this.pg.query(
      `UPDATE task_job
         SET status='queued', worker_id=NULL, claimed_at=NULL, started_at=NULL, heartbeat_at=NULL
       WHERE status='running'
         AND heartbeat_at IS NOT NULL
         AND heartbeat_at::timestamp < $1::timestamp - (GREATEST(COALESCE(timeout_sec,600),600)+120) * INTERVAL '1 second'`,
      [this.nowStr()],
    );
    return rows.length;
  }

  async markFinished(
    id: string,
    p: {
      status: JobStatus;
      exitCode: number | null;
      message?: string;
      errorKind?: string | null;
      errorAdvice?: string | null;
    },
  ): Promise<void> {
    await this.pg.query(
      `UPDATE task_job
         SET status=$2, exit_code=$3, finished_at=$4, message=$5, error_kind=$6, error_advice=$7, heartbeat_at=NULL
       WHERE id=$1`,
      [
        id,
        p.status,
        p.exitCode,
        this.nowStr(),
        p.message ?? '',
        p.errorKind ?? null,
        p.errorAdvice ?? null,
      ],
    );
  }

  // ------------------------------------------------------------ 停止 / 取消（API 侧）
  async requestStop(id: string): Promise<boolean> {
    const rows = await this.pg.query(
      `UPDATE task_job SET stop_requested=1 WHERE id=$1 AND status IN ('queued','running')`,
      [id],
    );
    return rows.length > 0;
  }

  /** 停止当前运行 + 取消所有排队（对齐旧 stopCurrent 的语义）。 */
  async stopAll(): Promise<boolean> {
    const running = await this.findRunning();
    let stopped = false;
    if (running) stopped = await this.requestStop(String(running['id']));
    await this.pg.query(
      `UPDATE task_job SET status='cancelled', finished_at=$1 WHERE status='queued'`,
      [this.nowStr()],
    );
    return stopped;
  }

  async cancelQueued(id: string): Promise<boolean> {
    const rows = await this.pg.query(
      `UPDATE task_job SET status='cancelled', finished_at=$1 WHERE id=$2 AND status='queued'`,
      [this.nowStr(), id],
    );
    return rows.length > 0;
  }

  async findRunning(): Promise<Row | null> {
    const rows = await this.pg.query(
      `SELECT * FROM task_job WHERE status='running' ORDER BY started_at ASC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async isStopRequested(id: string): Promise<boolean> {
    const row = await this.pg.queryOne(
      `SELECT stop_requested FROM task_job WHERE id=$1`,
      [id],
    );
    return row ? Number(row['stop_requested'] || 0) === 1 : false;
  }

  // ------------------------------------------------------------ 读取（API 侧 / 前端）
  async getJob(id: string): Promise<Row | null> {
    const rows = await this.pg.query(`SELECT * FROM task_job WHERE id=$1`, [id]);
    return rows[0] ?? null;
  }

  async getStatus(id: string): Promise<Row | null> {
    return this.getJob(id);
  }

  async getLog(id: string): Promise<string[] | null> {
    const row = await this.getJob(id);
    if (!row) return null;
    const p = String(row['log_path'] || '');
    if (!p || !fs.existsSync(p)) return [];
    try {
      return fs.readFileSync(p, 'utf-8').split('\n');
    } catch {
      return [];
    }
  }

  /** 从指定字节偏移增量读取日志（供 SSE 镜像器逐行转发实时日志）。 */
  async tailLog(
    id: string,
    fromByte: number,
  ): Promise<{ lines: string[]; nextByte: number }> {
    const row = await this.getJob(id);
    if (!row) return { lines: [], nextByte: fromByte };
    const p = String(row['log_path'] || '');
    if (!p || !fs.existsSync(p)) return { lines: [], nextByte: fromByte };
    try {
      const stat = fs.statSync(p);
      let start = fromByte;
      if (stat.size < start) start = 0; // 文件被截断/轮换，从头读
      const buf = Buffer.alloc(stat.size - start);
      const fd = fs.openSync(p, 'r');
      try {
        fs.readSync(fd, buf, 0, buf.length, start);
      } finally {
        fs.closeSync(fd);
      }
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      return { lines, nextByte: stat.size };
    } catch {
      return { lines: [], nextByte: fromByte };
    }
  }

  async currentAndQueue(): Promise<{ current: Row | null; queue: Row[] }> {
    const cur = await this.pg.query(
      `SELECT * FROM task_job WHERE status='running' ORDER BY started_at DESC LIMIT 1`,
    );
    const q = await this.pg.query(
      `SELECT * FROM task_job WHERE status='queued' ORDER BY created_at ASC, id ASC`,
    );
    return { current: cur[0] ?? null, queue: q };
  }

  async listRecent(limit = 60): Promise<HistoryEntry[]> {
    const rows = await this.pg.query(
      `SELECT * FROM task_job
         WHERE status IN ('success','failed','stopped','cancelled')
         ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => this.toHistory(r));
  }

  private toHistory(r: Row): HistoryEntry {
    const start = String(r['started_at'] || r['created_at'] || '');
    const fin = String(r['finished_at'] || '');
    let duration = 0;
    if (start && fin) {
      const d = new Date(fin.replace(' ', 'T') + 'Z').getTime() -
        new Date(start.replace(' ', 'T') + 'Z').getTime();
      if (!isNaN(d)) duration = Math.round(d / 100) / 10;
    }
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(String(r['args_json'] || '{}'));
    } catch {
      args = {};
    }
    return {
      run_id: String(r['id']),
      task_id: String(r['task_id']),
      name: String(r['name'] || ''),
      group: String(r['group'] || ''),
      status: r['status'] as JobStatus,
      exit_code: (r['exit_code'] as number) ?? null,
      start,
      duration,
      error_kind: (r['error_kind'] as string) || undefined,
      error_advice: (r['error_advice'] as string) || undefined,
      args,
    };
  }

  /** 任务最近一次成功的运行参数（用于产物占位符 <name> 展开）。 */
  async getLastArgs(taskId: string): Promise<Record<string, unknown>> {
    const rows = await this.pg.query(
      `SELECT args_json FROM task_job WHERE task_id=$1 AND status='success'
         ORDER BY finished_at DESC LIMIT 1`,
      [taskId],
    );
    if (!rows[0]) return {};
    try {
      return JSON.parse(String(rows[0]['args_json'] || '{}'));
    } catch {
      return {};
    }
  }
}
