# -*- coding: utf-8 -*-
"""纯 HTTP 兑换 Quark DA_TOKEN（无需 Playwright / 无需手动复制 cookie）。

===== 鉴权链路（2026-08-19 实测确认，最终版）=====
  1. Aeolus 登录（aeolus_sdk）→ 拿 AEOLUS_MOZI_TOKEN              【纯 HTTP】
  2. GET app2-edu.ele.me/kunkka-svr/fs/fbi/getReport?reportId=860325
     带 AEOLUS_MOZI_TOKEN → 返回带 QUARK_PARAMS 的 iframe URL     【纯 HTTP】
  3. GET report.htm?...QUARK_PARAMS=...（curl 中性 TLS 指纹）
     → 302 到 daLogin.htm?DA_BACK_URL=...&DA_SESSION=...           【纯 HTTP；urllib 会被网关按指纹拦 403】
  4. GET daLogin.htm?...（带 AEOLUS_MOZI_TOKEN）→ 跟随 302 回 quark
     → 种下 DA_TOKEN_lpd_meepo_ws（及其它 quark 域 cookie）        【纯 HTTP】
  5. 带 DA_TOKEN cookie 打 /fbi/.json WidgetAction → 拿数据       【纯 HTTP】

关键修正（推翻旧结论）：
  - 旧结论「DA 兑换必须浏览器 BucSSO 握手，纯 HTTP 复刻不了」是错的。
  - 真实 blocker 是 Python urllib 的 ClientHello TLS 指纹被网关拒（HTTP 403）。
  - curl 的中性指纹能过 report.htm → 302，因此整套链路纯 HTTP 即可闭环，
    根本不需要 Playwright / 不需要手动从浏览器复制 cookie。

用法（作为模块）：
  from quark_sdk.da_auth import acquire_da_token
  cookie_str, jar_path = acquire_da_token(aeo_cookie, verbose=True)

用法（独立测试）：
  python da_auth.py            # 自动 aeolus 登录 → 兑换 DA_TOKEN → 打印
                                    # （在 quark-sdk/ 目录下运行；脚本会自动把项目根加入 sys.path）
"""

import os
import sys
import json
import subprocess

# quark-sdk/ 位于项目根目录下；jar 与运行时缓存同源（均在项目根，已由 .gitignore 忽略）。
# 即使直接 `python da_auth.py`（此时 sys.path[0] 是 quark-sdk/ 而非项目根），
# 也保证项目根在 sys.path，使 `import aeolus_sdk.login` 可用。
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

HERE = os.path.dirname(os.path.abspath(__file__))

GET_REPORT_URL = "https://app2-edu.ele.me/kunkka-svr/fs/fbi/getReport?reportId=860325"
# curl jar 与 quark_da_cache.json 同源（同在 quark_sdk/ 包内），保持与
# quark_sdk/quark.py 的 DEFAULT_COOKIE_PATHS["quark_da_jar"] 一致。
QUARK_DA_JAR = os.path.join(HERE, "quark_da_cookies.txt")

# WidgetAction 需要的 cookie 来自 quark.alibaba.com 域；其它域（ele.me）的不带。
QUARK_DOMAIN = "quark.alibaba.com"


def _has_curl():
    from shutil import which
    return bool(which("curl"))


def _run_curl(args, cookie_header=None, jar=None, max_redirs=None,
              capture_redirect=False, timeout=60):
    """用 curl 发起请求。返回 subprocess.CompletedProcess（stdout 为文本）。

    - jar: 传入则自动加 -b/-c 复用同一 cookie 罐（跨重定向累积 cookie）。
    - capture_redirect: 设为 True 则不跟随重定向，并把 Location 通过
      -w '%{redirect_url}' 打到 stdout（用于从 report.htm 拿 daLogin URL）。
    """
    cmd = ["curl", "-sS", "--compressed"]
    if jar:
        cmd += ["-c", jar, "-b", jar]
    if cookie_header:
        cmd += ["-H", "cookie: " + cookie_header]
    if capture_redirect:
        cmd += ["--max-redirs", "0", "-o", os.devnull, "-w", "%{redirect_url}"]
    elif max_redirs is not None:
        cmd += ["--max-redirs", str(max_redirs)]
    cmd += ["--connect-timeout", "20", "--max-time", str(timeout)]
    cmd += args
    return subprocess.run(cmd, capture_output=True, text=True)


def _read_quark_cookie_str(jar_path):
    """从 Netscape cookie 罐里挑出 quark 域的 cookie，拼成 'a=1; b=2' 串。"""
    if not os.path.exists(jar_path):
        return ""
    pairs = []
    with open(jar_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\r\n")
            if not line:
                continue
            parts = line.split("\t")
            # Netscape 注释行（如 "# Netscape HTTP Cookie File"）字段数 < 7，跳过；
            # curl 把 HttpOnly cookie 写成 "#HttpOnly_.domain" —— 这是数据行，不能跳过。
            if len(parts) < 7:
                continue
            domain, _, _, _, _, name, value = parts[:7]
            if domain.startswith("#HttpOnly_"):
                domain = domain[len("#HttpOnly_"):]
            if QUARK_DOMAIN in domain:
                pairs.append("%s=%s" % (name, value))
    return "; ".join(pairs)


def acquire_da_token(aeo_cookie, report_id="860325", jar_path=QUARK_DA_JAR,
                     verbose=True):
    """用 Aeolus cookie 纯 HTTP 兑换 Quark DA_TOKEN。

    返回 (cookie_str, jar_path)。cookie_str 已含 quark 域全部 cookie（DA_TOKEN 等），
    可直接喂给 WidgetAction。失败时抛 RuntimeError。
    """
    if not aeo_cookie:
        raise RuntimeError("缺少 Aeolus cookie（AEOLUS_MOZI_TOKEN），无法兑换 DA_TOKEN")
    if not _has_curl():
        raise RuntimeError("未找到 curl（请安装或加入 PATH）；纯 HTTP 链路需要 curl 的中性 TLS 指纹")

    # 1) getReport 拿 iframe 票据 URL（urllib 即可，已验证；这里用 urllib 保持纯标准库）
    import urllib.request
    get_url = "https://app2-edu.ele.me/kunkka-svr/fs/fbi/getReport?reportId=" + report_id
    req = urllib.request.Request(get_url, headers={
        "accept": "application/json, text/plain, */*",
        "cookie": aeo_cookie,
        "origin": "https://a.ele.me",
        "referer": "https://a.ele.me/",
        "user-agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0"),
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        j = json.loads(resp.read().decode("utf-8", "replace"))
    report_url = (j.get("data") or {}).get("url")
    if not report_url:
        raise RuntimeError("getReport 未返回 url：%s" % json.dumps(j, ensure_ascii=False)[:300])
    qp_len = len(report_url.split("QUARK_PARAMS=", 1)[1]) if "QUARK_PARAMS=" in report_url else 0
    if verbose:
        print("[da] getReport ok，QUARK_PARAMS 长度 %d" % qp_len, flush=True)

    # 清掉旧罐，保证只采集本次链路产出的 cookie
    if os.path.exists(jar_path):
        os.remove(jar_path)
    open(jar_path, "a").close()

    # 2) report.htm（curl 中性指纹）→ 302 到 daLogin（含 DA_SESSION）
    p = _run_curl([report_url], capture_redirect=True)
    da_login = (p.stdout or "").strip()
    if "DA_SESSION=" not in da_login:
        raise RuntimeError("report.htm 未返回 daLogin 302（curl 拿到: %r）" % (p.stdout or "")[:300])
    if verbose:
        print("[da] report.htm -> daLogin 302 含 DA_SESSION ✅", flush=True)

    # 3) daLogin（带 Aeolus 令牌）→ 跟随 302 回 quark → 种 DA_TOKEN
    p = _run_curl([da_login, "-L"], cookie_header=aeo_cookie, jar=jar_path)
    if verbose:
        print("[da] daLogin 跟随完成（HTTP=%s）" % p.returncode, flush=True)

    # 4) 读罐拼 cookie 串
    cookie_str = _read_quark_cookie_str(jar_path)
    da = [c for c in cookie_str.split("; ") if c.startswith("DA_TOKEN")]
    if not da:
        # 打印罐内容便于排查
        jar_txt = ""
        try:
            with open(jar_path, encoding="utf-8", errors="replace") as f:
                jar_txt = f.read()[:600]
        except Exception:
            pass
        raise RuntimeError("daLogin 后未在罐中找到 DA_TOKEN。罐内容:\n%s" % jar_txt)

    if verbose:
        print("[da] DA_TOKEN 已获取 ✅（共 %d 个 quark cookie）" % len(cookie_str.split("; ")), flush=True)
    return cookie_str, jar_path


def main():
    # 独立测试：自动 aeolus 登录 → 兑换 DA_TOKEN
    try:
        import aeolus_sdk.login as al
        aeo, status = al.ensure_cookies(al.COOKIE_FILE)
        if not aeo:
            print("[da] Aeolus 登录失败（status=%s），无法继续" % status, flush=True)
            raise SystemExit(1)
        print("[da] Aeolus 登录状态: %s" % status, flush=True)
    except Exception as e:
        print("[da] Aeolus 自动登录异常: %s" % e, flush=True)
        raise SystemExit(1)

    try:
        cookie_str, jar = acquire_da_token(aeo, verbose=True)
    except Exception as e:
        print("[da] 兑换失败: %s" % e, flush=True)
        raise SystemExit(1)

    print("==== DA cookie 串（前 120 字符）====", flush=True)
    print(cookie_str[:120] + ("..." if len(cookie_str) > 120 else ""), flush=True)
    print("==== jar: %s ====" % jar, flush=True)
    print("=== DONE ===", flush=True)


if __name__ == "__main__":
    main()
