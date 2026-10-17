import { Body, Controller, Get, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
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
   * 拉取 IM 电联明细落盘。入参：start / end（YYYY-MM-DD，缺省今天）。
   * 返回 {ok, msg}。落盘成功后回调 Python 失效本看板的结果缓存
   * （缓存键 = "<start>~<end>"，与 analytics.im_contact.board 一致）。
   */
  @Post('refresh')
  async refresh(@Body() b: { start?: string; end?: string } = {}) {
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const start = (b.start || '').trim() || today;
    const end = (b.end || '').trim() || start;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return { ok: false, error: 'start / end 必须为 YYYY-MM-DD' };
    }
    if (start > end) return { ok: false, error: 'start 不能晚于 end' };
    try {
      const r = await this.svc.fetchAndLand(start, end);
      if (r.ok) await this.notifyInvalidate(start, end);
      return r;
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 当前落盘状态（区间 / 取数时间 / fetch_ok），供前端判断是否需要刷新。 */
  @Get('status')
  status() {
    const p = this.svc.filePath();
    if (!fs.existsSync(p)) {
      return { ok: true, landed: false, start: null, end: null, fetched_at: null, fetch_ok: null };
    }
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return {
        ok: true,
        landed: true,
        start: d.start ?? null,
        end: d.end ?? null,
        fetched_at: d.fetched_at ?? null,
        fetch_ok: d.fetch_ok ?? null,
        total: d.total ?? null,
      };
    } catch {
      return { ok: true, landed: false, start: null, end: null, fetched_at: null, fetch_ok: null };
    }
  }

  /**
   * 取数落盘后回调 Python 计算服务，失效 IM 电联看板的结果缓存。
   * 缓存键与 analytics.im_contact.board.build_one 一致（date = "<start>~<end>"）。
   * 计算服务不可达时静默忽略 —— 缓存只是性能优化（TTL 60s），漏失效顶多晚点重算。
   */
  private async notifyInvalidate(start: string, end: string): Promise<void> {
    const base = this.config.get<string>('PYTHON_COMPUTE_URL');
    if (!base) return;
    try {
      const root =
        this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..');
      const p = path.join(root, 'backend', 'data', 'teams.json');
      let ids: string[] = [];
      try {
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const list = Array.isArray(d) ? d : d.teams;
        if (Array.isArray(list)) {
          ids = list.map((t: { id?: string | number }) => String(t.id)).filter(Boolean);
        }
      } catch {
        /* teams.json 缺失时传空数组，由 Python 侧按 all 清理 */
      }
      await fetch(`${base}/cache/invalidate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teams: ids, date: `${start}~${end}` }),
      });
    } catch {
      /* ignore */
    }
  }
}
