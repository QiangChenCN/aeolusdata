import { Controller, Get, Logger, Query } from '@nestjs/common';
import { DeliveryTimeoutOrdersStoreService } from './delivery-timeout-orders-store.service';
import { todayYmd } from '../../infra/fetch/storage/raw-cache.service';

/**
 * 配送超时看板的**内部读端点**（给 Python 计算进程用，机器令牌鉴权）。
 *
 * 前缀刻意避开 `api/delivery-timeout`：否则会被本模块通配的 `delivery-timeout/{*path}`
 * 吞掉（path-to-regexp 无负向断言），导致 RefreshController/本端点 404。
 *
 * 权限：`permissions.ts` 里 `^/api/delivery-timeout-internal/.*$` → 'machine'，
 * 仅持有有效机器令牌的内部服务（Python）可调用，登录用户不算。
 *
 * 这是「Python 只算、Nest 管数据」的接缝：Nest 负责取数入库，Python 经此端点
 * 读实时运单明细做计算 —— 两边不再通过磁盘上的 JSON 文件耦合。
 */
@Controller('api/delivery-timeout-internal')
export class DeliveryTimeoutInternalController {
  private readonly logger = new Logger(DeliveryTimeoutInternalController.name);

  constructor(private readonly store: DeliveryTimeoutOrdersStoreService) {}

  /**
   * 取某站点某天的实时运单明细原始行。
   *
   * 返回 `{ok, date, team, rows, total, fetched_at}`；表不可用/参数缺失时 `ok:false` ——
   * Python 侧把它等同于旧版的「None」（判 need_refresh），语义保持一致。
   */
  @Get('orders')
  async orders(@Query('team') team?: string, @Query('date') date?: string) {
    if (!this.store.ready) {
      return { ok: false, error: 'PG 未启用（DATABASE_URL 未配置）', rows: [], total: 0 };
    }
    const d = (date || '').trim() || todayYmd();
    const t = String(team ?? '').trim();
    if (!t) return { ok: false, error: '缺少 team 参数', rows: [], total: 0 };
    try {
      const rows = await this.store.getTeam(d, t);
      const fetchedAt = await this.store.lastFetchedAt(d, t);
      return { ok: true, date: d, team: t, rows, total: rows.length, fetched_at: fetchedAt || null };
    } catch (e) {
      this.logger.error(`读取实时运单明细失败 ${d}/${t}: ${(e as Error).message}`);
      return { ok: false, error: (e as Error).message, rows: [], total: 0 };
    }
  }

  /** 诊断：某天全站入库行数与最近入库时间。 */
  @Get('status')
  async status(@Query('date') date?: string) {
    if (!this.store.ready) return { ok: false, error: 'PG 未启用（DATABASE_URL 未配置）' };
    const d = (date || '').trim() || todayYmd();
    try {
      return {
        ok: true,
        date: d,
        total: await this.store.countDay(d),
        fetched_at: (await this.store.lastFetchedAt(d)) || null,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
