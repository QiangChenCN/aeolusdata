#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""实测从页面 bundle 里挖到的「团队/站点列表」候选接口。

一次性诊断脚本。接口名来自 r.ele.me 排班页 JS bundle 的正则扫描（方法见 docs/接口清单.md 文末「逆向方法」）。
用法：.venv/Scripts/python.exe tools/probe_teams.py
"""
import os, sys, json, ssl, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import venv_guard  # noqa: F401
from get_data.teams import fetch_teams  # 复用生产封装（与 /api/teams 同源，单点真相）
from aeolus_sdk import login as L

HOST = "https://httpizza.ele.me/xtop/"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0")
CTX = ssl.create_default_context()


def post(action, body, cookie, referer="https://r.ele.me/pikipek/schedule.html?platform=fs&subType=ub",
         origin="https://r.ele.me"):
    h = {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/json",
        "origin": origin,
        "referer": referer,
        "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-site",
        "user-agent": UA,
        "cookie": cookie,
    }
    req = urllib.request.Request(HOST + action, data=json.dumps(body).encode("utf-8"),
                                 headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=25, context=CTX) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.read().decode("utf-8", "replace") if e.fp else "")
    except Exception as e:
        return -1, "%s: %s" % (type(e).__name__, e)


# 已知生产接口（getTeamsAll/1.0 + {}）已由 fetch_teams 封装，不在此重复实现；
# 这里只保留"探活/逆向"用的候选接口（含已知接口的其它 body 变体）。
SPECULATIVE = [
    ("xtop.lpd.intelligentConfig.getTeamsAll/1.0", {"params": {}}),
    ("xtop.lpd.intelligentConfig.getTeamsAll/1.0", {"params": {"request": {}}}),
    ("xtop.team.components.query/1.0", {"params": {}}),
    ("xtop.agency.components.query/1.0", {"params": {}}),
]


def main():
    cookie, st = L.ensure_cookies()
    print("cookie: %s (%d 字符)\n" % (st, len(cookie or "")))

    # ① 已知生产接口：直接复用 fetch_teams（单点真相，与 /api/teams 同源）
    print("=" * 76)
    print("[PROD] xtop.lpd.intelligentConfig.getTeamsAll/1.0  (fetch_teams)")
    try:
        teams = fetch_teams(cookie)
        print("  成功，共 %d 站：" % len(teams))
        for tid, name in teams:
            print("    - %s  %s" % (tid, name))
    except Exception as e:
        print("  失败: %s: %s" % (type(e).__name__, e))

    # ② 候选接口：仍用通用 post() 试探，接口若变更可快速复验
    for action, body in SPECULATIVE:
        code, text = post(action, body, cookie)
        print("=" * 76)
        print("[%s] %s" % (code, action))
        print("  body: %s" % json.dumps(body, ensure_ascii=False))
        print("  resp: %s" % text[:600].replace("\n", " "))
        if code == 200:
            try:
                j = json.loads(text)
            except Exception:
                continue
            s = json.dumps(j, ensure_ascii=False)
            print("  长度 %d 字符；含 teamId=%s teamName=%s" %
                  (len(s), "teamId" in s, "teamName" in s))
            if "teamId" in s or "teamName" in s:
                # 尝试定位列表数组
                def walk(o, path=""):
                    if isinstance(o, list) and o and isinstance(o[0], dict) \
                       and ("teamId" in o[0] or "teamName" in o[0]):
                        print("  >>> 列表在 %s，共 %d 条" % (path or "root", len(o)))
                        print("  >>> 首条: %s" % json.dumps(o[0], ensure_ascii=False)[:400])
                        return True
                    if isinstance(o, dict):
                        for k, v in o.items():
                            if walk(v, path + "." + k):
                                return True
                    return False
                walk(j)
                print("  >>> 完整: %s" % s[:1200])
    print("=" * 76)


if __name__ == "__main__":
    main()
