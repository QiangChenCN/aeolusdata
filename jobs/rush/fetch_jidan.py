#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_jidan.py —— 纯 HTTP 请求获取 dispatcher 急单（三站点，Python 版，不接管浏览器）

数据全部来自 3 个 HTTP 接口（直接带风神 cookie 调，不需要 CDP / 浏览器）：
 1) skyeye.shippingorder.paging/1.0
        —— 按状态分页拉 trackingId（仅 ID，不含急单标记）
 2) shippingOrderQuery.getShippingOrderList/1.0
        —— 按 trackingId 批量拉订单，响应含 isRushOrder / rushOrderDefineTypes /
           rushOrderHighestPriority / state / mname / maddress / name / knightPhone
 3) shippingOrderQuery.getOrderDetail/1.0
        —— 单条订单完整详情（97 字段：商家/顾客/骑手/时间/异常/商品/轨迹/异常报备）

急单定义（与看板一致）：isRushOrder===true 且 state∈{10,20,30}（在途可处理）

cookie 复用 `aeolus_sdk.login.ensure_cookies()`（风神 SSO，与 appeal_reminder 同一套），
故无需浏览器、无需手动传 cookie。

三站点 teamId（与考勤同体系）：
  917521130 -> 黄江；917521136 -> 万科；917521139 -> 大岭山大学城

用法：python fetch_jidan.py
产物：dispatcher_jidan_3stations.json / dispatcher_jidan_3stations.csv
"""
import os
import sys
import json
import time
import csv

HERE = os.path.dirname(os.path.abspath(__file__))      # jobs/rush
ROOT = os.path.dirname(os.path.dirname(HERE))          # 项目根（公共模块所在）
_COMMON = os.path.join(ROOT, "common")
if ROOT not in sys.path:                                # 不依赖调用方 cwd
    sys.path.insert(0, ROOT)
if _COMMON not in sys.path:                             # 公共模块已归集到 common/
    sys.path.insert(0, _COMMON)
OUT_DIR = os.path.join(HERE, "out")                    # 产物统一进 out/
os.makedirs(OUT_DIR, exist_ok=True)
sys.path.insert(0, HERE)
from aeolus_sdk.login import ensure_cookies  # 复用风神登录拿 cookie
from get_data import rush   # dispatcher 急单取数（单一来源；fetch_team 在此）

TEAMS = [(917521130, "黄江"), (917521136, "万科"), (917521139, "大岭山大学城")]

# state 中文映射（已用户校正：30=待送达）
STATE_LABEL = {10: "待接单", 20: "待到店", 30: "待送达", 40: "已完成", 80: "已取消", 90: "异常"}

# 急单类型 type -> 中文
RUSH_DEFINES = {
    1: "已超时", 2: "即将超时", 3: "特护订单特殊急单规则", 4: "骑手到店异常", 5: "骑手取餐慢",
    6: "高价值取餐慢", 7: "到店慢超时风险", 8: "取餐慢超时风险", 9: "配送慢超时风险", 10: "待指派运单智能调度超时",
}

# 急单取数已迁到 get_data.rush（单一来源；fetch_team / _post / 三连调常量全在那）。
# 本文件只做：站点循环 / 数据合并 / 字段展平 / 落盘 CSV+JSON。



def fmt_time(v):
    if v is None or v == "":
        return ""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return str(v)
    if not n:
        return str(v)
    d = time.gmtime(n / 1000.0) if n > 1e12 else time.localtime(n / 1000.0)
    return time.strftime("%m-%d %H:%M:%S", d)


def merge(data):
    merged = []
    for t in data:
        for o, dt in t["pairs"]:
            types = o.get("rushOrderDefineTypes") or []
            ev = (dt.get("eventList") or dt.get("displayEventList") or [])
            track = " | ".join(
                (e.get("eventName") or e.get("name") or "")
                + " "
                + (time.strftime("%Y/%m/%d %H:%M:%S", time.localtime(e.get("eventTime") / 1000.0))
                   if isinstance(e.get("eventTime"), (int, float)) else (e.get("time") or ""))
                for e in ev
            )
            goods = "; ".join(
                (it.get("name") or it.get("itemName") or "") + "x" + str(it.get("count") or it.get("quantity") or 1)
                for it in (dt.get("itemList") or [])
            )
            abnormal = (dt.get("reportAbnormalEventList") or [])
            abnormal_report = "暂无"
            if abnormal:
                parts = []
                for a in abnormal:
                    desc = a.get("feedbackDesc") or a.get("reason") or a.get("desc") \
                        or a.get("remark") or a.get("type") or ""
                    at = a.get("adjustType")
                    parts.append((desc + " (" + at + ")") if (desc and at) else (desc or at or "异常报备"))
                abnormal_report = "; ".join(parts)

            merged.append({
                "station": t["station"],
                "teamId": t["teamId"],
                "state": o.get("state"),
                "stateLabel": STATE_LABEL.get(o.get("state"), "state_" + str(o.get("state"))),
                "rushTypes": [RUSH_DEFINES.get(tp, "type_" + str(tp)) for tp in types],
                "rushHighestPriority": o.get("rushOrderHighestPriority"),
                "trackingId": dt.get("trackingId") or o.get("trackingId"),
                "platformTrackingId": dt.get("platformTrackingId") or "",
                "merchantName": dt.get("merchantName") or o.get("mname") or "",
                "merchantAddress": dt.get("merchantAddress") or o.get("maddress") or "",
                "merchantPhone": dt.get("merchantPhone") or "",
                "customerName": dt.get("customerName") or o.get("customerName") or "",
                "customerAddress": dt.get("customerAddress") or o.get("caddress") or "",
                "customerPhone": dt.get("customerPhone") or "",
                "riderName": dt.get("carrierDriverName") or o.get("name") or "",
                "riderPhone": dt.get("carrierDriverPhone") or o.get("knightPhone") or "",
                "customerExpectDeliveryAt": fmt_time(dt.get("customerExpectDeliveryAt")),
                "driverExamDeliveryAt": fmt_time(dt.get("driverExamDeliveryAt")),
                "overTime": fmt_time(dt.get("overTime")) if dt.get("overTime") else "",
                "errorType": dt.get("errorType") or "",
                "errorMsg": dt.get("errorMsg") or "",
                "customerRemark": dt.get("customerRemark") or "",
                "abnormalReport": abnormal_report,
                "goods": goods,
                "track": track,
            })
    return merged


def write_outputs(merged, data):
    out_json = os.path.join(OUT_DIR, "dispatcher_jidan_3stations.json")
    station_stats = [{"station": t["station"], "teamId": t["teamId"], "rushCount": t["rushCount"]} for t in data]
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump({"source": "http-api", "stationStats": station_stats,
                   "totalRush": len(merged), "orders": merged}, f, ensure_ascii=False, indent=2)
    print("已保存: dispatcher_jidan_3stations.json")

    headers = ["站点", "状态", "急单类型", "急单优先级", "运单号", "平台运单号", "商户", "商户地址", "商户电话",
               "顾客", "顾客地址", "顾客电话", "骑手", "骑手电话", "期望送达", "骑手取餐预计", "超时",
               "异常类型", "异常信息", "订单备注", "异常报备", "商品", "轨迹"]
    esc = lambda v: (s if not any(c in s for c in [",", '"', "\n"]) else '"' + s.replace('"', '""') + '"') \
        if (s := ("" if v is None else str(v))) else s
    rows = [[
        o["station"], o["stateLabel"], "|".join(o["rushTypes"]), o["rushHighestPriority"], o["trackingId"],
        o["platformTrackingId"], o["merchantName"], o["merchantAddress"], o["merchantPhone"], o["customerName"],
        o["customerAddress"], o["customerPhone"], o["riderName"], o["riderPhone"], o["customerExpectDeliveryAt"],
        o["driverExamDeliveryAt"], o["overTime"], o["errorType"], o["errorMsg"], o["customerRemark"],
        o["abnormalReport"], o["goods"], o["track"],
    ] for o in merged]
    out_csv = os.path.join(OUT_DIR, "dispatcher_jidan_3stations.csv")
    with open(out_csv, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
        w.writerow(headers)
        for r in rows:
            w.writerow([esc(v) for v in r])
    print("已保存: dispatcher_jidan_3stations.csv")


# ==================== 执行节点（server 步进条按顺序跑）====================
NODES = [
    {"id": "fetch", "name": "拉取三站在途急单", "desc": "登录风神 + 分页拉三站 trackingId/订单/急单"},
    {"id": "merge", "name": "合并去重", "desc": "三站数据并集 + 按站点汇总"},
    {"id": "write", "name": "落盘 CSV/JSON", "desc": "写 dispatcher_jidan_3stations.csv / .json"},
]


def node_fetch(ctx):
    cookie, status = ensure_cookies()
    if not cookie:
        print("✗ 未获取到风神 cookie，登录失败")
        raise SystemExit(1)
    print("cookie: %s（%d 字符）" % (status, len(cookie)))
    data = []
    for team_id, station in TEAMS:
        t = rush.fetch_team(team_id, station, cookie=cookie)
        print("[%s] paging trackingId:%d | 订单:%d | 急单(在途):%d"
              % (t["station"], t["totalTids"], t["totalOrders"], t["rushCount"]))
        data.append(t)
    ctx["data"] = data


def node_merge(ctx):
    ctx["merged"] = merge(ctx["data"])


def node_write(ctx):
    write_outputs(ctx["merged"], ctx["data"])


for _n in NODES:
    _n["fn"] = {"fetch": node_fetch, "merge": node_merge, "write": node_write}[_n["id"]]


def main():
    import nodeflow
    todo, err = nodeflow.prepare(NODES)
    if err:
        print("✗ " + err)
        sys.exit(1)
    sys.exit(nodeflow.execute(todo, {}, title="[急单]"))


if __name__ == "__main__":
    main()
