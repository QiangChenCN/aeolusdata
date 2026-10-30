import { Body, Controller, Get, Logger, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { todayYmd } from '../../infra/fetch/storage/raw-cache.service';
import { DeliveryStoreService } from './delivery-store.service';
import { DeliveryRefreshService } from './delivery-refresh.service';
import { DeliveryHistoryService } from './delivery-history.service';
import { DeliveryHistoryStoreService } from './delivery-history-store.service';
import {
  DELIVERY_COLUMNS,
  DELIVERY_NUMERIC_KEYS,
  DELIVERY_SEARCH_KEYS,
  normalizeOrderRow,
  DeliveryRow,
  DeliveryColKind,
} from './delivery-normalize';

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
@Controller('api/delivery')
export class DeliveryController {
  private readonly logger = new Logger(DeliveryController.name);

  constructor(
    private readonly store: DeliveryStoreService,
    private readonly refreshSvc: DeliveryRefreshService,
    private readonly historySvc: DeliveryHistoryService,
    private readonly historyStore: DeliveryHistoryStoreService,
  ) {}

  /**
   * 运单明细查询。
   *
   * query：
   *   · date     YYYY-MM-DD，默认今天
   *   · team     站点 id；空 / `__all__` = 全站
   *   · q        关键字（运单号 / 订单号 / 骑手 / 商家 / 站点）
   *   · state    运单状态精确过滤
   *   · sort     排序列（DELIVERY_COLUMNS 的 key）
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
      rows: [] as DeliveryRow[],
      columns: DELIVERY_COLUMNS.map((c) => ({ key: c.key, label: c.label, kind: c.kind })),
      teams: [] as { team: string; rows: number }[],
      states: [] as string[],
      total: 0,
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      fetched_at: null,
      ...extra,
    });
    try {
      const { rows, columns, teams, states, fetchedAt } = await this.resolveRows({ date, start, end, team, q, state, sort, order });
      const ps = Math.min(Math.max(Number(pageSize) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
      const total = rows.length;
      const pages = Math.max(1, Math.ceil(total / ps));
      const p = Math.min(Math.max(Number(page) || 1, 1), pages);
      const slice = rows.slice((p - 1) * ps, (p - 1) * ps + ps);
      const d = (date || '').trim() || todayYmd();
      return {
        ok: true,
        date: d,
        team: team && team !== '__all__' ? team : '',
        columns,
        teams,
        states,
        rows: slice,
        total,
        page: p,
        pageSize: ps,
        fetched_at: fetchedAt || null,
        error: null,
      };
    } catch (e) {
      const d = (date || '').trim() || todayYmd();
      this.logger.error(`运单明细查询失败 ${d}: ${(e as Error).message}`);
      return empty({ date: d, team: team && team !== '__all__' ? team : '', error: (e as Error).message });
    }
  }

  /**
   * 导出当前筛选结果为 CSV（UTF-8 BOM，Excel 直接可读）。
   * 复用与 orders 完全相同的取数 / 过滤 / 排序逻辑，但返回全部匹配行（不分页）。
   * cols 为逗号分隔的列 key（前端按当前可见列顺序传入）；缺省导出全部列。
   */
  @Get('export')
  async export(
    @Res() res: Response,
    @Query('date') date?: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('team') team?: string,
    @Query('q') q?: string,
    @Query('state') state?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
    @Query('cols') cols?: string,
  ) {
    try {
      const { rows, columns } = await this.resolveRows({ date, start, end, team, q, state, sort, order });
      // 导出列：默认全部；指定 cols 时按前端传入顺序筛选（即用户当前可见列）
      let expCols = columns;
      const keys = (cols || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (keys.length) {
        const byKey = new Map(columns.map((c) => [c.key, c]));
        const picked = keys.map((k) => byKey.get(k)).filter(Boolean);
        if (picked.length) expCols = picked as typeof columns;
      }
      const csv = this.toCsv(rows, expCols);
      const tag = `${start || date || 'all'}_${end || date || 'all'}`;
      const fname = `delivery_${tag}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.status(200).send(csv);
    } catch (e) {
      this.logger.error(`运单明细导出失败：${(e as Error).message}`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(500).send('导出失败：' + ((e as Error).message || '未知错误'));
    }
  }

  /**
   * 取数 / 过滤 / 排序的共享内核：根据筛选条件返回「全部匹配且已排序」的行（不分页）。
   * orders 在此结果上做分页；export 直接整包导出。
   */
  private async resolveRows(params: {
    date?: string; start?: string; end?: string; team?: string;
    q?: string; state?: string; sort?: string; order?: string;
  }): Promise<{
    rows: DeliveryRow[];
    columns: { key: string; label: string; kind: DeliveryColKind }[];
    teams: { team: string; rows: number }[];
    states: string[];
    fetchedAt: string;
  }> {
    if (!this.store.ready) throw new Error('PG 未启用（DATABASE_URL 未配置）');
    const d = (params.date || '').trim() || todayYmd();
    // team 支持逗号分隔多站点（前端 multiple 多选）；含 `__all__` 或为空 = 全站
    const t = String(params.team ?? '').trim();
    const teamList = t && t !== '__all__'
      ? t.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const teamFilter = teamList.length ? teamList : null; // null = 全站

    let raw: Record<string, unknown>[];
    let teams: { team: string; rows: number }[];
    let fetchedAt = '';
    try {
      if (params.start && params.end) {
        // 区间查询：联合实时表（当天）+ 历史表（T-1~T-7），覆盖所选日期段
        raw = await this.store.getRange(params.start, params.end, teamFilter || undefined);
        teams = await this.store.rangeCountByTeam(params.start, params.end);
        fetchedAt = await this.store.rangeLastFetchedAt(params.start, params.end, teamFilter || undefined);
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
      throw e;
    }

    const all = raw.map(normalizeOrderRow);
    const scoped = teamFilter && teamFilter.length
      ? all.filter((r) => teamFilter.includes(String(r.teamId ?? r.team_id ?? '')))
      : all;

    const states = [...new Set(scoped.map((r) => String(r.stateDesc ?? r.state ?? '')).filter(Boolean))].sort();

    const kw = String(params.q ?? '').trim().toLowerCase();
    const st = String(params.state ?? '').trim();
    let rows = scoped;
    if (kw) {
      rows = rows.filter((r) =>
        DELIVERY_SEARCH_KEYS.some((k) => String(r[k] ?? '').toLowerCase().includes(kw)),
      );
    }
    if (st) rows = rows.filter((r) => String(r.stateDesc ?? r.state ?? '') === st);

    // 排序：数值列按数值，其余按字典序（时间列格式 YYYY-MM-DD HH:mm:ss，字典序即时间序）
    const sk = String(params.sort ?? '').trim();
    const dir = String(params.order ?? '').trim().toLowerCase() === 'asc' ? 1 : -1;
    if (sk && DELIVERY_COLUMNS.some((c) => c.key === sk)) {
      rows = rows.slice().sort((a, b) => {
        const av = a[sk];
        const bv = b[sk];
        const an = av === null || av === '';
        const bn = bv === null || bv === '';
        if (an && bn) return 0;
        if (an) return 1; // 空值恒排最后
        if (bn) return -1;
        const c = DELIVERY_NUMERIC_KEYS.has(sk)
          ? Number(av) - Number(bv)
          : String(av).localeCompare(String(bv), 'zh');
        return dir * c;
      });
    }

    return {
      rows,
      columns: DELIVERY_COLUMNS.map((c) => ({ key: c.key, label: c.label, kind: c.kind })),
      teams,
      states,
      fetchedAt,
    };
  }

  /** 行集合 → CSV 文本（UTF-8 BOM + CRLF，字段按 RFC4180 转义）。 */
  private toCsv(rows: DeliveryRow[], cols: { key: string; label: string }[]): string {
    const esc = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      // 15 位以上纯数字（如 19 位运单号）直接写出会被 Excel 当数值解析，
      // 超出 15 位精度即四舍五入、尾数补 0 并转科学计数法；前置 TAB 强制按文本导入，原样显示。
      const texted = /^\d{15,}$/.test(s) ? '\t' + s : s;
      return /[",\r\n]/.test(texted) ? '"' + texted.replace(/"/g, '""') + '"' : texted;
    };
    const head = cols.map((c) => esc(c.label)).join(',');
    const body = rows.map((r) => cols.map((c) => esc(r[c.key])).join(','));
    return '\uFEFF' + [head, ...body].join('\r\n');
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
