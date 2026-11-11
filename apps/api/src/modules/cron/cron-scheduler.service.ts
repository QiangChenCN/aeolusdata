import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { JobQueueService } from '../jobs/job-queue.service';
import { TaskRegistryService } from '../tasks/task-registry.service';
import { StreamingService } from '../streaming/streaming.service';
import {
  CronStoreService,
  RUN_RUNNING, RUN_RETRYING, RUN_SUCCESS, RUN_FAILED, RUN_SKIPPED, RUN_MISSED,
  MAX_ATTEMPTS, CATCHUP_GRACE_SEC,
} from './cron-store.service';

/**
 * 自动任务定时调度器（移植自 workbench/todo_sched.py 的 TodoScheduler）。
 *
 * 每 TICK_SEC 秒扫描一次：到点把「关联了任务 + 开了自动执行」的事项丢进
 * TaskRunnerService 的串行队列跑，含三层去重、失败重试（最多 3 次 / 退避 60s/300s）、
 * 补跑宽限（15min）、重启恢复。
 *
 * 不依赖 apscheduler：同一事项同一时刻只触发一次的幂等语义落在 cron_run.fire_key
 * 的 UNIQUE 约束上（库重启后仍在），而非内存 job store。
 * 存储层已迁 PostgreSQL（异步），本服务所有相关方法均 async/await。
 */
@Injectable()
export class CronSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(CronSchedulerService.name);
  static readonly TICK_SEC = 5;
  static readonly PRUNE_EVERY = 3600;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastPrune = 0;
  private log: string[] = [];

  constructor(
    private readonly jobQueue: JobQueueService,
    private readonly registry: TaskRegistryService,
    private readonly store: CronStoreService,
    private readonly streaming: StreamingService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.initDb();
    await this.recoverOrphans();
    this.timer = setInterval(() => {
      void this.tick();
    }, CronSchedulerService.TICK_SEC * 1000);
  }

  isAlive(): boolean {
    return this.running || this.timer !== null;
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------ 主循环
  private async tick(): Promise<void> {
    try {
      await this.tickOnce();
    } catch (e) {
      this.note(`调度异常：${(e as Error).message}`);
    }
  }

  private async tickOnce(): Promise<void> {
    const now = new Date();
    await this.fireDue(now);
    await this.dispatchRetries();
    await this.pollRunning();
    if (Date.now() / 1000 - this.lastPrune > CronSchedulerService.PRUNE_EVERY) {
      try { await this.store.pruneRuns(); } catch { /* ignore */ }
      this.lastPrune = Date.now() / 1000;
    }
  }

  // ------------------------------------------------------------ 事件广播
  private emit(event: string, itemId: string | null = null, message = '', extra?: Record<string, unknown>): void {
    const payload: Record<string, unknown> = { type: 'cron', event, item_id: itemId, message };
    if (extra) Object.assign(payload, extra);
    try { this.streaming.emit(payload as never); } catch { /* ignore */ }
  }

  private note(msg: string): void {
    const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
    this.log.push(line);
    this.log = this.log.slice(-200);
    this.logger.log(msg);
  }

  // ------------------------------------------------------------ 到点触发
  private async fireDue(now: Date): Promise<void> {
    const nowStr = this.store.fmtLocal(now) || '';
    for (const item of await this.store.dueItems(nowStr)) await this.maybeFire(item, now);
  }

  private async maybeFire(item: Record<string, unknown>, now: Date): Promise<void> {
    const iid = String(item['id']);
    const due = String(item['remind_at'] || '');
    const taskId = String(item['task_id'] || '');

    const st = this.registry.linkState(taskId);
    if (st !== 'ok') {
      await this.store.markSkipped(iid, due, `关联任务${st === 'missing' ? '已不存在' : '已禁用'}，已跳过本次`);
      // 必须推进：否则重复事项的 remind_at 冻结在本次 due，findRun 永远命中这条
      // skipped 记录，事项从此静默卡死、再也不会触发（实际踩过）。
      // 重复事项推进到下次 remind_times；一次性事项无下次则置为 done。
      await this.settle(iid, false);
      this.emit('skipped', iid, `关联任务${st === 'missing' ? '已不存在' : '已禁用'}，本次未执行`);
      return;
    }
    // 全局「自动执行」主开关关闭时，静默跳过（不记 skipped，避免每个 tick 刷库）；
    // 恢复后若仍在补跑宽限内会自动补火，超窗则记为 missed（暂停不延长窗口）。
    if (await this.store.isAutoPaused()) return;
    if (await this.store.findRun(iid, due)) return; // 同一 due 本轮已处理，不重复点火
    // 排队执行：开启后不因「上一次还没跑完」而跳过，本次照常入队（TaskRunner 串行队列会排队）
    if (!item['queue_run'] && (await this.store.openRunOf(iid))) return; // 未开排队：上一次还没跑完则跳过

    const dueDt = this.store.parseDt(due);
    if (!dueDt) return;
    const late = (now.getTime() - dueDt.getTime()) / 1000;
    if (late > CATCHUP_GRACE_SEC) {
      await this.store.markMissed(iid, due, `服务未运行，已跳过本次（超出 ${CATCHUP_GRACE_SEC / 60} 分钟补跑宽限）`);
      await this.settle(iid, false);
      this.emit('missed', iid, '到点未执行：服务当时未运行，已跳过');
      return;
    }
    await this.dispatch(item, due, 1);
  }

  private async dispatch(item: Record<string, unknown>, due: string, attempt = 1): Promise<string | null> {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(String(item['task_args'] || '{}')); } catch { args = {}; }
    const taskId = String(item['task_id'] || '');
    const task = this.registry.get(taskId);
    const runIds = await this.jobQueue.enqueue([{
      task_id: taskId,
      args,
      timeout: Number(item['timeout'] || 0),
      source: 'cron',
      cronRunId: due,
      name: task?.name ?? taskId,
      group: (task?.group as string) || '',
    }]);
    if (!runIds.length) {
      await this.store.markSkipped(String(item['id']), due, '任务入队失败（任务可能已被移除）');
      return null;
    }
    try {
      await this.store.claimRun(String(item['id']), due, runIds[0], attempt);
    } catch {
      return null; // 被并发抢先，安静放弃
    }
    this.note(`触发「${item['title']}」→ 任务 ${taskId}（第 ${attempt} 次）`);
    this.emit('fired', String(item['id']), `已触发：${item['title']}`, { run_id: runIds[0] });
    return runIds[0];
  }

  // ------------------------------------------------------------ 重试
  private async dispatchRetries(): Promise<void> {
    if (await this.store.isAutoPaused()) return; // 全局暂停时连同重试一起挂起
    for (const r of await this.store.retryDue()) {
      const item = await this.store.getItem(String(r['item_id']));
      if (!item || !item['task_id']) {
        await this.store.finishRun(String(r['item_id']), String(r['due_at']), RUN_FAILED, '事项或关联任务已不存在');
        continue;
      }
      const st = this.registry.linkState(String(item['task_id']));
      if (st !== 'ok') {
        await this.store.finishRun(String(r['item_id']), String(r['due_at']), RUN_SKIPPED,
          `重试时关联任务${st === 'missing' ? '已不存在' : '已禁用'}`);
        await this.settle(String(r['item_id']), false);
        continue;
      }
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(String(item['task_args'] || '{}')); } catch { args = {}; }
      const task = this.registry.get(String(item['task_id']));
      const runIds = await this.jobQueue.enqueue([{
        task_id: String(item['task_id']),
        args,
        source: 'cron',
        cronRunId: String(r['due_at']),
        name: task?.name ?? String(item['task_id']),
        group: (task?.group as string) || '',
      }]);
      if (!runIds.length) continue; // 入队失败，下个 tick 再试
      await this.store.markDispatched(String(r['item_id']), String(r['due_at']), runIds[0], Number(r['attempt']));
      this.note(`重试「${item['title']}」第 ${r['attempt']} 次`);
      this.emit('retried', String(r['item_id']), `第 ${r['attempt']} 次重试：${item['title']}`,
        { run_id: runIds[0] });
    }
  }

  // ------------------------------------------------------------ 结果回收
  private async pollRunning(): Promise<void> {
    for (const r of await this.store.openRuns()) {
      if (r['status'] === RUN_RETRYING) continue; // 由 dispatchRetries 管
      const st = await this.jobQueue.getStatus(String(r['run_id']));
      if (!st) continue; // 还没派到 / 已丢失
      const status = String(st['status']);
      if (status === 'queued' || status === 'running') continue;

      const iid = String(r['item_id']);
      const due = String(r['due_at']);
      if (status === 'success') {
        await this.store.finishRun(iid, due, RUN_SUCCESS, '执行成功');
        await this.store.settleSuccess(iid);
        this.note(`「${await this.itemTitle(iid)}」执行成功`);
        this.emit('succeeded', iid, '执行成功');
        continue;
      }
      if (status === 'stopped') {
        await this.store.finishRun(iid, due, RUN_FAILED, '已被手动终止，不再自动重试');
        await this.settle(iid, false);
        this.emit('failed', iid, '执行被手动终止');
        continue;
      }
      // 失败 / 超时
      const attempt = Number(r['attempt']);
      if (attempt < MAX_ATTEMPTS) {
        await this.store.scheduleRetry(iid, due, attempt + 1,
          `第 ${attempt} 次失败（退出码 ${st['exit_code']}），${this.store.retryDelayFor(attempt)} 秒后重试`);
        this.emit('retrying', iid, `执行失败，${this.store.retryDelayFor(attempt)} 秒后第 ${attempt + 1} 次重试`);
      } else {
        await this.store.finishRun(iid, due, RUN_FAILED,
          `已重试 ${MAX_ATTEMPTS - 1} 次仍失败（退出码 ${st['exit_code']}）`);
        await this.settle(iid, false);
        this.emit('failed', iid, `重试 ${MAX_ATTEMPTS - 1} 次仍失败，已跳过本次`);
      }
    }
  }

  private async settle(iid: string, success: boolean): Promise<void> {
    try {
      if (success) await this.store.settleSuccess(iid);
      else await this.store.advanceAfterRun(iid);
    } catch (e) {
      this.note(`推进事项失败：${(e as Error).message}`);
    }
  }

  private async itemTitle(iid: string): Promise<string> {
    const it = await this.store.getItem(iid);
    return (it && String(it['title'])) || iid;
  }

  // ------------------------------------------------------------ 启动恢复
  private async recoverOrphans(): Promise<void> {
    const now = new Date();
    for (const r of await this.store.openRuns()) {
      // 任务已落 PG 队列表（task_job）：只要 job 还在（无论 running/queued/终态），
      // 就交给 worker / pollRunning 处理，不要再当孤儿重排，避免与 worker 重复执行。
      const job = await this.jobQueue.getStatus(String(r['run_id']));
      if (job) continue;

      const item = await this.store.getItem(String(r['item_id']));
      const title = await this.itemTitle(String(r['item_id']));
      const taskId = item && String(item['task_id'] || '');
      if (item && taskId && this.registry.linkState(taskId) === 'ok') {
        const dueDt = this.store.parseDt(String(r['due_at']));
        const late = dueDt ? (now.getTime() - dueDt.getTime()) / 1000 : 1e9;
        const attempt = Number(r['attempt']);
        if (attempt < MAX_ATTEMPTS && late <= CATCHUP_GRACE_SEC) {
          await this.store.scheduleRetry(String(r['item_id']), String(r['due_at']), attempt + 1,
            `服务重启，补跑第 ${attempt + 1} 次`);
          this.note(`重启恢复：补跑「${title}」第 ${attempt + 1} 次`);
          continue;
        }
      }
      await this.store.finishRun(String(r['item_id']), String(r['due_at']), RUN_FAILED, '服务重启，上次执行中断');
      await this.settle(String(r['item_id']), false);
      this.note(`重启恢复：中断的执行已收尾 —— ${title}`);
    }
    this.emit('recovered', null, '调度器已启动，待执行项已恢复');
  }

  // ------------------------------------------------------------ 手动触发
  async triggerNow(itemId: string): Promise<[boolean, string]> {
    const item = await this.store.getItem(itemId);
    if (!item) return [false, '事项不存在'];
    if (!item['task_id']) return [false, '这个事项没有关联任务'];
    const st = this.registry.linkState(String(item['task_id']));
    if (st !== 'ok') return [false, `关联任务${st === 'missing' ? '已不存在' : '已禁用'}，无法执行`];
    if (!item['queue_run'] && (await this.store.openRunOf(itemId))) return [false, '上一次执行还没结束，稍等再试'];

    const due = 'manual:' + (this.store.fmtLocal(new Date()) || '');
    if (await this.store.findRun(itemId, due)) return [false, '刚刚已经触发过了，一分钟后再试'];

    const runId = await this.dispatch(item, due, 1);
    if (!runId) return [false, '入队失败，请重试'];
    return [true, '已触发执行'];
  }

  /** 诊断用：最近调度日志。 */
  recentLog(): string[] {
    return this.log.slice(-50);
  }
}
