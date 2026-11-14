import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { StreamingService } from '../streaming/streaming.service';
import { JobQueueService, JobStatus } from './job-queue.service';

const TERMINAL: JobStatus[] = ['success', 'failed', 'stopped', 'cancelled'];

/**
 * API 侧 SSE 镜像器：worker 在独立进程执行，其状态只落在 PG。
 * 本服务周期性轮询 PG 的 task_job，把「运行态变化」重发为前端期望的 SSE 事件
 * （run_start / run_end / queue / history），使前端零改动地继续工作。
 *
 * 注意：实时日志行不在此重发 —— 前端 LogDialog 本就每 700ms 轮询 /api/log（读盘），
 * 而 worker 增量写盘，故日志实时性已由轮询保证。
 */
@Injectable()
export class TaskEventMirrorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskEventMirrorService.name);
  private readonly intervalMs = 1000;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastStatus = new Map<string, JobStatus>();
  private lastRunningId: string | null = null;
  private lastQueueSig = '';
  private lastHistorySig = '';
  private logByte = new Map<string, number>();

  constructor(
    private readonly jobQueue: JobQueueService,
    private readonly streaming: StreamingService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    if (this.running) return; // 避免上轮未结束时重叠
    this.running = true;
    try {
      const { current, queue } = await this.jobQueue.currentAndQueue();

      // 当前运行：新出现的 running 任务 → run_start
      const runningId = current ? String(current['id']) : null;
      if (this.lastRunningId && this.lastRunningId !== runningId) {
        this.logByte.delete(this.lastRunningId); // 上一任务已结束，清增量游标
      }
      if (runningId && runningId !== this.lastRunningId) {
        this.streaming.emit({
          type: 'run_start',
          run: {
            runId: runningId,
            taskId: String(current!['task_id']),
            name: String(current!['name'] || ''),
            status: 'running',
            lines: [],
          },
        });
      }
      this.lastRunningId = runningId;

      // 实时日志：对当前 running 任务增量转发 log 事件（与旧系统 SSE 行为一致；
      // 前端 LogDialog 另有 700ms 轮询 /api/log 兜底，二者不冲突）。
      if (runningId) {
        const { lines, nextByte } = await this.jobQueue.tailLog(
          runningId,
          this.logByte.get(runningId) || 0,
        );
        this.logByte.set(runningId, nextByte);
        for (const line of lines) {
          this.streaming.emit({
            type: 'log',
            run_id: runningId,
            line,
            ts: new Date().toISOString(),
          });
        }
      }

      // 排队集合变化 → queue
      const sig = queue.map((q) => String(q['id'])).join(',');
      if (sig !== this.lastQueueSig) {
        this.streaming.emit({
          type: 'queue',
          queue: queue.map((q) => ({
            runId: String(q['id']),
            taskId: String(q['task_id']),
            name: String(q['name'] || ''),
          })),
        });
        this.lastQueueSig = sig;
      }

      // 终态任务 → run_end + 必要时 history
      const recent = await this.jobQueue.listRecent(60);
      for (const h of recent) {
        const id = h.run_id;
        const prev = this.lastStatus.get(id);
        if (TERMINAL.includes(h.status) && prev !== h.status) {
          this.streaming.emit({
            type: 'run_end',
            run: {
              runId: id,
              taskId: h.task_id,
              status: h.status,
              errorKind: h.error_kind || null,
              errorAdvice: h.error_advice || null,
            },
          });
        }
        this.lastStatus.set(id, h.status);
      }
      // 历史签名（id+status）变化即推送：覆盖「任务跑完」与「运行记录被删除」两类变化
      const histSig = recent.map((h) => `${h.run_id}:${h.status}`).join(',');
      if (histSig !== this.lastHistorySig) {
        this.streaming.emit({ type: 'history', history: recent });
        this.lastHistorySig = histSig;
      }
    } catch (e) {
      // 轮询失败不打断主循环
      this.logger.debug(`镜像轮询异常（忽略）：${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
