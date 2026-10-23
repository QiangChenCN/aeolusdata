import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';

/**
 * 轻量健康探测（前端「服务」胶囊的数据源）。
 *
 * 返回后端自身 + Python 计算服务 + worker 进程三者的状态，只做极轻量探测：
 * 会被前端周期性调用（约 30s 一次），探测本身不能成为新的故障源。
 * 免机器令牌闸门见 AccessGuard 的 EXEMPT_MACHINE。
 */
@Controller('api')
export class HealthController {
  constructor(private readonly svc: HealthService) {}

  @Get('health')
  async health() {
    return this.svc.snapshot();
  }
}
