import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 原始数据落盘的**唯一写入方**（原 Python `dashboard/standard/cache.py::save_raw`）。
 *
 * 为什么集中到 Nest：取数已全部归 NestJS，而「原始层落盘的时机」就是「取数成功的瞬间」
 * —— 写成 Python 侧的分支等于让两个进程都知道格式。现在格式只写在这一处，
 * Python 只保留**读**（`cache.load_raw`，计算的输入端口）。
 *
 * 格式必须与迁移前逐字节兼容（下游 Python 计算直接读这些文件）：
 *   `dashboard/data/{kind}_{team}_{date}.json`，`JSON.stringify(payload)`（无缩进、UTF-8 原样），
 *   非空才写（避免把已有数据冲成空）。
 *
 * kind 语义（与 Python `cache.RAW_KINDS` 一致）：
 *   · orders    运单明细原始行        list[dict]
 *   · sched     排班目标展平行        list[dict]
 *   · att       实时考勤原始快照      {tc, rows, fetched_at}
 *                 （tc 随数据一起落盘，重算时复用拉取时的时段，避免「拉的是午高峰、
 *                   重算按晚高峰算」的口径漂移）
 *   · violation 违规处罚明细          {date, team_id, fetched_at, fetch_ok, fetch_error, rows}
 *                 （包一层 dict，使「已刷新但 0 条」与「未刷新」可区分）
 *
 * 注意：**结果层**（`dashboard/standard/cache/{rider,ach}_*.json`）已**删除**——
 * 全仓无任何读取方（Python 无 `CACHE.load(` 调用、前端/Nest 亦不读），是 write-only 死物。
 */
export const RAW_KINDS = ['orders', 'sched', 'att', 'violation'] as const;
export type RawKind = (typeof RAW_KINDS)[number];

/**
 * 写原始层时的可选项。
 *
 * `notify`：写成功后是否通知 Python 失效进程内结果缓存，**默认 true（安全默认）**。
 *
 * 为什么默认「通知」而不是「不通知」：Python 的 `dashboard.standard.cache._RESULT_CACHE`
 * 是**计算进程内的 memoization**，Nest 直接写盘它完全不知情。漏一次通知，看板就返回一个过期
 * 聚合结果 —— 表现为「刷新显示成功、数字却不变」，且全程无报错（2026-09-23 刚踩过同源事故：
 * 那条 /api/cache/invalidate 链路 milli 级别的疏漏，排查成本极高）。
 * 把「记得调 invalidate」改成「除非显式豁免，否则自动通知」，新增写入入口就不可能漏。
 *
 * 唯一需要豁免的是 `POST /api/cache/raw`（见 CacheController）：那是 Python 自己把 payload
 * 交回来落盘的，它在发请求前已经在**同进程** `invalidate_results()` 过了，再回调一次就是
 * Python → Nest → Python 的无谓往返。
 */
export interface RawWriteOptions {
  notify?: boolean;
}

/** 北京时间当天 `YYYY-MM-DD`（与 Python `cache.today_ymd` 同口径）。 */
export function todayYmd(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 北京时间 `YYYY-MM-DD HH:MM:SS`（与 Python `%Y-%m-%d %H:%M:%S` 同口径）。 */
export function nowStamp(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (Array.isArray(v) || typeof v === 'string') return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

@Injectable()
export class RawCacheService {
  private readonly logger = new Logger(RawCacheService.name);
  private readonly dataDir: string;
  /** 结果层目录（dashboard/standard/cache）——只剩 pace_state 等非本服务产物。 */
  readonly cacheDir: string;

  constructor(private readonly config: ConfigService) {
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.dataDir = path.join(root, 'dashboard', 'data');
    this.cacheDir = path.join(root, 'dashboard', 'standard', 'cache');
  }

  /** 原始层文件路径（供诊断）。 */
  rawPath(kind: RawKind, team: string, date: string): string {
    return path.join(this.dataDir, `${kind}_${team}_${date}.json`);
  }

  /**
   * 写原始层（对应 Python `cache.save_raw`）：非空才写，成功返回 true。
   *
   * 写成功后**默认**通知 Python 失效该 team/date 的结果缓存（见 `RawWriteOptions.notify`）：
   * 让「写了一版新数据」与「让计算进程重算」成为同一件事。通知是 fire-and-forget，失败只
   * 告警、不改变本次落盘结果。
   *
   * 与 Python 版一致的失败语义：抛错由调用方决定怎么处理（Python 原实现是吞掉返回 False，
   * 但 `save_raw` 的调用方都处于已被外层 try 包裹的刷新流程里）。
   */
  saveRaw(
    kind: RawKind,
    team: string,
    payload: unknown,
    date: string,
    opts?: RawWriteOptions,
  ): boolean {
    if (!(RAW_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`未知原始数据类型: ${kind}（可用 ${RAW_KINDS.join('/')}）`);
    }
    if (isEmpty(payload)) return false;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.rawPath(kind, team, date), JSON.stringify(payload), 'utf-8');
    } catch (e) {
      this.logger.error(`落盘失败 ${kind}_${team}_${date}: ${(e as Error).message}`);
      throw e;
    }
    // 只在**真正写了**之后通知：空 payload 没写文件，缓存里的旧结果仍是有效的。
    if (opts?.notify !== false) {
      void this.invalidateResults([String(team)], String(date));
    }
    return true;
  }

  /**
   * 写站点违规明细（对应 Python `dashboard/realtime/violations.py::save_team`）。
   *
   * `ok=false` 表示本次拉取失败：**仍然落盘**（保留旧 rows 便于事后回查），但置
   * `fetch_ok=false`，使读侧 `load_team` 返回 None → 看板显示「—」。
   * 为什么必须记这个标记：同一天常被反复刷新，若某次失败却什么都不写，盘上留着上次
   * 成功的旧数据，看板会把它当当天数据继续算 —— 数字照常显示但已失真、全程无报错
   * （2026-09-22 排查 401 时发现的静默失真风险）。
   */
  saveViolation(
    team: string,
    date: string,
    rows: unknown[],
    ok = true,
    error?: unknown,
    opts?: RawWriteOptions,
  ): boolean {
    const err = ok ? null : String(error ?? '').slice(0, 300) || null;
    const payload = {
      date,
      team_id: String(team),
      fetched_at: nowStamp(),
      fetch_ok: !!ok,
      fetch_error: err,
      rows: rows ?? [],
    };
    return this.saveRaw('violation', String(team), payload, date, opts);
  }

  /**
   * 通知 Python 失效进程内结果缓存。
   *
   * 必须做这件事的原因：Python 的结果缓存（`dashboard.standard.cache._RESULT_CACHE`）
   * 是**计算进程内的 memoization**，Nest 直接写文件它不知情 —— 不通知的话，刷新完看板
   * 仍返回旧聚合结果，表现为「刷新了但数字没变」。
   *
   * 失败只告警、不影响调用方结果（缓存最多是滞后，正确性由下次重算保证）。
   *
   * 调用时机：`saveRaw` / `saveViolation` 写成功后默认自动调用（调用方无需再记得）；看板
   * 配置变更走 `invalidateAll()`。仍保留为公开方法，供「只失效、不落盘」的场景使用。
   */
  async invalidateResults(teams: string[], date: string): Promise<void> {
    const base = this.config.get<string>('PYTHON_COMPUTE_URL');
    if (!base) {
      this.logger.warn('PYTHON_COMPUTE_URL 未配置，跳过结果缓存失效通知');
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(`${base}/api/cache/invalidate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teams, date }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        this.logger.log(`已通知 Python 失效结果缓存（${teams.length} 站 / ${date}）`);
      } else {
        this.logger.warn(`结果缓存失效通知失败：HTTP ${res.status}`);
      }
    } catch (e) {
      this.logger.warn(
        `结果缓存失效通知异常：${(e as Error).message}（不影响本次抓取结果）`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 配置变更后**全量**失效 Python 结果缓存（对应 Python `_CACHE.clear_results()`）。
   *
   * 看板配置（考核标准 / 门槛封顶）迁移到 Nest 后，写入方变了，但计算进程内的结果缓存
   * 仍需失效，否则「改了标准再看板数字不变」。标准达成设置（grade-global）保存时触发
   * 全量失效（与 Python 原 handler 调用 `clear_results` 的范围一致）。
   */
  async invalidateAll(): Promise<void> {
    const base = this.config.get<string>('PYTHON_COMPUTE_URL');
    if (!base) {
      this.logger.warn('PYTHON_COMPUTE_URL 未配置，跳过全量失效');
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(`${base}/api/cache/invalidate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ all: true }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        this.logger.log('已通知 Python 全量失效结果缓存（配置变更）');
      } else {
        this.logger.warn(`全量失效通知失败：HTTP ${res.status}`);
      }
    } catch (e) {
      this.logger.warn(`全量失效通知异常：${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
