#!/usr/bin/env python3
"""排班目标（排班统计）取数 —— 单一来源。

本文件只做一件事：调用 aeolus 排班统计接口
`xtop.fs.special.schedule.listScheduleStatistics/1.0` 拉取「排班目标 / 预测基线」。

设计约定（见工作区永久记忆 get_data 约定）：
- 每个 get_data 模块 = 一个接口，只负责「打接口取数」
- 所有查询参数（cookie / team_id / start_date / end_date）均由调用方传入
- 禁止在模块内做：自动重登 / 展平(flatten) / 写盘 / CLI
- 「Session 自动重登 / flatten / 调用编排」归调用方（dashboard/standard/schedule_statistics.py）

对外能力：
- query(team_id, start_date, end_date, retries=8, cookie=None) -> rows   单次请求，返回 result.data（按天列表）
- build_body(team_id, start_date, end_date)                       组装请求体
- AuthError                                                      会话失效异常（调用方捕获后重登）
"""
import json
import time
import datetime
import urllib.request
import urllib.error

from aeolus_sdk import login as L

API_URL = "https://httpizza.ele.me/xtop/xtop.fs.special.schedule.listScheduleStatistics/1.0"
HEADERS_BASE = {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "origin": "https://r.ele.me",
    "referer": "https://r.ele.me/pikipek/schedule.html?platform=fs&subType=ub",
}


class AuthError(Exception):
    """会话失效（单点登录被顶号 / cookie 过期）。"""


def _as_date_str(d):
    """接受 'YYYY-MM-DD' 字符串或 datetime.date，统一返回 'YYYY-MM-DD'。"""
    if isinstance(d, datetime.date):
        return d.strftime("%Y-%m-%d")
    return str(d)


def build_body(team_id, start_date, end_date):
    return {"params": {"request": {
        "teamId": int(team_id),
        "startDate": _as_date_str(start_date),
        "endDate": _as_date_str(end_date),
    }}}


def query(team_id, start_date, end_date, retries=8, cookie=None):
    """单次请求，返回 result.data（按天的列表）。

    cookie 可选，不传则自动 ensure_cookies() 登录。
    限流自动退避；会话失效（result 为 null / 401 / 账户下线）抛 AuthError，
    由上层 Session / fetch 捕获后重登重试。
    """
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    last = None
    for attempt in range(retries):
        h = dict(HEADERS_BASE)
        h["cookie"] = cookie
        body = build_body(team_id, start_date, end_date)
        req = urllib.request.Request(API_URL, data=json.dumps(body).encode(),
                                     headers=h, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                j = json.loads(r.read().decode())
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            last = f"net {e}"
            time.sleep(2 + attempt * 2)
            continue
        res = j.get("result")
        if res is None:
            raise AuthError("result is null（会话被顶号）")
        code = str(res.get("code"))
        msg = str(res.get("msg"))
        if code != "200":
            if code == "401" or "下线" in msg or "账户" in msg:
                raise AuthError(f"{code} {msg}")
            if "FREQUENT" in code.upper() or "频繁" in msg:
                last = msg
                time.sleep(3 + attempt * 3)
                continue
            raise RuntimeError(f"code={code} msg={msg}")
        return res.get("data") or []
    raise RuntimeError(f"重试 {retries} 次仍失败: {last}")


__all__ = ["API_URL", "HEADERS_BASE", "AuthError", "build_body", "query"]
