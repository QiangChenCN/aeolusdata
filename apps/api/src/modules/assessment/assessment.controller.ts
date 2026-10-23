import { Body, Controller, Get, Logger, Post, Sse } from '@nestjs/common';
import { MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { AssessmentViolationFetchService } from './assessment-violation-fetch.service';
import { AssessmentDeliveryFetchService } from './assessment-delivery-fetch.service';
import { VisitFetchService } from './visit-fetch.service';
import { AssessmentCooldownService } from './assessment-cooldown.service';
import { AssessmentEventsService } from './assessment-events.service';
import { AssessmentAutoRefreshService } from './assessment-auto-refresh.service';

/**
 * 考核看板自有取数端点。
 *
 * 注意：前缀用 `api/assessment-fetch` 而非 `api/assessment` —— 后者被 ProxyController 的
 * 通配 `assessment/{*path}` 转发给 Python，新原生端点若落在同前缀下会被通配吞掉。
 * 这里用独立前缀，彻底避开代理通配，互不干扰。
 *
 *   · `POST /api/assessment-fetch/violation`  违规处罚明细（全站合并 → apps/api/runtime/违规处罚明细-实时.json）
 *   · `POST /api/assessment-fetch/delivery`   运单明细（今日实时全站 → apps/api/runtime/运单明细-实时.json）
 */
@Controller('api/assessment-fetch')
export class AssessmentController {
  private readonly logger = new Logger(AssessmentController.name);
  constructor(
    private readonly violationSvc: AssessmentViolationFetchService,
    private readonly deliverySvc: AssessmentDeliveryFetchService,
    private readonly visitSvc: VisitFetchService,
    private readonly cooldownSvc: AssessmentCooldownService,
    private readonly config: ConfigService,
    private readonly events: AssessmentEventsService,
    private readonly auto: AssessmentAutoRefreshService,
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
   *
   * teams 为空（teams.json 缺失/解析失败）时退化为整体清缓存（{all:true}）：否则会静默
   * 不失效，表现即「刷新了但数字没变、也不报错」。Python 端点已支持 all。
   */
  private async notifyInvalidate(teams: string[], date: string): Promise<void> {
    const base = this.config.get<string>('PYTHON_COMPUTE_URL');
    if (!base) return;
    const payload = teams && teams.length ? { teams, date } : { all: true, date };
    try {
      const r = await fetch(`${base}/api/cache/invalidate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        this.logger.warn(`考核缓存失效回调异常 HTTP ${r.status} payload=${JSON.stringify(payload)}`);
      }
    } catch (e) {
      // 计算服务不可达：缓存只是性能优化，漏失效顶多下次读取晚点重算。但记录以便排查。
      this.logger.warn(`考核缓存失效回调失败（计算服务不可达？）: ${(e as Error).message}`);
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
        // 取数落盘 + 缓存失效完成 → 通知所有前端「已更新」，由其回读（SSE 推送）。
        this.events.emitUpdated(date);
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
   * 落盘 `apps/api/runtime/运单明细-实时.json`（覆盖写）。
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
        // 取数落盘 + 缓存失效完成 → 通知所有前端「已更新」，由其回读（SSE 推送）。
        this.events.emitUpdated(date);
      }
      return { ok: r.ok, msg: r.msg };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * SSE 端点：考核看板取数完成后推送 `{type:'updated', date, at}`。
   * 前端 `EventSource('/api/assessment-fetch/stream')` 订阅，收到后回读，
   * 替代固定间隔盲轮询，且任一端取数 → 所有在线前端实时刷新。
   */
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return this.events.toMessage();
  }

  /**
   * 拉取商家拜访明细（新专送拜访，15 分）：调风神 xtop querySubTaskPage → 落历史库。
   * 入参：mainTaskId（缺省 VISIT_MAIN_TASK_ID / 91467）、date（YYYY-MM-DD，缺省今天）。
   * 返回 {ok, msg, visited, total}（提取不到时 visited/total 为 null，由计算侧降级）。
   */
  @Post('visit')
  async fetchVisit(@Body() b: { mainTaskId?: number; date?: string }) {
    try {
      const r = await this.visitSvc.fetchAndLand(b.mainTaskId, b.date);
      return r;
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 读取服务端自动取数配置（enabled / intervalSec，多端共享）。 */
  @Get('auto')
  getAuto() {
    return this.auto.getConfig();
  }

  /**
   * 写入服务端自动取数配置：前端「自动/手动」开关与间隔选择落在这里（多端共享，末次写入生效）。
   * 自动 = 服务端按 intervalSec 定时取数并推送；手动 = 关闭服务端定时，仅手动刷新按钮取数。
   */
  @Post('auto')
  setAuto(@Body() b: { enabled?: boolean; intervalSec?: number }) {
    this.auto.setConfig(b.enabled === true, b.intervalSec);
    return this.auto.getConfig();
  }

  /** 读取本地 teams.json 的全部站点 id（运单全站单文件失效缓存时用到）。
   *  ⚠️ 路径必须与 TeamsFetchService.persist() 的 teamsFilePath() 完全一致（process.cwd()/runtime/teams.json）：
   *  二者不一致时本方法会读到空数组，导致 notifyInvalidate 拿不到 teams 而静默不失效缓存，
   *  表现即「刷新了但看板数字没变、也不报错」。旧实现走 PROJECT_ROOT/apps/api/runtime，
   *  在 Nest 工作目录恰为 apps/api 时撞巧一致，但属脆弱巧合，这里改为与落盘方同源。 */
  private allTeamIds(): string[] {
    try {
      const p = path.join(process.cwd(), 'runtime', 'teams.json');
      const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const list = Array.isArray(d) ? d : d.teams;
      if (Array.isArray(list)) {
        return list.map((t: { id?: string | number }) => String(t.id)).filter(Boolean);
      }
    } catch {
      /* teams.json 缺失时返回空，notifyInvalidate 会退化为整体清缓存（见下） */
    }
    return [];
  }
}
