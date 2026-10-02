import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { TaskRegistryService } from '../tasks/task-registry.service';
import { StreamingService } from '../streaming/streaming.service';
import {
  TodoStoreService, CATCHUP_GRACE_SEC, MAX_ATTEMPTS,
} from './todo-store.service';
import { TodoSchedulerService } from './scheduler.service';

type Row = Record<string, unknown>;

/** 工作内容（提醒事项）API（移植自 server.py 的 _get_todo / _post_todo_* 处理函数）。 */
@Controller('api')
export class TodoController {
  constructor(
    private readonly store: TodoStoreService,
    private readonly registry: TaskRegistryService,
    private readonly scheduler: TodoSchedulerService,
    private readonly streaming: StreamingService,
  ) {}

  @Get('todo')
  getTodo() {
    const items = this.store.listItems().map((it) =>
      this.store.apiItem(
        it,
        it['task_id'] ? this.registry.linkState(String(it['task_id'])) : '',
        !!this.store.openRunOf(String(it['id'])),
      ),
    );
    return {
      ok: true,
      todo: {
        lists: this.store.listLists().map((l) => this.store.apiList(l)),
        items,
        scheduler: {
          running: this.scheduler.isAlive(),
          catchup_grace_min: CATCHUP_GRACE_SEC / 60,
          max_attempts: MAX_ATTEMPTS,
        },
      },
    };
  }

  @Get('todo/runs')
  getRuns(@Query('item_id') itemId = '', @Query('limit') limit = '20') {
    const lim = Math.max(1, Math.min(50, parseInt(limit, 10) || 20));
    return { ok: true, runs: this.store.itemRuns(itemId, lim) };
  }

  @Post('todo/lists')
  postLists(@Body() data: Record<string, unknown>) {
    const op = data['op'];
    try {
      if (op === 'create') {
        const r = this.store.createList(
          (String(data['name'] || '').trim()) || '新列表',
          (data['icon'] as string) || 'list-checks',
          (data['color'] as string) || '#FF5000',
        );
        this.broadcast();
        return { ok: true, list: r };
      }
      if (op === 'update') {
        const r = this.store.updateList(String(data['id']), {
          name: data['name'], icon: data['icon'], color: data['color'],
        });
        this.broadcast();
        return { ok: !!r, list: r };
      }
      if (op === 'delete') {
        const [ok, msg] = this.store.deleteList(String(data['id']));
        if (ok) this.broadcast();
        return { ok, error: ok ? null : msg };
      }
      return { ok: false, error: '未知操作' };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  @Post('todo/items')
  postItems(@Body() data: Record<string, unknown>) {
    const op = data['op'];
    try {
      if (op === 'create') {
        const lid = (data['list_id'] as string) || this.defaultList();
        const r = this.store.createItem(
          String(data['title'] || '').trim(),
          lid,
          (data['note'] as string) || '',
          (data['remind_at'] as string) || '',
          data['flag'] as number,
          data['repeat'],
          (data['task_id'] as string) || '',
          data['auto_run'] as number,
          data['task_args'],
        );
        this.broadcast();
        return { ok: true, item: this.itemOut(r) };
      }
      if (op === 'update') {
        if (!data['id']) return { ok: false, error: '缺少 id' };
        const kw: Record<string, unknown> = {};
        for (const k of ['title', 'note', 'remind_at', 'list_id', 'task_id',
          'auto_run', 'flag', 'status']) {
          if (k in data) kw[k] = data[k];
        }
        if ('repeat' in data) kw['repeat'] = data['repeat'];
        const r = this.store.updateItem(String(data['id']), kw);
        this.broadcast();
        return { ok: !!r, item: this.itemOut(r) };
      }
      if (op === 'toggle') {
        const r = this.store.setDone(String(data['id']), !!data['done']);
        this.broadcast();
        return { ok: !!r, item: this.itemOut(r) };
      }
      if (op === 'delete') {
        const ok = this.store.deleteItem(String(data['id']));
        this.broadcast();
        return { ok };
      }
      if (op === 'unlink') {
        const r = this.store.unlinkTask(String(data['id']));
        this.broadcast();
        return { ok: !!r, item: this.itemOut(r) };
      }
      return { ok: false, error: '未知操作' };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  @Post('todo/trigger')
  postTrigger(@Body() data: Record<string, unknown>) {
    const [ok, msg] = this.scheduler.triggerNow(String(data['item_id']));
    return { ok, error: ok ? null : msg };
  }

  @Post('todo/import')
  postImport(@Body() data: Record<string, unknown>) {
    try {
      const [lists, items] = this.store.importPayload(data);
      return { ok: true, lists, items };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private itemOut(row: Row | null): Row | null {
    if (!row) return null;
    return this.store.apiItem(
      row,
      row['task_id'] ? this.registry.linkState(String(row['task_id'])) : '',
      !!this.store.openRunOf(String(row['id'])),
    ) as Row;
  }

  private defaultList(): string {
    const ls = this.store.listLists();
    if (ls.length) return String(ls[0]['id']);
    const created = this.store.createList('工作');
    return created ? String(created['id']) : 'l_work';
  }

  private broadcast(): void {
    try { this.streaming.emit({ type: 'todo', event: 'changed' } as never); } catch { /* ignore */ }
  }
}
