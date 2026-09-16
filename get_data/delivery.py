#!/usr/bin/env python3
"""运单明细 HTTP 取数 —— 单一来源。

本文件只做一件事：调用 aeolus 运单详情接口
`xtop.agencyTrackingFs.queryTracking/2.0` 拉取运单明细。

设计约定（见工作区永久记忆 get_data 约定）：
- 每个 get_data 模块 = 一个接口，只负责「打接口取数」
- 所有查询参数（时间窗 start_ms/end_ms、时段切片 period、每页大小 page_size、cookie）
  均由调用方传入；本文件不负责选日期、落盘、自动重登、限流退避或格式化
- 分页/落盘/重登/退避等编排逻辑归调用方（如 jobs/delivery/raw_fetch.py）

对外能力：
- query(start_ms, end_ms, current, page_size, period, cookie=None) -> (rows, total)  单次分页请求
- fetch(start_ms, end_ms, page_size, period, pace, cookie=None) -> list[dict]         分页拉全量
- build_body(...) / API / HEADERS_BASE / PAGE_SIZE / BJ / AuthError             供调用方组装/判别
"""
import datetime
import json
import urllib.request
import urllib.error

from aeolus_sdk import login as L

API = "https://httpizza.ele.me/xtop/xtop.agencyTrackingFs.queryTracking/2.0"
HEADERS_BASE = {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "origin": "https://aeolus.ele.me",
    "referer": "https://aeolus.ele.me/",
}
PAGE_SIZE = 50
BJ = datetime.timezone(datetime.timedelta(hours=8))


class AuthError(Exception):
    """会话失效（单点登录被顶号 / cookie 过期）。"""


def build_body(start_ms, end_ms, current, page_size, period="0-86400"):
    """组装单次分页请求体。period 为时段切片（如 "0-21600"），由调用方决定。"""
    return {"params": {"request": {
        "trackingFinishStart": start_ms,
        "trackingFinishEnd": end_ms,
        "merchantConsumerDistanceStart": "0",
        "merchantConsumerDistanceEnd": "999999",
        "payAmountStart": "0",
        "payAmountEnd": "999999",
        "weightStart": "0",
        "weightEnd": "999999",
        "current": current,
        "pageSize": page_size,
        "trackingStateKey": "all",
        "trackingLabelKey": "all",
        "trackingFinishTimePeriodList": [period],
    }}}


def query(start_ms, end_ms, current, page_size=PAGE_SIZE,
          period="0-86400", retries=8, cookie=None):
    """单次分页请求，返回 (rows, total)。

    cookie 可选，不传则自动 ensure_cookies() 登录。
    网络抖动按 retries 重试（不 sleep，节奏由调用方在页间控制）。
    会话失效（result 为 null / 401 / 账户下线）抛 AuthError，由调用方重登重试。
    其它业务错误（含限流 FREQUENT）抛 RuntimeError。
    """
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    last = None
    for attempt in range(retries):
        h = dict(HEADERS_BASE)
        h["cookie"] = cookie
        body = build_body(start_ms, end_ms, current, page_size, period)
        req = urllib.request.Request(API, data=json.dumps(body).encode(),
                                     headers=h, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                j = json.loads(r.read().decode())
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            last = f"net {e}"
            continue
        res = j.get("result")
        if res is None:
            raise AuthError("result is null（会话被顶号）")
        code = str(res.get("code"))
        msg = str(res.get("msg"))
        if code != "200":
            if "FREQUENT" in code.upper() or "频繁" in msg:
                last = msg
                continue
            if code == "401" or "下线" in msg or "账户" in msg:
                raise AuthError(f"{code} {msg}")
            raise RuntimeError(f"code={code} msg={msg}")
        d = res.get("data") or {}
        return (d.get("data") or []), int(d.get("total") or 0)
    raise RuntimeError(f"重试 {retries} 次仍失败: {last}")


def fetch(start_ms, end_ms, page_size=PAGE_SIZE, period="0-86400", pace=0.0, cookie=None):
    """分页拉取时间段内全部运单明细，返回行列表（list[dict]）。

    参数：时间窗 start_ms/end_ms、时段切片 period、每页大小 page_size；cookie 可选，不传则自动登录。
    pace 为页间停顿秒数（默认 0 不休眠；调用方按接口限流需要自行设定，如 0.5）。
    不含自动重登 / 落盘 / 限流退避 / limit 截断；会话失效抛 AuthError 交由调用方处理。
    """
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    page_size = max(1, min(page_size, PAGE_SIZE))
    all_rows = []
    current = 1
    while True:
        rows, total = query(start_ms, end_ms, current, page_size, period, cookie=cookie)
        if not rows:
            break
        all_rows.extend(rows)
        if len(all_rows) >= total:
            break
        current += 1
        if pace and current <= total // page_size:
            import time
            time.sleep(pace)
    return all_rows


__all__ = ["API", "HEADERS_BASE", "PAGE_SIZE", "BJ", "AuthError",
           "build_body", "query", "fetch"]
