from analytics.core.paths import ROOT, PY_HOME, _ROOT  # noqa: E402,F401 <<<


#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标准达成看板 —— 「全部站点」合并取数。

背景（2026-09-09 需求）：刷新一次会拉完所有「参与站点」的三源并生成各站数据，
看板要能切「全部站点」看合并结果。本模块负责把各站点结果合成一份：

  achievement_all：按日期合并各站人数 / 单量并重算达成率（不是把百分比再平均，
                   而是先合计分子分母再算率，避免小站被大站稀释或被放大）。
  riders_all     ：骑手维度天然是行级明细，直接拼接各站 rows（每行自带 team_name），
                   summary 的计数累加、达成率按总人数重算。

边界：
  · 某站当天没数据（从未刷新）→ 跳过并在 note 里点名，其它站照常展示；
    只有**全部**站点都没数据时才置 need_refresh=True 让前端提示去点刷新。
  · 各站达成门槛（标准1）不同 → 合并视图不显示门槛（置 None），不硬造一个值。
  · cache_time 取各站中**最早**的落盘时间：一次全量刷新理论上同时刻完成，
    取最早能暴露掉队的站点，不会用最新时间掩盖陈旧数据。

本模块只做合并计算，取数仍由 achievement / rider_dimension 负责（单一来源）。
"""
import datetime

from analytics.domains.standard import achievement as AC   # noqa: E402
from analytics.domains.standard import rider_dimension as RD  # noqa: E402
from analytics.core import cache as CACHE      # noqa: E402

BJ = datetime.timezone(datetime.timedelta(hours=8))

ALL_TEAM_ID = "__all__"     # 前端「全部站点」选项的 value


def _num(v):
    """数值相加用：None / 非数字当 0，但保留 int/float 类型。"""
    if v is None:
        return 0
    try:
        return float(v)
    except Exception:
        return 0


def _earliest(times):
    ts = [t for t in times if t]
    if not ts:
        return None
    return min(ts)


# ===================== 站点维度 =====================
def achievement_all(teams, start, end):
    """teams: [(team_id, team_name), ...]。返回与 achievement.recompute 同结构的结果。"""
    per, missing = [], []
    for tid, tname in teams:
        res = AC.recompute(tid, start, end)
        if res.get("need_refresh") or not (res.get("rows") or []):
            missing.append(tname or str(tid))
            continue
        per.append(res)

    if not per:
        return AC._empty(ALL_TEAM_ID, start, end, "none", need_refresh=True)

    # 1) rows：按 shift_date 合并，先合计再算率
    merged = {}
    for res in per:
        for r in (res.get("rows") or []):
            d = r.get("shift_date")
            m = merged.setdefault(d, {
                "shift_date": d, "time_code": r.get("time_code"),
                "time_name": r.get("time_name") or "全天",
                "actual_num": 0, "predict_num": 0,
                "predict_order": 0, "actual_order": 0,
                "_has_order": False,
            })
            m["actual_num"] += _num(r.get("actual_num"))
            m["predict_num"] += _num(r.get("predict_num"))
            if r.get("predict_order") is not None:
                m["predict_order"] += _num(r.get("predict_order"))
            if r.get("actual_order") is not None:
                m["actual_order"] += _num(r.get("actual_order"))
                m["_has_order"] = True

    rows = []
    for d in sorted(merged.keys()):
        m = merged[d]
        person_rate = AC._rate(m["actual_num"], m["predict_num"])
        order_rate = AC._rate(m["actual_order"], m["predict_order"]) if m["_has_order"] else None
        if person_rate is not None and order_rate is not None:
            combined = (person_rate + order_rate) / 2
        else:
            combined = person_rate if person_rate is not None else order_rate
        person_ok = None if person_rate is None else (person_rate >= AC.ACHIEVE_THRESHOLD * 100)
        order_ok = None if order_rate is None else (order_rate >= AC.ACHIEVE_THRESHOLD * 100)
        if person_ok is None or order_ok is None:
            achieved, label = None, "无数据"
        else:
            achieved, label = bool(person_ok and order_ok), ("达成" if (person_ok and order_ok) else "未达成")
        rows.append({
            "shift_date": d, "time_code": m["time_code"], "time_name": m["time_name"],
            "actual_num": round(m["actual_num"]) if m["actual_num"] else None,
            "predict_num": round(m["predict_num"]) if m["predict_num"] else None,
            "person_rate": person_rate, "person_achieved": person_ok,
            "predict_order": round(m["predict_order"]) if m["predict_order"] else None,
            "actual_order": round(m["actual_order"]) if m["_has_order"] else None,
            "order_rate": order_rate, "order_achieved": order_ok,
            "combined_rate": (round(combined * 10) / 10) if combined is not None else None,
            "achieved": achieved, "status_label": label,
        })

    # 2) summary：同样先合计再算率
    s_pred_n = sum(_num(r.get("predict_num")) for r in rows)
    s_act_n = sum(_num(r.get("actual_num")) for r in rows)
    s_pred_o = sum(_num(r.get("predict_order")) for r in rows)
    s_act_o = sum(_num(r.get("actual_order")) for r in rows)
    has_order = any(r.get("actual_order") is not None for r in rows)
    person_rate = AC._rate(s_act_n, s_pred_n)
    order_rate = AC._rate(s_act_o, s_pred_o) if has_order else None
    if person_rate is not None and order_rate is not None:
        combined = (person_rate + order_rate) / 2
        achieved = bool(person_rate >= AC.ACHIEVE_THRESHOLD * 100
                        and order_rate >= AC.ACHIEVE_THRESHOLD * 100)
        status_label = "达成" if achieved else "未达成"
    else:
        combined = person_rate if person_rate is not None else order_rate
        achieved, status_label = None, "无数据"
    summary = {
        "person_rate": person_rate,
        "order_rate": order_rate,
        "combined_rate": (round(combined * 10) / 10) if combined is not None else None,
        "achieved": achieved,
        "status_label": status_label,
        "total_predict_num": round(s_pred_n) if s_pred_n else None,
        "total_actual_num": round(s_act_n) if s_act_n else None,
        "total_predict_order": round(s_pred_o) if s_pred_o else None,
        "total_actual_order": round(s_act_o) if has_order else None,
        "day_count": len(rows),
        "team_count": len(per),          # 合并视图新增：参与统计的站点数
        "missing_teams": missing or None,
    }

    # 3) 考勤快照：各站数值相加（时段取第一个有值的站）
    att = None
    for res in per:
        a = res.get("attendance")
        if not a or a.get("sched") is None:
            continue
        if att is None:
            att = dict(a)
            att["_n"] = 1
        else:
            for k in ("sched", "online", "offline", "rest"):
                att[k] = (att.get(k) or 0) + (a.get(k) or 0)
            att["_n"] += 1
    if att:
        att.pop("_n", None)

    note = None
    if missing:
        note = "以下站点今日无落盘数据，未计入：%s" % "、".join(missing)
    return {
        "ok": True,
        "source": "cache",
        "error": None,
        "team": ALL_TEAM_ID,
        "teamName": "全部站点（%d 站）" % len(per),
        "start": start,
        "end": end,
        "summary": summary,
        "rows": rows,
        "attendance": att,
        "need_refresh": False,
        "data_status": "ok" if not missing else "partial",
        "data_note": note,
        "basis": "day",
        "cache_time": _earliest([r.get("cache_time") for r in per]),
    }


# ===================== 骑手维度 =====================
def riders_all(teams, start, end, time_code=None, month=None):
    """teams: [(team_id, team_name), ...]。返回与 rider_dimension.recompute 同结构的结果。"""
    rows, per, missing = [], [], []
    for tid, tname in teams:
        res = RD.recompute(tid, time_code=time_code, start=start, end=end, month=month)
        if res.get("need_refresh") or not (res.get("rows") or []):
            missing.append(tname or str(tid))
            continue
        per.append(res)
        rows.extend(res.get("rows") or [])

    if not per:
        return RD._empty(ALL_TEAM_ID, start, end, "none", need_refresh=True,
                         month=month, time_code=time_code)

    s = {
        "rider_count": sum(len(r.get("rows") or []) for r in per),
        "scheduled_count": sum((r.get("summary") or {}).get("scheduled_count") or 0 for r in per),
        "unscheduled_count": sum((r.get("summary") or {}).get("unscheduled_count") or 0 for r in per),
        "achieved_count": sum((r.get("summary") or {}).get("achieved_count") or 0 for r in per),
    }
    s["achieved_rate"] = (round(s["achieved_count"] * 1000 / max(1, s["rider_count"])) / 10
                          if s["rider_count"] else None)
    # 达成门槛：各站标准1 一致才展示，不同则置 None（不硬造一个合并门槛）
    ot = {(r.get("summary") or {}).get("day_order_target") for r in per}
    dt = {(r.get("summary") or {}).get("day_online_target_min") for r in per}
    s["day_order_target"] = ot.pop() if len(ot) == 1 else None
    s["day_online_target_min"] = dt.pop() if len(dt) == 1 else None
    s["team_count"] = len(per)
    s["missing_teams"] = missing or None
    # 考勤取数时段：取第一个有值的站（一次全量刷新各站同一时段）
    tc = tn = None
    for r in per:
        sm = r.get("summary") or {}
        if sm.get("att_time_code") is not None:
            tc, tn = sm.get("att_time_code"), sm.get("att_time_name")
            break

    return {
        "ok": True,
        "source": "cache",
        "error": None,
        "team": ALL_TEAM_ID,
        "teamName": "全部站点（%d 站）" % len(per),
        "start": start,
        "end": end,
        "rows": rows,
        "summary": s,
        "need_refresh": False,
        "month": month,
        "data_status": "ok" if not missing else "partial",
        "data_note": ("以下站点今日无落盘数据，未计入：%s" % "、".join(missing)) if missing else None,
        "cache_time": _earliest([r.get("cache_time") for r in per]),
        "att_time_code": tc,
        "att_time_name": tn,
    }
