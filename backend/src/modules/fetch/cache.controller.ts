import { Body, Controller, Logger, Post } from '@nestjs/common';
import { RawCacheService, RAW_KINDS, RawKind } from './raw-cache.service';

/**
 * 缓存落盘端点（全局 `AccessGuard` 保护，机器令牌调用）。
 *
 * 存在的理由：取数已归 NestJS，而「原始层落盘的时机」就是取数成功的瞬间。但 Python 计算步
 * 里有一处仍需产生原始数据 —— 违规明细由 Python 解析 CSV 后按站点分组（字段口径逻辑在那边），
 * 以及 att/sched 的落盘时机嵌在计算流程里（日期由计算步决定）。与其让两个进程都知道文件格式，
 * 不如让 Python 把 payload 交回来，由 Nest **统一落盘**。
 *
 * 反向的读不在这里：Python 计算的输入直接读文件（`cache.load_raw`），不经 Nest ——
 * 那是进程内文件读取，多绕一圈 HTTP 没有收益。
 *
 * 结果缓存失效：现在由 `RawCacheService` **在写入后默认自动**通知 Python
 * （`RawWriteOptions.notify` 默认 true，见那里的注释）。本端点是唯一豁免：`/api/cache/raw`
 * 的 payload 来自 Python 自己，它在同进程已经失效过，再回调会造成 Python → Nest → Python
 * 的无谓往返，故显式 `notify: false`。
 */
@Controller('api/cache')
export class CacheController {
  private readonly logger = new Logger(CacheController.name);

  constructor(private readonly raw: RawCacheService) {}

  /**
   * 写原始层。
   *
   * body 两种形态：
   *   · 通用：`{ kind, team, date, payload }`
   *   · 违规明细：`{ kind: 'violation', team, date, rows, ok?, error? }` —— 由 Nest 组
   *     `fetch_ok` 包装（失败标记的格式只写在一处）
   */
  @Post('raw')
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
    const kind = String(body?.kind || '') as RawKind;
    const team = String(body?.team ?? '').trim();
    const date = String(body?.date ?? '').trim();
    if (!(RAW_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, error: `kind 非法：${body?.kind}（可用 ${RAW_KINDS.join('/')}）` };
    }
    if (!team || !date) {
      return { ok: false, error: '缺少 team 或 date' };
    }
    try {
      // notify:false —— 见本控制器文件头注释：调用方（Python）已在自己进程内失效过结果缓存。
      const saved =
        kind === 'violation' && body?.rows !== undefined
          ? this.raw.saveViolation(
              team,
              date,
              body.rows ?? [],
              body.ok !== false,
              body.error,
              { notify: false },
            )
          : this.raw.saveRaw(kind, team, body?.payload, date, { notify: false });
      // 空 payload 被静默跳过（与 Python save_raw 一致）—— 这不是错误，但调用方应能区分，
      // 否则「写成功了」和「因为是空所以没写」在日志里长得一样。
      return { ok: true, saved, skipped: !saved ? 'payload 为空，按约定不写' : null };
    } catch (e) {
      this.logger.error(`落盘 ${kind}_${team}_${date} 失败：${(e as Error).message}`);
      return { ok: false, error: (e as Error).message };
    }
  }
}
