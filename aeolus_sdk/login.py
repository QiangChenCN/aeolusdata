import venv_guard  # 自动切换至项目 .venv

"""aeolus_sdk.login —— 风神(Aeolus)统一登录（全项目唯一登录实现）。

对外核心函数：
  - ensure_cookies(path="aeolus_sdk/cookie.txt") -> (cookie_str, status)   读本地校验，有效复用 / 无效登录并落盘（主入口）
  - get_cookies(endian="little")    -> str   完整 SSO 登录，返回 cookie 头字符串（内存值）
  - check_login(cookie_str)         -> bool  用鉴权接口探测 cookie 是否有效
  - load_cookies / save_cookies              本地 cookie 文件的读写

内部实现复刻 mozi-login.alibaba-inc.com 登录页用的经典 JS RSA 库(Dave Koelle 版)：
  明文账号密码 -> encodeURIComponent -> 字节 -> 小端整数 -> pow(m, e=0x10001, n) -> hex
  POST doLogin.json -> 跟随 ssoLogin.htm 票据交接 -> 访问 aeolus.ele.me 拿 AEOLUS_MOZI_TOKEN

⚠️ 每次调用都新建独立 opener/cookie jar，因此并发的多个场景各自拿各自的新鲜会话，
  互不共用 cookie、互不干扰。
"""
import os
import ssl
import threading
import http.cookiejar
import urllib.request
import urllib.error
import re
import json
from urllib.parse import quote

__all__ = [
    "ensure_cookies", "get_cookies", "check_login",
    "load_cookies", "save_cookies",
    "get_shared_cookies", "refresh_shared_cookies",
    "COOKIE_FILE",
]

# ===== 登录凭据（不再硬编码进源码）=====
# 按以下顺序读取，命中即返回：
#   1) 环境变量 AEOLUS_ACCOUNT / AEOLUS_PASSWORD
#   2) 本地未跟踪文件 aeolus_sdk/credentials.json  {"account": "...", "password": "..."}
#      （该文件已在 .gitignore 中排除，请勿提交）
# 注：旧凭据曾硬编码在本文件并提交到 git 历史，建议同步到风神后台轮换该密码。
def _load_credentials():
    acc = os.environ.get("AEOLUS_ACCOUNT")
    pwd = os.environ.get("AEOLUS_PASSWORD")
    if acc and pwd:
        return acc, pwd
    cred_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "credentials.json")
    try:
        with open(cred_file, encoding="utf-8") as f:
            d = json.load(f)
        acc = d.get("account")
        pwd = d.get("password")
        if acc and pwd:
            return acc, pwd
    except FileNotFoundError:
        pass
    except Exception:
        pass
    raise RuntimeError(
        "未找到风神登录凭据。请设置环境变量 AEOLUS_ACCOUNT / AEOLUS_PASSWORD，"
        "或在 aeolus_sdk/credentials.json 中配置 account/password（该文件已被 .gitignore 排除）。"
    )


ACCOUNT_RAW, PASSWORD_RAW = _load_credentials()
# =========================================================================

APP_NAME = "LOGISTICS_COMPANY"
TPL = "mknnjrtsvw9cj96u"
BACK_URL = "https://aeolus.ele.me?_tplCode=" + TPL
LOGIN_URL = (
    "https://mozi-login.alibaba-inc.com/rpc/login/doLogin.json"
    "?APP_NAME=%s&BACK_URL=%s&moziAppType=%s" % (APP_NAME, quote(BACK_URL, safe=""), APP_NAME)
)
PAGE_URL = (
    "https://mozi-login.alibaba-inc.com/?APP_NAME=%s&BACK_URL=%s&moziAppType=%s"
    % (APP_NAME, quote(BACK_URL, safe=""), APP_NAME)
)

_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "Origin": "https://mozi-login.alibaba-inc.com",
    "Referer": PAGE_URL,
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0"
    ),
    "sec-ch-ua": '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
}

_CTX = ssl.create_default_context()
if os.environ.get("AEOLUS_INSECURE_TLS"):
    # 默认保持证书校验（防中间人）。仅在确有自签/内网 CA 问题时临时开启。
    _CTX.check_hostname = False
    _CTX.verify_mode = ssl.CERT_NONE

# 登录态探针：专门校验 AEOLUS_MOZI_TOKEN 是否有效（浏览器实际用的校验接口）。
#   GET https://httpizza.ele.me/lpd.meepo.session/aeolus/validToken
#   带有效 token -> HTTP 200，body {"code":200,"data":null}
#   失效/被顶号  -> HTTP 401，body {"name":...,"message":"账户下线","meta":{"Type":"user","Code":"301"}}
# 比旧的 xtop.message.fs.wl.ticket.createTicketCheck 更干净：无建 ticket 的副作用，
# 且结果无歧义——直接看 HTTP 状态码（200 有效 / 401 失效），无需解析业务 code。
CHECK_URL = "https://httpizza.ele.me/lpd.meepo.session/aeolus/validToken"
_CHECK_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://aeolus.ele.me",
    "Referer": "https://aeolus.ele.me/",
    "User-Agent": _HEADERS["User-Agent"],
}


def _euc(s):
    """等价于 JS encodeURIComponent（保留 !~*'()-._ 不编码）。"""
    return quote(s, safe="!~*'()-._")


def _rsa_encrypt(plaintext, modulus_hex, exponent_hex="10001", endian="little"):
    """复刻 JS RSA 库：明文按字节 -> 整数 -> pow(e, n) -> hex（无填充）。"""
    e = int(exponent_hex, 16)
    n = int(modulus_hex, 16)
    nbits = n.bit_length()
    num_digits = (nbits + 15) // 16  # 16-bit 字数
    bi_high = num_digits - 1
    chunk = 2 * bi_high  # 每块字节数
    block_hex_len = (bi_high + 1) * 4  # 每块输出 hex 长度（与 biToHex 对齐）
    a = plaintext.encode("utf-8")
    while len(a) % chunk != 0:
        a += b"\x00"
    out = []
    for j in range(0, len(a), chunk):
        m_int = int.from_bytes(a[j : j + chunk], endian)
        c = pow(m_int, e, n)
        out.append(format(c, "x").zfill(block_hex_len))
    return "".join(out)


def _new_opener():
    """每次调用返回独立的 cookie jar + opener，保证会话隔离。"""
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cj),
        urllib.request.HTTPSHandler(context=_CTX),
    )
    return cj, op


def get_cookies(endian="little"):
    """完整 SSO 登录，返回 cookie 头字符串（如 'BucSsoJSESSIONID=...; AEOLUS_MOZI_TOKEN=...'）。

    每次调用都使用独立会话；返回的 cookie 只存在于调用方进程内存中，不落盘、不进共享存储。
    失败抛 RuntimeError。
    """
    cj, op = _new_opener()

    # [1] 取登录页（同一会话拿 rsaPublicKey + JSESSIONID）
    try:
        resp = op.open(urllib.request.Request(PAGE_URL, headers=_HEADERS), timeout=30)
        html = resp.read().decode("utf-8", "replace")
    except Exception as ex:
        raise RuntimeError("登录页请求失败: " + str(ex))

    m = re.search(r"'rsaPublicKey'\s*:\s*'([0-9a-fA-F]+)'", html)
    csrf = re.search(r"'_sso_csrftoken_'\s*:\s*'([0-9A-Za-z]+)'", html)
    umid = re.search(r"'umidTokenId'\s*:\s*'([0-9A-Za-z]+)'", html)
    if not m:
        raise RuntimeError("未从登录页解析到 rsaPublicKey")
    pub = m.group(1)
    csrf_v = csrf.group(1) if csrf else ""
    umid_v = umid.group(1) if umid else ""

    # [2] RSA 加密账号/密码
    ea = _rsa_encrypt(_euc(ACCOUNT_RAW), pub, endian=endian)
    ep = _rsa_encrypt(_euc(PASSWORD_RAW), pub, endian=endian)

    body = (
        "_sso_csrftoken_=%s&account=%s&password=%s&loginType=ACCOUNT&namespace=buc"
        "&isRsaPwd=true&login_maintain=true&keepLogged=false&umidTokenId=%s&phoneNumToken="
        % (csrf_v, ea, ep, umid_v)
    )

    # [3] POST doLogin.json
    req = urllib.request.Request(LOGIN_URL, data=body.encode("utf-8"), headers=_HEADERS, method="POST")
    try:
        resp = op.open(req, timeout=30)
        txt = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        raise RuntimeError("doLogin HTTPError %s: %s" % (e.code, txt[:300]))
    except Exception as ex:
        raise RuntimeError("doLogin 请求异常: " + str(ex))

    try:
        j = json.loads(txt)
        content = j.get("content", {}) or {}
        rtype = content.get("type")
        rurl = content.get("extInfo", {}).get("redirectURL", "")
    except Exception:
        raise RuntimeError("doLogin 响应解析失败: " + txt[:200])

    if rtype != "redirect" or not rurl:
        raise RuntimeError("登录失败: " + str(content.get("msg", txt[:200])))

    # [4] 跟随 doLogin 重定向，完成 SSO 票据交接（同会话）
    rurl_abs = rurl if rurl.startswith("http") else "https://mozi-login.alibaba-inc.com" + rurl
    try:
        op.open(urllib.request.Request(rurl_abs, headers=_HEADERS), timeout=30)
    except Exception:
        pass  # 交接页状态码可能非 200，但 cookie 已在 jar 中建立

    # [5] 访问 aeolus 拿 AEOLUS_MOZI_TOKEN
    try:
        op.open(urllib.request.Request(BACK_URL, headers=_HEADERS), timeout=30)
    except Exception:
        pass

    pairs = [
        (c.name, c.value)
        for c in cj
        if ("ele.me" in c.domain or "alibaba" in c.domain) and c.value not in ("", "null")
    ]
    cookie_str = "; ".join("%s=%s" % (k, v) for k, v in pairs)
    if not any(k == "AEOLUS_MOZI_TOKEN" for k, _ in pairs):
        raise RuntimeError("登录完成但未拿到 AEOLUS_MOZI_TOKEN（cookie=%s）" % cookie_str[:120])
    return cookie_str


def check_login(cookie_str):
    """用 validToken 接口探测 cookie 是否有效。True=已登录（可复用），False=失效。

    validToken 是专门校验 AEOLUS_MOZI_TOKEN 的轻量接口：
      - 生效        -> HTTP 200（body {"code":200,"data":null}）
      - 失效/被顶号  -> HTTP 401（body 报错「账户下线」）
    直接看 HTTP 状态码即可，无需解析业务 code，结果无歧义、无副作用。
    """
    if not cookie_str:
        return False
    _, op = _new_opener()
    req = urllib.request.Request(
        CHECK_URL, headers=dict(_CHECK_HEADERS, cookie=cookie_str.strip())
    )
    try:
        with urllib.request.urlopen(req, timeout=20, context=_CTX) as r:
            return r.status == 200
    except urllib.error.HTTPError:
        # 401 等明确未登录状态
        return False
    except Exception:
        # 网络异常等：保守按失效处理，ensure_cookies 会重登自愈
        return False


# ===================== 本地持久化 + 读校验核心流程 =====================
# 登录态落地文件：固定放在 aeolus_sdk/ 本目录（与 login.py 同目录），
# 这样无论从哪个 cwd 启动脚本，ensure_cookies 都落到同一份，跨脚本复用同一登录态。
COOKIE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookie.txt")


def load_cookies(path=COOKIE_FILE):
    """读取本地持久化的 cookies；文件不存在或为空返回 None。"""
    try:
        with open(path, encoding="utf-8") as f:
            s = f.read().strip()
        return s or None
    except FileNotFoundError:
        return None


def _save_cookies_raw(cookie_str, path=COOKIE_FILE):
    """落盘 cookie（不加跨进程锁）。仅给已持有 xp_lock 的调用方用，避免重入死锁。"""
    d = os.path.dirname(os.path.abspath(path))
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(cookie_str + "\n")
    # 收窄凭据文件权限，避免同机其他用户/进程读取（Linux 服务器有效；Windows 下影响有限）
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def save_cookies(cookie_str, path=COOKIE_FILE):
    """把 cookies 持久化保存到本地文件，供后续运行复用。

    跨进程安全：写盘前先拿 OS 级文件锁（aeolus_sdk.xlock），与 ensure_cookies /
    refresh_shared_cookies / 其它独立进程的重登动作串行，避免并发写坏 cookie.txt。
    dashboard.* / jobs.* 里直接调本函数的裸写路径，也由此自动获得互斥保护。
    """
    from .xlock import xp_lock
    with xp_lock(path):
        _save_cookies_raw(cookie_str, path)


def ensure_cookies(path=COOKIE_FILE):
    """登录模块核心：检测本地 cookies 是否有效，有效则复用(跳过登录)，
    无效则执行登录流程获取新 cookies 并持久化到本地文件。

    返回 (cookie_str, status)：
      status == 'reused' -> 本地 cookies 有效，直接复用，未触发登录
      status == 'login'  -> 本地失效，已重新登录获取并写入本地文件
    两个 status 都代表「cookie 可用，调用方拿去用即可」（即上层说的"返回 true = 有效、拿去用"）。

    跨进程安全：仅在确实需要重登时才拿 OS 级文件锁（见 aeolus_sdk.xlock），
    进入锁后二次复查——避免多个独立进程同时发现失效、同时重登互相顶号/写坏文件。
    """
    existing = load_cookies(path)
    if existing and check_login(existing):
        return existing, "reused"
    from .xlock import xp_lock
    with xp_lock(path):
        # 二次复查：等待锁期间可能有别的进程已经刷新过
        existing = load_cookies(path)
        if existing and check_login(existing):
            return existing, "reused"
        fresh = get_cookies()
        _save_cookies_raw(fresh, path)   # 已持 xp_lock，走无锁原始写盘避免重入死锁
        return fresh, "login"


# ===================== 进程内共享登录（全局锁 + 内存 token 复用）=====================
# 目的：风神是单点登录，同一账号同时只有一套有效会话。钉钉 Stream 服务是常驻进程，
# 并发收到多条 @ 查询时会各自 ensure_cookies() -> 都发现失效 -> 都去登录 -> 互相顶号。
# 用一把进程级锁 + 内存 token 缓存，把「N 个并发 = N 次登录」压成「最多 1 次登录」：
#   - 正常情况：进程内只登录一次，后续所有查询直接复用内存 token（不再每次 check_login，省请求、少顶号）。
#   - 并发登录：只有一个线程真正去登录，其余阻塞等待后共享同一份新 token。
#   - 被浏览器顶号：某请求 401 -> refresh_shared_cookies() 持锁重登一次，更新内存缓存 -> 后续所有请求共享新 token。
# 注意：本机制只约束「脚本进程内部」的并发，无法消除「浏览器手动登录顶掉脚本」这一 SSO 固有行为；
#       被顶后靠 401 自愈重登，那次重登仍会反过来顶掉浏览器（乒乓），但频率已大幅降低。
_shared_cookie = None
_shared_lock = threading.Lock()


def get_shared_cookies(force: bool = False) -> str:
    """进程内共享、带锁的登录入口（优先复用、少登录）。

    - 非 force 且内存已有缓存 -> 直接返回（不再每次 check_login，省请求、少顶号）。
    - 否则持锁登录：优先 ensure_cookies() 复用本地文件 cookie，失效才真正登录；
      登录成功后把 token 写回内存缓存，并发调用共享同一份。
    - 用 threading.Lock + 双重检查，保证并发时只有一个请求真正去登录。
    """
    global _shared_cookie
    if not force and _shared_cookie:
        return _shared_cookie
    with _shared_lock:
        # 双重检查：持锁后再看一眼，避免并发都进入后重复登录
        if not force and _shared_cookie:
            return _shared_cookie
        cookie, _ = ensure_cookies()  # 优先复用本地有效 cookie，失效才登录
        _shared_cookie = cookie
        return _shared_cookie


def refresh_shared_cookies() -> str:
    """被 401 顶号后调用：持锁保证并发时只真正重登一次，其余请求复用新 token。

    - 持锁后若已有缓存（说明并发的另一请求刚重登过、token 新鲜），直接复用，不再登录。
    - 仅当缓存为空（进程内从未登录过）才真正登录，并落盘供其他进程/下次复用。
    进程内用 _shared_lock，跨进程用 aeolus_sdk.xlock——双重锁保证重登期间不与
    其他进程/线程的登录动作交叉写盘。
    """
    global _shared_cookie
    with _shared_lock:
        if _shared_cookie:
            return _shared_cookie  # 别人刚重登过，直接复用新鲜 token，不重复登录
        from .xlock import xp_lock
        with xp_lock(COOKIE_FILE):
            cookie = get_cookies()     # 强制新登录（不读本地、不校验）
            _save_cookies_raw(cookie)  # 已持 xp_lock，走无锁原始写盘避免重入死锁
            _shared_cookie = cookie
            return _shared_cookie


if __name__ == "__main__":
    # 直接运行（python -m aeolus_sdk.login）：检测本地 cookies，无效则登录并落盘。
    #
    # 注意：这是 SDK 自带的诊断入口，**不是 server 的任务**，不接 nodeflow 节点化。
    # 节点化是工作台任务（tasks.json 里的条目）的约定，SDK 作为被 import 的库
    # 保持零外部依赖 —— 别把上层任务体系的框架塞进来。
    cookie_str, status = ensure_cookies()
    if not cookie_str:
        print("✗ 登录失败，未获取到 cookies")
        raise SystemExit(1)
    if status == "reused":
        print("✓ 本地 cookies 仍有效，直接复用（未触发登录），长度 %d" % len(cookie_str))
    else:
        print("✓ 本地 cookies 失效，已重新登录并写入本地文件（长度 %d）" % len(cookie_str))
    if check_login(cookie_str):
        print("✓ 服务端确认登录态有效")
    else:
        print("⚠ 已写入但未通过 check_login（可能接口波动）")
        raise SystemExit(1)
