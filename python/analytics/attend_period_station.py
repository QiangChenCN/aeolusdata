#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""时段出勤看板 —— 站点数据（新 tab「站点数据」后端聚合）。

将「时段有效 / 时段准确 / 时段有单」三个旧 tab 合并为单一「站点数据」tab，竖向 4 张卡片：
  卡1 时段有效：站点ID / 站点名称 / [时段达成率] / [时段目标人数] / [时段达标人数]
  卡2 排班准确：站点ID / 站点名称 / [时段达成率] / [排班人数]   / [时段达标人数]
  卡3 排班出勤：站点ID / 站点名称 / [时段达成率] / [排班人数]   / [时段有单人数]
  卡4 时段满足：站点ID / 站点名称 / [时段达成率] / [时段目标人数] / [时段有单人数]

数据口径（2026-09-13 与用户确认，全部取推荐项）：
  · 达标（达标人数 / 达成率）：某骑手某时段「单量达标 且 在线时长达标」才算达标，
        阈值取自系统设置 period_config 的 orders（单量要求）+ effective_online_req_h（在线时长要求），
        与 rider_period_detail 的 achieved 判定完全一致。
  · 时段达成率 = 达标人数 ÷ 时段目标人数（排班目标 predict_num），保留 1 位小数（%）。
  · 排班人数 = 排班目标 actual_num（实际排班人数，调度系统口径）。
  · 时段有单人数 = 该时段 timeFinishOrder > 0 的骑手数（与骑手明细 orders 字段一致）。
  · 全天列：系统设置 period_config 的「全天」行（name=全天 / 00:00-00:00）作达标标准
        （累计单量 ≥ orders 且 累计在线时长 ≥ effective_online_req_h）；
        目标人数 / 排班人数取排班目标 time_code=9999 行；
        全天列在每张卡片的所有时段列中排第一。

实现：复用 rider_period_detail.compute 的 per-rider cells（scheduled/orders/achieved/full_day_*），
      叠加 flatten_schedule 的 predict_num / actual_num，按站点×时段做行级聚合。
      实时考勤逐时段由 rider_period_detail.compute 内部并发拉取，本模块不再单独打接口。
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
import datetime
from sources import (
    fetch_schedule, flatten_schedule, TEAM_NAMES,
)
from analytics import rider_period_detail as RPD

BJ = datetime.timezone(datetime.timedelta(hours=8))
DAY_TIME_CODE = "9999"     # 全天汇总行（排班目标接口）
REST_TIME_CODE = "2"       # 休息行


def _log(msg):
    ts = datetime.datetime.now(BJ).strftime("%H:%M:%S")
    print(f"[{ts}] [attend_period_station] {msg}", flush=True)


def _norm_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _hm(s):
    """'HH:MM' / 'HH:MM:SS' → 分钟数，用于排序；非法返回 9999。"""
    if not s or ":" not in str(s):
        return 9999
    try:
        a, b = str(s).split(":")
        return int(a) * 60 + int(b)
    except Exception:
        return 9999


def _rate(actual, target):
    """达标率（百分数，保留 1 位）。分子缺失或分母为 0/None 时返回 None。"""
    if actual is None or target in (None, 0):
        return None
    return round(actual / target * 1000) / 10


def _station_metrics(team_id, date):
    """返回该站点的 (periods, metrics_by_tc)。

    periods : 时段列表（含全天，全天排第一），每项 {time_code, time_name, start_time, end_time, is_full_day}
    metrics : { tc(str): {target, scheduled, achieved, order, rate} }
    """
    # 1) 排班目标（predict_num / actual_num），键统一为 str(time_code)
    sched_rows = flatten_schedule(fetch_schedule(team_id, date, date))
    sched_by_tc = {str(r.get("time_code")): r for r in sched_rows}

    # 2) 骑手明细（per-rider cells：scheduled/orders/achieved；full_day_*）
    res = RPD.compute(team_id, date)
    rows = res.get("rows") or []
    rpd_periods = res.get("periods") or []

    metrics = {}
    for pd in rpd_periods:
        raw_tc = pd.get("time_code")          # 原始类型（schedule 多为 int），与 cells 键一致
        tc = str(raw_tc)
        sch = sched_by_tc.get(tc) or sched_by_tc.get(raw_tc) or {}
        target = _norm_int(sch.get("predict_num"))
        scheduled = _norm_int(sch.get("actual_num"))
        if scheduled is None:
            scheduled = _norm_int(pd.get("actual_num"))
        # 达标人数：该时段 achieved===True 的骑手数
        achieved = sum(1 for r in rows
                       if r.get("cells", {}).get(raw_tc, {}).get("achieved") is True)
        # 有单人数：该时段 orders > 0 的骑手数
        order = sum(1 for r in rows
                    if (r.get("cells", {}).get(raw_tc, {}).get("orders") or 0) > 0)
        metrics[tc] = {
            "target": target, "scheduled": scheduled,
            "achieved": achieved, "order": order,
            "rate": _rate(achieved, target),
        }

    # 3) 全天列（time_code=9999）
    fd_sch = sched_by_tc.get(DAY_TIME_CODE) or {}
    fd_target = _norm_int(fd_sch.get("predict_num"))
    fd_scheduled = _norm_int(fd_sch.get("actual_num"))
    fd_achieved = sum(1 for r in rows if r.get("full_day_achieved") is True)
    fd_order = sum(1 for r in rows if (r.get("full_day_orders") or 0) > 0)
    metrics[DAY_TIME_CODE] = {
        "target": fd_target, "scheduled": fd_scheduled,
        "achieved": fd_achieved, "order": fd_order,
        "rate": _rate(fd_achieved, fd_target),
    }

    # 4) 时段列顺序：全天排第一，真实时段按开始时间升序
    real_periods = [{
        "time_code": str(p.get("time_code")),
        "time_name": p.get("time_name"),
        "start_time": p.get("start_time"),
        "end_time": p.get("end_time"),
        "is_full_day": False,
    } for p in rpd_periods]
    real_periods.sort(key=lambda p: _hm(p.get("start_time")))
    periods = [{
        "time_code": DAY_TIME_CODE, "time_name": "全天",
        "start_time": None, "end_time": None, "is_full_day": True,
    }] + real_periods

    return periods, metrics


def station_data(team_id, date):
    """单站：站点数据聚合。返回与 station_data_all 同结构的单行结果。"""
    team_id = str(team_id)
    periods, metrics = _station_metrics(team_id, date)
    _log("站点数据聚合完成：%s，%d 个时段" % (team_id, len(periods)))
    return {
        "ok": True,
        "team": team_id,
        "teamName": TEAM_NAMES.get(team_id, "team " + team_id),
        "date": date,
        "periods": periods,
        "rows": [{
            "team_id": team_id,
            "team_name": TEAM_NAMES.get(team_id, team_id),
            "metrics": metrics,
        }],
        "missing_teams": None,
        "need_refresh": False,
        "source": "live",
        "fetched_at": datetime.datetime.now(BJ).isoformat(timespec="seconds"),
    }


def station_data_all(teams, date):
    """全量站点：逐站 station_data → 行级拼接（每行一站）。时段列以首个非空站点为准。"""
    rows, missing, periods_tpl = [], [], None
    for tid in teams:
        try:
            res = station_data(tid, date)
        except Exception as e:
            missing.append({"team": str(tid),
                            "name": TEAM_NAMES.get(str(tid), str(tid)),
                            "error": "%s: %s" % (type(e).__name__, e)})
            continue
        if not res.get("ok") or not (res.get("rows") or []):
            missing.append({"team": str(tid),
                            "name": res.get("teamName", str(tid)),
                            "error": "无数据"})
            continue
        if periods_tpl is None and (res.get("periods") or []):
            periods_tpl = res["periods"]
        rows.extend(res["rows"])

    if not rows:
        return {"ok": True, "team": "__all__", "teamName": "全部站点（0 站）", "date": date,
                "periods": [], "rows": [], "missing_teams": missing or None,
                "need_refresh": True, "source": "none",
                "data_note": ("以下站点均无数据：" + "、".join(m["name"] for m in missing)) if missing else "无数据"}

    note = ("以下站点当日无数据，未计入：" + "、".join(m["name"] for m in missing)) if missing else None
    return {
        "ok": True, "team": "__all__", "teamName": "全部站点（%d 站）" % len(rows),
        "date": date, "periods": periods_tpl, "rows": rows,
        "missing_teams": missing or None, "need_refresh": False,
        "data_status": "ok" if not missing else "partial", "data_note": note,
        "source": "live",
        "fetched_at": datetime.datetime.now(BJ).isoformat(timespec="seconds"),
    }


if __name__ == "__main__":
    import json as _json
    import argparse as _ap
    _a = _ap.ArgumentParser()
    _a.add_argument("--team", default="917521136")
    _a.add_argument("--date", default=datetime.datetime.now(BJ).strftime("%Y-%m-%d"))
    _ns = _args = _a.parse_args()
    out = station_data(_ns.team, _ns.date)
    print(_json.dumps(out, ensure_ascii=False, indent=2, default=str))
