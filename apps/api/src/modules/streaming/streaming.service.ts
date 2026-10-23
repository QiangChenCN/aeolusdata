import { Injectable } from '@nestjs/common';
import { Subject, Observable, map, merge, interval } from 'rxjs';
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

/**
 * 心跳间隔（毫秒）。
 *
 * 为什么必须有心跳：没有业务事件时 SSE 连接是**完全静默**的长连接 —— 服务端进程假死
 * （事件循环被阻塞、PG 连不上、worker 未启动等）时 TCP 连接依然"开着"，浏览器不会触发
 * error，前端的「服务已连接」会一直显示已连接（2026-10-24 实测：kill 后端后重连太快，
 * 用户几乎看不到断开；worker 未启动时 Header 同样是已连接）。
 *
 * 有了心跳，前端只需看「多久没收到任何事件」就能区分：
 *   · 有心跳  → 连接真的活着；
 *   · 无心跳  → 半开连接 / 进程假死 → 前端强制重建。
 * 心跳由 merge 注入订阅流：客户端断开时订阅取消，interval 自动清理，不会泄漏。
 */
export const SSE_PING_MS = 15_000;

@Injectable()
export class StreamingService {
  private readonly bus = new Subject<AppEvent>();

  emit(event: AppEvent): void {
    this.bus.next(event);
  }

  /**
   * 事件一律**具名下发**（SSE `event:` 行）。
   *
   * 为什么必须带 type：浏览器只把「未命名」的帧派发给 `onmessage`，具名帧必须靠
   * `addEventListener('<name>')` 接收。此前这里只给 data 不给 type，所有事件都以默认
   * message 帧下发，而前端 useSse 是用 addEventListener('log'/'run_start'/'run_end'...)
   * 具名订阅的 —— 等于一条业务事件都收不到（实时日志/运行状态推送是哑的）。
   */
  subscribe(): Observable<MessageEvent> {
    const events$ = this.bus.pipe(
      map((e) => ({ data: e, type: e.type }) as MessageEvent),
    );
    const ping$ = interval(SSE_PING_MS).pipe(
      map(() => ({ data: { type: 'ping', ts: Date.now() }, type: 'ping' }) as MessageEvent),
    );
    return merge(events$, ping$);
  }
}
