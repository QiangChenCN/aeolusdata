import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { dirs } from '../../../config/paths';
import { describeNetError } from '../../../common/net-error';

/**
 * 风神（Aeolus）SSO 登录协议 —— 原 Python `aeolus_sdk/login.py` 的 Nest 移植。
 *
 * 为什么整体搬到 Node 而不是继续 spawn Python：登录是「取数」的前置能力，而取数已全部归
 * NestJS；留一个 `python -m aeolus_sdk.login` 会让 Nest 依赖 Python 运行时才能取数，
 * 与「Python 只做大计算」的边界相冲突。
 *
 * 协议（与 mozi-login.alibaba-inc.com 登录页所用 JS RSA 库逐字对齐）：
 *   [1] GET 登录页 → 正则取 rsaPublicKey / _sso_csrftoken_ / umidTokenId（同一会话）
 *   [2] RSA 加密账号密码：encodeURIComponent → UTF-8 字节 → 分块小端整数 → pow(m, 0x10001, n) → hex
 *   [3] POST doLogin.json → `content.type === 'redirect'` 才算成功
 *   [4] 跟随 redirectURL 完成 SSO 票据交接（同会话，状态码可能非 200）
 *   [5] 访问 aeolus.ele.me 取 `AEOLUS_MOZI_TOKEN`
 *
 * 与 Python 的两处**有意不同**（都更严格）：
 *   · 凭据改为**惰性读取**。Python 在 import 期就 `_load_credentials()`，凭据缺失会让
 *     「只是 import 一下」也直接抛错；这里只在真正登录时才要凭据。
 *   · 不支持 `AEOLUS_INSECURE_TLS`。Node 全局 `fetch` 无法按请求关证书校验（需要 undici
 *     Agent 依赖），且线上一直是通过校验的（探针与本服务的取数都在校验下成功）。
 */

// ───────────── 常量（与 Python 逐字一致）─────────────
const APP_NAME = 'LOGISTICS_COMPANY';
const TPL = 'mknnjrtsvw9cj96u';
const BACK_URL = `https://aeolus.ele.me?_tplCode=${TPL}`;
const PAGE_URL = `https://mozi-login.alibaba-inc.com/?APP_NAME=${APP_NAME}&BACK_URL=${encodeURIComponent(
  BACK_URL,
)}&moziAppType=${APP_NAME}`;
const LOGIN_URL = `https://mozi-login.alibaba-inc.com/rpc/login/doLogin.json?APP_NAME=${APP_NAME}&BACK_URL=${encodeURIComponent(
  BACK_URL,
)}&moziAppType=${APP_NAME}`;
const CHECK_URL = 'https://httpizza.ele.me/lpd.meepo.session/aeolus/validToken';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0';

const HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7',
  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  Origin: 'https://mozi-login.alibaba-inc.com',
  Referer: PAGE_URL,
  'User-Agent': UA,
  'sec-ch-ua': '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

/** 登录态探针请求头（与 Python `_CHECK_HEADERS` 一致）。 */
const CHECK_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://aeolus.ele.me',
  Referer: 'https://aeolus.ele.me/',
  'User-Agent': UA,
};

const REQ_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 20_000;
const MAX_REDIRECT_HOPS = 10;

/** 等价于 JS `encodeURIComponent` / Python `quote(s, safe="!~*'()-._")`。 */
export function encodeURIComponentLoose(s: string): string {
  const unreserved = /[A-Za-z0-9_.\-~]/;
  const safe = "!~*'()-._";
  let out = '';
  for (const ch of s) {
    if (unreserved.test(ch) || safe.includes(ch)) {
      out += ch;
    } else {
      for (const b of Buffer.from(ch, 'utf8')) {
        out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return out;
}

/** 模幂（平方-乘法）。 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

/**
 * 复刻 JS RSA 库（Dave Koelle 版）的**无填充分块**加密 —— 不是标准 PKCS#1。
 *
 * 明文按 `chunk = 2*(numDigits-1)` 字节分块（小端整数），每块 `pow(m, e, n)`，
 * 输出 hex 左补零到 `numDigits*4` 位后拼接。任何一步偏差都会导致「服务端返回账号密码错误」，
 * 而错误信息不会告诉你原因 —— 故本函数有与 Python 的逐向量等价测试。
 */
export function rsaEncryptJs(
  plaintext: string,
  modulusHex: string,
  exponentHex = '10001',
): string {
  const e = BigInt('0x' + exponentHex);
  const n = BigInt('0x' + modulusHex);
  const nbits = n.toString(2).length;
  const numDigits = Math.floor((nbits + 15) / 16);
  const biHigh = numDigits - 1;
  const chunk = 2 * biHigh; // 每块字节数
  const blockHexLen = (biHigh + 1) * 4; // 每块输出 hex 长度

  let buf = Buffer.from(plaintext, 'utf8');
  while (buf.length % chunk !== 0) {
    buf = Buffer.concat([buf, Buffer.from([0])]);
  }

  const out: string[] = [];
  for (let i = 0; i < buf.length; i += chunk) {
    let m = 0n;
    for (let j = chunk - 1; j >= 0; j--) {
      m = (m << 8n) | BigInt(buf[i + j]);
    }
    out.push(modPow(m, e, n).toString(16).padStart(blockHexLen, '0'));
  }
  return out.join('');
}

interface JarEntry {
  value: string;
  domain: string;
}

/**
 * 简易 cookie jar + 手工跳转跟随。
 *
 * 为什么不用 `fetch` 的 `redirect: 'follow'`：SSO 的票据交接全靠**每一跳**的 `Set-Cookie`
 * （登录页 JSESSIONID → doLogin → 交接 → aeolus），而 follow 模式拿不到中间响应的头。
 * Python 侧用的是 `urllib` 的 CookieProcessor + 自动跳转，等价能力只能这样补。
 */
class SsoSession {
  private jar = new Map<string, JarEntry>();

  private absorb(res: Response): void {
    const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const line of raw) {
      const parts = line.split(';');
      const pair = parts[0];
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      let domain = '';
      for (const attr of parts.slice(1)) {
        const eq = attr.indexOf('=');
        if (eq < 0) continue;
        if (attr.slice(0, eq).trim().toLowerCase() === 'domain') {
          domain = attr.slice(eq + 1).trim().replace(/^\./, '');
        }
      }
      if (!name) continue;
      if (value === '') continue; // 空值 = 服务端要求删除
      this.jar.set(name, { value, domain });
    }
  }

  private headerFor(url: string): string {
    const host = new URL(url).hostname;
    const out: string[] = [];
    for (const [name, e] of this.jar) {
      if (e.domain && host !== e.domain && !host.endsWith('.' + e.domain)) continue;
      out.push(`${name}=${e.value}`);
    }
    return out.join('; ');
  }

  /** 发一次请求并**手工跟随跳转**，每一跳都收 cookie。 */
  async open(url: string, init: { method?: string; body?: string } = {}): Promise<Response> {
    let current = url;
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
      const cookie = this.headerFor(current);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(current, {
          method: init.method ?? 'GET',
          body: init.body,
          headers: { ...HEADERS, ...(cookie ? { cookie } : {}) },
          redirect: 'manual',
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      this.absorb(res);
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString();
        continue;
      }
      return res;
    }
    throw new Error(`跳转次数超过 ${MAX_REDIRECT_HOPS} 次（起始 ${url}）`);
  }

  async text(url: string, init: { method?: string; body?: string } = {}): Promise<string> {
    const res = await this.open(url, init);
    return await res.text();
  }

  /** 最终 cookie 头：只保留 ele.me / alibaba 域且有值的（与 Python 的过滤逐字一致）。 */
  finalCookieString(): string {
    const pairs: string[] = [];
    for (const [name, e] of this.jar) {
      if (!(e.domain.includes('ele.me') || e.domain.includes('alibaba'))) continue;
      if (e.value === '' || e.value === 'null') continue;
      pairs.push(`${name}=${e.value}`);
    }
    return pairs.join('; ');
  }

  hasCookie(name: string): boolean {
    return this.jar.has(name);
  }
}

@Injectable()
export class AeolusLoginService {
  private readonly logger = new Logger(AeolusLoginService.name);
  private readonly credFile: string;

  constructor(private readonly config: ConfigService) {
    this.credFile = dirs.runtime('aeolus_sdk/credentials.json');
  }

  /**
   * 登录凭据：仅由「系统设置 → 风神设置」UI 维护到
   * `apps/api/runtime/aeolus_sdk/credentials.json`（已被 .gitignore 排除）。
   * 不读取任何环境变量 —— 风神账号密码只存在该文件，不落 .env。
   */
  credentials(): { account: string; password: string } {
    try {
      const d = JSON.parse(fs.readFileSync(this.credFile, 'utf-8'));
      if (d?.account && d?.password) {
        return { account: String(d.account), password: String(d.password) };
      }
    } catch {
      /* 落到下面的统一报错 */
    }
    throw new Error(
      '未找到风神登录凭据。请在「系统设置 → 风神设置」中保存账号密码（落盘到 ' +
        'apps/api/runtime/aeolus_sdk/credentials.json，已被 .gitignore 排除）。',
    );
  }

  /**
   * 完整 SSO 登录，返回 cookie 头字符串（如 `BucSsoJSESSIONID=...; AEOLUS_MOZI_TOKEN=...`）。
   *
   * `input` 是**临时凭据覆盖**，只有「系统设置 → 风神设置」的验证入口会用到：账号密码都传
   * 则用它登录，否则仍走 `credentials()` 读已保存的凭据。这样验证不必先把试填的凭据落盘。
   */
  async login(input?: { account?: string; password?: string }): Promise<string> {
    const override =
      input?.account && input?.password
        ? { account: input.account, password: input.password }
        : undefined;
    const { account, password } = override ?? this.credentials();
    const s = new SsoSession();

    // [1] 登录页（同一会话拿 rsaPublicKey + JSESSIONID）
    let html: string;
    try {
      html = await s.text(PAGE_URL);
    } catch (ex) {
      throw describeNetError('登录页请求失败', ex);
    }
    const pub = /'rsaPublicKey'\s*:\s*'([0-9a-fA-F]+)'/.exec(html)?.[1];
    if (!pub) throw new Error('未从登录页解析到 rsaPublicKey');
    const csrf = /'_sso_csrftoken_'\s*:\s*'([0-9A-Za-z]+)'/.exec(html)?.[1] ?? '';
    const umid = /'umidTokenId'\s*:\s*'([0-9A-Za-z]+)'/.exec(html)?.[1] ?? '';

    // [2] RSA 加密账号 / 密码
    const ea = rsaEncryptJs(encodeURIComponentLoose(account), pub);
    const ep = rsaEncryptJs(encodeURIComponentLoose(password), pub);

    const body =
      `_sso_csrftoken_=${csrf}&account=${ea}&password=${ep}&loginType=ACCOUNT&namespace=buc` +
      `&isRsaPwd=true&login_maintain=true&keepLogged=false&umidTokenId=${umid}&phoneNumToken=`;

    // [3] POST doLogin.json
    let txt: string;
    try {
      const res = await s.open(LOGIN_URL, { method: 'POST', body });
      txt = await res.text();
      if (res.status >= 400) {
        throw new Error(`doLogin HTTPError ${res.status}: ${txt.slice(0, 300)}`);
      }
    } catch (ex) {
      // HTTPError 是业务语义（自行构造），原样抛出；其余为网络层错误，展开 cause 再抛。
      const m = (ex as Error).message;
      throw m.startsWith('doLogin HTTPError') ? ex : describeNetError('doLogin 请求异常', ex);
    }

    let content: Record<string, any>;
    try {
      const j = JSON.parse(txt);
      content = (j?.content ?? {}) as Record<string, any>;
    } catch {
      throw new Error('doLogin 响应解析失败: ' + txt.slice(0, 200));
    }
    if (content.type !== 'redirect' || !content?.extInfo?.redirectURL) {
      throw new Error('登录失败: ' + String(content.msg ?? txt.slice(0, 200)));
    }

    // [4] 跟随 doLogin 重定向，完成 SSO 票据交接（同会话）
    const rurl = String(content.extInfo.redirectURL);
    const rurlAbs = rurl.startsWith('http')
      ? rurl
      : 'https://mozi-login.alibaba-inc.com' + rurl;
    try {
      await s.open(rurlAbs);
    } catch (ex) {
      // 交接页状态码可能非 200，但 cookie 已在 jar 中建立；这里只可能是网络层失败，记日志备查。
      this.logger.warn(String(describeNetError('SSO 票据交接请求异常（已忽略）', ex).message));
    }

    // [5] 访问 aeolus 拿 AEOLUS_MOZI_TOKEN
    try {
      await s.open(BACK_URL);
    } catch (ex) {
      // 同上：取 MOZI_TOKEN 这一跳失败会直接反映为「拿不到 token」，此处留痕便于分清网络与会话原因。
      this.logger.warn(String(describeNetError('取 AEOLUS_MOZI_TOKEN 请求异常（已忽略）', ex).message));
    }

    const cookieStr = s.finalCookieString();
    if (!s.hasCookie('AEOLUS_MOZI_TOKEN')) {
      throw new Error(
        `登录完成但未拿到 AEOLUS_MOZI_TOKEN（cookie=${cookieStr.slice(0, 120)}）`,
      );
    }
    this.logger.log(
      `SSO 登录成功（凭据来源：${override ? '临时输入' : '已保存文件'}），cookie 长度 ${cookieStr.length}`,
    );
    return cookieStr;
  }

  /**
   * 登录态探针：validToken 接口。
   *   生效（HTTP 200）→ true；失效/被顶号（401）或网络异常 → false。
   */
  async checkLogin(cookie: string): Promise<boolean> {
    if (!cookie) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
    try {
      const res = await fetch(CHECK_URL, {
        headers: { ...CHECK_HEADERS, cookie: cookie.trim() },
        signal: ctrl.signal,
      });
      return res.status === 200;
    } catch {
      // 网络异常：保守按失效处理，上层 ensure() 会走重登自愈
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
