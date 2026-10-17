import { Body, Controller, Get, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImContactFetchService } from './im-contact-fetch.service';

/**
 * IM 电联看板自有取数端点。
 *
 * 注意：前缀用 `api/im-contact-fetch` 而非 `api/im-contact` —— 后者被 ProxyController 的
 * 通配 `im-contact/{*path}` 转发给 Python（数据端点 /data、配置端点 /teams），
 * 新原生端点若落在同前缀下会被通配吞掉。这里用独立前缀，彻底避开代理通配。
 *
 *   · `POST /api/im-contact-fetch/refresh`   拉取 [start,end] 全站 IM 电联明细 → 落盘
 *
 * 数据读取（GET /api/im-contact/data）与展示站点配置（/api/im-contact/teams）走
 * ProxyController 通配：前者转发 Python 计算（analytics.im_contact），后者改派
 * ImContactConfigService（见 config.service.ts 的 isConfigPath）。
 */
@Controller('api/im-contact-fetch')
export class ImContactController {
  constructor(
    private readonly svc: ImContactFetchService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 拉取 IM 电联明细落盘。入参：start / end（YYYY-MM-DD，可选）。
   *
   * 取数默认 = T-1 所在月的**整月**（report 数据滞后一天，按用户要求默认取整月并累计落库）；
   * 仅当显式传入 start/end 时才按传入区间取（仍 upsert 累计，不破坏历史）。
   *
   * 落盘成功后回调 Python 失效本看板全部结果缓存（数据区间变化，按具体区间失效不可靠）。
   */
  @Post('refresh')
  async refresh(@Body() b: { start?: string; end?: string } = {}) {
    let start = (b.start || '').trim();
    let end = (b.end || '').trim();
    if (!start || !end) {
      const m = this.monthOfTMinus1();
      start = start || m.start;
      end = end || m.end;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return { ok: false, error: 'start / end 必须为 YYYY-MM-DD' };
    }
    if (start > end) return { ok: false, error: 'start 不能晚于 end' };
    try {
      const r = await this.svc.fetchAndLand(start, end);
      if (r.ok) await this.notifyInvalidate();
      return r;
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** T-1（北京时间昨天）所在月的起止 YYYY-MM-DD。 */
  private monthOfTMinus1(): { start: string; end: string } {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const tMinus1 = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1));
    const y = tMinus1.getUTCFullYear();
    const m = tMinus1.getUTCMonth(); // 0-based
    const pad = (n: number) => String(n).padStart(2, '0');
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return { start: `${y}-${pad(m + 1)}-01`, end: `${y}-${pad(m + 1)}-${pad(lastDay)}` };
  }

  /** 当前落盘状态（已落盘区间 / 取数时间 / fetch_ok / 累计条数），供前端判断是否需要刷新。 */
  @Get('status')
  status() {
    return this.svc.status();
  }

  /**
   * 取数落盘后回调 Python 计算服务，失效 IM 电联看板全部结果缓存。
   * 计算缓存键含前端展示区间（近 7 天等），刷新后是整月落库，按具体区间失效不可靠，
   * 故直接 all:true 全量失效。计算服务不可达时静默忽略 —— 缓存 TTL 60s 兜底。
   */
  private async notifyInvalidate(): Promise<void> {
    const base = this.config.get<string>('PYTHON_COMPUTE_URL');
    if (!base) return;
    try {
      await fetch(`${base}/cache/invalidate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
    } catch {
      /* ignore */
    }
  }
}
