#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""时段出勤看板 —— 骑手明细（按骑手 × 时段 下钻）。

整合两个数据源（复用 dashboard.get_data 公共取数模块）：
  · fetch_schedule    「排班目标」—— 当天 站×日期×时段 明细（timeList），
                       用于：① 确定当天真实存在的排班时段（time_code / 名称 / 区间）；
                             ② 通过 actual_num > 0 判断该时段确有排班。
  · fetch_attendance  「实时考勤」—— 单站点单时段快照，返回该时段内骑手列表，
                       每条骑手带：knightId / knightName / teamId / workStatus /
                       timeCode(排班时段列表) / timeFinishOrder(该时段单量) /
                       timeValidOnlineTime(该时段有效在线时长，秒)。

计算逻辑（严格按需求）：
  1. 从排班目标数据中筛出「当天真实存在的排班时段」（time_code 非全天/休息）。
     逐时段并发拉实时考勤；实时考勤接口对任意 tc 都返回全站骑手，
     故以「骑手自身 timeCode 列表是否含该时段码」判定其「该时段有排班」，
     仅纳入真正排班者（未排班骑手 timeFinishOrder=0 且 timeCode 不含本时段码，须过滤）。
     跨时段并集即为「当天有排班的所有骑手」。
  2. 对每位骑手，到实时考勤中匹配其各时段的「单量(timeFinishOrder)」与
     「有效在线时长(timeValidOnlineTime)」，依据 period_config 的预设达标规则
     （单量要求 orders + 有效在线时长要求 effective_online_req_h）逐时段判定是否达标。
  3. 展示字段：骑手ID / 骑手姓名 / 所属站点，以及该骑手「各个时段是否达成」。

达标规则（period_config 单月配置，作用于每一真实时段）：
  订单达标 = 该时段单量 >= 单量要求(orders)      （单量要求=0 视为免考核，记达标）
  时长达标 = 该时段有效在线时长(小时) >= 时长要求(effective_online_req_h)
            （时长要求=0 视为免考核，记达标）
  该时段整体「达成」 = 订单达标 且 时长达标。

时段匹配：排班目标时段 → period_config 达标规则，按「时段名称」优先、回落「起止时间」匹配。
未匹配到规则（排班目标有该时段但 period_config 未配置）时，该时段标记为「未配置规则」，
骑手在该时段单元格记为 None（无法判定），不计入达成统计。

对外 API：
  compute(team_id, date, cookie=None) -> dict
"""
import os
import sys
import datetime

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from dashboard.get_data import (
    fetch_schedule, fetch_attendance, flatten_schedule,
    ensure_cookies, TEAM_NAMES,
)
from dashboard.standard import period_config as PC

BJ = datetime.timezone(datetime.timedelta(hours=8))

# 排班目标里的非真实时段码：9999=全天汇总行，2=休息行
DAY_TIME_CODE = "9999"
REST_TIME_CODE = "2"

# 实时考勤 workStatus 语义（与 jobs/attendance、achievement、attend_period 一致）
REST_STATES = {2}        # 小休（暂离）
OFFLINE_STATES = {3}     # 下线（未在线装备）


def _log(msg):
    ts = datetime.datetime.now(BJ).strftime("%H:%M:%S")
    print(f"[{ts}] [rider_period_detail] {msg}", flush=True)


def _norm_int(v):
    try:
        if v is None or v == "":
            return 0
        return int(float(v))
    except (ValueError, TypeError):
        return 0


def _to_sec(v):
    """秒（接口给的是秒）。缺失/非法记 None。"""
    try:
        if v is None or v == "":
            return None
        return int(float(v))
    except (ValueError, TypeError):
        return None


def _norm_time(s):
    """'00:00:00' / '00:00' → '00:00'，非法返回原串。"""
    if not s:
        return s
    s = str(s).strip()
    if s.count(":") == 2:
        h, m, _ = s.split(":")
        return "%02d:%02d" % (int(h), int(m))
    return s


def _hm_to_min(s):
    s = _norm_time(s)
    if not s or ":" not in s:
        return 9999
    try:
        a, b = s.split(":")
        return int(a) * 60 + int(b)
    except ValueError:
        return 9999


# ===================== 主聚合：骑手明细 =====================
def compute(team_id, date, cookie=None):
    """骑手明细：排班目标 + 逐时段实时考勤 → 骑手×时段达标矩阵。

    参数：
      team_id  站点 teamId（str/int）
      date     'YYYY-MM-DD'（调用方传，默认当天）
      cookie   风神 SSO cookie；不传则自动登录
    返回 dict：{ ok, team, teamName, date, periods[], rows[], summary, fetched_at, source }
    """
    team_id = str(team_id)
    if cookie is None:
        cookie, _ = ensure_cookies()

    # 1) 排班目标（展平成 站×日期×时段 一行），仅保留真实排班时段
    sched_rows = flatten_schedule(fetch_schedule(cookie, team_id, date, date))
    periods = [r for r in sched_rows
               if str(r.get("time_code")) not in (DAY_TIME_CODE, REST_TIME_CODE)]
    # 排班目标「全天」行（time_code=9999）：其 predict_num/actual_num 供站点数据「全天」列投影，
    # 不二次取数。统一数据源 attend_period_source 复用此字段。
    fd_sched = next((r for r in sched_rows
                     if str(r.get("time_code")) == DAY_TIME_CODE), None)

    # 2) 时段配置（达标规则）：按名称 / 起止时间 建索引；
    #    普通时段列顺序须与「时段设置」界面列顺序保持一致（支持手动拖拽排序，顺序以 cfg 数组为准）。
    cfg = PC.load(month=date[:7])
    cfg_by_name = {p["name"]: p for p in cfg["periods"]}
    cfg_by_time = {(p["start"], p["end"]): p for p in cfg["periods"]}
    # 「全天」行（name=全天 / 00:00-00:00）仅用于全天达标判定，不作为普通时段列参与排序
    cfg_list = [p for p in cfg["periods"]
                if p.get("name") != "全天" and (p.get("start"), p.get("end")) != ("00:00", "00:00")]
    cfg_pos = {}
    for _i, _p in enumerate(cfg_list):
        cfg_pos.setdefault(_p.get("name"), _i)
        cfg_pos.setdefault((_p.get("start"), _p.get("end")), _i)
    def _period_order_key(r):
        _name = r.get("time_name")
        _s = _norm_time(r.get("start_time"))
        _e = _norm_time(r.get("end_time"))
        for _k in (_name, (_s, _e)):
            if _k in cfg_pos:
                return (0, cfg_pos[_k], 0)
        # 未匹配到配置规则的时段排在最后，按开始时间兜底
        return (1, 0, _hm_to_min(r.get("start_time")))
    periods.sort(key=_period_order_key)

    # 3) 逐时段并发拉取实时考勤。
    #    关键结论（2026-09-13 实测）：listAttendance 对任意 tc 都返回**全站全部骑手**，
    #    但其 timeFinishOrder/timeValidOnlineTime 是「该请求时段」的值；骑手自身 timeCode 字段
    #    才是其当天真实排班列表（非回显）。因此：① 必须逐时段拉取才能拿到各时段真实单量；
    #    ② 必须用「骑手 timeCode 含本时段码」过滤，才能得到该时段真正排班的骑手（否则全员全时段排班）。
    #    为保性能，用线程池并发拉取各时段（各请求独立、互不依赖）。
    riders = {}            # rider_id -> {rider_id, rider_name, team_id}
    rider_period = {}      # rider_id -> { tc: {orders, online_sec, work_status} }
    period_defs = []

    # 3.1) 并发拉取：tc -> 该时段骑手列表
    import concurrent.futures as _cf
    def _fetch_one(_tc):
        try:
            _d = fetch_attendance(team_id, _tc, cookie)
            return _tc, (_d.get("result") or {}).get("data") or []
        except Exception as _e:
            return _tc, _e
    _tcs = [p.get("time_code") for p in periods]
    att_by_tc = {}
    with _cf.ThreadPoolExecutor(max_workers=min(len(_tcs), 8)) as _ex:
        for _tc, _res in _ex.map(_fetch_one, _tcs):
            if isinstance(_res, Exception):
                _log("时段 %s 实时考勤拉取失败: %s" % (_tc, _res))
                att_by_tc[_tc] = []
            else:
                att_by_tc[_tc] = _res

    for p in periods:
        tc = p.get("time_code")
        name = p.get("time_name")
        start = _norm_time(p.get("start_time"))
        end = _norm_time(p.get("end_time"))
        actual = p.get("actual_num")
        c = cfg_by_name.get(name) or cfg_by_time.get((start, end))
        if c:
            orders_req = _norm_int(c.get("orders"))
            online_req_h = round(float(c.get("effective_online_req_h") or 0), 2)
            configured = True
        else:
            orders_req = 0
            online_req_h = 0.0
            configured = False
        period_defs.append({
            "time_code": tc, "time_name": name,
            "start_time": start, "end_time": end,
            "orders_req": orders_req, "online_req_h": online_req_h,
            "configured": configured,
            "actual_num": actual,
            "predict_num": _norm_int(p.get("predict_num")),
            "error": None,
        })
        riders_in = att_by_tc.get(tc, [])
        if not riders_in:
            period_defs[-1]["error"] = "该时段实时考勤无数据"
            continue
        # 关键：实时考勤接口对任意 tc 都返回全站骑手，未排班骑手 timeFinishOrder=0
        # 且 timeCode 不含本时段码。必须按「骑手 timeCode 列表是否含本时段码」过滤，
        # 才得到「该时段真正排班」的骑手；否则会误判全员全时段已排班。
        try:
            _tc_int = int(tc)
        except (TypeError, ValueError):
            _tc_int = tc
        for r in riders_in:
            rid = str(r.get("knightId") or r.get("riderId") or "")
            if not rid:
                continue
            _r_tcs_int = []
            for _x in (r.get("timeCode") or []):
                try:
                    _r_tcs_int.append(int(_x))
                except (TypeError, ValueError):
                    _r_tcs_int.append(_x)
            if _tc_int not in _r_tcs_int:
                continue
            if rid not in riders:
                riders[rid] = {
                    "rider_id": rid,
                    "rider_name": r.get("knightName") or r.get("riderName") or "",
                    "team_id": str(r.get("teamId") or team_id),
                }
            rider_period.setdefault(rid, {})[tc] = {
                "orders": _norm_int(r.get("timeFinishOrder")),
                "online_sec": _to_sec(r.get("timeValidOnlineTime")),
                "work_status": r.get("workStatus"),
            }

    # 4) 组装每位骑手的逐时段达标矩阵
    # 系统设置中的「全天」配置标准（period_config 里 name=全天 或 00:00-00:00 的时段）
    fd_cfg = cfg_by_name.get("全天") or cfg_by_time.get(("00:00", "00:00"))
    fd_orders_req = _norm_int(fd_cfg.get("orders")) if fd_cfg else 0
    fd_online_req_h = round(float(fd_cfg.get("effective_online_req_h") or 0), 2) if fd_cfg else 0.0
    fd_configured = bool(fd_cfg)

    rows = []
    for rid, rinfo in riders.items():
        cells = {}
        scheduled_n = 0
        achieved_n = 0
        full_day_orders = 0
        full_day_online_sec = 0
        for pd in period_defs:
            tc = pd["time_code"]
            rec = rider_period.get(rid, {}).get(tc)
            if rec is None:
                cells[tc] = {"scheduled": False, "orders": None, "online_sec": None,
                             "order_ok": None, "online_ok": None,
                             "achieved": None, "work_status": None,
                             "configured": pd["configured"]}
                continue
            scheduled_n += 1
            orders = rec["orders"]
            online_sec = rec["online_sec"]
            online_h = (online_sec / 3600.0) if online_sec is not None else None
            # 达标规则：订单达标 且 时长达标；任一要求=0 视为该轴免考核
            order_ok = (pd["orders_req"] == 0) or (orders >= pd["orders_req"])
            online_ok = (pd["online_req_h"] == 0) or (
                online_h is not None and online_h >= pd["online_req_h"])
            if pd["configured"]:
                achieved = bool(order_ok and online_ok)
                if achieved:
                    achieved_n += 1
            else:
                achieved = None
            cells[tc] = {
                "scheduled": True,
                "orders": orders,
                "online_sec": online_sec,
                "order_ok": order_ok,
                "online_ok": online_ok,
                "achieved": achieved,
                "work_status": rec["work_status"],
                "configured": pd["configured"],
            }
            # 累计「全天」判定用的实际值（只统计有排班的时段）
            full_day_orders += orders or 0
            if online_sec is not None:
                full_day_online_sec += online_sec

        full_day_online_h = round(full_day_online_sec / 3600.0, 2)
        # 全天达标判定：依据系统设置里的「全天」行（name=全天 / 00:00-00:00）
        if fd_configured:
            fd_order_ok = (fd_orders_req == 0) or (full_day_orders >= fd_orders_req)
            fd_online_ok = (fd_online_req_h == 0) or (full_day_online_h >= fd_online_req_h)
            full_day_achieved = bool(fd_order_ok and fd_online_ok)
        else:
            full_day_achieved = None

        rows.append({
            "rider_id": rinfo["rider_id"],
            "rider_name": rinfo["rider_name"],
            "team_id": rinfo["team_id"],
            "team_name": TEAM_NAMES.get(str(rinfo["team_id"]), rinfo["team_id"]),
            "cells": cells,
            "scheduled_periods": scheduled_n,
            "achieved_periods": achieved_n,
            "full_day_orders": full_day_orders,
            "full_day_online_sec": full_day_online_sec,
            "full_day_online_h": full_day_online_h,
            "full_day_achieved": full_day_achieved,
            "full_day_configured": fd_configured,
            "full_day_orders_req": fd_orders_req,
            "full_day_online_req_h": fd_online_req_h,
        })

    # 排序：达成时段数降序 → 姓名 → 骑手ID
    rows.sort(key=lambda x: (-x["achieved_periods"],
                             str(x["rider_name"]), str(x["rider_id"])))

    summary = {
        "rider_count": len(rows),
        "scheduled_total": sum(r["scheduled_periods"] for r in rows),
        "achieved_total": sum(r["achieved_periods"] for r in rows),
        "period_count": len(period_defs),
        "configured_periods": sum(1 for p in period_defs if p["configured"]),
    }

    _log("骑手明细聚合完成：%d 个时段，%d 名骑手" % (len(period_defs), len(rows)))
    return {
        "ok": True,
        "team": team_id,
        "teamName": TEAM_NAMES.get(team_id, "team " + team_id),
        "date": date,
        "periods": period_defs,
        "rows": rows,
        "summary": summary,
        # 排班目标「全天」行预测/实际人数（站点数据「全天」列投影用，避免二次取数）
        "full_day_schedule": {
            "predict_num": _norm_int(fd_sched.get("predict_num")) if fd_sched else None,
            "actual_num": _norm_int(fd_sched.get("actual_num")) if fd_sched else None,
        },
        "fetched_at": datetime.datetime.now(BJ).isoformat(timespec="seconds"),
        "source": "live",
    }


if __name__ == "__main__":
    import json as _json
    import argparse as _ap
    _a = _ap.ArgumentParser()
    _a.add_argument("--team", default="917521136")
    _a.add_argument("--date", default=datetime.datetime.now(BJ).strftime("%Y-%m-%d"))
    _ns = _ap.parse_args()
    print(_json.dumps(compute(_ns.team, _ns.date), ensure_ascii=False, indent=2))
