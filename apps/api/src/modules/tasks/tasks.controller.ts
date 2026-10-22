import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import * as path from 'path';
import { IsArray, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JobQueueService, HistoryEntry } from '../jobs/job-queue.service';
import { TaskRunnerService } from './task-runner.service';
import { TaskRegistryService } from './task-registry.service';

class RunItemDto {
  @IsString()
  task_id!: string;

  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;
}

class RunTaskDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RunItemDto)
  items!: RunItemDto[];
}

type Row = Record<string, unknown>;

/**
 * 任务中心 REST（前端契约保持不变）。
 *
 * 2026-10-22：执行已迁到独立 worker（PG 任务队列）。本控制器只负责「下发任务 + 读 PG 状态/日志/产物」，
 * 不再持有执行能力。实时日志由前端轮询 /api/log（worker 增量写盘）保证；状态徽标由
 * TaskEventMirrorService 从 PG 重发 SSE 保证。
 */
@Controller('api')
export class TasksController {
  constructor(
    private readonly jobQueue: JobQueueService,
    private readonly runner: TaskRunnerService,
    private readonly registry: TaskRegistryService,
  ) {}

  @Post('run')
  async run(@Body() body: RunTaskDto) {
    if (!body.items || body.items.length !== 1) {
      return { ok: false, error: '每次仅支持执行一个任务' };
    }
    const item = body.items[0];
    const task = this.registry.get(item.task_id);
    if (!task) return { ok: false, error: '任务不存在或未实现' };
    const ids = await this.jobQueue.enqueue([
      {
        task_id: item.task_id,
        args: item.args,
        timeout: Number(task.timeout) || 0,
        source: 'manual',
        name: task.name,
        group: (task.group as string) || '',
      },
    ]);
    return { ok: true, run_ids: ids };
  }

  @Post('stop')
  async stop() {
    const stopped = await this.jobQueue.stopAll();
    return { ok: true, stopped };
  }

  @Post('cancel')
  async cancel(@Body() b: { run_id?: string }) {
    const ok = b.run_id ? await this.jobQueue.cancelQueued(b.run_id) : false;
    return { ok };
  }

  @Get('state')
  async state() {
    // registry（groups + tasks）必须与 snapshot 一起下发：前端读的是
    // s.registry.groups / s.registry.tasks，缺了它任务中心就是空的。
    const { current, queue } = await this.jobQueue.currentAndQueue();
    const recent = await this.jobQueue.listRecent(60);
    const current_lines = current
      ? (await this.jobQueue.getLog(String(current['id'])) || []).slice(-5000)
      : null;
    const last: Record<string, HistoryEntry | null> = {};
    for (const tid of this.registry.taskIds()) {
      last[tid] = recent.find((h) => h.task_id === tid) || null;
    }
    return {
      ok: true,
      current: current ? this.toRun(current) : null,
      queue: queue.map((q) => ({
        runId: String(q['id']),
        taskId: String(q['task_id']),
        name: String(q['name'] || ''),
      })),
      history: recent,
      current_lines,
      queued_ids: queue.map((q) => String(q['task_id'])),
      last,
      registry: this.registry.view(),
    };
  }

  @Get('history')
  async history() {
    return { ok: true, history: await this.jobQueue.listRecent(60) };
  }

  @Get('log')
  async log(@Query('run_id') runId: string, @Res() res: Response): Promise<void> {
    // 与单体一致：查不到是 404，不是「200 + ok:false」。
    const row = await this.jobQueue.getJob(runId);
    if (!row) {
      res.status(404).json({ ok: false, error: '未找到该运行记录' });
      return;
    }
    const lines = (await this.jobQueue.getLog(runId)) || [];
    res.json({
      ok: true,
      run_id: runId,
      lines,
      status: row['status'],
      task_id: row['task_id'],
      name: row['name'],
      error_kind: row['error_kind'],
      error_advice: row['error_advice'],
    });
  }

  /** 下载运行日志（纯文本，供浏览器直接跳转下载）。 */
  @Get('download')
  async download(@Query('run_id') runId: string, @Res() res: Response): Promise<void> {
    const lines = (await this.jobQueue.getLog(runId)) || [];
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(lines.join('\n'));
  }

  /** 列举运行产物（file:read 权限由 AccessGuard 裁决）。 */
  @Get('files')
  async files(@Query('task_id') taskId?: string) {
    // task_id 要回显：单体如此，前端也按它显示当前筛选的任务
    return { ok: true, task_id: taskId || '', files: await this.runner.listArtifacts(taskId) };
  }

  /** 产物预览 / 下载。 */
  @Get('file')
  file(@Query('path') p: string, @Res() res: Response): void {
    if (!p) {
      res.status(400).type('text/plain; charset=utf-8').send('缺少 path');
      return;
    }
    const r = this.runner.readArtifact(p);
    if (!r) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', r.ctype);
    const fname = encodeURIComponent(path.basename(r.abs));
    res.setHeader(
      'Content-Disposition',
      `${r.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${fname}`,
    );
    res.sendFile(r.abs);
  }

  private toRun(row: Row): Record<string, unknown> {
    return {
      runId: String(row['id']),
      taskId: String(row['task_id']),
      name: String(row['name'] || ''),
      status: String(row['status']),
      cmd: '',
      lines: [],
    };
  }
}
