import { Controller, Get, Logger, Query } from '@nestjs/common';
import { AssessmentDetailStoreService } from './assessment-detail-store.service';
import { todayYmd } from '../../infra/fetch/storage/raw-cache.service';

/**
 * 考核看板的**内部读端点**（给 Python 计算进程用，机器令牌鉴权）。
 *
 * 前缀刻意用 `assessment-internal` 而不是 `assessment/...`：后者会被本看板的
 * ProxyController 通配转发吞掉（与 `assessment-fetch` 前缀同理）。
 *
 * 权限：`permissions.ts` 里 `^/api/assessment-internal/.*$` → 'machine'，
 * 仅持有有效机器令牌的内部服务（Python）可调用，登录用户不算。
 *
 * 这是「Python 只算、Nest 管数据」的接缝：2026-10-23 起考核看板的运单 / 违规明细
 * 不再经 `apps/api/runtime/*.json` 落盘交换，Python 经本端点读 PG 表。
 */
@Controller('api/assessment-internal')
export class AssessmentInternalController {
  private readonly logger = new Logger(AssessmentInternalController.name);

  constructor(private readonly store: AssessmentDetailStoreService) {}

  /** 实时运单明细（表 `delivery_realtime`）：某站点某天的原始行。 */
  @Get('orders')
  async orders(@Query('team') team?: string, @Query('date') date?: string) {
    if (!this.store.ready) {
      return { ok: false, error: 'PG 未启用（DATABASE_URL 未配置）', rows: [], total: 0 };
    }
    const d = (date || '').trim() || todayYmd();
    const t = String(team ?? '').trim();
    if (!t) return { ok: false, error: '缺少 team 参数', rows: [], total: 0 };
    try {
      const rows = await this.store.getDeliveryTeam(d, t);
      return {
        ok: true,
        date: d,
        team: t,
        rows,
        total: rows.length,
        fetched_at: (await this.store.lastFetchedAt('delivery', d, t)) || null,
      };
    } catch (e) {
      this.logger.error(`读取考核运单明细失败 ${d}/${t}: ${(e as Error).message}`);
      return { ok: false, error: (e as Error).message, rows: [], total: 0 };
    }
  }

  /**
   * 实时违规处罚明细（表 `violation_realtime`）：某天**全站**原始行。
   *
   * 不按 team 过滤：该表没有 team_id 列，明细行自带「团队ID」，站点过滤在读侧
   * （Python `violations.load_team_raw`）解析行内容完成 —— 与原先读全站单文件的口径一致。
   */
  @Get('violations')
  async violations(@Query('date') date?: string) {
    if (!this.store.ready) {
      return { ok: false, error: 'PG 未启用（DATABASE_URL 未配置）', rows: [], total: 0 };
    }
    const d = (date || '').trim() || todayYmd();
    try {
      const rows = await this.store.getViolationDay(d);
      return {
        ok: true,
        date: d,
        rows,
        total: rows.length,
        fetched_at: (await this.store.lastFetchedAt('violation', d)) || null,
      };
    } catch (e) {
      this.logger.error(`读取考核违规明细失败 ${d}: ${(e as Error).message}`);
      return { ok: false, error: (e as Error).message, rows: [], total: 0 };
    }
  }

  /** 历史违规处罚明细（表 `violation`）：某天全站原始行（同上，站点过滤在读侧）。 */
  @Get('violation-history')
  async violationHistory(@Query('date') date?: string) {
    if (!this.store.ready) {
      return { ok: false, error: 'PG 未启用（DATABASE_URL 未配置）', rows: [], total: 0 };
    }
    const d = (date || '').trim() || todayYmd();
    try {
      const rows = await this.store.getViolationHistoryDay(d);
      return { ok: true, date: d, rows, total: rows.length };
    } catch (e) {
      this.logger.error(`读取考核历史违规明细失败 ${d}: ${(e as Error).message}`);
      return { ok: false, error: (e as Error).message, rows: [], total: 0 };
    }
  }

  /**
   * 诊断 + 前端「更新时间」来源：某天两路明细的入库行数与最近入库时间。
   * 取数失败现在不再写表（保留上一版数据），故 fetched_at 只反映真正落库的时间。
   */
  @Get('status')
  async status(@Query('date') date?: string) {
    if (!this.store.ready) return { ok: false, error: 'PG 未启用（DATABASE_URL 未配置）' };
    const d = (date || '').trim() || todayYmd();
    try {
      return {
        ok: true,
        date: d,
        delivery_total: await this.store.countDay('delivery', d),
        violation_total: await this.store.countDay('violation', d),
        delivery_fetched_at: (await this.store.lastFetchedAt('delivery', d)) || null,
        violation_fetched_at: (await this.store.lastFetchedAt('violation', d)) || null,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
