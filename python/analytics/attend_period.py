#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""时段出勤看板 —— 聚合逻辑（dashboard/attend_period.py）。

数据源（复用 sources 公共取数模块）：
  · fetch_schedule    当天排班目标（站×日期×时段，每时段含 predict_num/actual_num）
  · fetch_attendance  实时考勤（单站点单时段快照，含骑手级 workStatus / timeCode / timeValidOnlineTime）

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

实时考勤逐时段拉取：对每个真实时段调用一次 fetch_attendance(time_code)，
                    单时段内按「tc ∈ rider.timeCode」归并，统计在线/小休/下线。
                    （礼貌性节流 0.25s/时段，避免触发接口限流。）
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
import time
import datetime
import concurrent.futures as _cf
from sources import (
    fetch_schedule, fetch_attendance, flatten_schedule, TEAM_NAMES,
)

BJ = datetime.timezone(datetime.timedelta(hours=8))

# 考勤 workStatus 语义（与 jobs/attendance、标准达成 achievement 一致）
REST_STATES = {2}        # 小休（暂离）
OFFLINE_STATES = {3}     # 下线（未在线装备）
DAY_TIME_CODE = "9999"   # 全天汇总行
REST_TIME_CODE = "2"     # 休息行

# 逐时段考勤拉取间的礼貌性节流（秒）
_PERIOD_SLEEP = 0.25


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


def _row_from_period(p, riders, err):
    """由「单时段排班记录 + 该时段骑手列表(可能 None) + 错误(可能 None)」构造一行时段有效结果。

    供 compute_valid（单站）与 attend_period_all.valid_all（并发全站）共用，避免逻辑分叉。
    """
    tc = p.get("time_code")
    target = p.get("predict_num")
    scheduled = p.get("actual_num")
    if err or riders is None:
        return {
            "time_code": tc, "time_name": p.get("time_name"),
            "start_time": p.get("start_time"), "end_time": p.get("end_time"),
            "target": target, "scheduled": scheduled,
            "online": None, "offline": None, "rest": None,
            "absent": None, "rate": None,
            "valid_dur_sec": None, "valid_dur": "—",
            "error": err or "无数据",
        }
    in_slot = [r for r in riders if tc in (r.get("timeCode") or [])]
    online = [r for r in in_slot
              if r.get("workStatus") not in REST_STATES
              and r.get("workStatus") not in OFFLINE_STATES]
    offline = sum(1 for r in in_slot if r.get("workStatus") in OFFLINE_STATES)
    rest = sum(1 for r in in_slot if r.get("workStatus") in REST_STATES)
    valid_dur = sum(int(r.get("timeValidOnlineTime") or 0) for r in online)
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
def compute_valid(team_id, date, cookie=None):
    """时段有效：当天排班目标 + 逐时段实时考勤 → 每时段有效出勤行。

    参数：
      team_id  站点 teamId（str/int）
      date     'YYYY-MM-DD'（默认当天，调用方传）
      cookie   风神 SSO cookie；不传则自动登录
    返回 dict：{ ok, team, teamName, date, rows[], summary, fetched_at, source }
    """
    team_id = str(team_id)

    sched_rows = flatten_schedule(fetch_schedule(team_id, date, date))
    periods = [r for r in sched_rows
               if str(r.get("time_code")) not in (DAY_TIME_CODE, REST_TIME_CODE)]

    def _fetch(p):
        tc = p.get("time_code")
        try:
            data = fetch_attendance(team_id, tc)
            riders = (data.get("result") or {}).get("data") or []
            return p, riders, None
        except Exception as e:
            _log("站点 %s 时段 %s 考勤拉取失败: %s" % (team_id, tc, e))
            return p, None, "%s: %s" % (type(e).__name__, e)

    # 各时段考勤并发拉取（不再串行 0.25s 节流）：单站刷新从「时段数×~1.3s」降到「最慢一段 ~1.3s」。
    # nest_client 会话令牌为进程级，并发线程均可读到，无需逐线程传递。
    rows = []
    if periods:
        with _cf.ThreadPoolExecutor(max_workers=min(8, len(periods) + 1)) as ex:
            for p, riders, err in ex.map(_fetch, periods):
                rows.append(_row_from_period(p, riders, err))

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
