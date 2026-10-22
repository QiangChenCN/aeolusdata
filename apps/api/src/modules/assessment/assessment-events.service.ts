import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { MessageEvent } from '@nestjs/common';

/**
 * 考核看板 SSE 事件总线。
 *
 * 取数完成（手动 / 自动 / 服务端定时）后由取数路径调用 `emitUpdated`，
 * 经本服务广播给所有订阅前端（`/api/assessment-fetch/stream`），前端收到后回读。
 * 这样「取数完成 → 服务端推『已更新』→ 前端回读」替代了固定间隔的盲轮询，
 * 且任一端触发取数，所有在线前端实时刷新（多标签页 / 多人协同）。
 */
@Injectable()
export class AssessmentEventsService {
  // 单播 Subject：每个新订阅者只收到订阅之后的事件（无需重放历史）。
  private readonly subject = new Subject<{ date: string; at: number }>();
  readonly stream$ = this.subject.asObservable();

  /** 取数成功落盘后调用：通知前端「数据已更新，可回读」。 */
  emitUpdated(date: string): void {
    this.subject.next({ date, at: Date.now() });
  }

  /** 转为 SSE 的 MessageEvent 流（Nest @Sse 要求返回 Observable<MessageEvent>）。 */
  toMessage(): Observable<MessageEvent> {
    return this.stream$.pipe(
      map(
        (p) =>
          ({
            data: JSON.stringify({ type: 'updated', date: p.date, at: p.at }),
          }) as MessageEvent,
      ),
    );
  }
}
