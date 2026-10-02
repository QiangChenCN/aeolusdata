import { Injectable, Logger } from '@nestjs/common';
import { TaskHandler } from './task-handler';

/**
 * 原生任务处理器注册表。
 *
 * 处理器在自己构造函数里 `handlers.register(this)` 完成自注册（它们是本模块的 provider，
 * Nest 启动时全部实例化）。TaskRunnerService 按 taskId 查表：
 *   命中 → Nest 原生执行；未命中 → 回退旧的 spawn(python cmd) 路径（过渡期）。
 */
@Injectable()
export class TaskHandlersService {
  private readonly logger = new Logger(TaskHandlersService.name);
  private readonly map = new Map<string, TaskHandler>();

  register(h: TaskHandler): void {
    if (this.map.has(h.id)) {
      this.logger.warn(`任务处理器 id 重复：${h.id}（后者覆盖前者）`);
    }
    this.map.set(h.id, h);
  }

  get(id: string): TaskHandler | undefined {
    return this.map.get(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  ids(): string[] {
    return [...this.map.keys()];
  }
}
