import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { QuarkCredsService } from '../creds/quark-creds.service';

/**
 * 登录态探针（原 Python `server.py::check_cookie_status` / `_check_aeolus_cookie` /
 * `_check_quark_cookie` 的 Nest 原生实现），供 `GET /api/cookies/status`。
 *
 * 语义（务必保持，前端顶部胶囊按它渲染）：
 *   · 只读 —— 绝不写文件、绝不触发重登；单次 < 300ms，前端 60s 轮一次；
 *   · 任何探针异常都被**结构化捕获**，绝不冒泡成 500（否则前端 r.json() 失败，
 *     会把真实错误吞成「状态未知」）；
 *   · aeolus 三态：valid / invalid / unknown；quark 四态：valid / invalid / nocache / unknown。
 *   · invalid 表示「凭证确实废了」，unknown 表示「这次没测出来」—— 二者绝不能混，
 *     否则网络抖动会误导用户去重兑 / 重登。
 */
const AEOLUS_VALID_TOKEN_URL = 'https://httpizza.ele.me/lpd.meepo.session/aeolus/validToken';
const AEOLUS_PROBE_TIMEOUT_MS = 10_000;
/** 与 Python 一致：探针 UA 固定，不带浏览器指纹。 */
const AEOLUS_PROBE_UA = 'workbench/1.0';

export type TriState = 'valid' | 'invalid' | 'unknown';
export type QuarkState = 'valid' | 'invalid' | 'nocache' | 'unknown';

export interface AeolusStatus {
  ok: true;
  status: TriState;
  checked_at: string;
  reason?: string;
}

export interface QuarkStatus {
  ok: true;
  status: QuarkState;
  reason: string;
  checked_at: string;
  age_hours: number | null;
}

export interface CookieStatus extends AeolusStatus {
  quark: QuarkStatus;
}

/** 本地时间戳 `YYYY-MM-DD HH:mm:ss`（与 Python `datetime.now().strftime(...)` 同格式）。 */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

@Injectable()
export class CookieStatusService {
  private readonly logger = new Logger(CookieStatusService.name);
  private readonly cookieFile: string;

  constructor(
    private readonly config: ConfigService,
    private readonly quark: QuarkCredsService,
  ) {
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.cookieFile = path.join(root, 'backend', 'aeolus_sdk', 'cookie.txt');
  }

  /** 风神 + Quark 的合并状态（`GET /api/cookies/status` 的完整响应体）。 */
  async check(): Promise<CookieStatus> {
    const checkedAt = stamp();

    // 两个探针互不依赖（aeolus 只读本地 cookie.txt，quark 只读 da_cache.json，
    // 都不触发重登/写盘），故并发执行：总耗时 = max(①,②) 而非 ①+②。
    // 串行时 ≈ 250ms+250ms≈500ms；并发后 ≈ 250ms，回到「单次 < 300ms」目标。
    const [aeolus, quark] = await Promise.all([
      this.checkAeolus().catch((e: unknown) => this.aeolusUnknown(e, checkedAt)),
      this.quark
        .cacheStatus()
        .then((q) => ({ ok: true, ...q, checked_at: checkedAt }) as QuarkStatus)
        .catch((e: unknown) => this.quarkUnknown(e, checkedAt)),
    ]);

    return { ...aeolus, quark };
  }

  private aeolusUnknown(e: unknown, checkedAt: string): AeolusStatus {
    this.logger.error(`[cookies/status] aeolus 探针异常: ${(e as Error).message}`);
    return {
      ok: true,
      status: 'unknown',
      reason: `aeolus 探针异常: ${String((e as Error).message).slice(0, 120)}`,
      checked_at: checkedAt,
    };
  }

  private quarkUnknown(e: unknown, checkedAt: string): QuarkStatus {
    this.logger.error(`[cookies/status] quark 探针异常: ${(e as Error).message}`);
    return {
      ok: true,
      status: 'unknown',
      reason: `quark 探针异常: ${String((e as Error).message).slice(0, 120)}`,
      checked_at: checkedAt,
      age_hours: null,
    };
  }

  /**
   * 风神 `backend/aeolus_sdk/cookie.txt` 有效性（validToken 探针）。三态：valid / invalid / unknown。
   *
   * 判定口径与 Python 的 `urllib.urlopen` 对齐：能拿到响应（2xx）→ valid；
   * 401 → invalid；其它 4xx/5xx → unknown（HTTP N）；网络异常 → unknown。
   */
  private async checkAeolus(): Promise<AeolusStatus> {
    const checkedAt = stamp();

    if (!fs.existsSync(this.cookieFile)) {
      return {
        ok: true,
        status: 'unknown',
        reason: 'backend/aeolus_sdk/cookie.txt 不存在',
        checked_at: checkedAt,
      };
    }

    let cookie = '';
    try {
      cookie = fs.readFileSync(this.cookieFile, 'utf-8').trim();
    } catch (e) {
      return {
        ok: true,
        status: 'unknown',
        reason: `读取 backend/aeolus_sdk/cookie.txt 失败: ${(e as Error).message}`,
        checked_at: checkedAt,
      };
    }
    if (!cookie) {
      return {
        ok: true,
        status: 'unknown',
        reason: 'backend/aeolus_sdk/cookie.txt 为空',
        checked_at: checkedAt,
      };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AEOLUS_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(AEOLUS_VALID_TOKEN_URL, {
        headers: { Cookie: cookie, 'User-Agent': AEOLUS_PROBE_UA },
        signal: ctrl.signal,
      });
      // 只为确认可达，不解析正文（Python 也只 read(64) 就丢）。
      await res.arrayBuffer();
      if (res.status === 401) {
        return { ok: true, status: 'invalid', checked_at: checkedAt };
      }
      if (!res.ok) {
        return { ok: true, status: 'unknown', reason: `HTTP ${res.status}`, checked_at: checkedAt };
      }
      return { ok: true, status: 'valid', checked_at: checkedAt };
    } catch (e) {
      return {
        ok: true,
        status: 'unknown',
        reason: String((e as Error).message).slice(0, 80),
        checked_at: checkedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
