import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as os from 'os';
import { PgService } from '../pg/pg.service';

const TABLE = 'worker_heartbeat';
/** 心跳周期：worker 每 10s 报一次（一次 PG upsert，成本极低，报密一点状态更实时）。 */
export const WORKER_BEAT_MS = 10_000;
/** 判定「在线」的窗口：2.5 个心跳周期 —— 容忍一次丢报，又不至于让"worker 已死"拖太久。 */
export const WORKER_ACTIVE_MS = 25_000;

export interface WorkerPresence {
  count: number;
  lastSeen: number | null; // epoch ms
  workers: string[];
}

/**
 * worker 进程心跳（PG `worker_heartbeat` 表）。
 *
 * 为什么需要：worker 是独立进程、不监听 HTTP，「任务一直排队中」是它挂了的典型表现，
 * 但此前**没有任何地方能回答 worker 是否活着** —— task_job 上的 heartbeat_at 是任务级
 * 心跳，worker 空闲（没抢到任务）时不会写任何东西，因此空闲即"不可见"。
 *
 * 这里让每个 worker 进程周期性 upsert 一行（worker_id 为主键），判断在线只需查
 * `last_seen` 在最近一个窗口内的行数。进程优雅退出时删除自己的行，避免"已停仍显示在线"。
 */
@Injectable()
export class WorkerHeartbeatService implements OnModuleInit {
  private readonly logger = new Logger(WorkerHeartbeatService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        worker_id   TEXT PRIMARY KEY,
        host        TEXT,
        pid         INTEGER,
        started_at  BIGINT,
        last_seen   BIGINT
      )
    `);
  }

  /** 上报一次心跳（幂等 upsert：同一 worker_id 只保留一行）。 */
  async beat(workerId: string): Promise<void> {
    const now = Date.now();
    await this.pg.query(
      `INSERT INTO ${TABLE} (worker_id, host, pid, started_at, last_seen)
       VALUES ($1,$2,$3,$4,$4)
       ON CONFLICT (worker_id) DO UPDATE SET host=EXCLUDED.host, pid=EXCLUDED.pid, last_seen=EXCLUDED.last_seen`,
      [workerId, os.hostname(), process.pid, now],
    );
    // 顺带清理长期失联的残留行（崩溃退出没来得及删），表始终只有极少量行
    await this.pg.query(`DELETE FROM ${TABLE} WHERE last_seen < $1`, [now - 24 * 3600 * 1000]);
  }

  /** 优雅退出：抹掉自己的行，否则会残留一个"在线"的幽灵 worker。 */
  async release(workerId: string): Promise<void> {
    await this.pg.query(`DELETE FROM ${TABLE} WHERE worker_id = $1`, [workerId]);
  }

  /** 当前在线的 worker（窗口内有心跳即算在线）。 */
  async active(withinMs: number = WORKER_ACTIVE_MS): Promise<WorkerPresence> {
    const rows = await this.pg.query(
      `SELECT worker_id, last_seen FROM ${TABLE} WHERE last_seen > $1 ORDER BY last_seen DESC`,
      [Date.now() - withinMs],
    );
    const list = (rows || []) as { worker_id: string; last_seen: number }[];
    return {
      count: list.length,
      lastSeen: list.length ? Number(list[0].last_seen) : null,
      workers: list.map((r) => r.worker_id),
    };
  }
}
