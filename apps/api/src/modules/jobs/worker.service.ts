import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import * as os from 'os';
import { JobQueueService } from './job-queue.service';
import { TaskExecutorService } from './task-executor.service';

/**
 * 任务执行 worker（独立进程）。
 *
 * 只做一件事：周期性地从 PG 抢占一个 queued 任务 → 交给 TaskExecutorService 执行，
 * 全程串行（一次一个），避免 aeolus cookie 并发争抢。抢占是原子的，因此可水平起多个
 * worker 实例；崩溃的任务由 recoverStale 自动退回队列重跑。
 */
@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  private readonly workerId = `${os.hostname()}-${process.pid}`;
  private readonly pollMs = 1000;
  private readonly recoverMs = 30_000;
  private stopFlag = false;
  private tickTimer: NodeJS.Timeout | undefined;
  private recoverTimer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private readonly jobQueue: JobQueueService,
    private readonly executor: TaskExecutorService,
  ) {}

  onModuleInit(): void {
    this.logger.log(`worker 启动（id=${this.workerId}），开始抢占任务`);
    this.scheduleTick();
    this.recoverTimer = setInterval(() => void this.recover(), this.recoverMs);
    void this.recover();
  }

  onModuleDestroy(): void {
    this.stopFlag = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.recoverTimer) clearInterval(this.recoverTimer);
    this.logger.log('worker 正在停止（不再抢占新任务，进行中的任务将由其自行结束）');
  }

  private scheduleTick(): void {
    if (this.stopFlag) return;
    this.tickTimer = setTimeout(() => void this.tick(), this.pollMs);
  }

  private async tick(): Promise<void> {
    if (this.stopFlag) return;
    try {
      if (!this.busy) {
        const job = await this.jobQueue.claim(this.workerId);
        if (job) {
          this.busy = true;
          try {
            await this.executor.run(job);
          } catch (e) {
            this.logger.error(`执行异常：${(e as Error).message}`);
          } finally {
            this.busy = false;
          }
        }
      }
    } catch (e) {
      this.logger.error(`抢占循环异常：${(e as Error).message}`);
    } finally {
      this.scheduleTick();
    }
  }

  private async recover(): Promise<void> {
    try {
      const n = await this.jobQueue.recoverStale();
      if (n > 0) this.logger.warn(`回收 ${n} 个陈旧 running 任务，已退回队列重跑`);
    } catch (e) {
      this.logger.error(`回收异常：${(e as Error).message}`);
    }
  }
}
