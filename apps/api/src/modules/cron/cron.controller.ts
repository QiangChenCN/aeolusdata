import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { TaskRegistryService } from '../tasks/task-registry.service';
import { StreamingService } from '../streaming/streaming.service';
import {
  CronStoreService, CATCHUP_GRACE_SEC, MAX_ATTEMPTS,
} from './cron-store.service';
import { CronSchedulerService } from './cron-scheduler.service';

type Row = Record<string, unknown>;

/** 工作内容（提醒事项）API（移植自 server.py 的 _get_todo / _post_todo_* 处理函数）。 */
@Controller('api')
export class CronController {
  constructor(
    private readonly store: CronStoreService,
    private readonly registry: TaskRegistryService,
    private readonly scheduler: CronSchedulerService,
    private readonly streaming: StreamingService,
  ) {}

  @Get('cron')
  async getCron() {
    const items = await this.store.listItems();
    const itemOuts = await Promise.all(
      items.map(async (it) =>
        this.store.apiItem(
          it,
          it['task_id'] ? this.registry.linkState(String(it['task_id'])) : '',
          !!(await this.store.openRunOf(String(it['id']))),
        ),
      ),
    );
    const lists = (await this.store.listLists()).map((l) => this.store.apiList(l));
    return {
      ok: true,
      cron: {
        lists,
        items: itemOuts,
        scheduler: {
          running: this.scheduler.isAlive(),
          catchup_grace_min: CATCHUP_GRACE_SEC / 60,
          max_attempts: MAX_ATTEMPTS,
          auto_paused: (await this.store.getMeta('auto_paused', '0')) === '1',
        },
      },
    };
  }

  @Get('cron/runs')
  async getRuns(@Query('item_id') itemId = '', @Query('limit') limit = '20') {
    const lim = Math.max(1, Math.min(50, parseInt(limit, 10) || 20));
    return { ok: true, runs: await this.store.itemRuns(itemId, lim) };
  }

  @Post('cron/lists')
  async postLists(@Body() data: Record<string, unknown>) {
    const op = data['op'];
    try {
      if (op === 'create') {
        const r = await this.store.createList(
          (String(data['name'] || '').trim()) || '新列表',
          (data['icon'] as string) || 'list-checks',
          (data['color'] as string) || '#FF5000',
        );
        this.broadcast();
        return { ok: true, list: r };
      }
      if (op === 'update') {
        const r = await this.store.updateList(String(data['id']), {
          name: data['name'], icon: data['icon'], color: data['color'],
        });
        this.broadcast();
        return { ok: !!r, list: r };
      }
      if (op === 'delete') {
        const [ok, msg] = await this.store.deleteList(String(data['id']));
        if (ok) this.broadcast();
        return { ok, error: ok ? null : msg };
      }
      return { ok: false, error: '未知操作' };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  @Post('cron/items')
  async postItems(@Body() data: Record<string, unknown>) {
    const op = data['op'];
    try {
      if (op === 'create') {
        const lid = (data['list_id'] as string) || (await this.defaultList());
        const r = await this.store.createItem(
          String(data['title'] || '').trim(),
          lid,
          (data['note'] as string) || '',
          (data['remind_at'] as string) || '',
          data['flag'] as number,
          data['repeat'],
          (data['task_id'] as string) || '',
          data['auto_run'] as number,
          data['task_args'],
          (data['remind_times'] as string[]) || [],
          Number(data['timeout']) || 0,
          data['queue_run'] as number,
          (data['start_date'] as string) || '',
        );
        this.broadcast();
        return { ok: true, item: await this.itemOut(r) };
      }
      if (op === 'update') {
        if (!data['id']) return { ok: false, error: '缺少 id' };
        const kw: Record<string, unknown> = {};
        for (const k of ['title', 'note', 'remind_at', 'list_id', 'task_id', 'task_args',
          'auto_run', 'flag', 'status', 'remind_times', 'timeout', 'queue_run', 'start_date']) {
          if (k in data) kw[k] = data[k];
        }
        // task_args 以 JSON 文本落库（前端传对象，这里统一序列化，pg 驱动才不会按其默认规则序列化）
        if ('task_args' in kw) kw['task_args'] = JSON.stringify(kw['task_args'] || {});
        if ('repeat' in data) kw['repeat'] = data['repeat'];
        const r = await this.store.updateItem(String(data['id']), kw);
        this.broadcast();
        return { ok: !!r, item: await this.itemOut(r) };
      }
      if (op === 'toggle') {
        const r = await this.store.setDone(String(data['id']), !!data['done']);
        this.broadcast();
        return { ok: !!r, item: await this.itemOut(r) };
      }
      if (op === 'delete') {
        const ok = await this.store.deleteItem(String(data['id']));
        this.broadcast();
        return { ok };
      }
      if (op === 'unlink') {
        const r = await this.store.unlinkTask(String(data['id']));
        this.broadcast();
        return { ok: !!r, item: await this.itemOut(r) };
      }
      return { ok: false, error: '未知操作' };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  @Post('cron/trigger')
  async postTrigger(@Body() data: Record<string, unknown>) {
    const [ok, msg] = await this.scheduler.triggerNow(String(data['item_id']));
    return { ok, error: ok ? null : msg };
  }

  @Post('cron/import')
  async postImport(@Body() data: Record<string, unknown>) {
    try {
      const [lists, items] = await this.store.importPayload(data);
      return { ok: true, lists, items };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 全局「自动执行」总开关：paused=true 暂停所有自动任务的点火与重试，false 恢复。 */
  @Post('cron/auto-paused')
  async postAutoPaused(@Body() data: Record<string, unknown>) {
    const paused = !!data['paused'];
    await this.store.setMeta('auto_paused', paused ? '1' : '0');
    this.broadcast();
    return { ok: true, paused };
  }

  private async itemOut(row: Row | null): Promise<Row | null> {
    if (!row) return null;
    return this.store.apiItem(
      row,
      row['task_id'] ? this.registry.linkState(String(row['task_id'])) : '',
      !!(await this.store.openRunOf(String(row['id']))),
    ) as Row;
  }

  private async defaultList(): Promise<string> {
    const ls = await this.store.listLists();
    if (ls.length) return String(ls[0]['id']);
    const created = await this.store.createList('工作');
    return created ? String(created['id']) : 'l_work';
  }

  private broadcast(): void {
    try { this.streaming.emit({ type: 'cron', event: 'changed' } as never); } catch { /* ignore */ }
  }
}
