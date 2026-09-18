#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标准达成看板 —— 站点维度数据报表（按站点逐行）。

把「排班目标 / 运单明细 / 实时考勤 / 骑手等级标准」四源聚合到「站点」粒度，
输出一张按站点逐行的管理报表。每行一列对应老板给定的指标。

口径（与 rider_dimension / achievement 完全一致，避免漂移）：
  · 规模目标   = 排班目标 timeCode=9999 全天行的 predict_num（目标/预测排班人数）
  · 排班人数   = 排班目标 timeCode=9999 全天行的 actual_num（实际排班人数）
  · 排班满足率 = 排班人数 / 规模目标
  · 有单骑手数 = 运单明细中 is_completed(配送成功) 且当天单量≥1 的骑手数
  · 实际出勤人数 = 有单骑手数（运单明细 is_completed 配送成功 且 当天单量≥1 的骑手；
                  按老板口径「出勤=实际产生配送产出」，与「在线+小休」登录口径不同）
  · 出勤满足率 = 实际出勤人数 / 规模目标
  · 达标人数   = 骑手维度里 achieved（达成标准1及以上，即 grade.level>=1）的骑手数
  · 达标率     = 达标人数 / 规模目标
  · 未达标人数 = 实际出勤骑手数 - 达标人数（出勤骑手 = 排班∪未排班但有单；达标 = 骑手维度 achieved）
  · 预计可达标 = 骑手维度「预计可达标骑手」(est_achievable_label ∈ {达成困难,有望达成,轻松达成})
                  + 已达标骑手 = 全部实际出勤骑手 − 不可达标骑手（宽口径，含达成困难）
  · 预计可达标率 = 预计可达标人数 / 实际出勤并集(len(rd_rows))
  · 标准k人数  = 骑手维度里 grade.level == k 的骑手数（k=1..5）
  · 尖峰激励   = (标准2+标准3+标准4+标准5人数) / 规模目标

数据来源：全部读 dashboard.standard.cache 的原始三源（recompute 路径，零 HTTP），
与「标准达成」看板的站点/骑手维度共用同一份落盘数据，因此报表数据永远与看板一致。
实时数据由 /api/standard/refresh-all 维护，本模块不自行发起 HTTP 请求。

对外：
  build_one(team_id, start, end, month, source) -> dict   单站一行
  build_all(teams, start, end, month)           -> dict   按站点逐行（多站）
"""
import os
import sys
import math
import datetime

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from dashboard.standard import cache as CACHE
from dashboard.standard import rider_dimension as RD
from dashboard.standard import achievement as AC
from dashboard.standard import threshold_config as TC

BJ = datetime.timezone(datetime.timedelta(hours=8))

from dashboard.standard.teams_config import TEAM_NAMES  # 站点名唯一兜底源（teams_config.py）

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


def build_one(team_id, start, end, month, source="cache"):
    """单站报表行。source 仅标记用途（本模块只读落盘三源，不发起 HTTP）。

    三源（排班目标 / 运单明细 / 考勤）缺任一即返回 need_refresh=True，
    由前端提示先点「刷新数据」拉取实时数据 —— 与 riders 维度一致的约定。
    """
    team_id = str(team_id)
    date = start
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
    if not month:
        month = datetime.datetime.now(BJ).strftime("%Y-%m")

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

    # —— 有单骑手数：is_completed + 当天单量≥1 ——
    allday_all = RD._aggregate_rider_all_orders(orders, team_id, date)
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
    # 预计可达标 = 骑手维度「预计可达标骑手」(est_achievable_label ∈ {达成困难,有望达成,轻松达成})
    #           + 已达标骑手 = 全部实际出勤骑手 − 不可达标骑手（宽口径，含达成困难）
    expected_achievable_num = sum(
        1 for r in rd_rows
        if (r.get("est_achievable_label") or "不可达标") != "不可达标"
    )
    expected_achievable_rate = _pct(expected_achievable_num, scale_target)
    peak_incentive = _pct(std[2] + std[3] + std[4] + std[5], scale_target)

    # —— 门槛人数 / 封顶人数（按月份百分比配置；未设置则该列为 None，前端显示提示）——
    # 门槛人数 = ceil(规模目标 × 门槛值/100)；封顶人数 = floor(规模目标 × 封顶值/100)。
    _tc = TC.counts(scale_target, month)
    threshold_count = _tc.get("threshold_count")
    cap_count = _tc.get("cap_count")

    return {
        "team_id": team_id,
        "team_name": TEAM_NAMES.get(team_id, team_id),
        "need_refresh": False,
        "data_status": "ok",
        "data_note": None,
        "scale_target": scale_target,
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
        from dashboard.standard import teams_config as TCFG
        teams = TCFG.configured_teams()
        print(_json.dumps(build_all(teams, _ns.start, _ns.end), ensure_ascii=False, indent=2))
    else:
        print(_json.dumps(build_one(_ns.team, _ns.start, _ns.end, None),
                          ensure_ascii=False, indent=2))
