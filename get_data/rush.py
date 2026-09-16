#!/usr/bin/env python3
"""dispatcher 急单取数 —— 单一来源。

本文件只做一件事：调用 dispatcher 三个接口分页拉三站「在途急单」完整明细：
  1) skyeye.shippingorder.paging/1.0              按状态分页拉 trackingId
  2) shippingOrderQuery.getShippingOrderList/1.0  按 trackingId 批量拉订单（含 isRushOrder）
  3) shippingOrderQuery.getOrderDetail/1.0        单条订单完整详情

设计约定（见工作区永久记忆 get_data 约定）：
- 每个 get_data 模块 = 一个接口族（急单需三连调），只负责「打接口取数」
- 所有查询参数（cookie / team_id / station / 站点账号常量）均由调用方或本模块常量传入
- 禁止在模块内做：merge 去重 / 时间格式化 / 写 CSV / 自动重登 / CLI
- 调用方（jobs/rush/fetch_jidan.py）负责 merge / fmt_time / 写盘 / 站点循环

对外能力：
- fetch_team(team_id, station, cookie=None) -> dict
  返回 {"teamId","station","totalTids","totalOrders","rushCount","pairs":[(order, detail)]}
  pairs 仅含 isRushOrder===True 且 state∈IN_PROGRESS 的急单（这是「急单」的数据定义，非业务筛选）。
"""
import os
import json
import time
import ssl
import urllib.request
import urllib.error

from aeolus_sdk import login as L

USER_ID = 13053485
CITY_ID = 51
PAGE_SIZE = 200
DETAIL_BATCH = 80
IN_PROGRESS = [10, 20, 30]  # 在途状态

API_PAGING = "https://httpizza.ele.me/xtop/xtop.lpdcs.skyeye.shippingorder.paging/1.0"
API_LIST = "https://httpizza.ele.me/xtop/xtop.lpd.matrix.intervention.shippingOrderQuery.getShippingOrderList/1.0"
API_DETAIL = "https://httpizza.ele.me/xtop/xtop.lpd.matrix.intervention.shippingOrderQuery.getOrderDetail/1.0"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0")

# 默认强校验证书；仅 DISABLE_TLS_VERIFY=1 时回退不校验（见 aeolus_sdk/login.py 说明）
if os.environ.get("DISABLE_TLS_VERIFY") == "1":
    _CTX = ssl.create_default_context()
    _CTX.check_hostname = False
    _CTX.verify_mode = ssl.CERT_NONE
else:
    _CTX = ssl.create_default_context()


def _post(cookie, api, params, team_id, timeout=30):
    """POST 一个 dispatcher 接口，返回 result.data 或 None。"""
    body = json.dumps({"metas": {"teamid": team_id}, "params": params}).encode("utf-8")
    req = urllib.request.Request(api, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Cookie": cookie,
        "User-Agent": UA,
        "Referer": "https://dispatcher.ele.me/",
        "Origin": "https://dispatcher.ele.me",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    })
    with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as r:
        j = json.loads(r.read().decode("utf-8", "replace"))
    return (j and j.get("result") and j["result"].get("data")) or None


def _post_retry(cookie, api, params, team_id, tries=3):
    last = None
    for _ in range(tries):
        try:
            d = _post(cookie, api, params, team_id)
            if d is not None:
                return d
        except Exception as e:  # 网络/HTTP 异常，重试
            last = e
        time.sleep(0.8)
    if last:
        import sys
        sys.stderr.write("  [warn] 接口重试 %d 次仍无数据: %s\n" % (tries, api))
    return None


def fetch_team(team_id, station, cookie=None):
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    # ① paging 拉在途 [10,20,30] 的 trackingId（paging 不接受多状态，逐状态循环）
    tids = []
    for status in IN_PROGRESS:
        page = 1
        while True:
            d = _post_retry(cookie, API_PAGING, {
                "request": {
                    "teamId": team_id, "userId": USER_ID, "status": [status],
                    "knightIdList": [], "retailerIdList": [], "platformTrackingId": "",
                    "trackingId": "", "shippingOrderSort": "exceptionTime", "sort": 1,
                    "pageIndex": page, "pageSize": PAGE_SIZE,
                }
            }, team_id)
            if not d:
                break
            pl = d.get("shippingOrderInfoList") or []
            tids += [o.get("trackingId") for o in pl]
            if len(tids) >= d.get("total", 0) or len(pl) < PAGE_SIZE:
                break
            page += 1

    # ② getShippingOrderList 批量(80)拉详情，筛 isRushOrder && 在途
    orders = []
    for i in range(0, len(tids), DETAIL_BATCH):
        chunk = tids[i:i + DETAIL_BATCH]
        d2 = _post_retry(cookie, API_LIST, {
            "request": {"teamId": team_id, "trackingIds": chunk, "cityId": CITY_ID, "shopTeam": False}
        }, team_id)
        if d2:
            orders += (d2.get("shippingOrderInfoList") or [])
        time.sleep(0.3)
    rush = [o for o in orders if o.get("isRushOrder") is True and o.get("state") in IN_PROGRESS]

    # ③ 逐单 getOrderDetail 拉完整详情
    pairs = []
    for o in rush:
        tid = o.get("trackingId")
        det = _post_retry(cookie, API_DETAIL, {"teamId": team_id, "trackingId": str(tid)}, team_id)
        pairs.append((o, det or {}))
        time.sleep(0.2)
    return {
        "teamId": team_id, "station": station,
        "totalTids": len(tids), "totalOrders": len(orders),
        "rushCount": len(rush), "pairs": pairs,
    }


__all__ = ["API_PAGING", "API_LIST", "API_DETAIL", "UA", "USER_ID", "CITY_ID",
           "PAGE_SIZE", "DETAIL_BATCH", "IN_PROGRESS", "_post", "_post_retry", "fetch_team"]
