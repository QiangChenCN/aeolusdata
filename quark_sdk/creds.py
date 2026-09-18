#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""quark_sdk.creds —— Quark（阿里内部报表平台）凭证与连接辅助层。

本模块只负责「拿到一个可用的 Quark DA cookie」以及「报表页三件套 token 提取」，
**不含任何业务取数/解析逻辑**（那些已迁到 get_data/rider_equipment.py）。

与 aeolus_sdk.login 同性质：纯标准库（urllib + json + re + subprocess + os）。

对外函数：
  - load_aeo_cookie / load_quark_cookie    —— 读取风神 SSO / Quark 手动 cookie
  - load_da_cache / save_da_cache / clear_da_cache —— DA cookie 落盘缓存（避免每次重兑）
  - ensure_da_cookie                       —— 缓存探活优先，否则重新兑换（返回 cookie/jar/source）
  - get_report_url / auto_fetch_tokens     —— 用 Aeolus cookie 拉报表页、提取 reportIdToken/secParam/metaTime
  - probe_da_health                        —— DA cookie 有效性探针（真·鉴权，看是否被踢回登录页）
  - DEFAULT_COOKIE_PATHS / _QUARK_SDK_DIR / AEOLUS_COOKIE_FILE —— 凭据落盘路径常量

⚠️ 关于"探活"：Quark 侧没有类似风神 validToken 的专用 session 校验接口。
doQueryClipConfig 等轻量接口经实测均不校验 DA cookie（空 cookie 也返回 code:0），
因此不做独立探活，DA cookie 有效性由取数接口 WidgetAction 判定（见 get_data/rider_equipment）。
本模块的 probe_da_health 仅用于确认 Quark 网关连通性（看是否被踢回 HTML 登录页）。

依赖：
  - aeolus_sdk.login（ensure_cookies，获取 AEO_COOKIE）
  - da_auth（acquire_da_token，DA_TOKEN 兑换 + 写 curl jar）
  - 系统 curl（report.htm 跟随 302 需要中性 TLS 指纹，urllib 会 403）

设计原则（与 aeolus_sdk.login 对齐）：
  · 本模块不写"取数"，也不把凭证写进共享记忆 / 共享文件。
  · 内部异常按需抛出或由调用方（get_data/rider_equipment）决定回落。
"""
import os
import sys
import json
import re
import time
import urllib.request
import urllib.parse

# da_auth.py 与本模块同处 quark_sdk/ 包内，用同包相对导入即可。
# （da_auth 自身仍依赖 aeolus_sdk.login 做 SSO，由 venv_guard 注入项目根。）
try:
    import venv_guard  # noqa: F401
except Exception:  # 允许在 SDK 被 install/embed 时缺 venv_guard
    pass


# ============================================================
# 端点与常量
# ============================================================
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0"
)
GET_REPORT_URL = "https://app2-edu.ele.me/kunkka-svr/fs/fbi/getReport?reportId=860325"

# DA cookie 健康探针（2026-09-03 重新选定）：
#   选它的理由：/fbi/** 路径受 DA 网关保护，cookie 无效会返回 HTML 登录页；
#   而 /common/** 路径（旧用的 doQueryClipConfig）不鉴权，空 cookie 也 code:0。
#   doGetSite 是只读查询、无参数、无副作用、响应 188 字节。
DA_HEALTH_URL = (
    "https://quark.alibaba.com/fbi/fbi.json"
    "?action=site/FbiSiteAction&event_submit_doGetSite=true"
)
# 反例（留档，勿再用作探针）：空 cookie 也返回 code:0，没有鉴别力
#   https://quark.alibaba.com/common/ClipAction/doQueryClipConfig?region=cn

# Quark 系凭据（quark_cookie.txt / quark_da_cookies.txt / quark_da_cache.json）
# 统一收口到 quark_sdk/ 包内（与 da_auth.py 同目录），不再依赖 base 参数 ——
# 否则 task_equipment 传 base=jobs/equipment 会让缓存落到子目录而永不命中（每次强制重兑）。
_QUARK_SDK_DIR = os.path.dirname(os.path.abspath(__file__))  # 本文件已在 quark_sdk/ 内

DEFAULT_COOKIE_PATHS = {
    "quark": os.path.join(_QUARK_SDK_DIR, "quark_cookie.txt"),
    "quark_da_jar": os.path.join(_QUARK_SDK_DIR, "quark_da_cookies.txt"),
    "quark_da_cache": os.path.join(_QUARK_SDK_DIR, "quark_da_cache.json"),
}

# Aeolus SSO cookie 实际落盘位置（与 aeolus_sdk.login.COOKIE_FILE 完全一致）。
AEOLUS_COOKIE_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "aeolus_sdk", "cookie.txt")


# ============================================================
# 凭证加载（与 aeolus_sdk.login 同套分层）
# ============================================================
def load_aeo_cookie(base=".", force=False):
    """Aeolus SSO cookie 来源：aeolus_sdk.login 自动登录 → AEO_COOKIE 环境变量 → aeo_cookie.txt。

    Aeolus SSO cookie 固定落在 aeolus_sdk/cookie.txt（AEOLUS_COOKIE_FILE，与 login.py 一致），
    不依赖 base；aeo_cookie.txt 仍在 base（项目根）下。
    """
    if force:
        from aeolus_sdk.xlock import xp_lock
        with xp_lock(AEOLUS_COOKIE_FILE):
            try:
                os.remove(AEOLUS_COOKIE_FILE)
                print("[aeolus] 强制重新登录：已清空本地 cookie 缓存", flush=True)
            except FileNotFoundError:
                pass
    try:
        import aeolus_sdk.login as al  # noqa: F401
        cookie_str, status = al.ensure_cookies(AEOLUS_COOKIE_FILE)
        if cookie_str:
            print("[aeolus] 登录状态: %s" % status, flush=True)
            return cookie_str
    except Exception as e:
        print("[aeolus] aeolus_sdk 登录失败: %s" % e, flush=True)
    env = os.environ.get("AEO_COOKIE")
    if env and env.strip():
        return env.strip()
    try:
        with open(os.path.join(base, "aeo_cookie.txt"), encoding="utf-8") as f:
            s = f.read().strip()
        if s:
            return s
    except FileNotFoundError:
        pass
    return None


def load_quark_cookie(base="."):
    """Quark DA cookie 来源：优先 QUARK_COOKIE 环境变量，其次 quark_cookie.txt。"""
    env = os.environ.get("QUARK_COOKIE")
    if env and env.strip():
        return env.strip()
    try:
        with open(os.path.join(base, DEFAULT_COOKIE_PATHS["quark"]), encoding="utf-8") as f:
            s = f.read().strip()
        if s:
            return s
    except FileNotFoundError:
        pass
    return None


# ============================================================
# DA cookie 缓存（避免每次跑数都重新兑换）
# ============================================================
# 为什么需要：acquire_da_token() 每次都清空 cookie 罐并完整走一遍
#   getReport → report.htm 302 → daLogin → 种 DA_TOKEN，
# 是 3 次真实网络往返；而 DA_TOKEN 本身是有有效期的普通 cookie，
# 没过期就能直接复用。这里落盘缓存，失效才重兑。
#
# 探活端点选型（2026-09-03，两轮修正后才定下来）：
#   DA 网关**只保护 /fbi/** 路径**，/common/** 不鉴权。
#     ✗ /common/ClipAction/doQueryClipConfig（旧用）—— 空/伪造 cookie 也返回 code:0，恒真假探针
#     ✗ report.htm 不带 QUARK_PARAMS —— 有无 cookie 一律 {"code":"400","msg":"token为空"}
#     ✗ IndexAction/doUserProfile —— 名字像取用户，实际是前端告警上报
#     ✓ /fbi/fbi.json?action=site/FbiSiteAction&event_submit_doGetSite=true
#        真 cookie → JSON（code:510 "site is null"）；伪造/空 cookie → HTML 登录页。有鉴别力。
#   判据只看"是否被踢回 HTML 登录页"，不看 code 值（业务码会随环境变）。
#   即便如此，取数阶段仍有兜底：WidgetAction 若也返回 HTML → 清缓存 → 强制重兑 → 重试。
#   可选的 max_age_sec 只是给调用方的保险丝，默认不启用（不按存放时长推断失效）。

def _da_cache_path(base="."):
    # Quark 系凭据固定落在 quark_sdk/（见 DEFAULT_COOKIE_PATHS），base 不再影响路径。
    return DEFAULT_COOKIE_PATHS["quark_da_cache"]


def load_da_cache(base=".", max_age_sec=None):
    """读取缓存的 DA cookie。返回 dict(cookie/jar/saved_at/age_sec) 或 None。"""
    try:
        with open(_da_cache_path(base), encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return None
    cookie = (d.get("cookie") or "").strip()
    if not cookie:
        return None
    saved_at = float(d.get("saved_at") or 0)
    age = (time.time() - saved_at) if saved_at else None
    if max_age_sec and age is not None and age > max_age_sec:
        return None
    return {
        "cookie": cookie,
        "jar": d.get("jar") or os.path.join(base, DEFAULT_COOKIE_PATHS["quark_da_jar"]),
        "saved_at": saved_at,
        "age_sec": age,
    }


def save_da_cache(base, cookie, jar):
    """落盘 DA cookie（原子写，避免与其它进程抢同一文件时写坏）。"""
    p = _da_cache_path(base)
    tmp = p + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"cookie": cookie, "jar": jar, "saved_at": time.time()},
                      f, ensure_ascii=False)
        os.replace(tmp, p)
        return True
    except Exception as e:
        print("[da-cache] 写入失败: %s" % e, flush=True)
        return False


def clear_da_cache(base="."):
    """清空 DA cookie 缓存（排查 / 强制重兑时用）。返回是否真的删掉了文件。
    加跨进程锁，避免和正在写盘的 ensure_da_cookie 抢同一文件。"""
    from aeolus_sdk.xlock import xp_lock
    p = _da_cache_path(base)
    with xp_lock(p):
        try:
            os.remove(p)
            return True
        except FileNotFoundError:
            return False
        except Exception as e:
            print("[da-cache] 清除失败: %s" % e, flush=True)
            return False


def ensure_da_cookie(base, aeo_cookie, verbose=True, force=False, max_age_sec=None):
    """取一个可用的 Quark DA cookie：缓存探活通过就复用，否则重新兑换。

    返回 (cookie_str, jar_path, source)，source ∈ {"cache", "fresh"}；
    兑换失败抛 RuntimeError（由调用方决定回落策略）。

    探活用的是有真实鉴别力的探针（见 probe_da_health），命中缓存能省掉
    兑换的 3 次网络往返。探活本身约 0.3s，比"等取数失败再重兑"（约 +13s）划算。
    """
    jar_default = os.path.join(base, DEFAULT_COOKIE_PATHS["quark_da_jar"])

    if not force:
        c = load_da_cache(base, max_age_sec=max_age_sec)
        if c:
            age = c["age_sec"]
            age_txt = ("%.1f 小时前" % (age / 3600.0)) if age is not None else "时间未知"
            if verbose:
                print("[da-cache] 发现缓存 DA cookie（%s），先探活..." % age_txt, flush=True)
            if probe_da_health(c["cookie"], verbose=verbose):
                if verbose:
                    print("[da-cache] 缓存 DA cookie 存活，跳过兑换 ✅", flush=True)
                return c["cookie"], (c["jar"] or jar_default), "cache"
            if verbose:
                print("[da-cache] 缓存 DA cookie 已失效，重新兑换...", flush=True)
        elif verbose:
            print("[da-cache] 无可用缓存，走完整兑换链路", flush=True)

    from aeolus_sdk.xlock import xp_lock
    with xp_lock(DEFAULT_COOKIE_PATHS["quark_da_cache"]):
        # 进入跨进程锁后二次复查：等待期间别的进程可能已兑换好
        if not force:
            c = load_da_cache(base, max_age_sec=max_age_sec)
            if c and probe_da_health(c["cookie"], verbose=verbose):
                if verbose:
                    print("[da-cache] 锁内复查：缓存已由其他进程刷新，复用 ✅", flush=True)
                return c["cookie"], (c["jar"] or jar_default), "cache"
        from .da_auth import acquire_da_token
        cookie_str, jar = acquire_da_token(aeo_cookie, verbose=verbose)
        save_da_cache(base, cookie_str, jar)
        return cookie_str, (jar or jar_default), "fresh"


# ============================================================
# 报表页 & 三件套 token 提取
# ============================================================
def get_report_url(aeo_cookie):
    """用 Aeolus cookie 调 getReport，返回带 QUARK_PARAMS 的 iframe URL。"""
    req = urllib.request.Request(GET_REPORT_URL, headers={
        "accept": "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
        "cookie": aeo_cookie,
        "origin": "https://a.ele.me",
        "referer": "https://a.ele.me/",
        "user-agent": UA,
        "sec-ch-ua": '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-site",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        j = json.loads(resp.read().decode("utf-8", "replace"))
    data = j.get("data") or {}
    url = data.get("url")
    if not url:
        raise RuntimeError("getReport 未返回 url：%s" % json.dumps(j, ensure_ascii=False)[:300])
    return url


def _curl_get(url, jar=None, timeout=90):
    """用 curl 抓取页面（复用 DA cookie 罐；report.htm 需跟随重定向）。

    urllib ClientHello 指纹会被网关 403，必须 curl。
    """
    cmd = ["curl", "-sS", "--compressed", "-L",
           "-c", jar, "-b", jar,
           "--connect-timeout", "20", "--max-time", str(timeout),
           "-H", "user-agent: " + UA,
           "-H", "accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
           "-H", "referer: https://quark.alibaba.com/",
           url]
    import subprocess
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.stdout or ""


def _unescape_js_string(s):
    """把 JS 字符串字面量解回真实字符串。"""
    return json.loads('"' + s + '"')


def _extract_page_tokens(html):
    """从报表页 window.PageInfo 提取三件套。"""
    def grab(pat):
        m = re.search(pat, html)
        return _unescape_js_string(m.group(1)) if m else None

    report_id_token = grab(r'reportIdToken\\":\\"((?:(?!\\").)*?)\\"')
    sec_param = grab(r'secParam\\":\\"((?:(?!\\").)*?)\\"')
    gmt_modified = grab(r'gmtModified\\":\\"?((?:(?!\\").)*?)\\"?')
    if not gmt_modified:
        m2 = re.search(r'gmtModified\\":\\"([^\\"]+)', html)
        gmt_modified = _unescape_js_string(m2.group(1)) if m2 else None
    return report_id_token, sec_param, gmt_modified


def auto_fetch_tokens(aeo_cookie, da_jar, verbose=True):
    """纯 HTTP 自动获取 reportIdToken / secureParams / metaTime。"""
    report_url = get_report_url(aeo_cookie)
    html = _curl_get(report_url, jar=da_jar)
    if ("reportIdToken" not in html) and ("hasPermission" not in html):
        raise RuntimeError("报表页未返回有效内容（可能无权限 / QUARK_PARAMS 失效）")
    tok, sec, gmt = _extract_page_tokens(html)
    if not (tok and sec and gmt):
        raise RuntimeError("未能从报表页 window.PageInfo 提取 reportIdToken/secParam/gmtModified")
    if verbose:
        print("[tokens] 自动提取 reportIdToken(%d)/secParam(%d)/gmtModified(%s)"
              % (len(tok), len(sec), gmt), flush=True)
    return tok, sec, gmt


# ============================================================
# DA cookie 健康探针（真·鉴权，2026-09-03 重选端点）
# ============================================================
def probe_da_health(cookie, verbose=True):
    """判断 Quark DA cookie 是否还有效。判据：DA 网关是否放行。

    端点：`GET /fbi/fbi.json?action=site/FbiSiteAction&event_submit_doGetSite=true`
      · cookie 有效 → 网关放行，返回 JSON（正常是 {"code":510,"message":"site is null"}，
        510 只是"这个 embed 场景没有 site"的业务码，**不代表鉴权失败**）
      · cookie 无效 → 网关拦截，返回 HTML 登录页（与取数接口被踢回的行为一致）

    === 2026-09-09 优化（降低假阳/假阴）===
    旧版只靠「body 是否以 < 开头」判断，存在两类误判：
      - 假阳性：非 HTML 也非合法 JSON 的异常中间页被当成有效；
      - 假阴性：若登录页结构变化（不再以 < 开头）会被误判为有效。
    新版三重判据，按优先级短路：
      1) HTTP 401/403 → 网关硬拒，直接失效（最稳，不看 body）；
      2) body 以 < 开头 → 被踢回登录页，失效；
      3) 能 json.loads 成功 → 网关放行（JSON 即鉴权通过），有效；
      4) 其余（非 JSON 非 HTML 的怪响应）→ 保守判失效，宁可多兑一次，也不拿坏 cookie 去取数。
    仍保留取数侧 WidgetAction 兜底（返回 HTML 即清缓存重兑），本探针只是省一次往返的快筛。
    """
    req = urllib.request.Request(DA_HEALTH_URL, headers={
        "accept": "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
        "cookie": cookie,
        "referer": "https://quark.alibaba.com/dashboard/view/report.htm?id=860325&DA_APP_NAME=lpd_meepo_ws",
        "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin",
        "user-agent": UA,
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            status = resp.status
            body = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if verbose:
            print("[health] DA cookie 失效（HTTP %s，网关硬拒）" % e.code, flush=True)
        return False
    except Exception as e:
        print("[health] 探测异常（按失效处理，将重新兑换）: %s" % e, flush=True)
        return False
    # 1) 网关硬拒
    if status in (401, 403):
        if verbose:
            print("[health] DA cookie 失效（HTTP %s）" % status, flush=True)
        return False
    # 2) 被踢回登录页
    if body.lstrip().startswith("<"):
        if verbose:
            print("[health] DA cookie 失效（被踢回登录页）", flush=True)
        return False
    # 3) 网关放行：必须是合法 JSON（成功时一定是 JSON，510 也是 JSON）
    try:
        json.loads(body)
    except Exception:
        if verbose:
            print("[health] 响应既非 JSON 也非登录页，按失效处理（防假阳性）", flush=True)
        return False
    if verbose:
        print("[health] DA cookie 有效 ✅", flush=True)
    return True


__all__ = [
    # 凭证
    "load_aeo_cookie", "load_quark_cookie",
    "load_da_cache", "save_da_cache", "clear_da_cache", "ensure_da_cookie",
    # 报表
    "get_report_url", "auto_fetch_tokens", "probe_da_health",
    # 常量
    "DEFAULT_COOKIE_PATHS", "AEOLUS_COOKIE_FILE",
    "GET_REPORT_URL", "DA_HEALTH_URL",
]
