import { Body, Controller, Post } from '@nestjs/common';
import { DeliveryTimeoutRefreshService } from './delivery-timeout-refresh.service';

/**
 * 配送超时看板的独立刷新入口（`POST /api/delivery-timeout/refresh`）。
 *
 * 与标准达成的 `/api/standard/refresh-all` 完全独立：不共享其状态机 / 频控 / 参与站点作用域，
 * 只复用底层取数（风神）与落盘（`RawCacheService`）。同步返回抓取+落盘结果，前端无需轮询。
 */
@Controller('api/delivery-timeout')
export class DeliveryTimeoutController {
  constructor(private readonly svc: DeliveryTimeoutRefreshService) {}

  @Post('refresh')
  refresh(@Body() body: { date?: string } = {}) {
    return this.svc.refresh(body?.date);
  }
}
