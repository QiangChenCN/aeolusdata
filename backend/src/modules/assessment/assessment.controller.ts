import { Body, Controller, Get, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { AssessmentViolationFetchService } from './assessment-violation-fetch.service';
import { AssessmentDeliveryFetchService } from './assessment-delivery-fetch.service';
import { AssessmentCooldownService } from './assessment-cooldown.service';

/**
 * 考核看板自有取数端点。
 *
 * 注意：前缀用 `api/assessment-fetch` 而非 `api/assessment` —— 后者被 ProxyController 的
 * 通配 `assessment/{*path}` 转发给 Python，新原生端点若落在同前缀下会被通配吞掉。
 * 这里用独立前缀，彻底避开代理通配，互不干扰。
 *
 *   · `POST /api/assessment-fetch/violation`  违规处罚明细（全站合并 → backend/data/违规处罚明细-实时.json）
 *   · `POST /api/assessment-fetch/delivery`   运单明细（今日实时全站 → backend/data/运单明细-实时.json）
 */
@Controller('api/assessment-fetch')
export class AssessmentController {
  constructor(
    private readonly violationSvc: AssessmentViolationFetchService,
    private readonly deliverySvc: AssessmentDeliveryFetchService,
    private readonly cooldownSvc: AssessmentCooldownService,
    private readonly config: ConfigService,
  ) {}

  /** 手动刷新冷却状态查询（页面加载恢复读秒用）。 */
  @Get('refresh-cooldown')
  getCooldown() {
    return this.cooldownSvc.status();
  }

  /** 主动写入一次冷却时间戳（如从自动切回手动时，默认进入 1 分钟冷却）。不触发取数。 */
  @Post('refresh-cooldown')
  markCooldown() {
    this.cooldownSvc.mark();
    return this.cooldownSvc.status();
  }

  /**
   * 取数落盘后回调 Python 计算服务，失效考核看板（assessment_board）的进程内结果缓存。
   * 若 PYTHON_COMPUTE_URL 未配置或计算服务不可达，静默忽略——缓存只是性能优化，
   * 漏失效顶多下次读取晚一点重算，绝不让取数接口因此失败。
   */
  private async notifyInvalidate(teams: string[], date: string): Promise<void> {
    const base = this.config.get<string>('PYTHON_COMPUTE_URL');
    if (!base) return;
    try {
      await fetch(`${base}/cache/invalidate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teams, date }),
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * 拉取考核看板违规处罚明细（自有取数）：取 date 全天 → 按站点分组 → 落盘自有命名空间。
   * 入参：teams（站点 id 列表，必填）、date（YYYY-MM-DD，缺省今天）、
   *       manual（是否由前端「手动刷新按钮」触发；为 true 时走 1 分钟冷却节流并写入冷却时间戳，
   *       自动轮询不传，跳过冷却）。
   * 返回 {ok, msg, remaining_sec?}；冷却中返回 {ok:false, cooldown:true, remaining_sec}。
   */
  @Post('violation')
  async fetchViolation(@Body() b: { teams?: string[]; date?: string; manual?: boolean }) {
    const date =
      (b.date || '').trim() ||
      new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const teams = (b.teams || []).map(String).filter(Boolean);
    if (!teams.length) return { ok: false, error: 'teams 不能为空' };
    const manual = b.manual === true;
    if (manual && this.cooldownSvc.inCooldown()) {
      return {
        ok: false,
        cooldown: true,
        remaining_sec: this.cooldownSvc.remainingSec(),
        error: '手动刷新冷却中，请稍后再试',
      };
    }
    try {
      const r = await this.violationSvc.fetchAndLand(teams, date);
      // 取数落盘后必须通知 Python 失效考核看板的结果缓存，否则 Python 一直返回
      // 进程内旧缓存（build_one 命中即返回），表现就是「刷新了但数字没变」。
      if (r.ok) {
        // 违规明细是全站合并的全局单文件（fetchAndLand 忽略 teams 参数全站拉取），
        // 取数成功后必须失效当天全部站点的考核看板结果缓存，与运单取数保持一致；
        // 否则仅失效传入子集时，未被失效的站点仍命中 Python 进程内旧缓存，表现即「刷新了但数字没变」。
        await this.notifyInvalidate(this.allTeamIds(), date);
        if (manual) this.cooldownSvc.mark();
      }
      return {
        ok: r.ok,
        msg: r.msg,
        ...(manual ? { remaining_sec: this.cooldownSvc.remainingSec() } : {}),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * 拉取考核看板运单明细（自有取数）：抓今日（实时，截至当前）全站运单 →
   * 落盘 `backend/data/运单明细-实时.json`（覆盖写）。
   * 入参：date（YYYY-MM-DD，缺省今天）。返回 {ok, msg}。
   * 运单是全站单文件，取数成功后必须失效当天**全部站点**的考核看板结果缓存
   * （否则 Python 仍返回旧聚合结果，表现就是「刷新了但推配送/完成/T8 没变」）。
   */
  @Post('delivery')
  async fetchDelivery(@Body() b: { date?: string }) {
    const date =
      (b.date || '').trim() ||
      new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    try {
      const r = await this.deliverySvc.fetchAndLand(date);
      if (r.ok) {
        await this.notifyInvalidate(this.allTeamIds(), date);
      }
      return { ok: r.ok, msg: r.msg };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 读取本地 teams.json 的全部站点 id（运单全站单文件失效缓存时用到）。 */
  private allTeamIds(): string[] {
    try {
      const root = this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..');
      const p = path.join(root, 'backend', 'data', 'teams.json');
      const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const list = Array.isArray(d) ? d : d.teams;
      if (Array.isArray(list)) {
        return list.map((t: { id?: string | number }) => String(t.id)).filter(Boolean);
      }
    } catch {
      /* teams.json 缺失时返回空，notifyInvalidate 会因缺 teams 被忽略（降级：下次读晚点重算） */
    }
    return [];
  }
}
