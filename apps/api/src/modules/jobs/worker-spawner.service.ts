import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { WorkerHeartbeatService } from './worker-heartbeat.service';

/**
 * 后端托管任务 worker 子进程（方案 B）。
 *
 * 背景：worker（消费 task_job 队列）原先是独立进程，需人工
 * `node dist/src/main-worker` 拉起；漏起则任务永远「排队中」。
 * 本服务在后端启动时自动拉起并看护它：
 *   · 启动时先看 PG 心跳表是否有存活 worker，有则不重复拉起（避免 restart 后端时产生双份）；
 *   · worker 退出（崩溃/异常）自动重启，带退避与防雪崩上限；
 *   · 仅挂在 AppModule（API 进程），不进 WorkerModule，故 worker 进程自身不会再去拉 worker。
 *
 * 与现有设计兼容：抢占是原子的、可水平多实例，所以「后端顺带管一个 worker」不会破坏隔离，
 * 同时保留进程级故障隔离与风神 cookie 串行（worker 仍是独立进程）。
 */
@Injectable()
export class WorkerSpawnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerSpawnerService.name);
  private child: ChildProcess | null = null;
  private stopping = false;
  private respawns = 0;
  private lastRespawnAt = 0;
  private readonly RESPAWN_CAP = 10;
  private readonly RESPAWN_WINDOW_MS = 60_000;
  private readonly RESPAWN_DELAY_MS = 2_000;

  constructor(private readonly heartbeat: WorkerHeartbeatService) {}

  onModuleInit(): void {
    void this.ensureWorker();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    // 优雅停机：后端「拥有」该 worker，停机时一并结束（SIGKILL 场景由 detached 保证 worker 存活，
    // 新后端启动会检测到存活 worker 而不重复拉起）。
    if (this.child && !this.child.killed) {
      this.logger.log('后端停止，结束托管的 worker 子进程');
      this.child.kill('SIGTERM');
    }
  }

  /** 初始拉起：先看是否已有存活 worker，避免后端重启时产生第二个实例。 */
  private async ensureWorker(): Promise<void> {
    try {
      const p = await this.heartbeat.active();
      if (p.count > 0) {
        this.logger.log(`检测到已有存活 worker（${p.workers.join(', ')}），本次不重复拉起`);
        return;
      }
    } catch (e) {
      this.logger.warn(`查询 worker 心跳失败，仍尝试拉起：${(e as Error).message}`);
    }
    if (this.child && !this.child.killed) return;
    this.spawnOnce();
  }

  /** 向上回溯定位 api 根目录（dist/src/main-worker.js 作为锚点）。 */
  private resolveApiRoot(): string {
    const marker = path.join('dist', 'src', 'main-worker.js');
    if (fs.existsSync(path.join(process.cwd(), marker))) return process.cwd();
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return process.cwd();
  }

  /** 真正拉起一次 worker 子进程。 */
  private spawnOnce(): void {
    const apiRoot = this.resolveApiRoot();
    const workerPath = path.join(apiRoot, 'dist', 'src', 'main-worker.js');
    if (!fs.existsSync(workerPath)) {
      this.logger.error(`未找到 ${workerPath}，请先 pnpm build:api；本次跳过 worker 拉起`);
      return;
    }
    const logDir = path.join(apiRoot, 'runtime', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'worker.log');
    // 直接拿 fd 透传给孩子进程（避免 WriteStream.fd 的类型与生命周期问题），追加模式。
    const logFd = fs.openSync(logPath, 'a');

    const child = spawn(process.execPath, [workerPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    this.child = child;
    this.logger.log(`已拉起 worker 子进程(pid=${child.pid})，日志 → ${logPath}`);

    child.on('error', (err) => {
      this.logger.error(`worker 子进程启动失败：${err.message}`);
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      // 清掉崩溃 worker 的残留心跳行（优雅退出时 worker 自己已 release，这里兜底），
      // 让 health 面板不会在 25s 窗口内显示幽灵「在线」。
      void this.heartbeat
        .release(`${os.hostname()}-${child.pid}`)
        .catch(() => undefined);
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
      if (this.stopping) return;
      this.logger.warn(`worker 子进程退出(code=${code}, signal=${signal})，准备自动重启`);
      this.scheduleRespawn();
    });
    child.unref();
  }

  /** 退出后的退避重启，带防雪崩上限。 */
  private scheduleRespawn(): void {
    const now = Date.now();
    if (now - this.lastRespawnAt > this.RESPAWN_WINDOW_MS) this.respawns = 0;
    this.lastRespawnAt = now;
    this.respawns += 1;
    if (this.respawns > this.RESPAWN_CAP) {
      this.logger.error(
        `worker 在 ${this.RESPAWN_WINDOW_MS / 1000}s 内退出 ${this.respawns} 次，停止自动重启以免雪崩；请排查 worker.log`,
      );
      return;
    }
    setTimeout(() => {
      if (this.stopping) return;
      if (this.child && !this.child.killed) return;
      this.spawnOnce();
    }, this.RESPAWN_DELAY_MS);
  }
}
