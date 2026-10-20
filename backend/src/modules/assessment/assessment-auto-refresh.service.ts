import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { AssessmentViolationFetchService } from './assessment-violation-fetch.service';
import { AssessmentDeliveryFetchService } from './assessment-delivery-fetch.service';
import { VisitFetchService } from './visit-fetch.service';
import { AssessmentEventsService } from './assessment-events.service';

/**
 * 考核看板「服务端定时取数」—— 取代前端固定间隔盲轮询。
 *
 * 前端不再按 5/10/15 分钟各自打风神；改为：本服务按共享间隔（默认 10 分钟，
 * 受 `ASSESSMENT_AUTO_REFRESH_SEC` 控制，前端「自动/手动」开关与间隔选择经
 * `POST /api/assessment-fetch/auto` 写入）周期性拉取违规 + 运单两路，落盘后失效
 * Python 缓存并广播 `updated`，所有在线前端实时回读。
 *
 * 这是 SSE 推送优化的关键一环：把「谁触发取数」从每个前端客户端上收为服务端单一来源，
 * 既省（多端共享一次取数），又实时（取数完成即推）。前端 SSE 断开时回退为前端定时取数。
 */
@Injectable()
export class AssessmentAutoRefreshService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssessmentAutoRefreshService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFetch = 0;
  private enabled: boolean;
  private intervalSec: number;

  constructor(
    private readonly violationSvc: AssessmentViolationFetchService,
    private readonly deliverySvc: AssessmentDeliveryFetchService,
    private readonly visitSvc: VisitFetchService,
    private readonly events: AssessmentEventsService,
    private readonly config: ConfigService,
  ) {
    // 默认开启；ASSESSMENT_AUTO_REFRESH=false 可关闭（完全由手动刷新驱动）。
    this.enabled = this.config.get<string>('ASSESSMENT_AUTO_REFRESH') !== 'false';
    const sec = Number(this.config.get<string>('ASSESSMENT_AUTO_REFRESH_SEC') || '600');
    this.intervalSec = Number.isFinite(sec) && sec > 0 ? sec : 600;
  }

  onModuleInit(): void {
    // 启动后由首轮 tick 立即触发一次取数（lastFetch=0 → 立即到期），让看板冷启动即有数据。
    this.lastFetch = 0;
    this.timer = setInterval(() => void this.tick(), 1000);
    this.logger.log(
      `考核看板自动取数：${this.enabled ? '开启' : '关闭'}，间隔 ${this.intervalSec}s`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 前端「自动/手动」开关与间隔选择写入（多端共享，末次写入生效）。 */
  setConfig(enabled: boolean, intervalSec?: number): void {
    if (typeof enabled === 'boolean') this.enabled = enabled;
    if (intervalSec && Number.isFinite(intervalSec) && intervalSec > 0) {
      this.intervalSec = intervalSec;
    }
    // 配置变更后立即触发一次，让前端尽快看到新数据（而非再等一个周期）。
    this.lastFetch = 0;
    this.logger.log(
      `考核看板自动取数配置更新：enabled=${this.enabled}, interval=${this.intervalSec}s`,
    );
  }

  getConfig(): { enabled: boolean; intervalSec: number } {
    return { enabled: this.enabled, intervalSec: this.intervalSec };
  }

  private todayYmd(): string {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }

  /** 周期性触发：到点才取数（避免 @Interval 固定周期不支持动态间隔）。 */
  private async tick(): Promise<void> {
    if (!this.enabled) return;
    const now = Date.now();
    if (now - this.lastFetch < this.intervalSec * 1000) return;
    this.lastFetch = now;
    await this.refreshAll(this.todayYmd());
  }

  /** 违规 + 运单两路取数 → 落盘 → 失效 Python 缓存 → 广播 updated。 */
  async refreshAll(date: string): Promise<void> {
    try {
      const [v, d] = await Promise.all([
        this.violationSvc.fetchAndLand([], date),
        this.deliverySvc.fetchAndLand(date),
      ]);
      if (v.ok || d.ok) {
        await this.notifyInvalidate(this.allTeamIds(), date);
        this.events.emitUpdated(date);
        this.logger.log(
          `考核看板自动取数完成：violation.ok=${v.ok}, delivery.ok=${d.ok}`,
        );
      } else {
        this.logger.warn(
          `考核看板自动取数两路均未成功：${v.msg} / ${d.msg}`,
        );
      }
      // 商家拜访取数（尽力而为，失败不影响主流程）：落历史库，供历史区间聚合读取。
      try {
        const r = await this.visitSvc.fetchAndLand(undefined, date);
        if (!r.ok) this.logger.warn('考核看板商家拜访取数未成功：' + r.msg);
      } catch (ve) {
        this.logger.warn('考核看板商家拜访取数异常：' + (ve as Error).message);
      }
    } catch (e) {
      this.logger.error('考核看板自动取数异常：' + (e as Error).message);
    }
  }

  /** 取数落盘后回调 Python 失效考核看板结果缓存（与 controller 同源逻辑）。 */
  private async notifyInvalidate(teams: string[], date: string): Promise<void> {
    const base = this.config.get<string>('PYTHON_COMPUTE_URL');
    if (!base) return;
    try {
      await fetch(`${base}/api/cache/invalidate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teams, date }),
      });
    } catch {
      /* 缓存失效漏掉顶多下次读晚点重算，绝不让取数接口失败 */
    }
  }

  /** 读取全部站点 id（全站单文件失效缓存时用到，与 controller 同源）。 */
  private allTeamIds(): string[] {
    try {
      const root =
        this.config.get<string>('PROJECT_ROOT') ||
        path.resolve(process.cwd(), '..');
      const p = path.join(root, 'backend', 'data', 'teams.json');
      const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const list = Array.isArray(d) ? d : d.teams;
      if (Array.isArray(list)) {
        return list
          .map((t: { id?: string | number }) => String(t.id))
          .filter(Boolean);
      }
    } catch {
      /* teams.json 缺失时返回空，notifyInvalidate 因缺 teams 被忽略（降级） */
    }
    return [];
  }
}
