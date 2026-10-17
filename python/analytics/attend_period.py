#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""时段出勤看板 —— 聚合逻辑（dashboard/attend_period.py）。

数据源（复用 sources 公共取数模块）：
  · fetch_schedule    当天排班目标（站×日期×时段，每时段含 predict_num/actual_num）
  · fetch_attendance  实时考勤（单站点一次请求，返回全站骑手列表；每位骑手 timeCode 为排班时段列表、
                     timeAttendanceVos 含全时段明细：各时段 timeFinishOrder / timeValidOnlineTime。
                     顶层 timeFinishOrder / timeValidOnlineTime 仅对应 queryTimeCode，各时段真实值须读 timeAttendanceVos）

本模块只做「取数编排 + 关联聚合」，不实现 HTTP 细节（那些在 sources/ 与各 auth 包里）。

「时段有效」口径
--------------
  有效出勤人数 = 该时段 scheduled 骑手中 workStatus ∉ {2 小休, 3 下线} 的人数
  有效在线时长 = 上述在线骑手的 timeValidOnlineTime 之和（秒）
  排班目标     = 排班目标接口 predict_num（该时段预测排班人数，作分母）
  有效出勤率   = 有效出勤人数 / 排班目标
  缺勤人数     = 排班目标 - 有效出勤人数
  实际排班     = 排班目标接口 actual_num（该时段实际排班人数，作参考列）

时段筛选：跳过 time_code=9999（全天汇总行）与 time_code=2（休息行），
          仅保留真实排班时段（午高峰 / 晚高峰 / …）。

实时考勤单次取数：每个站点只调用一次 fetch_attendance（任意 timeCode 即可），
                    返回的 timeAttendanceVos 已含全时段明细；单时段内按
                    「tc ∈ rider.timeCode」归并，从 timeAttendanceVos[时段] 取有效在线时长，统计在线/小休/下线。
                    （2026-10-17 实测：timeAttendanceVos 与逐时段专查顶层值逐位一致，无需逐时段并发/节流。）
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
    fetch_schedule, fetch_attendance, flatten_schedule, TEAM_NAMES,
)

BJ = datetime.timezone(datetime.timedelta(hours=8))

# 考勤 workStatus 语义（与 jobs/attendance、标准达成 achievement 一致）
REST_STATES = {2}        # 小休（暂离）
OFFLINE_STATES = {3}     # 下线（未在线装备）
DAY_TIME_CODE = "9999"   # 全天汇总行
REST_TIME_CODE = "2"     # 休息行

def _log(msg):
    ts = datetime.datetime.now(BJ).strftime("%H:%M:%S")
    print(f"[{ts}] [attend_period] {msg}", flush=True)


def _fmt_dur(sec):
    """秒 → 'XhYm' / 'Ym' / '0'。"""
    sec = int(sec or 0)
    if sec <= 0:
        return "0"
    h = sec // 3600
    m = (sec % 3600) // 60
    return f"{h}h{m}m" if h > 0 else f"{m}m"


def build_attendance_index(riders):
    """骑手考勤列表 → {rider_id: {tcs:[int…], vos:{int tc: vo}, workStatus}}。

    vos 取自每位骑手的 timeAttendanceVos（含**全时段**明细），按 timeCode 建索引；
    各时段单量 / 有效在线时长必须从 vos[时段] 取，不能读骑手顶层（顶层只对应 queryTimeCode）。
    供 compute_valid（单站）与 attend_period_all.valid_all（并发全站）共用。
    """
    index = {}
    if not riders:
        return index
    for _r in riders:
        _rid = str(_r.get("knightId") or _r.get("riderId") or "")
        if not _rid:
            continue
        _vos = {}
        for _v in (_r.get("timeAttendanceVos") or []):
            try:
                _vos[int(_v.get("timeCode"))] = _v
            except (TypeError, ValueError):
                pass
        _tcs = []
        for _x in (_r.get("timeCode") or []):
            try:
                _tcs.append(int(_x))
            except (TypeError, ValueError):
                _tcs.append(_x)
        index[_rid] = {"tcs": _tcs, "vos": _vos, "workStatus": _r.get("workStatus")}
    return index


def _row_from_period(p, att_index, err):
    """由「单时段排班记录 + 该站点考勤索引(可能 None) + 错误(可能 None)」构造一行时段有效结果。

    供 compute_valid（单站）与 attend_period_all.valid_all（并发全站）共用，避免逻辑分叉。
    att_index：build_attendance_index 产物；若该时段无排班骑手则按「0 / 无数据」处理。
    """
    tc = p.get("time_code")
    target = p.get("predict_num")
    scheduled = p.get("actual_num")
    if err or att_index is None:
        return {
            "time_code": tc, "time_name": p.get("time_name"),
            "start_time": p.get("start_time"), "end_time": p.get("end_time"),
            "target": target, "scheduled": scheduled,
            "online": None, "offline": None, "rest": None,
            "absent": None, "rate": None,
            "valid_dur_sec": None, "valid_dur": "—",
            "error": err or "无数据",
        }
    try:
        _tc_int = int(tc)
    except (TypeError, ValueError):
        _tc_int = tc
    in_slot = [info for info in att_index.values() if _tc_int in info["tcs"]]
    online = [info for info in in_slot
              if info["workStatus"] not in REST_STATES
              and info["workStatus"] not in OFFLINE_STATES]
    offline = sum(1 for info in in_slot if info["workStatus"] in OFFLINE_STATES)
    rest = sum(1 for info in in_slot if info["workStatus"] in REST_STATES)
    # 有效在线时长：从 timeAttendanceVos[时段] 取该时段值（顶层只对应 queryTimeCode）
    valid_dur = sum(int((info["vos"].get(_tc_int) or {}).get("timeValidOnlineTime") or 0)
                    for info in online)
    on_n = len(online)
    rate = _rate(on_n, target)
    absent = (target - on_n) if (target not in (None, 0)) else None
    return {
        "time_code": tc, "time_name": p.get("time_name"),
        "start_time": p.get("start_time"), "end_time": p.get("end_time"),
        "target": target, "scheduled": scheduled,
        "online": on_n, "offline": offline, "rest": rest,
        "absent": absent, "rate": rate,
        "valid_dur_sec": valid_dur, "valid_dur": _fmt_dur(valid_dur),
        "error": None,
    }


def _rate(actual, target):
    """有效出勤率（百分数，保留 1 位）。分子缺失或分母为 0/None 时返回 None。"""
    if actual is None or target in (None, 0):
        return None
    return round(actual / target * 1000) / 10


# ===================== 主聚合：时段有效 =====================
def compute_valid(team_id, date):
    """时段有效：当天排班目标 + 逐时段实时考勤 → 每时段有效出勤行。

    参数：
      team_id  站点 teamId（str/int）
      date     'YYYY-MM-DD'（默认当天，调用方传）
    返回 dict：{ ok, team, teamName, date, rows[], summary, fetched_at, source }
    """
    team_id = str(team_id)

    sched_rows = flatten_schedule(fetch_schedule(team_id, date, date))
    periods = [r for r in sched_rows
               if str(r.get("time_code")) not in (DAY_TIME_CODE, REST_TIME_CODE)]

    # 单次请求拿全站骑手 × 全时段考勤（timeAttendanceVos 已含各时段明细，无需逐时段并发/节流）。
    # 实测（2026-10-17）：listAttendance 对任意 timeCode 返回全站骑手，timeAttendanceVos 与
    # 逐时段专查的顶层值逐位一致（null 与 0 等价），故每站点仅取数一次。
    _query_tc = periods[0]["time_code"] if periods else "120"
    _att_err = None
    _att_riders = []
    try:
        _data = fetch_attendance(team_id, _query_tc)
        _att_riders = (_data.get("result") or {}).get("data") or []
    except Exception as e:
        _log("站点 %s 实时考勤拉取失败: %s" % (team_id, e))
        _att_err = "%s: %s" % (type(e).__name__, e)
    _att_index = build_attendance_index(_att_riders) if _att_err is None else None

    rows = [_row_from_period(p, _att_index, _att_err) for p in periods]

    # 汇总（仅统计有有效结果的时段）
    tot_t = sum((r["target"] or 0) for r in rows if r["target"] is not None)
    tot_o = sum((r["online"] or 0) for r in rows if r["online"] is not None)
    tot_abs = sum((r["absent"] or 0) for r in rows if r["absent"] is not None)
    summary_rate = _rate(tot_o, tot_t)
    summary = {
        "target": tot_t,
        "online": tot_o,
        "absent": tot_abs,
        "rate": summary_rate,
        "period_count": len(rows),
    }

    _log("时段有效聚合完成：%d 个时段，在线 %s / 目标 %s" % (len(rows), tot_o, tot_t))
    return {
        "ok": True,
        "team": team_id,
        "teamName": TEAM_NAMES.get(team_id, "team " + team_id),
        "date": date,
        "rows": rows,
        "summary": summary,
        "fetched_at": datetime.datetime.now(BJ).isoformat(timespec="seconds"),
        "source": "live",
    }


if __name__ == "__main__":
    import json as _json
    import argparse as _ap
    _a = _ap.ArgumentParser()
    _a.add_argument("--team", default="917521136")
    _a.add_argument("--date", default=datetime.datetime.now(BJ).strftime("%Y-%m-%d"))
    _ns = _a.parse_args()
    print(_json.dumps(compute_valid(_ns.team, _ns.date), ensure_ascii=False, indent=2))
