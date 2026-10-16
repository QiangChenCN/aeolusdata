import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AeolusCookieService } from './aeolus-cookie.service';

/**
 * Quark 报表凭证链（**原生 NestJS 实现**，替代原 Python `quark_sdk/` + `tools/quark_creds_dump.py`）。
 *
 * 鉴权链路（2026-08-19 实测确认）：
 *   1. Aeolus SSO cookie（读 backend/aeolus_sdk/cookie.txt；失效时由 AeolusCookieService 触发重登）
 *   2. GET app2-edu.ele.me/kunkka-svr/fs/fbi/getReport?reportId=860325 → 带 QUARK_PARAMS 的 iframe URL
 *   3. GET report.htm?...（**必须走 curl**：urllib/Node fetch 的 ClientHello 指纹会被网关 403）
 *      → 302 到 daLogin.htm?DA_SESSION=...
 *   4. GET daLogin.htm（带 Aeolus 令牌，跟随 302 回 quark）→ 种下 DA_TOKEN_lpd_meepo_ws
 *   5. 读 curl cookie 罐 → 拼出 quark 域 cookie 串（供 WidgetAction 使用）
 *
 * 另外两次 HTTP（不带 QUARK_PARAMS 的报表页）用于提取 reportIdToken / secureParams / metaTime。
 *
 * 缓存：`backend/data/quark/da_cache.json`（{cookie, jar, saved_at}）。
 *   · 缓存探活通过则直接复用（省掉 3 次网络往返）；
 *   · 失效或被强制时重新兑换。写盘用「临时文件 + rename」保证原子性。
 *   · 该文件现在是 Nest 独占写入方（原 Python 侧写入方已删除），不再需要跨进程锁。
 */
export interface QuarkCreds {
  daCookie: string;
  daSource: string;
  reportIdToken: string;
  secureParams: string;
  metaTime: string;
}

/** quark 域（读 DA cookie 罐时按此域名筛选）。报表 ID 由各调用方显式传入，不在此设默认。 */
const QUARK_DOMAIN = 'quark.alibaba.com';
/** DA cookie 健康探针：/fbi/** 受 DA 网关保护（无效 cookie 会被踢回 HTML 登录页）。 */
const DA_HEALTH_URL =
  'https://quark.alibaba.com/fbi/fbi.json?action=site/FbiSiteAction&event_submit_doGetSite=true';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0';

@Injectable()
export class QuarkCredsService {
  private readonly logger = new Logger(QuarkCredsService.name);
  private readonly dataDir: string;
  private readonly cachePath: string;
  private readonly jarPath: string;
  private readonly manualPath: string;

  constructor(
    private readonly config: ConfigService,
    private readonly aeolus: AeolusCookieService,
  ) {
    const root = path.resolve(
      this.config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.dataDir = path.join(root, 'backend', 'data', 'quark');
    this.cachePath = path.join(this.dataDir, 'da_cache.json');
    this.jarPath = path.join(this.dataDir, 'da_cookies.txt');
    this.manualPath = path.join(this.dataDir, 'manual_cookie.txt');
  }

  // ───────────── curl 封装（中性 TLS 指纹，urllib/fetch 替代不了）─────────────
  private curl(
    extra: string[],
    opts: {
      cookieHeader?: string;
      jar?: string;
      captureRedirect?: boolean;
      maxRedirs?: number;
      timeout?: number;
      /** 额外捕获 HTTP 状态码（附加 -w），供探针区分「401/403 硬拒」与「HTML 登录页」。 */
      captureStatus?: boolean;
      /**
       * 跟随重定向（-L）。探针必须开：DA cookie 失效时该端点会先回 302 再落到
       * 403 / 登录页；不跟随只能看到「302 + 空正文」，会把「已废」误判成「未知」。
       * 与迁移前 Python 用 `urllib.urlopen`（默认跟随）的口径对齐。
       */
      followRedirects?: boolean;
    } = {},
  ): Promise<{ stdout: string; code: number; httpStatus: number | null }> {
    const cmd: string[] = ['-sS', '--compressed'];
    if (opts.followRedirects) cmd.push('-L');
    if (opts.jar) cmd.push('-c', opts.jar, '-b', opts.jar);
    if (opts.cookieHeader) cmd.push('-H', `cookie: ${opts.cookieHeader}`);
    if (opts.captureRedirect) {
      // 用 NUL/空设备丢弃正文，只把重定向目标打到 stdout。
      cmd.push(
        '--max-redirs',
        '0',
        '-o',
        process.platform === 'win32' ? 'NUL' : '/dev/null',
        '-w',
        '%{redirect_url}',
      );
    } else if (opts.maxRedirs != null) {
      cmd.push('--max-redirs', String(opts.maxRedirs));
    }
    if (opts.captureStatus) {
      // 把 HTTP 状态码追加到 stdout 末尾（形如 "\n403"）。curl 不带 -f 时 4xx 也返回正文，
      // 因此必须靠 -w 拿到状态码，才能把「401/403 硬拒」与「HTML 登录页」分开。
      cmd.push('-w', '\n%{http_code}');
    }
    cmd.push('--connect-timeout', '20', '--max-time', String(opts.timeout ?? 60));
    cmd.push(...extra);
    return new Promise((resolve, reject) => {
      execFile('curl', cmd, { encoding: 'buffer', timeout: (opts.timeout ?? 60) * 1000 + 15000, maxBuffer: 32 * 1024 * 1024 }, (err, so) => {
        if (err && (err as { code?: string }).code === 'ENOENT') {
          reject(
            new Error('未找到 curl（请安装或加入 PATH）；Quark DA 兑换需要 curl 的中性 TLS 指纹'),
          );
          return;
        }
        // 显式 UTF-8 解码且允许替换：绝不按系统 ANSI 解码（否则非 UTF-8 字节会抛错）。
        let stdout = (so as Buffer).toString('utf-8');
        let httpStatus: number | null = null;
        if (opts.captureStatus) {
          const i = stdout.lastIndexOf('\n');
          if (i >= 0) {
            const n = Number(stdout.slice(i + 1).trim());
            stdout = stdout.slice(0, i);
            httpStatus = Number.isFinite(n) && n > 0 ? n : null;
          }
        }
        resolve({ stdout, code: err ? 1 : 0, httpStatus });
      });
    });
  }

  // ───────────── cookie 罐解析 ─────────────
  /** 从 Netscape cookie 罐里挑出 quark 域 cookie，拼成 'a=1; b=2'。 */
  private readQuarkCookieStr(jarPath: string): string {
    if (!fs.existsSync(jarPath)) return '';
    const pairs: string[] = [];
    for (const line of fs.readFileSync(jarPath, 'utf-8').split(/\r?\n/)) {
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 7) continue;
      let [domain, , , , , name, value] = parts;
      if (domain.startsWith('#HttpOnly_')) domain = domain.slice('#HttpOnly_'.length);
      if (domain.includes(QUARK_DOMAIN)) pairs.push(`${name}=${value}`);
    }
    return pairs.join('; ');
  }

  // ───────────── 缓存 ─────────────
  private loadCache(): { cookie: string; jar: string; ageSec: number | null } | null {
    try {
      const d = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
      const cookie = String(d.cookie || '').trim();
      if (!cookie) return null;
      const savedAt = Number(d.saved_at || 0);
      return {
        cookie,
        jar: d.jar || this.jarPath,
        ageSec: savedAt ? Date.now() / 1000 - savedAt : null,
      };
    } catch {
      return null;
    }
  }

  private saveCache(cookie: string, jar: string): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = this.cachePath + '.tmp';
      fs.writeFileSync(
        tmp,
        JSON.stringify({ cookie, jar, saved_at: Date.now() / 1000 }, null, 2),
        'utf-8',
      );
      fs.renameSync(tmp, this.cachePath);
    } catch (e) {
      this.logger.warn(`写入 DA cookie 缓存失败: ${(e as Error).message}`);
    }
  }

  /** Quark DA cookie 有效性探针（布尔版，供兑换流程复用）。 */
  async probeHealthy(cookie: string): Promise<boolean> {
    return (await this.probeDetail(cookie)).kind === 'valid';
  }

  /**
   * 健康探针「详细版」：把 401/403 硬拒、HTML 登录页、非 JSON 怪响应、网络异常区分开。
   *
   * 语义与迁移前的 Python `server.py::_check_quark_cookie` 一致 —— 前端顶部胶囊依赖这个
   * 区分：网络抖动应显示「状态未知」而不是「凭证已废」（后者会误导用户去重兑）。
   */
  async probeDetail(
    cookie: string,
  ): Promise<{ kind: 'valid' } | { kind: 'invalid' | 'unknown'; reason: string }> {
    let stdout = '';
    let httpStatus: number | null = null;
    try {
      const r = await this.curl([DA_HEALTH_URL], {
        cookieHeader: cookie,
        timeout: 20,
        captureStatus: true,
        followRedirects: true,
      });
      stdout = r.stdout;
      httpStatus = r.httpStatus;
    } catch (e) {
      return { kind: 'unknown', reason: `探针异常: ${(e as Error).message.slice(0, 80)}` };
    }
    // 先看状态码：urllib 的 HTTPError 语义 = 连正文都不该信。curl 不带 -f 时 4xx 也会
    // 返回正文，所以这里靠 -w 拿到的状态码，而不是靠正文形状来判。
    if (httpStatus === 401 || httpStatus === 403) {
      return { kind: 'invalid', reason: `探针被网关硬拒（HTTP ${httpStatus}）` };
    }
    if (httpStatus != null && (httpStatus < 200 || httpStatus >= 400)) {
      return { kind: 'unknown', reason: `HTTP ${httpStatus}` };
    }
    const body = stdout.trim();
    if (!body) return { kind: 'unknown', reason: '响应为空，按未知处理' };
    if (body.startsWith('<')) {
      return { kind: 'invalid', reason: '探针被踢回 HTML 登录页（DA cookie 已废）' };
    }
    try {
      JSON.parse(body);
    } catch {
      // 非 JSON 非登录页的怪响应 → 保守报 unknown（不假报有效）。
      return { kind: 'unknown', reason: '响应既非 JSON 也非登录页，按未知处理' };
    }
    return { kind: 'valid' };
  }

  /**
   * 读缓存原始内容：区分「文件不存在」与「文件在但缺 cookie 字段」（缓存损坏）。
   *
   * 与 `loadCache()` 的差别：后者把这两种情况都折叠成 null，无法支撑前端
   * 「还没兑换过」vs「缓存坏了」的分辨。
   */
  private readCacheRaw(): { found: boolean; cookie: string; ageSec: number | null } {
    let text: string;
    try {
      text = fs.readFileSync(this.cachePath, 'utf-8');
    } catch {
      return { found: false, cookie: '', ageSec: null };
    }
    try {
      const d = JSON.parse(text);
      const savedAt = Number(d.saved_at || 0);
      return {
        found: true,
        cookie: String(d.cookie || '').trim(),
        ageSec: savedAt ? Date.now() / 1000 - savedAt : null,
      };
    } catch {
      // 文件在但内容不是合法 JSON（半写）→ 视为「缓存损坏」：found=true 但 cookie 为空。
      return { found: true, cookie: '', ageSec: null };
    }
  }

  /** 当前缓存状态（只读，供 /api/fetch/quark/status 与 /api/cookies/status）。 */
  async cacheStatus(): Promise<{
    status: 'valid' | 'invalid' | 'nocache' | 'unknown';
    reason: string;
    age_hours: number | null;
  }> {
    const raw = this.readCacheRaw();
    if (!raw.found) {
      return {
        status: 'nocache',
        reason: 'da_cache.json 不存在（尚未兑换 Quark DA cookie）',
        age_hours: null,
      };
    }
    const ageHours = raw.ageSec == null ? null : raw.ageSec / 3600;
    if (!raw.cookie) {
      // 缓存存在但缺 cookie 字段 = 格式损坏。照实报，不假装失效、也不假装有效。
      return {
        status: 'unknown',
        reason: 'Quark 缓存缺少 cookie 字段（缓存损坏，建议删除后重跑装备任务）',
        age_hours: ageHours,
      };
    }
    const p = await this.probeDetail(raw.cookie);
    if (p.kind === 'valid') {
      return { status: 'valid', reason: '探针放行（返回 JSON）', age_hours: ageHours };
    }
    return { status: p.kind, reason: p.reason, age_hours: ageHours };
  }

  // ───────────── 兑换 ─────────────
  /** GET getReport → 带 QUARK_PARAMS 的 iframe URL（reportId 决定取哪个报表的 token）。 */
  private async getReportUrl(aeoCookie: string, reportId: string): Promise<string> {
    const endpoint = `https://app2-edu.ele.me/kunkka-svr/fs/fbi/getReport?reportId=${reportId}`;
    const res = await fetch(endpoint, {
      headers: {
        accept: 'application/json, text/plain, */*',
        cookie: aeoCookie,
        origin: 'https://a.ele.me',
        referer: 'https://a.ele.me/',
        'user-agent': UA,
      },
    });
    const j = (await res.json()) as { data?: { url?: string } };
    const url = j.data?.url;
    if (!url) {
      throw new Error(`getReport 未返回 url：${JSON.stringify(j).slice(0, 300)}`);
    }
    return url;
  }

  /** 纯 HTTP 兑换 DA_TOKEN，写 curl 罐，返回 quark 域 cookie 串。 */
  private async acquireDaToken(aeoCookie: string, reportId: string): Promise<string> {
    if (!aeoCookie) throw new Error('缺少 Aeolus cookie（AEOLUS_MOZI_TOKEN），无法兑换 DA_TOKEN');
    const reportUrl = await this.getReportUrl(aeoCookie, reportId);
    this.logger.log(`[da] getReport ok（QUARK_PARAMS 长度 ${reportUrl.split('QUARK_PARAMS=')[1]?.length ?? 0}）`);

    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.jarPath, '', 'utf-8'); // 清掉旧罐，只采集本次链路

    // report.htm（curl 中性指纹）→ 302 daLogin（含 DA_SESSION）
    const r1 = await this.curl([reportUrl], { captureRedirect: true });
    const daLogin = r1.stdout.trim();
    if (!daLogin.includes('DA_SESSION=')) {
      throw new Error(`report.htm 未返回 daLogin 302（curl 拿到: ${r1.stdout.slice(0, 300)}）`);
    }
    this.logger.log('[da] report.htm -> daLogin 302 含 DA_SESSION ✅');

    // daLogin（带 Aeolus 令牌）→ 跟随 302 回 quark → 种 DA_TOKEN
    await this.curl([daLogin, '-L'], { cookieHeader: aeoCookie, jar: this.jarPath });

    const cookieStr = this.readQuarkCookieStr(this.jarPath);
    if (!cookieStr.split('; ').some((c) => c.startsWith('DA_TOKEN'))) {
      let jarTxt = '';
      try {
        jarTxt = fs.readFileSync(this.jarPath, 'utf-8').slice(0, 600);
      } catch {
        /* ignore */
      }
      throw new Error(`daLogin 后未在罐中找到 DA_TOKEN。罐内容:\n${jarTxt}`);
    }
    this.logger.log(`[da] DA_TOKEN 已获取 ✅（共 ${cookieStr.split('; ').length} 个 quark cookie）`);
    return cookieStr;
  }

  // ───────────── 报表页三件套 token ─────────────
  private unescapeJs(s: string): string {
    return JSON.parse(`"${s}"`) as string;
  }

  private extractPageTokens(html: string): {
    token: string | null;
    secure: string | null;
    metaTime: string | null;
  } {
    const grab = (re: RegExp): string | null => {
      const m = html.match(re);
      return m ? this.unescapeJs(m[1]) : null;
    };
    const token = grab(/reportIdToken\\":\\"((?:(?!\\").)*?)\\"/);
    const secure = grab(/secParam\\":\\"((?:(?!\\").)*?)\\"/);
    let metaTime = grab(/gmtModified\\":\\"?((?:(?!\\").)*?)\\"/);
    if (!metaTime) {
      const m2 = html.match(/gmtModified\\":\\"([^\\"]+)/);
      metaTime = m2 ? this.unescapeJs(m2[1]) : null;
    }
    return { token, secure, metaTime };
  }

  private async fetchTokens(
    aeoCookie: string,
    reportId: string,
  ): Promise<{ token: string; secure: string; metaTime: string }> {
    const reportUrl = await this.getReportUrl(aeoCookie, reportId);
    const { stdout: html } = await this.curl([reportUrl, '-L'], {
      jar: this.jarPath,
      timeout: 90,
    });
    if (!html.includes('reportIdToken') && !html.includes('hasPermission')) {
      throw new Error('报表页未返回有效内容（可能无权限 / QUARK_PARAMS 失效）');
    }
    const { token, secure, metaTime } = this.extractPageTokens(html);
    if (!token || !secure || !metaTime) {
      throw new Error('未能从报表页 window.PageInfo 提取 reportIdToken/secParam/gmtModified');
    }
    this.logger.log(
      `[tokens] 自动提取 reportIdToken(${token.length})/secParam(${secure.length})/gmtModified(${metaTime})`,
    );
    return { token, secure, metaTime };
  }

  // ───────────── 对外入口 ─────────────
  /** 取一次凭证三件套；forceRefresh=true 时忽略缓存强制重兑。 */
  async fetch(forceRefresh = false, reportId: string): Promise<QuarkCreds> {
    // Aeolus cookie：读本地共享文件（失效时才由 AeolusCookieService 触发 Python 重登）；
    // 不在此强踢登录 —— 会顶掉浏览器会话并加剧 SSO 乒乓。
    const aeoCookie = await this.aeolus.ensure();
    if (!aeoCookie) throw new Error('无法取得 Aeolus cookie');

    // 1) DA cookie：手动（env / 文件）> 缓存探活 > 重新兑换
    const manual = (process.env.QUARK_COOKIE || '').trim() || this.readManualCookie();
    let daCookie = '';
    let daSource = '';
    if (manual) {
      daCookie = manual;
      daSource = 'manual';
      this.logger.log('[cookie] 使用手动提供的 Quark DA cookie（QUARK_COOKIE / manual_cookie.txt）');
    } else {
      const cached = forceRefresh ? null : this.loadCache();
      if (cached) {
        const ageTxt =
          cached.ageSec == null ? '时间未知' : `${(cached.ageSec / 3600).toFixed(1)} 小时前`;
        this.logger.log(`[da-cache] 发现缓存 DA cookie（${ageTxt}），先探活...`);
        if (await this.probeHealthy(cached.cookie)) {
          this.logger.log('[da-cache] 缓存 DA cookie 存活，跳过兑换 ✅');
          daCookie = cached.cookie;
          daSource = 'cache';
        } else {
          this.logger.log('[da-cache] 缓存 DA cookie 已失效，重新兑换...');
        }
      } else {
        this.logger.log('[da-cache] 无可用缓存，走完整兑换链路');
      }
      if (!daCookie) {
        daCookie = await this.acquireDaToken(aeoCookie, reportId);
        daSource = 'fresh';
        this.saveCache(daCookie, this.jarPath);
      }
    }

    // 2) 报表页三件套（需要 jar 里的 DA cookie 才能过 DA 网关）
    const { token, secure, metaTime } = await this.fetchTokens(aeoCookie, reportId);

    return {
      daCookie,
      daSource,
      reportIdToken: token,
      secureParams: secure,
      metaTime,
    };
  }

  private readManualCookie(): string {
    try {
      return fs.readFileSync(this.manualPath, 'utf-8').trim();
    } catch {
      return '';
    }
  }
}
