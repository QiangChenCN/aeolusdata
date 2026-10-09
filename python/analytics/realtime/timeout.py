#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""配送超时看板 —— 站点维度配送时效统计（汇总 + 骑手下钻 + 订单明细）。

与「实时数据看板」同源：直接从本地运单原始层（orders）重算，零 HTTP 请求；
超时时长口径与 order_rules.over_expect_seconds / is_t8_timeout 完全一致。

指标口径（运单按「骑手接单时间」归属北京时间自然日）：
  · 推配送单量    = 当天接单的全部运单（count_pushed_orders，不剔除任何状态）
  · 配送成功单量  = 当天接单且 状态=配送成功(state 40) 的运单
  · 配送中单量    = 当天已接单 + 非完成 + 非取消 的运单（在配送管道中；用排除法，
                    不依赖精确的「配送中」状态字符串，避免风神状态词变动导致漏计）
  · 超时单量(T8)  = 配送成功 且 超平台期望时间 > 8 分钟（is_t8_timeout）
  · 预估超时单量  = 配送中 且 当前北京时间 已越过「平台期望送达时间」(platformExpectAt)
                    —— 仍在途但已注定迟到的单（按当前迟到分钟预估）
  · 准时率        = (配送成功单量 - 超时单量) / 配送成功单量（已送达范畴）
  · 预估准时率    = (已处理单量 - 超时单量 - 预估超时单量) / 已处理单量
                    已处理单量 = 配送成功单量 + 配送中单量（剔除取消，只看有交付结果/在途的）
  · 复合超时时长  = 超时单量「超平台期望分钟」之和 + 预估超时单量「当前迟到分钟」之和（分钟）
  · 严重度分桶    = 仅对超时单按「超多少分钟」分三档：8-15 / 15-30 / ≥30

下钻数据（供前端 click 站点→骑手→订单）：
  · riders：本站内「准时率未达 100%」的骑手（即超时单量 > 0），含该骑手的
            delivered / timeout / ontime_rate / overtime_min / timeout_orders(明细)

严重度分档边界（含上界）：8 分 < 超时长 ≤ 15 分 → "8-15"；15 分 < 超时长 ≤ 30 分 → "15-30"；
超时长 > 30 分 → ">=30"（is_t8_timeout 已保证超时长 > 8 分，故每个超时单必落一档）。

依赖：
  · analytics.cache        原始数据层读写 + 进程内结果缓存
  · analytics.order_rules  完成态 / 超时 / 取值 / 接单时间归属（与有效单口径同源）
  · analytics.realtime.board 配送完成单计数 / 准时率（单一来源，避免重复实现）
  · analytics.teams_config 站点名兜底
"""
import os

# >>> python-home bootstrap (added by layout migration) >>>
import os as _os
import sys as _sys
def _find_python_home():
    d = _os.path.dirname(_os.path.abspath(__file__))
    while d and _os.path.basename(d) != 'python':
        d = _os.path.dirname(d)
    return d
PY_HOME = _find_python_home()
ROOT = _os.path.dirname(PY_HOME) if PY_HOME else _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
_ROOT = ROOT
if PY_HOME and PY_HOME not in _sys.path:
    _sys.path.insert(0, PY_HOME)
# <<< python-home bootstrap <<<

import datetime
from analytics import cache as CACHE
from analytics import order_rules as OR
from analytics.realtime import board as RTB
from analytics.teams_config import TEAM_NAMES

BJ = datetime.timezone(datetime.timedelta(hours=8))
MODULE = "realtime_timeout"

# 严重度分桶键（与前端约定一致）
BUCKET_LIGHT = "8-15"     # 8 分 < 超时长 ≤ 15 分
BUCKET_MID = "15-30"      # 15 分 < 超时长 ≤ 30 分
BUCKET_HEAVY = ">=30"     # 超时长 > 30 分

STATE_DESC_KEYS = ("状态描述", "stateDesc", "statusDesc", "statusName")
RIDER_ID_KEYS = ("knightId", "骑手ID", "riderId", "riderID")
RIDER_NAME_KEYS = ("knightName", "骑手姓名", "riderName")
# 取消类状态判定（命中即不算「配送中」）
CANCEL_HINTS = ("取消", "作废", "撤销")


def _severity_bucket(over_min):
    """超时分钟 → 严重度分桶键（字段 over_min 已保证 > 8）。"""
    if over_min <= 15:
        return BUCKET_LIGHT
    if over_min <= 30:
        return BUCKET_MID
    return BUCKET_HEAVY


def _to_min(sec):
    """秒 → 保留 1 位小数的分钟。"""
    return round(sec / 60.0, 1)


def _rider_key(o):
    rid = OR.order_val(o, RIDER_ID_KEYS)
    if rid not in (None, ""):
        return str(rid)
    rname = OR.order_val(o, RIDER_NAME_KEYS)
    if rname not in (None, ""):
        return "name:" + str(rname)
    return "未知"


def is_delivering(o, date):
    """配送中判定（排除法）：当天已接单 + 非完成 + 非取消。

    不依赖精确的「配送中」状态字符串（风神状态词可能变动），只要「已接单(acceptAtLast 存在)
    且尚未配送成功且非取消类状态」即视为在配送管道中，归入配送中单量，并参与预估超时判断。
    """
    raw = OR.order_val(o, OR.ACCEPT_KEYS)
    if raw is None:
        return False
    ms = OR.accept_ms(o)
    if ms is None:
        return False
    if OR.ms_to_ymd(ms) != date:
        return False
    if OR.is_completed(o):
        return False
    desc = str(OR.order_val(o, STATE_DESC_KEYS) or "")
    if any(h in desc for h in CANCEL_HINTS):
        return False
    return True


def _predicted_overtime_min(o, now_ms):
    """若 o 为配送中且当前已越过平台期望送达时间，返回当前迟到分钟；否则 None。"""
    expect = OR.order_val(o, OR.PLATFORM_EXPECT_KEYS)   # platformExpectAt（毫秒时间戳）
    if expect is None:
        return None
    try:
        e = int(expect)
    except (ValueError, TypeError):
        return None
    if now_ms > e:
        return round((now_ms - e) / 60000.0, 1)
    return None


def analyze(orders, date, now_ms):
    """纯计算：给定已加载的 orders 列表、归属日、当前北京时间毫秒。

    返回站点维度统计 + 骑手下钻数据（不含 team 元信息，由 build_one 装配）。
    """
    completed = RTB.count_delivery_completed(orders, date)
    delivering = 0
    timeout = 0
    predicted = 0
    buckets = {BUCKET_LIGHT: 0, BUCKET_MID: 0, BUCKET_HEAVY: 0}
    confirmed_overtime_sum = 0.0     # 超时单超平台期望分钟之和
    predicted_overtime_sum = 0.0     # 预估超时单当前迟到分钟之和
    max_over = None
    details = []                     # 超时订单明细（按超时分钟降序）
    riders = {}                      # 骑手聚合（仅含超时单的骑手）

    for o in (orders or []):
        ms = OR.accept_ms(o)
        if ms is None:
            continue
        if OR.ms_to_ymd(ms) != date:
            continue
        if OR.is_completed(o):
            if OR.is_t8_timeout(o):
                timeout += 1
                sec = OR.over_expect_seconds(o)
                if sec is None:
                    continue
                over_min = _to_min(sec)
                buckets[_severity_bucket(over_min)] += 1
                confirmed_overtime_sum += over_min
                if max_over is None or over_min > max_over:
                    max_over = over_min
                det = {
                    "tracking_id": o.get("trackingId"),
                    "rider_id": OR.order_val(o, RIDER_ID_KEYS),
                    "rider_name": OR.order_val(o, RIDER_NAME_KEYS),
                    "over_min": over_min,
                    "severity": _severity_bucket(over_min),
                }
                details.append(det)
                rk = _rider_key(o)
                r = riders.setdefault(rk, {
                    "rider_id": OR.order_val(o, RIDER_ID_KEYS),
                    "rider_name": OR.order_val(o, RIDER_NAME_KEYS),
                    "delivered": 0, "timeout": 0,
                    "overtime_min": 0.0, "timeout_orders": [],
                })
                r["delivered"] += 1
                r["timeout"] += 1
                r["overtime_min"] += over_min
                r["timeout_orders"].append(det)
        elif is_delivering(o, date):
            delivering += 1
            pom = _predicted_overtime_min(o, now_ms)
            if pom is not None:
                predicted += 1
                predicted_overtime_sum += pom

    details.sort(key=lambda d: d["over_min"], reverse=True)

    # 骑手下钻：仅保留「准时率未达 100%」（即超时单量 > 0）的骑手
    rider_list = []
    for r in riders.values():
        if r["timeout"] > 0:
            r["ontime_rate"] = round((r["delivered"] - r["timeout"]) * 1000.0 / r["delivered"]) / 10
            r["overtime_min"] = round(r["overtime_min"], 1)
            rider_list.append(r)
    rider_list.sort(key=lambda r: r["overtime_min"], reverse=True)

    pushed = OR.count_pushed_orders(orders, date, date)
    handled = completed + delivering
    composite_overtime_min = round(confirmed_overtime_sum + predicted_overtime_sum, 1)

    return {
        "pushed_order_volume": pushed,
        "delivery_completed": completed,
        "delivering": delivering,
        "timeout_total": timeout,
        "predicted_timeout": predicted,
        "ontime_rate": RTB.ontime_rate(completed, timeout),
        "predicted_ontime_rate": (round((handled - timeout - predicted) * 1000.0 / handled) / 10)
                                  if handled else None,
        "composite_overtime_min": composite_overtime_min,
        "max_over_min": max_over,
        "over_min_sum": round(confirmed_overtime_sum, 1),
        "buckets": buckets,
        "timeout_orders": details,
        "riders": rider_list,
    }


def build_one(team_id, date=None):
    """单站配送超时统计。date 缺省取北京时间当天；now 取当前北京时间。

    原始 orders 缺失即返回 need_refresh=True（与实时看板一致：先拉取当天三源落盘）。
    命中进程内结果缓存直接返回。
    """
    team_id = str(team_id)
    if date is None:
        date = CACHE.today_ymd()
    cached = CACHE.get_result(MODULE, team_id, date, "", "cache")
    if cached is not None:
        return cached
    orders = CACHE.load_raw("orders", team_id, date)
    if orders is None:
        return {
            "team_id": team_id,
            "team_name": TEAM_NAMES.get(team_id, team_id),
            "need_refresh": True,
            "data_status": "no_data",
            "data_note": "今日运单明细尚未落盘，请点「刷新数据」拉取后查看",
            "pushed_order_volume": None,
            "delivery_completed": None,
            "delivering": None,
            "timeout_total": None,
            "predicted_timeout": None,
            "ontime_rate": None,
            "predicted_ontime_rate": None,
            "composite_overtime_min": None,
            "max_over_min": None,
            "over_min_sum": 0,
            "buckets": {BUCKET_LIGHT: None, BUCKET_MID: None, BUCKET_HEAVY: None},
            "timeout_orders": [],
            "riders": [],
        }
    now_ms = int(datetime.datetime.now(BJ).timestamp() * 1000)
    metrics = analyze(orders, date, now_ms)
    result = {
        "team_id": team_id,
        "team_name": TEAM_NAMES.get(team_id, team_id),
        "need_refresh": False,
        "data_status": "ok",
        "data_note": None,
    }
    result.update(metrics)
    CACHE.put_result(MODULE, team_id, date, "", "cache", result)
    return result


if __name__ == "__main__":
    import json as _json
    import argparse as _ap
    _a = _ap.ArgumentParser()
    _a.add_argument("--team", required=True)
    _a.add_argument("--date", default=CACHE.today_ymd())
    _ns = _ap.parse_args()
    print(_json.dumps(build_one(_ns.team, _ns.date), ensure_ascii=False, indent=2))
