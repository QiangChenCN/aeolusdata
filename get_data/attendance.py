#!/usr/bin/env python3
"""实时考勤 HTTP 取数 —— 单一来源。

本文件只做一件事：调用风神实时考勤接口
`xtop.fs.special.realtimeattendance.listAttendance/1.0` 拉取单站点实时考勤原始数据。

设计约定（见工作区永久记忆 get_data 约定）：
- 每个 get_data 模块 = 一个接口，只负责「打接口取数」
- 所有查询参数（team_id / time_code / cookie）均由调用方传入，本文件不做选站点、统计、筛选
- 统计 / 筛选 / 格式化 / 自动重登 / 落盘等逻辑归调用方，不在此处

如需「站点发现（选站点）」，见 get_data/teams.py 的 fetch_teams。
"""
import json
import os
import ssl
import urllib.request

from aeolus_sdk import login as L

API_URL = "https://httpizza.ele.me/xtop/xtop.fs.special.realtimeattendance.listAttendance/1.0"

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

# 默认强校验证书；仅 DISABLE_TLS_VERIFY=1 时回退不校验
if os.environ.get("DISABLE_TLS_VERIFY") == "1":
    _CTX = ssl.create_default_context()
    _CTX.check_hostname = False
    _CTX.verify_mode = ssl.CERT_NONE
else:
    _CTX = ssl.create_default_context()


def fetch_team(team_id, time_code, cookie=None):
    """单站点实时考勤 → 接口原始 JSON（含 result.data 骑手列表）。

    参数：team_id（站点）、time_code（时段码）；cookie 可选，不传则自动登录。
    """
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    body = json.dumps({"params": {"request": {
        "teamId": team_id,
        "timeCode": str(time_code),
        "shiftedOffline": 0,
    }}}).encode("utf-8")
    headers = dict(STATIC_HEADERS)
    headers["cookie"] = cookie
    req = urllib.request.Request(API_URL, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30, context=_CTX) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw)


__all__ = ["API_URL", "STATIC_HEADERS", "fetch_team"]
