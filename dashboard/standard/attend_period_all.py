#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""时段出勤看板 —— 全部站点合并取数（与标准达成 multi_team.py 平行）。

背景：时段出勤的两个外部取数接口（排班目标 schedule_statistics / 实时考勤 realtimeattendance）
请求体的 teamId **仅接受单个站点，不支持批量**。

  ★ 2026-09-12 实跑验证（登录态有效，三种 teamId 取值各打一次）：
      · 排班目标：single → code=200 返回 1 站；list([id,id,id]) / comma("id,id,id") → result=null
      · 实时考勤：single → code=200 返回 116 人；list / comma → result=null
      · 关键反证：每次批量请求前紧邻的 single 都成功，且考勤批量失败后的下一个 single 仍 200，
        说明「会话未被顶号」，批量返回 null 是 teamId 不接受数组/逗号串所致，确为「不支持批量」。
  ⇒ 本模块按「参与站点」逐站拉取（退化方案），再合并生成全量站点报表。

对外 API：
  valid_all(teams, date, cookie=None)      —— 时段有效：逐站 compute_valid → 按 time_code 合并
                                             人数/目标/在线/缺勤/有效在线时长，保留每站明细 per_site。
  rider_detail_all(teams, date, cookie=None)—— 骑手明细：逐站 compute → 行级拼接（每行自带 team_name/team_id）。

边界：
  · 某站当天无数据 / 拉取异常 → 记入 missing_teams，其余站照常展示；仅全部失败才置 need_refresh。
  · 合并「时段有效」按 time_code 对齐：时段码在两个站点一致即相加（公司级有效出勤率 = Σ在线 / Σ目标），
    某站缺该时段则对总和贡献 0（不虚构数据）。
"""
import os
import sys
import datetime

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from dashboard import attend_period as AP
from dashboard.standard import rider_period_detail as RPD
from dashboard.standard import attend_period_teams as APT

BJ = datetime.timezone(datetime.timedelta(hours=8))
ALL_TEAM_ID = "__all__"


def _rate(actual, target):
    """有效出勤率（百分数，保留 1 位）。分子缺失或分母为 0/None 时返回 None。"""
    if actual is None or target in (None, 0):
        return None
    return round(actual / target * 1000) / 10


def _hm(s):
    """'HH:MM' / 'HH:MM:SS' → 分钟数，用于排序；非法返回 9999。"""
    if not s or ":" not in str(s):
        return 9999
    try:
        a, b = str(s).split(":")
        return int(a) * 60 + int(b)
    except Exception:
        return 9999


def _fmt_dur(sec):
    sec = int(sec or 0)
    if sec <= 0:
        return "0"
    h = sec // 3600
    m = (sec % 3600) // 60
    return f"{h}h{m}m" if h > 0 else f"{m}m"


# ===================== 时段有效：全量合并 =====================
def valid_all(teams, date, cookie=None):
    """teams: 站点 id 列表。返回与 attend_period.compute_valid 同结构的合并结果（team="__all__"）。"""
    per, missing = [], []
    for tid in teams:
        try:
            res = AP.compute_valid(tid, date, cookie=cookie)
        except Exception as e:
            missing.append({"team": str(tid),
                            "name": AP.TEAM_NAMES.get(str(tid), str(tid)),
                            "error": "%s: %s" % (type(e).__name__, e)})
            continue
        if not res.get("ok") or not (res.get("rows") or []):
            missing.append({"team": str(tid),
                            "name": res.get("teamName", str(tid)),
                            "error": "无数据"})
            continue
        per.append(res)

    per_site = [{"team": r["team"], "teamName": r.get("teamName"),
                 "summary": r.get("summary"), "rows": len(r.get("rows") or [])}
                for r in per]

    if not per:
        return {"ok": True, "team": ALL_TEAM_ID, "teamName": "全部站点（0 站）", "date": date,
                "rows": [], "summary": None, "per_site": [],
                "missing_teams": missing or None, "need_refresh": True, "source": "none",
                "data_note": ("以下站点均无数据：" + "、".join(m["name"] for m in missing)) if missing else "无数据"}

    # 按 time_code 合并（公司级：Σ在线 / Σ目标）
    merged = {}
    for res in per:
        for r in res["rows"]:
            tc = r["time_code"]
            m = merged.setdefault(tc, {
                "time_code": tc, "time_name": r.get("time_name"),
                "start_time": r.get("start_time"), "end_time": r.get("end_time"),
                "target": 0, "scheduled": 0, "online": 0, "offline": 0, "rest": 0,
                "absent": 0, "valid_dur_sec": 0, "error": None,
                "_on": 0, "_ab": 0,
            })
            m["target"] += (r.get("target") or 0)
            m["scheduled"] += (r.get("scheduled") or 0)
            if r.get("online") is not None:
                m["online"] += r["online"]; m["_on"] += 1
            if r.get("offline") is not None:
                m["offline"] += r["offline"]
            if r.get("rest") is not None:
                m["rest"] += r["rest"]
            if r.get("absent") is not None:
                m["absent"] += r["absent"]; m["_ab"] += 1
            if r.get("valid_dur_sec") is not None:
                m["valid_dur_sec"] += r["valid_dur_sec"]
            if r.get("error"):
                m["error"] = (m["error"] + "; " + r["error"]) if m["error"] else r["error"]

    rows = []
    for tc in sorted(merged.keys(), key=lambda c: _hm(merged[c].get("start_time"))):
        m = merged[tc]
        online = m["online"] if m["_on"] else None
        target = m["target"] if m["target"] else None
        rate = _rate(online, target)
        absent = (target - online) if (target not in (None, 0) and online is not None) else None
        rows.append({
            "time_code": tc, "time_name": m["time_name"],
            "start_time": m["start_time"], "end_time": m["end_time"],
            "target": target, "scheduled": m["scheduled"] or None,
            "online": online, "offline": m["offline"] or None, "rest": m["rest"] or None,
            "absent": absent, "rate": rate,
            "valid_dur_sec": m["valid_dur_sec"] or None,
            "valid_dur": _fmt_dur(m["valid_dur_sec"]), "error": m["error"],
        })

    tot_t = sum((r["target"] or 0) for r in rows if r["target"] is not None)
    tot_o = sum((r["online"] or 0) for r in rows if r["online"] is not None)
    tot_abs = sum((r["absent"] or 0) for r in rows if r["absent"] is not None)
    summary = {
        "target": tot_t, "online": tot_o, "absent": tot_abs,
        "rate": _rate(tot_o, tot_t), "period_count": len(rows),
        "team_count": len(per),
    }
    note = ("以下站点当日无数据，未计入：" + "、".join(m["name"] for m in missing)) if missing else None
    return {
        "ok": True, "team": ALL_TEAM_ID, "teamName": "全部站点（%d 站）" % len(per),
        "date": date, "rows": rows, "summary": summary, "per_site": per_site,
        "missing_teams": missing or None, "need_refresh": False,
        "data_status": "ok" if not missing else "partial", "data_note": note,
        "fetched_at": datetime.datetime.now(BJ).isoformat(timespec="seconds"), "source": "live",
    }


# ===================== 骑手明细：全量拼接 =====================
def rider_detail_all(teams, date, cookie=None):
    """teams: 站点 id 列表。返回与 rider_period_detail.compute 同结构的拼接结果（team="__all__"）。"""
    rows, per, missing = [], [], []
    periods_index = {}
    for tid in teams:
        try:
            res = RPD.compute(tid, date, cookie=cookie)
        except Exception as e:
            missing.append({"team": str(tid),
                            "name": RPD.TEAM_NAMES.get(str(tid), str(tid)),
                            "error": "%s: %s" % (type(e).__name__, e)})
            continue
        if not res.get("ok") or not (res.get("rows") or []):
            missing.append({"team": str(tid),
                            "name": res.get("teamName", str(tid)),
                            "error": "无数据"})
            continue
        per.append(res)
        for p in res.get("periods") or []:
            periods_index.setdefault(str(p["time_code"]), p)
        rows.extend(res.get("rows") or [])

    if not per:
        return {"ok": True, "team": ALL_TEAM_ID, "teamName": "全部站点（0 站）", "date": date,
                "periods": [], "rows": [], "summary": None,
                "missing_teams": missing or None, "need_refresh": True, "source": "none",
                "data_note": ("以下站点均无数据：" + "、".join(m["name"] for m in missing)) if missing else "无数据"}

    periods = list(periods_index.values())
    periods.sort(key=lambda p: _hm(p.get("start_time")))
    s = {
        "rider_count": len(rows),
        "scheduled_total": sum((r.get("scheduled_periods") or 0) for r in rows),
        "achieved_total": sum((r.get("achieved_periods") or 0) for r in rows),
        "period_count": len(periods),
        "configured_periods": sum(1 for p in periods if p.get("configured")),
        "team_count": len(per),
    }
    s["achieved_rate"] = (round(s["achieved_total"] * 1000 / max(1, s["rider_count"])) / 10
                          if s["rider_count"] else None)
    note = ("以下站点当日无数据，未计入：" + "、".join(m["name"] for m in missing)) if missing else None
    return {
        "ok": True, "team": ALL_TEAM_ID, "teamName": "全部站点（%d 站）" % len(per),
        "date": date, "periods": periods, "rows": rows, "summary": s,
        "missing_teams": missing or None, "need_refresh": False,
        "data_status": "ok" if not missing else "partial", "data_note": note,
        "fetched_at": datetime.datetime.now(BJ).isoformat(timespec="seconds"), "source": "live",
    }


if __name__ == "__main__":
    import json as _json
    import argparse as _ap
    _a = _ap.ArgumentParser()
    _a.add_argument("--date", default=datetime.datetime.now(BJ).strftime("%Y-%m-%d"))
    _ns = _a.parse_args()
    print(_json.dumps(valid_all(APT.get_teams(), _ns.date), ensure_ascii=False, indent=2, default=str))
