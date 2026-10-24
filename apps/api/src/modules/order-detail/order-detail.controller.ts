import { Body, Controller, Get, Logger, Post, Query } from '@nestjs/common';
import { todayYmd } from '../../infra/fetch/storage/raw-cache.service';
import { OrderDetailStoreService } from './order-detail-store.service';
import { OrderDetailRefreshService } from './order-detail-refresh.service';
import { OrderDetailHistoryService } from './order-detail-history.service';
import { OrderDetailHistoryStoreService } from './order-detail-history-store.service';
import {
  ORDER_DETAIL_COLUMNS,
  ORDER_DETAIL_NUMERIC_KEYS,
  ORDER_DETAIL_SEARCH_KEYS,
  normalizeOrderRow,
  OrderDetailRow,
} from './order-detail-normalize';

/** 单页最大行数（防止前端把 pageSize 调到极大拖垮传输）。 */
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

/**
 * 运单明细看板的 HTTP 入口（登录用户可读，`permissions.ts` 默认落到 'view'）。
 *
 * 与「内部读端点」的区别：internal 前缀是给 Python 计算进程用的机器令牌端点，
 * 本控制器是**给人看的看板读端点** —— 返回的是归一化后的展示行 + 列定义 + 分页信息，
 * 而不是整包原始 JSON。
 *
 * 过滤 / 排序 / 分页都在内存里做：单日全站是千级行数，下推到 SQL 反而要在
 * JSON 列上做表达式匹配，既慢又难维护（明细行的字段是宽表，未做成列）。
 */
@Controller('api/order-detail')
export class OrderDetailController {
  private readonly logger = new Logger(OrderDetailController.name);

  constructor(
    private readonly store: OrderDetailStoreService,
    private readonly refreshSvc: OrderDetailRefreshService,
    private readonly historySvc: OrderDetailHistoryService,
    private readonly historyStore: OrderDetailHistoryStoreService,
  ) {}

  /**
   * 运单明细查询。
   *
   * query：
   *   · date     YYYY-MM-DD，默认今天
   *   · team     站点 id；空 / `__all__` = 全站
   *   · q        关键字（运单号 / 订单号 / 骑手 / 商家 / 站点）
   *   · state    运单状态精确过滤
   *   · sort     排序列（ORDER_DETAIL_COLUMNS 的 key）
   *   · order    asc | desc
   *   · page / pageSize
   */
  @Get('orders')
  async orders(
    @Query('date') date?: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('team') team?: string,
    @Query('q') q?: string,
    @Query('state') state?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const empty = (extra: Record<string, unknown> = {}) => ({
      ok: false,
      rows: [] as OrderDetailRow[],
      columns: ORDER_DETAIL_COLUMNS.map((c) => ({ key: c.key, label: c.label, kind: c.kind })),
      teams: [] as { team: string; rows: number }[],
      states: [] as string[],
      total: 0,
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      fetched_at: null,
      ...extra,
    });

    if (!this.store.ready) {
      return empty({ error: 'PG 未启用（DATABASE_URL 未配置）' });
    }
    const d = (date || '').trim() || todayYmd();
    const t = String(team ?? '').trim();
    const teamFilter = t && t !== '__all__' ? t : '';

    let raw: Record<string, unknown>[];
    let teams: { team: string; rows: number }[];
    let fetchedAt = '';
    try {
      if (start && end) {
        // 区间查询：联合实时表（当天）+ 历史表（T-1~T-7），覆盖所选日期段
        raw = await this.store.getRange(start, end, teamFilter || undefined);
        teams = await this.store.rangeCountByTeam(start, end);
        fetchedAt = await this.store.rangeLastFetchedAt(start, end, teamFilter || undefined);
      } else {
        // 单日读取：站点覆盖 / 状态枚举 / 过滤排序都在同一份数据上完成
        raw = await this.store.getDay(d);
        teams = await this.store.countByTeam(d);
        fetchedAt = await this.store.lastFetchedAt(d, teamFilter || undefined);
        // 实时表当日快照为空（历史日期、或当天还没刷过）→ 回退历史运单明细表 T-1~T-7 滚动留档
        if (!raw.length) {
          const hist = await this.historyStore.getDay(d);
          if (hist.length) {
            raw = hist;
            teams = await this.historyStore.countByTeam(d);
            fetchedAt = await this.historyStore.lastFetchedAt(d, teamFilter || undefined);
          }
        }
      }
    } catch (e) {
      this.logger.error(`读取运单明细失败 ${d}: ${(e as Error).message}`);
      return empty({ date: d, team: teamFilter, error: (e as Error).message });
    }

    const all = raw.map(normalizeOrderRow);
    const scoped = teamFilter ? all.filter((r) => String(r.team_id ?? '') === teamFilter) : all;

    const states = [...new Set(scoped.map((r) => String(r.state ?? '')).filter(Boolean))].sort();

    const kw = String(q ?? '').trim().toLowerCase();
    const st = String(state ?? '').trim();
    let rows = scoped;
    if (kw) {
      rows = rows.filter((r) =>
        ORDER_DETAIL_SEARCH_KEYS.some((k) => String(r[k] ?? '').toLowerCase().includes(kw)),
      );
    }
    if (st) rows = rows.filter((r) => String(r.state ?? '') === st);

    // 排序：数值列按数值，其余按字典序（时间列格式 YYYY-MM-DD HH:mm:ss，字典序即时间序）
    const sk = String(sort ?? '').trim();
    const dir = String(order ?? '').trim().toLowerCase() === 'asc' ? 1 : -1;
    if (sk && ORDER_DETAIL_COLUMNS.some((c) => c.key === sk)) {
      rows = rows.slice().sort((a, b) => {
        const av = a[sk];
        const bv = b[sk];
        const an = av === null || av === '';
        const bn = bv === null || bv === '';
        if (an && bn) return 0;
        if (an) return 1; // 空值恒排最后
        if (bn) return -1;
        const c = ORDER_DETAIL_NUMERIC_KEYS.has(sk)
          ? Number(av) - Number(bv)
          : String(av).localeCompare(String(bv), 'zh');
        return dir * c;
      });
    }

    const ps = Math.min(Math.max(Number(pageSize) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / ps));
    const p = Math.min(Math.max(Number(page) || 1, 1), pages);
    const slice = rows.slice((p - 1) * ps, (p - 1) * ps + ps);

    return {
      ok: true,
      date: d,
      team: teamFilter,
      columns: ORDER_DETAIL_COLUMNS.map((c) => ({ key: c.key, label: c.label, kind: c.kind })),
      teams,
      states,
      rows: slice,
      total,
      page: p,
      pageSize: ps,
      fetched_at: fetchedAt || null,
      error: null,
    };
  }

  /** 刷新：拉全站运单入库（同步返回，前端无需轮询）。需 data:refresh 权限。 */
  @Post('refresh')
  async refresh(@Body() body: { date?: string } = {}) {
    return this.refreshSvc.refresh(body?.date);
  }

  /**
   * 历史运单明细状态：滚动窗口（T-1 ~ T-7）每天的入库行数与写入时间，
   * 以及上一次滚动运行的快照（重启后仍可读）。
   */
  @Get('history/status')
  async historyStatus() {
    const dates = this.historySvc.windowDates();
    if (!this.historyStore.ready) {
      return { ok: false, dates, days: [], total: 0, last_run: null, error: 'PG 未启用（DATABASE_URL 未配置）' };
    }
    try {
      const days = await this.historyStore.statsOf(dates);
      return {
        ok: true,
        dates,
        days,
        total: days.reduce((s, d) => s + d.rows, 0),
        last_run: await this.historySvc.lastRun(),
        error: null,
      };
    } catch (e) {
      this.logger.error(`读取历史运单明细状态失败：${(e as Error).message}`);
      return { ok: false, dates, days: [], total: 0, last_run: null, error: (e as Error).message };
    }
  }

}
