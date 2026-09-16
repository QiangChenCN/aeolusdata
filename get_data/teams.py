#!/usr/bin/env python3
"""站点发现（选站点）HTTP 取数 —— 单一来源。

本文件只做一件事：调用风神站点列表接口
`xtop.lpd.intelligentConfig.getTeamsAll/1.0` 拉取当前账号可见的全部站点。

设计约定（见工作区永久记忆 get_data 约定）：
- 每个 get_data 模块 = 一个接口，只负责「打接口取数」
- 参数（cookie）由调用方传入；本文件不做筛选之外的编排
- 「选站点」是调用方的职责；本文件只提供原始站点清单供其选择

（实时考勤取数在 get_data/attendance.py 的 fetch_team。）
"""
import json
import os
import ssl
import urllib.request

from aeolus_sdk import login as L

TEAMS_API = "https://httpizza.ele.me/xtop/xtop.lpd.intelligentConfig.getTeamsAll/1.0"

STATIC_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
    "content-type": "application/json",
    "origin": "https://r.ele.me",
    "referer": "https://r.ele.me/pikipek/schedule.html?platform=fs&subType=ub",
    "sec-ch-ua": '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
}

if os.environ.get("DISABLE_TLS_VERIFY") == "1":
    _CTX = ssl.create_default_context()
    _CTX.check_hostname = False
    _CTX.verify_mode = ssl.CERT_NONE
else:
    _CTX = ssl.create_default_context()


def fetch_teams(cookie=None):
    """拉取全部站点（团队）→ [(team_id, name), ...]。

    cookie 可选：不传则自动 ensure_cookies() 登录（aeolus_sdk.login）。
    只保留 `teamStatus == 1`（有效）的站点，停运站点跳过。
    失败抛异常，由调用方决定回落兜底还是中止——不在此静默吞掉。
    """
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    headers = dict(STATIC_HEADERS)
    headers["cookie"] = cookie
    req = urllib.request.Request(TEAMS_API, data=b"{}", headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30, context=_CTX) as resp:
        j = json.loads(resp.read().decode("utf-8"))
    data = ((j.get("result") or {}).get("data")) or []
    out = []
    for t in data:
        if t.get("teamStatus") not in (None, 1):
            continue                       # 非有效站点（停运/已下线）直接跳过
        tid, name = t.get("id"), t.get("team_name")
        if tid and name:
            out.append((tid, name))
    return out


__all__ = ["TEAMS_API", "STATIC_HEADERS", "fetch_teams"]
