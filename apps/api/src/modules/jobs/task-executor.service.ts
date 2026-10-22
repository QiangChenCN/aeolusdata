import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import { TaskHandlersService } from '../tasks/task-handlers.service';
import { TaskRegistryService, TaskDef } from '../tasks/task-registry.service';
import { TaskHandler, TaskStop } from '../tasks/task-handler';
import { parseRange, pickRange } from '../tasks/pipeline';
import { JobQueueService, JobStatus } from './job-queue.service';
import { diagnose } from '../tasks/diagnostics.util';

type Row = Record<string, unknown>;

/**
 * 任务执行核心（从旧 TaskRunnerService.executeNative 抽取）。
 *
 * 只负责「拿到一个 job → 跑它的原生流水线 → 落盘日志 → 回报状态」，
 * 不持有队列、不持有全量运行内存态、不向 SSE 广播（SSE 由 API 侧镜像器从 PG 重发）。
 *
 * 不变量（与旧实现一致）：
 *  · 全局串行由 worker 的抢占循环保证（一次只 claim 一个）；
 *  · 终止为协作式：经 ctx.isStopped() 读取 PG 的 stop_requested，由处理器自行退出；
 *  · 日志增量写盘（<log_path>），使 API 侧 /api/log 轮询能看到实时进度。
 */
@Injectable()
export class TaskExecutorService {
  private readonly logger = new Logger(TaskExecutorService.name);

  constructor(
    private readonly handlers: TaskHandlersService,
    private readonly registry: TaskRegistryService,
    private readonly jobQueue: JobQueueService,
  ) {}

  async run(job: Row): Promise<void> {
    const runId = String(job['id']);
    const taskId = String(job['task_id']);
    const task: TaskDef | undefined = this.registry.get(taskId);
    const name = String(job['name'] || task?.name || taskId);
    const group = String(job['group'] || (task?.group as string) || '');
    const logPath: string = String(job['log_path'] || '');

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(String(job['args_json'] || '{}'));
    } catch {
      args = {};
    }

    const timeout = Number(
      job['timeout_sec'] && Number(job['timeout_sec']) > 0
        ? job['timeout_sec']
        : (task?.timeout ?? 600),
    );

    const lines: string[] = [];
    const append = (line: string): void => {
      lines.push(line);
      if (logPath) {
        try {
          fs.appendFileSync(logPath, line + '\n');
        } catch {
          /* ignore */
        }
      }
    };

    const startedAt = String(job['started_at'] || this.iso());
    let timer: NodeJS.Timeout | undefined;
    let hb: NodeJS.Timeout | undefined;
    // 协作式停止：本地缓存标志（保持 TaskRunContext.isStopped 的同步契约），
    // 由定时器从 PG 读取 stop_requested 刷新（≤1s 延迟）。超时也会置位。
    let stopped = false;
    let stopChk: NodeJS.Timeout | undefined;
    try {
      const handler: TaskHandler | undefined = this.handlers.get(taskId);
      if (!handler) {
        append(`[错误] 任务「${name}」尚未实现为 Nest 原生流水线（无对应处理器）。`);
        await this.finish(runId, 'failed', -1, '未实现',
          `任务 ${taskId} 尚未实现为 Nest 原生流水线`, lines, append, startedAt);
        return;
      }

      append(`[开始] ${name}`);
      // 区间校验（与旧实现同语义：非法区间直接失败，宁可非零退出）
      if (handler.stages?.length) {
        const [b, e] = parseRange(args);
        pickRange(
          handler.stages.map((s) => s.id),
          b,
          e,
        );
      }

      hb = setInterval(() => {
        void this.jobQueue.heartbeat(runId);
      }, 5000);
      stopChk = setInterval(() => {
        void this.jobQueue.isStopRequested(runId).then((v) => {
          if (v) stopped = true;
        });
      }, 1000);

      await Promise.race([
        handler.run({
          runId,
          taskId,
          name,
          group,
          args,
          log: append,
          isStopped: () => stopped,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.jobQueue.requestStop(runId);
            reject(new Error(`超过 ${timeout} 秒未完成`));
          }, timeout * 1000);
        }),
      ]);

      await this.finish(runId, 'success', 0, null, null, lines, append, startedAt);
    } catch (err) {
      if (err instanceof TaskStop) {
        append(`[结束] ${err.message}`);
        await this.finish(runId, 'success', 0, null, null, lines, append, startedAt,
          err.message);
        return;
      }
      const timeoutHit = (err as Error).message.includes('秒未完成');
      const d = diagnose(lines.join('\n'), 1);
      const msg = timeoutHit ? `执行超时（${timeout}s）` : (err as Error).message;
      await this.finish(runId, 'failed', 1, d.kind, d.advice, lines, append, startedAt,
        msg, timeoutHit);
    } finally {
      if (timer) clearTimeout(timer);
      if (hb) clearInterval(hb);
      if (stopChk) clearInterval(stopChk);
    }
  }

  private iso(): string {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }

  private async finish(
    runId: string,
    status: JobStatus,
    exitCode: number,
    errorKind: string | null,
    errorAdvice: string | null,
    lines: string[],
    append: (line: string) => void,
    startedAt: string,
    message?: string,
    timeoutHit?: boolean,
  ): Promise<void> {
    if (status === 'failed') {
      append('');
      append(`✗ 失败（退出码 ${exitCode}）｜诊断：${errorKind}`);
      append(`  建议：${errorAdvice}`);
    } else {
      const dur = this.durationSec(startedAt);
      append('');
      append(`✓ 完成（退出码 0，耗时 ${dur} 秒）`);
    }
    await this.jobQueue.markFinished(runId, {
      status,
      exitCode,
      message: message || '',
      errorKind,
      errorAdvice,
    });
  }

  private durationSec(startedAt: string): string {
    const s = new Date(startedAt.replace(' ', 'T') + 'Z').getTime();
    if (isNaN(s)) return '0.0';
    return (Math.round((Date.now() - s) / 100) / 10).toString();
  }
}
