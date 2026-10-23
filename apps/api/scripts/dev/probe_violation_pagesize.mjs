// 风神「违规处罚明细」列表接口上游 page_size 上限探测。
//
// 做法：对 queryList/1.0 依次传入递增的 page_size，观察「请求值 vs 实际返回列表长度 / 上游 total」，
// 判断上游是否在某个上限做了截断(clamp)或报错。
//
// 安全：默认只读本地 cookie.txt 并做一次 validToken 探针；cookie 失效且未加 --force-login 时
// 绝不主动重登（重登会顶掉共享同一账号的其他会话，包括生产）。
//
// 用法：
//   node apps/api/scripts/probe_violation_pagesize.mjs [--days 30] [--force-login] [--sizes 10,50,100,200,500,1000,2000,5000]
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(process.cwd());
const SDK_DIR = path.join(ROOT, 'aeolus_sdk');
const COOKIE_FILE = path.join(SDK_DIR, 'cookie.txt');
const CRED_FILE = path.join(SDK_DIR, 'credentials.json');

const VIOLATION_LIST_URL =
  'https://httpizza.ele.me/xtop/xtop.lpd.quality.control.violation.violationOrderAeolusCenterApi.queryList/1.0';

const STATIC_HEADERS = {
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7',
  'content-type': 'application/json',
  origin: 'https://penalty.faas.ele.me',
  referer: 'https://penalty.faas.ele.me/ZSViolationPunish.html',
  'sec-ch-ua': '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0',
  'x-shard': 'shardid=1',
};

const CHECK_URL = 'https://httpizza.ele.me/lpd.meepo.session/aeolus/validToken';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0';

// ───────── 参数解析 ─────────
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const DAYS = Number(arg('--days', 30));
const FORCE_LOGIN = process.argv.includes('--force-login');
const DUMP = process.argv.includes('--dump');
const SIZES = (arg('--sizes', '10,50,100,200,500,1000,2000,5000'))
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));

// ───────── 北京时区区间 ─────────
function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}
function startOfDay(dt) {
  const d = new Date(dt);
  d.setHours(0, 0, 0, 0);
  return d;
}
function toMs(dt) {
  return Date.parse(dt) - 8 * 3600 * 1000; // 北京本地时刻 → UTC 毫秒
}
const nowBJ = beijingNow();
const endMs = toMs(nowBJ);
const startDt = startOfDay(nowBJ);
startDt.setDate(startDt.getDate() - (DAYS - 1));
const startMs = toMs(startDt);

function getCookieFile() {
  try {
    return fs.readFileSync(COOKIE_FILE, 'utf-8').trim();
  } catch {
    return null;
  }
}

async function checkLogin(cookie) {
  if (!cookie) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(CHECK_URL, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://aeolus.ele.me',
        Referer: 'https://aeolus.ele.me/',
        'User-Agent': UA,
        cookie: cookie.trim(),
      },
      signal: ctrl.signal,
    });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// ───────── 仅在 --force-login 时使用的极简重登（复刻后端协议，纯 Node 内置）─────────
function encodeURIComponentLoose(s) {
  const unreserved = /[A-Za-z0-9_.\-~]/;
  const safe = "!~*'()-._";
  let out = '';
  for (const ch of s) {
    if (unreserved.test(ch) || safe.includes(ch)) out += ch;
    else for (const b of Buffer.from(ch, 'utf8')) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
function modPow(base, exp, mod) {
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
function rsaEncryptJs(plaintext, modulusHex, exponentHex = '10001') {
  const e = BigInt('0x' + exponentHex);
  const n = BigInt('0x' + modulusHex);
  const nbits = n.toString(2).length;
  const numDigits = Math.floor((nbits + 15) / 16);
  const biHigh = numDigits - 1;
  const chunk = 2 * biHigh;
  const blockHexLen = (biHigh + 1) * 4;
  let buf = Buffer.from(plaintext, 'utf8');
  while (buf.length % chunk !== 0) buf = Buffer.concat([buf, Buffer.from([0])]);
  const out = [];
  for (let i = 0; i < buf.length; i += chunk) {
    let m = 0n;
    for (let j = chunk - 1; j >= 0; j--) m = (m << 8n) | BigInt(buf[i + j]);
    out.push(modPow(m, e, n).toString(16).padStart(blockHexLen, '0'));
  }
  return out.join('');
}
const LOGIN_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7',
  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  Origin: 'https://mozi-login.alibaba-inc.com',
  'User-Agent': UA,
};
class SsoSession {
  constructor() {
    this.jar = new Map();
  }
  absorb(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const parts = line.split(';');
      const idx = parts[0].indexOf('=');
      if (idx <= 0) continue;
      const name = parts[0].slice(0, idx).trim();
      const value = parts[0].slice(idx + 1).trim();
      let domain = '';
      for (const a of parts.slice(1)) {
        const eq = a.indexOf('=');
        if (eq < 0) continue;
        if (a.slice(0, eq).trim().toLowerCase() === 'domain') domain = a.slice(eq + 1).trim().replace(/^\./, '');
      }
      if (value === '') continue;
      this.jar.set(name, { value, domain });
    }
  }
  headerFor(url) {
    const host = new URL(url).hostname;
    const out = [];
    for (const [name, en] of this.jar) {
      if (en.domain && host !== en.domain && !host.endsWith('.' + en.domain)) continue;
      out.push(`${name}=${en.value}`);
    }
    return out.join('; ');
  }
  async open(url, init = {}) {
    let current = url;
    for (let h = 0; h < 10; h++) {
      const cookie = this.headerFor(current);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      let res;
      try {
        res = await fetch(current, {
          method: init.method ?? 'GET',
          body: init.body,
          headers: { ...LOGIN_HEADERS, ...(cookie ? { cookie } : {}) },
          redirect: 'manual',
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(t);
      }
      this.absorb(res);
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString();
        continue;
      }
      return res;
    }
    throw new Error('重定向过多');
  }
  finalCookieString() {
    const pairs = [];
    for (const [name, en] of this.jar) {
      if (!(en.domain.includes('ele.me') || en.domain.includes('alibaba'))) continue;
      if (en.value === '' || en.value === 'null') continue;
      pairs.push(`${name}=${en.value}`);
    }
    return pairs.join('; ');
  }
}
async function doLogin() {
  const { account, password } = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'));
  const APP_NAME = 'LOGISTICS_COMPANY';
  const TPL = 'mknnjrtsvw9cj96u';
  const BACK_URL = `https://aeolus.ele.me?_tplCode=${TPL}`;
  const PAGE_URL = `https://mozi-login.alibaba-inc.com/?APP_NAME=${APP_NAME}&BACK_URL=${encodeURIComponent(BACK_URL)}&moziAppType=${APP_NAME}`;
  const LOGIN_URL = `https://mozi-login.alibaba-inc.com/rpc/login/doLogin.json?APP_NAME=${APP_NAME}&BACK_URL=${encodeURIComponent(BACK_URL)}&moziAppType=${APP_NAME}`;
  const s = new SsoSession();
  const html = await s.open(PAGE_URL).then((r) => r.text());
  const pub = /'rsaPublicKey'\s*:\s*'([0-9a-fA-F]+)'/.exec(html)?.[1];
  if (!pub) throw new Error('未解析到 rsaPublicKey');
  const csrf = /'_sso_csrftoken_'\s*:\s*'([0-9A-Za-z]+)'/.exec(html)?.[1] ?? '';
  const umid = /'umidTokenId'\s*:\s*'([0-9A-Za-z]+)'/.exec(html)?.[1] ?? '';
  const ea = rsaEncryptJs(encodeURIComponentLoose(account), pub);
  const ep = rsaEncryptJs(encodeURIComponentLoose(password), pub);
  const body =
    `_sso_csrftoken_=${csrf}&account=${ea}&password=${ep}&loginType=ACCOUNT&namespace=buc` +
    `&isRsaPwd=true&login_maintain=true&keepLogged=false&umidTokenId=${umid}&phoneNumToken=`;
  const res = await s.open(LOGIN_URL, { method: 'POST', body });
  const txt = await res.text();
  const j = JSON.parse(txt);
  const content = j?.content ?? {};
  if (content.type !== 'redirect' || !content?.extInfo?.redirectURL)
    throw new Error('登录失败: ' + String(content.msg ?? txt.slice(0, 200)));
  const rurl = String(content.extInfo.redirectURL);
  const rurlAbs = rurl.startsWith('http') ? rurl : 'https://mozi-login.alibaba-inc.com' + rurl;
  try {
    await s.open(rurlAbs);
  } catch {}
  try {
    await s.open(BACK_URL);
  } catch {}
  const cookieStr = s.finalCookieString();
  if (!s.jar.has('AEOLUS_MOZI_TOKEN')) throw new Error('未拿到 AEOLUS_MOZI_TOKEN');
  fs.writeFileSync(COOKIE_FILE, cookieStr + '\n', 'utf-8');
  return cookieStr;
}

// ───────── queryList 调用 ─────────
async function queryList(cookie, startMs, endMs, pageNo, pageSize) {
  const body = JSON.stringify({
    params: { request: { violationStartTime: startMs, violationEndTime: endMs, pageNo, pageSize } },
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(VIOLATION_LIST_URL, {
      method: 'POST',
      headers: { accept: 'application/json, text/plain, */*', ...STATIC_HEADERS, cookie },
      body,
      signal: ctrl.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function extractList(r) {
  const arrays = [];
  const totals = [];
  const walk = (node, depth) => {
    if (node == null || typeof node !== 'object' || depth > 3) return;
    if (Array.isArray(node)) {
      arrays.push(node);
      return;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) arrays.push(v);
      else if (typeof v === 'number' && /total|count|num/i.test(k)) totals.push(v);
      else if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(r, 0);
  let list = [];
  for (const a of arrays) if (a.length && a.every((x) => x && typeof x === 'object') && a.length > list.length) list = a;
  const total = totals.length ? Math.max(...totals) : null;
  return { list, total };
}

// ───────── 主流程 ─────────
async function main() {
  console.log(`探测区间：最近 ${DAYS} 天（北京时区） startMs=${startMs} endMs=${endMs}`);
  console.log(`测试 page_size 序列：${SIZES.join(', ')}`);

  let cookie = getCookieFile();
  const valid = await checkLogin(cookie);
  if (!valid) {
    console.log('本地 cookie 已失效（validToken 探针 401/失败）。');
    if (FORCE_LOGIN) {
      console.log('⚠️ --force-login：将重新登录风神（会顶掉共享账号的其他会话，含生产）。');
      cookie = await doLogin();
      console.log('重登完成，新 cookie 长度', cookie.length);
    } else {
      console.log('未加 --force-login，放弃（避免顶号）。如需重登请加 --force-login。');
      process.exit(2);
    }
  } else {
    console.log('本地 cookie 有效，直接探测。');
  }

  console.log('\npage_size | 返回列表条数 | 上游total | http code / result.code | 截断?');
  console.log('-----------|------------|-----------|------------------------|-------');
  const results = [];
  for (const size of SIZES) {
    let j;
    try {
      j = await queryList(cookie, startMs, endMs, 1, size);
    } catch (e) {
      console.log(`${String(size).padStart(9)} | 请求异常：${e.message}`);
      results.push({ size, error: e.message });
      continue;
    }
    const result = j && typeof j === 'object' ? j.result : null;
    const code = j?.code ?? (result ? String(result.code ?? '') : 'NO_RESULT');
    const msg = result?.msg ?? '';
    let listLen = 0;
    let total = null;
    if (result) {
      const ex = extractList(result);
      listLen = ex.list.length;
      total = ex.total;
    }
    if (DUMP && size === SIZES[0]) {
      console.log('\n── 原始响应结构（首条 size）──');
      const keys = result && typeof result === 'object' ? Object.keys(result) : '(result 非对象)';
      console.log('result 顶层 keys:', JSON.stringify(keys));
      const preview = result ? JSON.parse(JSON.stringify(result, (k, v) => (Array.isArray(v) && v.length > 2 ? v.slice(0, 2) : v))) : null;
      console.log('result 预览:', JSON.stringify(preview, null, 2).slice(0, 1500));
      if (Array.isArray(result?.data)) console.log('result.data 是数组，长度=', result.data.length);
    }
    const clamped = listLen < size ? '是(返回<请求)' : '否';
    console.log(
      `${String(size).padStart(9)} | ${String(listLen).padStart(10)} | ${String(total).padStart(9)} | code=${String(code).padEnd(6)} ${msg.slice(0, 24)} | ${clamped}`,
    );
    results.push({ size, listLen, total, code, msg });
  }

  // 推断上限
  console.log('\n── 推断 ──');
  const timeMsg = results.find((r) => /查询时间不能超过/.test(r.msg || ''));
  if (timeMsg) {
    console.log('⚠️ 上游返回业务消息「查询时间不能超过2天」且 http/result.code=200：');
    console.log('   → 该接口硬性限制【查询时间区间 ≤ 2 天】，超限时静默返回 0 条（不会被错误码拦截，是潜伏 bug）。');
    console.log('   → 本次窗口被拒，说明安全做法是【每次查询 ≤ 1 天】。');
  }
  const ok = results.filter((r) => r.total != null && r.listLen != null);
  if (ok.length) {
    const maxReturned = Math.max(...ok.map((r) => r.listLen));
    const globalTotal = Math.max(...ok.map((r) => r.total)); // 来自 data.count，真实总量
    // 真正的截断：返回 < 请求 且 真实总量 > 请求（即还有更多没给）
    const realClamp = ok.find((r) => r.listLen < r.size && r.total > r.size);
    const anyError = results.find((r) => r.code && String(r.code) !== '200' && String(r.code) !== 'NO_RESULT');
    if (anyError) console.log('出现错误码，说明某个 page_size 被上游拒绝：', anyError);
    if (realClamp) {
      const idx = ok.findIndex((r) => r.listLen < r.size && r.total > r.size);
      const capCandidate = idx > 0 ? ok[idx - 1].size : ok[0].size;
      console.log(`疑似上游单页上限 ≈ ${capCandidate}（page_size=${ok[idx].size} 时返回 ${ok[idx].listLen} < 请求值，且总量 ${ok[idx].total} > 请求值）。`);
    } else if (maxReturned < SIZES[SIZES.length - 1] && !timeMsg) {
      console.log(`区间内真实总量仅 ${globalTotal} 条，${SIZES[SIZES.length - 1]} 已远超总量，无法观测到 page_size 上限（返回<请求纯属数据量不足，非截断）。`);
      console.log(`结论：在 [${SIZES.join(',')}] 范围内未观测到 page_size 截断或报错，上游至少接受 ${SIZES[SIZES.length - 1]} 每页（可能更高）。当前默认 200 安全。`);
    } else if (!timeMsg) {
      console.log(`在测试序列 ${SIZES.join(',')} 内未观测到截断或报错，上游至少接受 ${SIZES[SIZES.length - 1]} 每页（可能更高，可继续加大 --sizes）。`);
    }
  } else if (!timeMsg) {
    console.log('无有效返回，无法推断。');
  }
}

main().catch((e) => {
  console.error('探针失败：', e);
  process.exit(1);
});
