import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import * as path from 'path';
import { IsArray, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { TaskRunnerService, HistoryEntry } from './task-runner.service';
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

@Controller('api')
export class TasksController {
  constructor(
    private readonly runner: TaskRunnerService,
    private readonly registry: TaskRegistryService,
  ) {}

  @Post('run')
  run(@Body() body: RunTaskDto) {
    if (!body.items || body.items.length !== 1) {
      return { ok: false, error: '每次仅支持执行一个任务' };
    }
    const ids = this.runner.enqueue(body.items);
    return { ok: true, run_ids: ids };
  }

  @Post('stop')
  stop() {
    return { ok: true, stopped: this.runner.stopCurrent() };
  }

  @Post('cancel')
  cancel(@Body() b: { run_id?: string }) {
    return { ok: this.runner.cancelQueued(b.run_id) };
  }

  @Get('state')
  state() {
    // registry（groups + tasks）必须与 snapshot 一起下发：前端读的是
    // s.registry.groups / s.registry.tasks，缺了它任务中心就是空的。
    const snap = this.runner.snapshot();
    // 补齐前端按单体契约消费的三个字段（main.js 读 s.current_lines / s.last / s.queued_ids）：
    //  · current_lines  当前任务已有的日志行 —— 页面刷新 / 断线重连后补回丢失的输出
    //  · last           每个任务最近一次运行记录（任务卡片的「上次运行」）
    //  · queued_ids     队列中的任务 id 列表
    // 缺了它们不会报错，只会「静默少东西」，只有跨实现比对才看得出来。
    const last: Record<string, HistoryEntry | null> = {};
    for (const tid of this.registry.taskIds()) {
      last[tid] = snap.history.find((h) => h.task_id === tid) || null;
    }
    return {
      ok: true,
      ...snap,
      current_lines: snap.current
        ? (this.runner.runLog(snap.current.runId) || []).slice(-5000)
        : null,
      queued_ids: snap.queue.map((q) => q.taskId),
      last,
      registry: this.registry.view(),
    };
  }

  @Get('history')
  history() {
    return { ok: true, history: this.runner.historySlice() };
  }

  @Get('log')
  log(@Query('run_id') runId: string, @Res() res: Response): void {
    // 与单体一致：查不到是 404，不是「200 + ok:false」。
    const lines = this.runner.runLog(runId);
    if (!lines) {
      res.status(404).json({ ok: false, error: '未找到该运行记录' });
      return;
    }
    res.json({ ok: true, run_id: runId, lines });
  }

  /** 下载运行日志。
   *  必须与单体一致下发**纯文本**：前端是 `window.location.href =
   *  /api/download?run_id=...` 直接跳转（main.js），返回 {ok,run_id,text} 的 JSON
   *  会让用户拿到一段 JSON 而不是日志内容。 */
  @Get('download')
  download(@Query('run_id') runId: string, @Res() res: Response): void {
    const lines = this.runner.runLog(runId) || [];
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(lines.join('\n'));
  }

  /** 列举运行产物（file:read 权限由 AccessGuard 裁决）。 */
  @Get('files')
  files(@Query('task_id') taskId?: string) {
    // task_id 要回显：单体如此，前端也按它显示当前筛选的任务
    return { ok: true, task_id: taskId || '', files: this.runner.listArtifacts(taskId) };
  }

  /** 产物预览 / 下载：图片与文本/HTML 走 inline（浏览器直接看，iframe/img 才能渲染），
   *  其余类型用 attachment 触发下载。此前一律 res.download()，导致 iframe 预览 HTML
   *  变成「下载文件」、<img> 也加载不出来。 */
  @Get('file')
  file(@Query('path') p: string, @Res() res: Response): void {
    // 与单体一致：缺 path 是「参数错误」400，而不是「资源不存在」404
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
    // 文件名走 RFC 5987，避免中文文件名乱码
    const fname = encodeURIComponent(path.basename(r.abs));
    res.setHeader(
      'Content-Disposition',
      `${r.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${fname}`,
    );
    res.sendFile(r.abs);
  }
}
