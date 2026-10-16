import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { RefreshRunnerService } from '../../../fetch/runners/refresh-runner.service';
import { RawCacheService, RAW_KINDS, RawKind } from '../../../fetch/storage/raw-cache.service';

/**
 * 全量刷新入口（`/api/standard/refresh-all` + `-status`）。
 *
 * 原先由 Nest 代理给 Python `dashboard/standard/refresh_all.py`，现已原生化：
 * 编排在 `RefreshRunnerService`（阶段调度 / 状态机 / 日志 / 单飞），计算在 Python
 * （`/api/compute/{violations,rider-dimension,achievement}`）。
 *
 * 频控（60s/用户 + 15s 全局间隔）、数据权限收敛（受限用户只刷可见站点，收敛为空必须 403）
 * 与单飞语义都实现在 runner 里 —— 因为 `ProxyController` 的 `standard/{*path}` 通配也会
 * 命中这个路径，两处必须走同一份逻辑。本控制器只做 HTTP 粘合。
 */
@Controller('api')
export class RefreshController {
  constructor(
    private readonly runner: RefreshRunnerService,
    private readonly raw: RawCacheService,
  ) {}

  @Post('standard/refresh-all')
  start(
    @Req() req: Request,
    @Body() body: { teams?: unknown; start?: string; end?: string },
  ) {
    return this.runner.startFromRequest(req, body);
  }

  @Get('standard/refresh-all-status')
  status(@Req() req: Request) {
    return { ok: true, status: this.runner.status(req) };
  }

  /**
   * 标准达成看板原始层写端点（Nest 调用方直接落盘，不再经 Python 回调）。
   * 支持通用 payload 与 violation 的 rows 形态（后者由 `RawCacheService.saveViolation`
   * 组装 `fetch_ok` 包装，使「已刷新但 0 条」与「未刷新」可区分）。
   */
  @Post('standard/raw')
  saveRaw(
    @Body()
    body: {
      kind?: string;
      team?: string;
      date?: string;
      payload?: unknown;
      rows?: unknown[];
      ok?: boolean;
      error?: unknown;
    },
  ) {
    const kind = String(body?.kind || '');
    const team = String(body?.team ?? '').trim();
    const date = String(body?.date ?? '').trim();
    if (!(RAW_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, error: `kind 非法：${body?.kind}（可用 ${RAW_KINDS.join('/')}）` };
    }
    if (!team || !date) return { ok: false, error: '缺少 team 或 date' };
    try {
      const saved =
        kind === 'violation' && body?.rows !== undefined
          ? this.raw.saveViolation(team, date, body.rows ?? [], body.ok !== false, body.error)
          : this.raw.saveRaw(kind as RawKind, team, body?.payload, date);
      return { ok: true, saved, skipped: !saved ? 'payload 为空，按约定不写' : null };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
