import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { AeolusLoginService } from './aeolus-login.service';

/**
 * 风神登录态（cookie）的**状态与策略层**：文件读写 + 进程内复用 + 重登串行化。
 *
 * 协议本身在 `AeolusLoginService`（RSA + SSO 跳转 + validToken 探针）；本服务只决定
 * 「什么时候该登录」，对应 Python `aeolus_sdk/login.py` 的
 * `load_cookies / save_cookies / ensure_cookies / get_shared_cookies / refresh_shared_cookies`。
 *
 * 迁移动机（2026-09-23）：原来重登是 `spawn python -m aeolus_sdk.login`。取数既然全在 Nest，
 * 就不该让「取数」依赖 Python 运行时 —— 否则 Python 缺一个 venv，整条取数链就断了。
 *
 * 三处与 Python 的**行为差异**（都有意为之，且更严格）：
 *  1. `ensure()` 会做 validToken 探针。Python 的 `ensure_cookies` 也做；而迁移前的 Nest 版本
 *     只「文件存在就用」，于是拿着过期 cookie 反复打接口赚 401，还得靠 Python 侧
 *     `call_with_relogin` 兜。现在探针 + 进程内缓存（只探一次）既自愈又不浪费请求。
 *  2. `relogin()` **强制**新登录，不复用内存 token。Python 的 `refresh_shared_cookies` 在内存
 *     已有 token 时直接返回它 —— 而调用方正是「刚被 401 顶掉」的场景，返回旧 token 会让
 *     重试再失败、白转一圈。并发重登用 in-flight promise 合并（同一时刻只真登一次）。
 *  3. `force=true` 的语义仍是「忽略进程内缓存」（不是「强制新登录」）—— 与迁移前的
 *     `ensure(true)` 一致（那时它 spawn 的 Python 入口同样会先复查文件 cookie）。
 *
 * 跨进程锁（原 `aeolus_sdk/xlock.py`）已不需要：迁移后 writer 只有本进程（Python 侧不再有
 * 任何登录/写 cookie 的代码）。跨进程读由原子写（临时文件 + rename）保证不会读到半截。
 */
@Injectable()
export class AeolusCookieService {
  private readonly logger = new Logger(AeolusCookieService.name);
  private readonly cookieFile: string;
  /** 进程内共享登录态：等价 Python `_shared_cookie`。 */
  private cached: string | null = null;
  /** 进程内串行锁（等价 Python `_shared_lock`）：Node 单线程，用 promise 链即可。 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 并发重登合并：同一时刻只真登一次，其余复用同一结果。 */
  private reloginInFlight: Promise<string> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly sso: AeolusLoginService,
  ) {
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.cookieFile =
      (process.env.AEOLUS_COOKIE_FILE || '').trim() ||
      // 2026-09-24：aeolus_sdk/ 已移入 backend/ 下（它是本模块的产物，归到写入方一侧）。
      path.join(root, 'backend', 'aeolus_sdk', 'cookie.txt');
  }

  /** 读取本地 cookie 头字符串；不存在/为空返回 null（同步，供只读调用方）。 */
  get(): string | null {
    try {
      const s = fs.readFileSync(this.cookieFile, 'utf-8').trim();
      return s || null;
    } catch {
      return null;
    }
  }

  /** cookie 文件路径（供探针 / 诊断读取）。 */
  file(): string {
    return this.cookieFile;
  }

  /** 上次成功探针的时间戳（ms）：窗口内信任缓存，避免每次取数都打探针。 */
  private cachedProbedAt = 0;
  /** 缓存信任窗口：60s 内复用已验证 cookie，超出则重新探针（仍可自愈）。 */
  private static readonly PROBE_TTL_MS = 60_000;

  /**
   * 确保拿到可用 cookie。
   *
   * `force=true`：忽略进程内缓存，重新走「读文件 → 探针 → 必要时登录」。
   *
   * ⚠️ 修复（2026-09-28）：原实现 `if (!force && this.cached) return this.cached`
   * 一旦进程内缓存过有效 cookie，就**永远跳过探针**，即使 cookie 早已过期
   * （账户下线）也照用不误 → 所有走 ensure() 的取数静默吃 401、返回空（这正是
   * 「商站任务抓不到数据」的根因之一）。现改为：缓存仅在该窗口内被信任，超出则
   * 重新打 validToken 探针；失效则走重登自愈。
   */
  async ensure(force = false): Promise<string> {
    if (
      !force &&
      this.cached &&
      Date.now() - this.cachedProbedAt < AeolusCookieService.PROBE_TTL_MS
    ) {
      return this.cached;
    }
    if (!force) {
      const candidate = this.cached ?? this.get();
      if (candidate && (await this.sso.checkLogin(candidate))) {
        this.cached = candidate;
        this.cachedProbedAt = Date.now();
        return candidate;
      }
      this.cached = null;
    }
    return this.loginLocked();
  }

  /**
   * 被 401 顶号后调用：**强制**新登录（不复用文件、不复用内存 token）。
   * 并发调用合并为一次真实登录，避免互相顶号（SSO 乒乓）。
   */
  async relogin(): Promise<string> {
    if (this.reloginInFlight) {
      this.logger.warn('风神会话失效，已有一轮重登在进行，复用其结果…');
      return this.reloginInFlight;
    }
    this.logger.warn('风神会话失效，重新登录…');
    const p = this.withLock(async () => {
      const fresh = await this.sso.login();
      this.saveCookie(fresh);
      this.cached = fresh;
      this.logger.log('重登完成，已拿到新 cookie');
      return fresh;
    }).finally(() => {
      this.reloginInFlight = null;
    });
    this.reloginInFlight = p;
    return p;
  }

  /**
   * 退出登录（WebUI 系统设置「账号设置」→ 退出登录）：清空进程内登录态并删除本地 cookie 文件。
   * 不删除账号密码配置；下次取数 / `ensure()` 会用已保存凭据自动重登，故本操作只"使当前会话失效"。
   */
  async logout(): Promise<{ ok: boolean; removed: boolean }> {
    this.cached = null;
    this.cachedProbedAt = 0;
    this.reloginInFlight = null;
    let removed = false;
    try {
      if (fs.existsSync(this.cookieFile)) {
        fs.unlinkSync(this.cookieFile);
        removed = true;
      }
    } catch (e) {
      this.logger.warn(`退出登录时删除 cookie 文件失败：${(e as Error).message}`);
    }
    this.logger.log('已退出风神登录态（本地 cookie 已清除）');
    return { ok: true, removed };
  }

  /** 锁内：先复查（等锁期间可能已被刷新），仍无效才真登录。 */
  private loginLocked(): Promise<string> {
    return this.withLock(async () => {
      if (this.cached) return this.cached;
      const existing = this.get();
      if (existing && (await this.sso.checkLogin(existing))) {
        this.cached = existing;
        this.cachedProbedAt = Date.now();
        return existing;
      }
      const fresh = await this.sso.login();
      this.saveCookie(fresh);
      this.cached = fresh;
      this.cachedProbedAt = Date.now();
      return fresh;
    });
  }

  /** promise 链互斥（失败不阻断后续）。 */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 原子写 cookie 文件（临时文件 + rename），并收窄权限到 0600。 */
  private saveCookie(cookie: string): void {
    const dir = path.dirname(this.cookieFile);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.cookieFile}.tmp${process.pid}`;
      fs.writeFileSync(tmp, cookie + '\n', 'utf-8');
      try {
        fs.chmodSync(tmp, 0o600);
      } catch {
        /* Windows 下影响有限 */
      }
      fs.renameSync(tmp, this.cookieFile);
    } catch (e) {
      // 写盘失败不该让登录白做：内存里仍有可用 token，但下次重启会丢 —— 必须显式告警。
      this.logger.error(`cookie 落盘失败（${this.cookieFile}）：${(e as Error).message}`);
      throw new Error(`cookie 落盘失败：${(e as Error).message}`);
    }
  }
}
