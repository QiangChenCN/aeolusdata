#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""时段出勤看板 —— 骑手明细（按骑手 × 时段 下钻）。

整合两个数据源（复用 sources 公共取数模块）：
  · fetch_schedule    「排班目标」—— 当天 站×日期×时段 明细（timeList），
                       用于：① 确定当天真实存在的排班时段（time_code / 名称 / 区间）；
                             ② 通过 actual_num > 0 判断该时段确有排班。
  · fetch_attendance  「实时考勤」—— 单站点一次请求，返回全站骑手列表；
                       每位骑手带：knightId / knightName / teamId / workStatus /
                       timeCode(排班时段列表) 与 timeAttendanceVos(全时段明细)，
                       其中 timeAttendanceVos 内含各时段的 timeFinishOrder(单量) /
                       timeValidOnlineTime(有效在线时长，秒)。顶层 timeFinishOrder /
                       timeValidOnlineTime 仅对应 queryTimeCode（本次查询时段），
                       各时段真实值须读 timeAttendanceVos 对应时段条目。

计算逻辑（严格按需求）：
  1. 从排班目标数据中筛出「当天真实存在的排班时段」（time_code 非全天/休息）。
     实时考勤接口对任意 tc 都返回全站骑手，故以「骑手自身 timeCode 列表是否含该时段码」
     判定其「该时段有排班」，仅纳入真正排班者（未排班骑手 timeCode 不含本时段码，须过滤）。
     跨时段并集即为「当天有排班的所有骑手」。
     取数优化（2026-10-17）：listAttendance 的 timeAttendanceVos 已含全部时段明细，
     与逐时段专查的顶层值逐位一致（null 与 0 等价），故每个站点只请求一次考勤，
     从 timeAttendanceVos 按 timeCode 取各时段值，无需逐时段并发拉取。
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
  compute(team_id, date) -> dict
"""
import os

# >>> python-home bootstrap (added by layout migration) >>>
import os as _os
import sys as _sys

def _find_python_home():
    d = _os.path.dirname(_os.path.abspath(__file__))
    # 计算服务代码根：同时含 analytics/ 与 compute_api/ 子目录
    while d and not (
        _os.path.isdir(_os.path.join(d, "analytics"))
        and _os.path.isdir(_os.path.join(d, "compute_api"))
    ):
        d = _os.path.dirname(d)
    return d

def _find_repo_root():
    d = _os.path.dirname(_os.path.abspath(__file__))
    # 仓库根：含 .git 或根 package.json
    while d and d != _os.path.dirname(d) and not (
        _os.path.exists(_os.path.join(d, ".git"))
        or _os.path.exists(_os.path.join(d, "package.json"))
    ):
        d = _os.path.dirname(d)
    return d

PY_HOME = _find_python_home()
ROOT = _find_repo_root()
_ROOT = ROOT
if PY_HOME and PY_HOME not in _sys.path:
    _sys.path.insert(0, PY_HOME)
# <<< python-home bootstrap <<<


import sys
import datetime
from sources import (
    fetch_schedule, fetch_attendance, flatten_schedule, TEAM_NAMES,
)
from analytics.core import period_config as PC

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
def compute(team_id, date):
    """骑手明细：排班目标 + 逐时段实时考勤 → 骑手×时段达标矩阵。

    参数：
      team_id  站点 teamId（str/int）
      date     'YYYY-MM-DD'（调用方传，默认当天）
    返回 dict：{ ok, team, teamName, date, periods[], rows[], summary, fetched_at, source }
    """
    team_id = str(team_id)

    # 1) 排班目标（展平成 站×日期×时段 一行），仅保留真实排班时段。
    #    取数与登录态（含失效重登）均归 Nest 独占，本进程不再持有/触发任何登录逻辑。
    sched_rows = flatten_schedule(fetch_schedule(team_id, date, date))
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

    # 3) 单次请求拿全站骑手 × 全时段考勤。
    #    实测（2026-10-17）：listAttendance 对任意 timeCode 都返回全站骑手，且每位骑手的
    #    timeAttendanceVos 已包含**所有时段**的明细（timeFinishOrder / timeValidOnlineTime /
    #    timeOnlineTime …），与该时段「单独查询」的顶层值逐位一致（null 与 0 等价）。
    #    ⇒ 每个站点只需请求一次，从 timeAttendanceVos 按 timeCode 取各时段值即可，无需逐时段并发。
    #    注意：顶层 timeFinishOrder / timeValidOnlineTime 只对应 queryTimeCode（本次查询时段），
    #    各时段单量/时长必须读 timeAttendanceVos 对应时段条目，不能读顶层（否则取到的是查询时段的值）。
    riders = {}            # rider_id -> {rider_id, rider_name, team_id}
    rider_period = {}      # rider_id -> { tc: {orders, online_sec, work_status} }
    period_defs = []

    # 单次考勤取数（任意 tc 即可触发返回，timeAttendanceVos 含全时段）；登录态由 Nest 自行补齐。
    _query_tc = periods[0]["time_code"] if periods else "120"
    try:
        _att_raw = fetch_attendance(team_id, _query_tc)
        att_riders = (_att_raw.get("result") or {}).get("data") or []
    except Exception as _e:
        _log("站点 %s 实时考勤拉取失败: %s" % (team_id, _e))
        att_riders = []

    # 预建索引：rider_id -> {tcs:[int…], vos:{int tc: vo}, rider: 原始记录}
    # vos[tc] = timeAttendanceVos 中该时段的明细（含 timeFinishOrder / timeValidOnlineTime）。
    _att_index = {}
    for _r in att_riders:
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
        _att_index[_rid] = {"tcs": _tcs, "vos": _vos, "rider": _r}

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
        # 实时考勤接口对任意 tc 都返回全站骑手；未排班骑手 timeCode 不含本时段码。
        # 按「骑手 timeCode 列表是否含本时段码」过滤，才得到「该时段真正排班」的骑手。
        try:
            _tc_int = int(tc)
        except (TypeError, ValueError):
            _tc_int = tc
        _in_slot = [rid for rid, _info in _att_index.items() if _tc_int in _info["tcs"]]
        if not _in_slot:
            period_defs[-1]["error"] = "该时段实时考勤无数据"
            continue
        for rid in _in_slot:
            _info = _att_index[rid]
            _vo = _info["vos"].get(_tc_int) or {}
            if rid not in riders:
                _r = _info["rider"]
                riders[rid] = {
                    "rider_id": rid,
                    "rider_name": _r.get("knightName") or _r.get("riderName") or "",
                    "team_id": str(_r.get("teamId") or team_id),
                }
            rider_period.setdefault(rid, {})[tc] = {
                # 各时段单量/时长读 timeAttendanceVos[时段]，不读顶层（顶层只对应 queryTimeCode）
                "orders": _norm_int(_vo.get("timeFinishOrder")),
                "online_sec": _to_sec(_vo.get("timeValidOnlineTime")),
                "work_status": _info["rider"].get("workStatus"),
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
