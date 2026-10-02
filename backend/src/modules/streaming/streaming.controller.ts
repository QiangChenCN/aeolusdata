import { Controller, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';
import { MessageEvent } from '@nestjs/common';
import { StreamingService } from './streaming.service';

@Controller('api')
export class StreamingController {
  constructor(private readonly streaming: StreamingService) {}

  /** SSE 端点：前端 EventSource('/api/events?token=...') 订阅全量事件流。 */
  @Sse('events')
  events(): Observable<MessageEvent> {
    return this.streaming.subscribe();
  }
}
