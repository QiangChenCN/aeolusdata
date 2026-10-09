#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""配送超时看板 —— 站点维度超时统计（汇总 + 订单明细）。

与「实时数据看板」同源：直接从本地运单原始层（orders）重算，零 HTTP 请求；
超时时长口径与 order_rules.over_expect_seconds / is_t8_timeout 完全一致。

指标口径（运单按「骑手接单时间」归属北京时间自然日）：
  · 配送完成单  = 当天接单且状态=配送成功(state 40) 的运单
  · 超时单(T8)  = 配送完成单中「超出平台期望时间 > 8 分钟」的运单（= is_t8_timeout）
                 是「配送完成单」子集，故准时率 = (完成 - 超时) / 完成 ∈ [0,1]
  · 严重度分桶  = 仅对超时单按「超多少分钟」分三档（8-15 分 / 15-30 分 / ≥30 分）
  · 平均超时分钟 = 超时单「超平台期望分钟」的均值（无超时单时为 None）
  · 最大超时分钟 = 超时单中最大的「超平台期望分钟」（无超时单时为 None）
  · 明细        = 每个超时单的运单号 / 骑手 / 超多少分钟 / 严重度（按超时分钟降序）

严重度分档边界（含上界）：
  8 分 < 超时长 ≤ 15 分 → "8-15"
  15 分 < 超时长 ≤ 30 分 → "15-30"
  超时长 > 30 分         → ">=30"
（is_t8_timeout 已保证超时长 > 8 分，故每个超时单必落一档。）

依赖：
  · analytics.cache        原始数据层读写 + 进程内结果缓存
  · analytics.order_rules  完成态 / 超时判定 / 取值（与有效单口径同源）
  · analytics.realtime.board 配送完成单计数（单一来源，避免重复实现）
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

RIDER_ID_KEYS = ("knightId", "骑手ID", "riderId", "riderID")
RIDER_NAME_KEYS = ("knightName", "骑手姓名", "riderName")


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


def analyze(orders, date):
    """纯计算：给定已加载的 orders 列表与归属日，返回超时统计（不含 team 元信息）。

    与 build_one 解耦，便于单测：build_one 只负责缓存/落盘/team 元信息装配，
    真正算法全在这里。
    """
    completed = RTB.count_delivery_completed(orders, date)
    buckets = {BUCKET_LIGHT: 0, BUCKET_MID: 0, BUCKET_HEAVY: 0}
    details = []
    over_sum = 0.0
    max_over = None
    for o in (orders or []):
        ms = OR.accept_ms(o)
        if ms is None:
            continue
        if OR.ms_to_ymd(ms) != date:
            continue
        # 仅统计「配送成功 且 超平台期望 > 8 分钟」的超时单（与实时看板 T8 同源）
        if not OR.is_t8_timeout(o):
            continue
        sec = OR.over_expect_seconds(o)
        if sec is None:
            continue
        over_min = _to_min(sec)
        bucket = _severity_bucket(over_min)
        buckets[bucket] += 1
        over_sum += over_min
        if max_over is None or over_min > max_over:
            max_over = over_min
        details.append({
            "tracking_id": o.get("trackingId"),
            "rider_id": OR.order_val(o, RIDER_ID_KEYS),
            "rider_name": OR.order_val(o, RIDER_NAME_KEYS),
            "over_min": over_min,
            "severity": bucket,
        })
    # 明细按超时分钟降序，最久未达的排最前，便于优先排查
    details.sort(key=lambda d: d["over_min"], reverse=True)
    timeout_total = len(details)
    return {
        "delivery_completed": completed,
        "timeout_total": timeout_total,
        "ontime_rate": RTB.ontime_rate(completed, timeout_total),
        "avg_over_min": round(over_sum / timeout_total, 1) if timeout_total else None,
        "max_over_min": max_over,
        "over_min_sum": round(over_sum, 1),
        "buckets": buckets,
        "timeout_orders": details,
    }


def build_one(team_id, date=None):
    """单站配送超时统计。date 缺省取北京时间当天。

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
            "data_note": "今日运单明细尚未落盘，请先在「标准达成」点「刷新数据」拉取",
            "delivery_completed": None,
            "timeout_total": None,
            "ontime_rate": None,
            "avg_over_min": None,
            "max_over_min": None,
            "over_min_sum": 0,
            "buckets": {BUCKET_LIGHT: None, BUCKET_MID: None, BUCKET_HEAVY: None},
            "timeout_orders": [],
        }
    metrics = analyze(orders, date)
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
