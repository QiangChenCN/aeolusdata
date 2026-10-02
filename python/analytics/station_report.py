#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标准达成看板 —— 站点维度数据报表（按站点逐行）。

把「排班目标 / 运单明细 / 实时考勤 / 骑手等级标准」四源聚合到「站点」粒度，
输出一张按站点逐行的管理报表。每行一列对应老板给定的指标。

口径（与 rider_dimension / achievement 完全一致，避免漂移）：
  · 天应排(=规模目标) = 排班目标 timeCode=9999 全天行的 predict_num（目标/预测排班人数）
  · 排班人数   = 排班目标 timeCode=9999 全天行的 actual_num（实际排班人数）
  · 排班满足率 = 排班人数 / 天应排
  · 有单骑手数 = 运单明细中 is_completed(配送成功) 且当天单量≥1 的骑手数
  · 实际出勤人数 = 有单骑手数（运单明细 is_completed 配送成功 且 当天单量≥1 的骑手；
                  按老板口径「出勤=实际产生配送产出」，与「在线+小休」登录口径不同）
  · 出勤满足率 = 实际出勤人数 / 天应排
  · 达标人数   = 骑手维度里 achieved（达成标准1及以上，即 grade.level>=1）的骑手数
  · 达标率     = 达标人数 / 天应排
  · 未达标人数 = 实际出勤骑手数 - 达标人数（出勤骑手 = 排班∪未排班但有单；达标 = 骑手维度 achieved）
  · 预计可达标 = 骑手维度「预计可达标」预测(std1_forecast，与骑手看板同一口径：已达成/轻松/一般/困难/时长未知/不可达标)
                  + 已达标骑手 = 全部实际出勤骑手 − 不可达标骑手（宽口径，含达成困难）
  · 预计可达标率 = 预计可达标人数 / 实际出勤并集(len(rd_rows))
  · 标准k人数  = 骑手维度里 grade.level == k 的骑手数（k=1..5）
  · 尖峰激励   = (标准2+标准3+标准4+标准5人数) / 天应排

数据来源：全部读 analytics.cache 的原始三源（recompute 路径，零 HTTP），
与「标准达成」看板的站点/骑手维度共用同一份落盘数据，因此报表数据永远与看板一致。
实时数据由 /api/standard/refresh-all 维护，本模块不自行发起 HTTP 请求。

对外：
  build_one(team_id, start, end, month, source) -> dict   单站一行
  build_all(teams, start, end, month)           -> dict   按站点逐行（多站）
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

import sys
import math
import datetime
from analytics import cache as CACHE
from analytics import rider_dimension as RD
from analytics import achievement as AC
from analytics import threshold_config as TC
from analytics import grade_standards as GS
from analytics import order_rules as OR

BJ = datetime.timezone(datetime.timedelta(hours=8))

from analytics.teams_config import TEAM_NAMES  # 站点名唯一兜底源（teams_config.py）

ALL_TEAM_ID = "__all__"


def _log(msg):
    ts = datetime.datetime.now(BJ).strftime("%H:%M:%S")
    print("[%s] [station-report] %s" % (ts, msg), flush=True)


def _int(v):
    if v is None:
        return None
    try:
        return int(v)
    except (ValueError, TypeError):
        return None


def _pct(actual, target):
    """百分比（1 位）。分子或分母缺失/为 0 返回 None。"""
    if actual is None or target in (None, 0):
        return None
    return round(actual / target * 1000) / 10


def _ceil_pct(target, pct):
    """target(人) × 百分比/100 向上取整；任一缺失返回 None。"""
    if target is None or pct is None:
        return None
    return int(math.ceil(target * pct / 100.0))


def _floor_pct(target, pct):
    """target(人) × 百分比/100 向下取整；任一缺失返回 None。"""
    if target is None or pct is None:
        return None
    return int(math.floor(target * pct / 100.0))


def build_one(team_id, start, end, month, source="cache"):
    """单站报表行。source 仅标记用途（本模块只读落盘三源，不发起 HTTP）。

    三源（排班目标 / 运单明细 / 考勤）缺任一即返回 need_refresh=True，
    由前端提示先点「刷新数据」拉取实时数据 —— 与 riders 维度一致的约定。
    """
    team_id = str(team_id)
    date = start
    if not month:
        month = datetime.datetime.now(BJ).strftime("%Y-%m")
    # 站点考核配置：未参与考核（未启用 / 未配置且非默认站）的站点，标准达成看板不展示
    if team_id not in GS.participating_teams(month):
        return {
            "team_id": team_id,
            "team_name": TEAM_NAMES.get(team_id, team_id),
            "need_refresh": False,
            "data_status": "not_enabled",
            "data_note": "该站点未启用考核，已在看板中隐藏",
        }
    _cfg = GS.get_config(team_id, month)
    cached = CACHE.get_result("station_report", team_id, date, month, "cache")
    if cached is not None:
        return cached
    sched = CACHE.load_raw("sched", team_id, date)
    orders = CACHE.load_raw("orders", team_id, date)
    att = CACHE.load_raw("att", team_id, date)
    if sched is None or orders is None or att is None:
        return {
            "team_id": team_id,
            "team_name": TEAM_NAMES.get(team_id, team_id),
            "need_refresh": True,
            "data_status": "no_data",
            "data_note": "今日尚有站点数据未落盘，请先在「标准达成」点「刷新数据」拉取",
        }

    # —— 骑手维度：复用 RD._build 聚合 achieved / grade（口径与骑手维度完全一致）——
    riders_raw = (att or {}).get("rows") or []
    target_tc = (att or {}).get("tc")
    rd = RD._build(team_id=team_id, start=start, end=end, month=month,
                   riders_raw=riders_raw, orders=orders, target_tc=target_tc,
                   source="cache")
    rd_rows = rd.get("rows") or []
    std = [0, 0, 0, 0, 0, 0]  # index 0=未定级, 1..5=标准1..5
    for r in rd_rows:
        lv = (r.get("grade") or {}).get("level") or 0
        if 0 <= lv <= 5:
            std[lv] += 1
    achieved_num = sum(1 for r in rd_rows if r.get("achieved"))

    # —— 排班目标（9999 全天行）——
    day_rows = AC._day_target_rows(sched)
    if day_rows:
        dr = day_rows[0]
        scale_target = _int(dr.get("predict_num"))
        scheduled_num = _int(dr.get("actual_num"))
    else:
        scale_target = scheduled_num = None
    # 考核人数分母 = 天应排（排班目标 9999 全天行的 predict_num），直接取自排班管理，无需手动配置。

    # —— 有单骑手数：直接复用 RD._build 已算好的 full_day_orders（= 当天完成单按骑手计数），
    #    不再对 orders 做一次等价全扫描（_aggregate_rider_all_orders 已删除）——
    allday_all = {str(r["rider_id"]): r["full_day_orders"] for r in rd_rows}
    rider_with_order = sum(1 for c in allday_all.values() if c >= 1)

    # —— 实际出勤人数：按老板口径 = 有单骑手数（运单明细 配送成功 且 当天单量≥1）——
    # 与「在线+小休」登录口径不同：此处出勤=实际产生配送产出。
    attended = rider_with_order

    # —— 率指标 ——
    schedule_rate = _pct(scheduled_num, scale_target)
    attend_rate = _pct(attended, scale_target)
    achieved_rate = _pct(achieved_num, scale_target)
    # 未达标人数 = (排班 ∪ 未排班但有单) − 已达标
    #           = 实际出勤骑手数 − 达标人数（不再用规模目标做减法）
    unachieved_num = len(rd_rows) - achieved_num
    # 预计可达标 = 骑手维度「预计可达标」预测(std1_forecast，与骑手看板同一口径：已达成/轻松/一般/困难/时长未知/不可达标)
    #           + 已达标骑手 = 全部实际出勤骑手 − 不可达标骑手（宽口径，含达成困难）
    expected_achievable_num = sum(
        1 for r in rd_rows
        if (r.get("std1_forecast") or "不可达标") != "不可达标"
    )
    expected_achievable_rate = _pct(expected_achievable_num, scale_target)
    peak_incentive = _pct(std[2] + std[3] + std[4] + std[5], scale_target)

    # —— 推配送单量（实时数据看板第一个指标）：运单明细按骑手接单时间归属当天、全量不剔除 ——
    pushed_order_volume = OR.count_pushed_orders(orders, start, end)

    # —— 门槛人数 / 封顶人数：按本站点配置的百分比（天应排 × 门槛/封顶百分比）；
    #    该站未设百分比则回落全局月度 threshold_config（与历史行为一致）——
    # 门槛人数 = ceil(天应排 × 门槛%/100)；封顶人数 = floor(天应排 × 封顶%/100)。
    _tp = _cfg.get("threshold_pct")
    _cp = _cfg.get("cap_pct")
    if _tp is None or _cp is None:
        _g = TC.get(month)
        if _tp is None:
            _tp = _g.get("threshold_pct")
        if _cp is None:
            _cp = _g.get("cap_pct")
    # 双缺失兜底：沿用历史口径（门槛 80% / 封顶 100% 规模目标）
    if _tp is None:
        _tp = 80.0
    if _cp is None:
        _cp = 100.0
    threshold_count = _ceil_pct(scale_target, _tp)
    cap_count = _floor_pct(scale_target, _cp)

    result = {
        "team_id": team_id,
        "team_name": TEAM_NAMES.get(team_id, team_id),
        "need_refresh": False,
        "data_status": "ok",
        "data_note": None,
        "scale_target": scale_target,
        "pushed_order_volume": pushed_order_volume,
        "scheduled_num": scheduled_num,
        "schedule_rate": schedule_rate,
        "rider_with_order": rider_with_order,
        "attended_num": _int(attended),
        "attend_rate": attend_rate,
        "threshold_count": threshold_count,
        "cap_count": cap_count,
        "achieved_num": achieved_num,
        "achieved_rate": achieved_rate,
        "unachieved_num": _int(unachieved_num),
        "expected_achievable_num": expected_achievable_num,
        "expected_achievable_rate": expected_achievable_rate,
        "std1": std[1], "std2": std[2], "std3": std[3], "std4": std[4], "std5": std[5],
        "peak_incentive": peak_incentive,
    }
    CACHE.put_result("station_report", team_id, date, month, "cache", result)
    return result


def build_all(teams, start, end, month=None):
    """teams: [(team_id, team_name), ...]。返回按站点逐行的报表。"""
    rows, missing = [], []
    for tid, tname in teams:
        res = build_one(tid, start, end, month, "cache")
        if res.get("need_refresh"):
            missing.append(tname or str(tid))
            continue
        rows.append(res)
    note = ("以下站点今日无落盘数据，未计入：%s" % "、".join(missing)) if missing else None
    return {
        "ok": True,
        "source": "cache",
        "team": ALL_TEAM_ID,
        "teamName": "全部站点（%d 站）" % len(rows),
        "start": start,
        "end": end,
        "basis": "day",
        "rows": rows,
        "data_status": "ok" if not missing else "partial",
        "data_note": note,
        "missing_teams": missing or None,
    }


if __name__ == "__main__":
    import json as _json
    import argparse as _ap
    _a = _ap.ArgumentParser()
    _a.add_argument("--team", default="__all__")
    _a.add_argument("--start", default=CACHE.today_ymd())
    _a.add_argument("--end", default=CACHE.today_ymd())
    _ns = _a.parse_args()
    if _ns.team == "__all__":
        from analytics import teams_config as TCFG
        teams = TCFG.configured_teams()
        print(_json.dumps(build_all(teams, _ns.start, _ns.end), ensure_ascii=False, indent=2))
    else:
        print(_json.dumps(build_one(_ns.team, _ns.start, _ns.end, None),
                          ensure_ascii=False, indent=2))
