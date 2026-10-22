import { Body, Controller, Post } from '@nestjs/common';
import { DeliveryTimeoutRefreshService } from './delivery-timeout-refresh.service';
import { RawCacheService, RAW_KINDS, RawKind } from '../../infra/fetch/storage/raw-cache.service';

/**
 * 配送超时看板的独立刷新入口（`POST /api/delivery-timeout/refresh`）。
 *
 * 与标准达成的 `/api/standard/refresh-all` 完全独立：不共享其状态机 / 频控 / 参与站点作用域，
 * 只复用底层取数（风神）与落盘（`RawCacheService`）。同步返回抓取+落盘结果，前端无需轮询。
 */
@Controller('api/delivery-timeout')
export class DeliveryTimeoutController {
  constructor(
    private readonly svc: DeliveryTimeoutRefreshService,
    private readonly raw: RawCacheService,
  ) {}

  @Post('refresh')
  refresh(@Body() body: { date?: string } = {}) {
    return this.svc.refresh(body?.date);
  }

  /**
   * 原始层通用写端点（手动回填 / 外部触发用）。
   *
   * 注（2026-10-21）：本看板的计算源已改为自有 PG 表 `delivery_timeout_orders`
   * （见 `DeliveryTimeoutRefreshService` + `DeliveryTimeoutOrdersStoreService`），
   * 正常刷新**不再写** `apps/api/runtime/raw/orders_*`。这里保留该入口仅为诊断回填。
   */
  @Post('raw')
  saveRaw(
    @Body()
    body: { kind?: string; team?: string; date?: string; payload?: unknown },
  ) {
    const kind = String(body?.kind || '');
    const team = String(body?.team ?? '').trim();
    const date = String(body?.date ?? '').trim();
    if (!(RAW_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, error: `kind 非法：${body?.kind}（可用 ${RAW_KINDS.join('/')}）` };
    }
    if (!team || !date) return { ok: false, error: '缺少 team 或 date' };
    try {
      const saved = this.raw.saveRaw(kind as RawKind, team, body?.payload, date);
      return { ok: true, saved, skipped: !saved ? 'payload 为空，按约定不写' : null };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
