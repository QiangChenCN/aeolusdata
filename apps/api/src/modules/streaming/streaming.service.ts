import { Injectable } from '@nestjs/common';
import { Subject, Observable, map } from 'rxjs';
import { MessageEvent } from '@nestjs/common';

/**
 * 全局事件总线（对齐旧 server.py 的 MGR 广播）。
 * 旧前端订阅 /api/events 全量流、自行按 run_id 过滤，故此处用全局广播，
 * 事件形态保持 { type, run_id, ... } 不变（迁移不变量）。
 */
export interface AppEvent {
  type: string;
  [key: string]: unknown;
}

@Injectable()
export class StreamingService {
  private readonly bus = new Subject<AppEvent>();

  emit(event: AppEvent): void {
    this.bus.next(event);
  }

  subscribe(): Observable<MessageEvent> {
    return this.bus.pipe(map((e) => ({ data: e }) as MessageEvent));
  }
}
