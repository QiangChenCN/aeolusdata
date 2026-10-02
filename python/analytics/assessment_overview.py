#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""考核结算大屏 —— 跨源聚合（运力达标 / 大网质量 / 时段出勤 / 历史对比 / 红黄灯）。

单一数据来源 = dashboard/data 三源缓存（orders / sched / att），与「标准达成」「时段出勤」
共用同一份落盘数据，口径零漂移；大屏只读缓存、零额外 HTTP（时段出勤复用 attend_period_source
的进程内数据集缓存，若用户尚未在「时段出勤」点查询则留空并提示，不主动打接口）。

口径（与现有看板一致）：
  · 运力达标  = station_report.build_one（达标人数 / 规模门槛 / 标准1~5 分布）
  · 大网质量  = 订单缓存直接算：完全妥投率 / 超时率 / 单均复合超时时长 / 用户+商户投诉率 /
               索赔率 / 违规率 / 欺诈率；服务质量星级按方案公式由投诉率推算
               （星级原始值、判责责任方、IM/电联/拜访、门店达标率、事故率、服务费金额
                当前订单缓存无字段，留占位，见 places 字段）
  · 时段出勤  = attend_period_source 数据集（站点×时段达成率）
  · 历史对比  = 读取多日订单/排班/考勤缓存，逐日算达标率+质量，给环比（vs 昨日）

阈值（红黄灯，城市/区域运营管理者视角）：
  · 运力达标率 < 90% 红，< 95% 黄
  · 服务质量星级 ≤ 2 红，≤ 3 黄
  · 投诉率 > 1.5% 黄，> 3% 红
  · 超时率 > 12% 黄，> 20% 红

对外：build_assessment(date, teams, refresh=False) -> dict
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
from analytics import cache as CACHE
from analytics import station_report as SR
from analytics import attend_period_source as APS
from analytics import rider_dimension as RD
from analytics import grade_standards as GS
from analytics import achievement as AC

BJ = datetime.timezone(datetime.timedelta(hours=8))

from analytics.teams_config import TEAM_NAMES  # 站点名唯一兜底源（teams_config.py）
ALL_TEAM_ID = "__all__"

# —— 红黄灯阈值 ——
TH = {
    "achieved_red": 90.0, "achieved_yellow": 95.0,   # 运力达标率(%)
    "star_red": 2.0, "star_yellow": 3.0,             # 服务质量星级
    "complaint_yellow": 1.5, "complaint_red": 3.0,   # 投诉率(%)
    "timeout_yellow": 12.0, "timeout_red": 20.0,     # 超时率(%)
}


# ============================================================
# 工具
# ============================================================
def _t(v):
    """把订单缓存里的布尔字段归一为 Python bool（兼容 true/false/字符串/'0'/'1'）。"""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v == 1 or v == 1.0
    s = str(v).strip().lower()
    return s in ("true", "1", "是", "y", "t")


def _parse_dur(s):
    """'HH:MM:SS' / 'MM:SS' -> 秒；空/非法返回 None。"""
    if not s or not str(s).strip():
        return None
    parts = str(s).split(":")
    try:
        parts = [int(float(p)) for p in parts]
    except (ValueError, TypeError):
        return None
    if len(parts) == 3:
        h, m, sec = parts
    elif len(parts) == 2:
        h, m, sec = 0, parts[0], parts[1]
    else:
        return None
    return h * 3600 + m * 60 + sec


def _agg_rate(num, den):
    if not den:
        return None
    return round(num * 1000 / den) / 10


def _clamp_star(v):
    if v is None:
        return None
    return max(1.0, min(5.0, round(v, 2)))


# ============================================================
# 大网质量（订单缓存）
# ============================================================
def compute_quality(orders):
    """从订单缓存（list[dict]）算大网质量指标。订单为空返回 zeros + need=True。"""
    n = len(orders)
    if n == 0:
        return {"order_count": 0, "need": True,
                "deliver_rate": None, "timeout_rate": None, "avg_timeout_sec": None,
                "star": None, "complaint_rate": None, "claim_rate": None,
                "violate_rate": None, "cheat_rate": None}
    done = 0
    over = 0
    timeout_sec_sum = 0
    timeout_cnt = 0
    complain = 0
    claim = 0
    violate = 0
    cheat = 0
    for o in orders:
        if str(o.get("运单状态") or o.get("stateDesc") or "") == "配送成功":
            done += 1
        if _t(o.get("是否超平台期望时间") or o.get("isOverPlatformExpect")):
            over += 1
            d = _parse_dur(o.get("超平台期望送达时长") or o.get("overPlatformExpectDuration"))
            if d:
                timeout_sec_sum += d
                timeout_cnt += 1
        if _t(o.get("用户投诉是否成立") or o.get("isUserComplaint")) or \
           _t(o.get("商户投诉是否成立") or o.get("isMerchantComplaint")):
            complain += 1
        if _t(o.get("索赔是否成立") or o.get("isClaim")):
            claim += 1
        if _t(o.get("违规取餐是否成立") or o.get("isViolatePickup")) or \
           _t(o.get("违规到店是否成立") or o.get("isViolateArrive")) or \
           _t(o.get("违规送达是否成立") or o.get("isViolateDeliver")):
            violate += 1
        if _t(o.get("欺诈是否成立") or o.get("isCheat")):
            cheat += 1
    # 服务质量星级：方案公式（以「用户投诉率+商户投诉率」为不满意率代入）
    #   星级 = (3.5 + 0.5*(1 - 不满意率/0.01)) * 0.95（新专送膨胀系数）
    complaint_rate = complain / n if n else 0
    star = (3.5 + 0.5 * (1 - complaint_rate / 0.01)) * 0.95
    return {
        "order_count": n,
        "need": False,
        "deliver_rate": _agg_rate(done, n),
        "timeout_rate": _agg_rate(over, n),
        "avg_timeout_sec": round(timeout_sec_sum / timeout_cnt, 1) if timeout_cnt else None,
        "star": _clamp_star(star),
        "complaint_rate": _agg_rate(complain, n),
        "claim_rate": _agg_rate(claim, n),
        "violate_rate": _agg_rate(violate, n),
        "cheat_rate": _agg_rate(cheat, n),
    }


# ============================================================
# 单站聚合
# ============================================================
def _team_block(team_id, team_name, date):
    """单站：运力达标 + 大网质量 + 时段出勤（缓存）。缺运单缓存则 need_refresh。"""
    orders = CACHE.load_raw("orders", team_id, date)
    if orders is None:
        return {"team_id": team_id, "team_name": team_name,
                "need_refresh": True, "station": None, "quality": None, "period": None}
    station = SR.build_one(team_id, date, date, None, "cache")
    quality = compute_quality(orders)
    # 时段出勤：只读 attend_period_source 进程内缓存（不主动打接口）
    period = None
    try:
        ds = APS.get_dataset(team_id, date, refresh=False)
        if ds:
            srow = next((r for r in (ds.get("station_rows") or [])
                         if str(r.get("team_id")) == str(team_id)), None)
            if srow:
                period = {"metrics": srow.get("metrics") or {}, "source": ds.get("source")}
    except Exception:
        period = None
    return {"team_id": team_id, "team_name": team_name,
            "need_refresh": bool(station.get("need_refresh")),
            "station": (station if not station.get("need_refresh") else None),
            "quality": quality, "period": period}


def _agg_station(rows):
    """把多站 station 行汇总成「全部站点」运力达标口径。"""
    tot_scale = sum((r.get("scale_target") or 0) for r in rows if r)
    tot_ach = sum((r.get("achieved_num") or 0) for r in rows if r)
    tot_sched = sum((r.get("scheduled_num") or 0) for r in rows if r)
    tot_att = sum((r.get("attended_num") or 0) for r in rows if r)
    std = [0, 0, 0, 0, 0, 0]
    for r in rows:
        if not r:
            continue
        for i in range(1, 6):
            std[i] += (r.get("std%d" % i) or 0)
    threshold = sum((r.get("threshold_count") or 0) for r in rows if r)
    cap = sum((r.get("cap_count") or 0) for r in rows if r)
    return {
        "scale_target": tot_scale or None,
        "scheduled_num": tot_sched or None,
        "attended_num": tot_att or None,
        "achieved_num": tot_ach or None,
        "achieved_rate": _agg_rate(tot_ach, tot_scale),
        "schedule_rate": _agg_rate(tot_sched, tot_scale),
        "attend_rate": _agg_rate(tot_att, tot_scale),
        "threshold_count": threshold or None,
        "cap_count": cap or None,
        "std1": std[1], "std2": std[2], "std3": std[3], "std4": std[4], "std5": std[5],
        "peak_incentive": _agg_rate(std[2] + std[3] + std[4] + std[5], tot_scale),
    }


def _agg_quality(blocks):
    """把多站 quality 按订单量加权合并（直接拼订单计数再算率，避免率相加失真）。"""
    # 直接在各站已算率基础上做订单量加权平均（各站 order_count 已知）
    total = sum((b.get("quality", {}) or {}).get("order_count") or 0 for b in blocks if b.get("quality"))
    if not total:
        return None
    def wavg(key):
        s = 0.0
        for b in blocks:
            q = b.get("quality") or {}
            if not q or q.get(key) is None:
                continue
            w = q.get("order_count") or 0
            s += q[key] * w
        return round(s / total, 2)
    q0 = next((b.get("quality") for b in blocks if b.get("quality")), {})
    star = (3.5 + 0.5 * (1 - (wavg("complaint_rate") / 100) / 0.01)) * 0.95
    return {
        "order_count": total,
        "deliver_rate": wavg("deliver_rate"),
        "timeout_rate": wavg("timeout_rate"),
        "avg_timeout_sec": None,   # 加权平均秒数失真，跨站不汇总（各站明细里可见）
        "star": _clamp_star(star),
        "complaint_rate": wavg("complaint_rate"),
        "claim_rate": wavg("claim_rate"),
        "violate_rate": wavg("violate_rate"),
        "cheat_rate": wavg("cheat_rate"),
    }


# ============================================================
# 历史趋势（多日缓存）
# ============================================================
def _available_dates(teams, end_date, max_days=14):
    """返回 end_date 往前最多 max_days 天、且所有团队都有 orders 缓存的日期列表（升序）。"""
    dates = []
    e = datetime.date.fromisoformat(end_date)
    for i in range(max_days):
        d = (e - datetime.timedelta(days=i)).isoformat()
        if all(CACHE.raw_exists("orders", t, d) for t, _ in teams):
            dates.append(d)
        else:
            break
    return sorted(dates)


def _station_achieved_for_date(team_id, date):
    """轻量历史达标算法（不依赖 rider_dimension._build 的『今天』硬编码）。

    直接读 sched/orders/att 三源缓存，按 date 当天口径算：
      · 规模目标 scale_target = 排班目标 9999 全天行 predict_num
      · 达标人数 = 骑手集合（status==2 排班 ∪ 当日有完成单的未排班骑手）中
        「有效单量≥标准1 且 有效在线时长≥标准1」的人数（与 station_report 一致）
    返回 (achieved_num, scale_target) 或 None（缺源）。
    """
    sched = CACHE.load_raw("sched", team_id, date)
    orders = CACHE.load_raw("orders", team_id, date)
    att = CACHE.load_raw("att", team_id, date)
    if sched is None or orders is None or att is None:
        return None
    day_rows = AC._day_target_rows(sched)
    scale_target = int(day_rows[0]["predict_num"]) if day_rows else 0
    levels = GS.build_levels(team_id, date[:7])
    base = levels[1] if len(levels) > 1 else None
    if not base:
        return (0, scale_target)
    dot = base["min_valid_orders"]
    dom = base["min_valid_minutes"]
    allday = RD._aggregate_rider_orders(orders, team_id, date)
    completed = RD.riders_with_completed_orders_today(orders, team_id, date)
    riders_raw = att.get("rows") or []
    scheduled_ids = set()
    riders_sched = []
    for r in riders_raw:
        if str(r.get("status")) == "2":
            rid = str(r.get("knightId"))
            scheduled_ids.add(rid)
            riders_sched.append(r)
    for rid in completed:
        if rid not in scheduled_ids:
            riders_sched.append({"knightId": rid})
    achieved = 0
    for r in riders_sched:
        rid = str(r.get("knightId"))
        if not rid:
            continue
        vo = allday.get(rid, 0)
        fv = r.get("fullDayValidOnlineTime")
        vom = None if fv is None else RD._to_min(fv)
        order_ok = (dot == 0) or (vo >= dot)
        dur_ok = (dom == 0) or (vom is not None and vom >= dom)
        if order_ok and dur_ok:
            achieved += 1
    return (achieved, scale_target)


def _build_trend(teams, dates):
    """逐日算「全部站点」达标率 + 大网质量。返回 {dates, achieved_rate, deliver_rate,
    complaint_rate, timeout_rate, star, 环比}。"""
    achieved, deliver, complaint, timeout, star = [], [], [], [], []
    for d in dates:
        a = s = 0
        orders_all = []
        for tid, _ in teams:
            res = _station_achieved_for_date(tid, d)
            if res is None:
                continue
            a += res[0]
            s += res[1]
            orders_all.extend(CACHE.load_raw("orders", tid, d) or [])
        achieved.append(_agg_rate(a, s))
        q = compute_quality(orders_all)
        deliver.append(q["deliver_rate"])
        complaint.append(q["complaint_rate"])
        timeout.append(q["timeout_rate"])
        star.append(q["star"])
    # 环比（vs 昨日，即倒数第二日）
    ring = None
    if len(achieved) >= 2 and achieved[-1] is not None and achieved[-2] is not None:
        ring = {
            "achieved_rate": round((achieved[-1] - achieved[-2]) * 10) / 10,
            "deliver_rate": (round((deliver[-1] - deliver[-2]) * 10) / 10
                             if deliver[-1] is not None and deliver[-2] is not None else None),
            "complaint_rate": (round((complaint[-1] - complaint[-2]) * 10) / 10
                               if complaint[-1] is not None and complaint[-2] is not None else None),
        }
    return {"dates": dates, "achieved_rate": achieved, "deliver_rate": deliver,
            "complaint_rate": complaint, "timeout_rate": timeout, "star": star,
            "ring": ring,
            "yoy": None}   # 同比需上月同期缓存，当前数据范围不足 → null


# ============================================================
# 红黄灯
# ============================================================
def _level(value, red, yellow, higher_better=True):
    """返回 'red' / 'yellow' / 'ok' / None（value 为 None 时）。higher_better=True 表示值越大越好。"""
    if value is None:
        return None
    if higher_better:
        if value < red:
            return "red"
        if value < yellow:
            return "yellow"
        return "ok"
    else:
        if value > red:
            return "red"
        if value > yellow:
            return "yellow"
        return "ok"


def _alerts(blocks):
    out = []
    for b in blocks:
        tn = b.get("team_name")
        st = b.get("station") or {}
        q = b.get("quality") or {}
        ar = st.get("achieved_rate")
        lv = _level(ar, TH["achieved_red"], TH["achieved_yellow"], True)
        if lv in ("red", "yellow"):
            out.append({"team": tn, "type": "运力达标率", "level": lv,
                        "msg": "运力达标率 %.1f%%（门槛 %.0f%%）" % (ar, TH["achieved_yellow"])})
        star = q.get("star")
        lv = _level(star, TH["star_red"], TH["star_yellow"], True)
        if lv in ("red", "yellow"):
            out.append({"team": tn, "type": "服务质量星级", "level": lv,
                        "msg": "服务质量星级 %.2f 星" % star})
        cr = q.get("complaint_rate")
        lv = _level(cr, TH["complaint_red"], TH["complaint_yellow"], False)
        if lv in ("red", "yellow"):
            out.append({"team": tn, "type": "投诉率", "level": lv,
                        "msg": "投诉率 %.2f%%" % cr})
        tr = q.get("timeout_rate")
        lv = _level(tr, TH["timeout_red"], TH["timeout_yellow"], False)
        if lv in ("red", "yellow"):
            out.append({"team": tn, "type": "超时率", "level": lv,
                        "msg": "超时率 %.2f%%" % tr})
    return out


# ============================================================
# 主入口
# ============================================================
_CACHE = {}   # (date) -> 结果；refresh 时清


def build_assessment(date, teams, refresh=False):
    """聚合考核结算大屏所需全部数据。

    teams: [(team_id, name)]；date: 'YYYY-MM-DD'；refresh: 清除模块级缓存重算。
    """
    if refresh:
        _CACHE.pop(date, None)
    if date in _CACHE:
        return _CACHE[date]

    blocks = [_team_block(tid, name, date) for tid, name in teams]
    valid = [b for b in blocks if b.get("station")]
    station_all = _agg_station([b.get("station") for b in blocks if b.get("station")])
    quality_all = _agg_quality([b for b in blocks if b.get("quality")])
    period_all = None
    try:
        ds = APS.get_dataset(ALL_TEAM_ID, date, refresh=False)
        if ds:
            period_all = {"periods": ds.get("periods") or [],
                          "station_rows": ds.get("station_rows") or [],
                          "source": ds.get("source")}
        else:
            # 「时段出勤」看板按站点点查询后，进程内会按 team 缓存数据集；
            # 这里把各站缓存汇总成「全市」热力（避免大屏主动打接口）。
            srows = []
            periods_by_code = {}
            for tid, _ in teams:
                d2 = APS.get_dataset(tid, date, refresh=False)
                if not d2:
                    continue
                srows.extend(d2.get("station_rows") or [])
                for p in (d2.get("periods") or []):
                    periods_by_code.setdefault(str(p.get("time_code")), p)
            if srows:
                period_all = {"periods": [periods_by_code[k] for k in sorted(periods_by_code)],
                              "station_rows": srows, "source": "per-team cache"}
    except Exception:
        period_all = None

    dates = _available_dates(teams, date)
    trend = _build_trend(teams, dates) if dates else None
    alerts = _alerts(blocks)

    missing = [b.get("team_name") for b in blocks if b.get("need_refresh")]
    notes = []
    if not period_all:
        notes.append("时段出勤需在「时段出勤」看板点一次「查询」拉取实时数据后，本大屏才会显示（复用其进程内缓存，不重复打接口）。")
    if quality_all is None:
        notes.append("今日运单缓存缺失，无法计算大网质量；请先在「标准达成」点「刷新数据」。")

    payload = {
        "ok": True,
        "basis": "day",
        "date": date,
        "generated_at": datetime.datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S"),
        "all": {"team_name": "全部站点（%d 站）" % len(teams),
                "station": station_all, "quality": quality_all, "period": period_all},
        "teams": blocks,
        "trend": trend,
        "alerts": alerts,
        "thresholds": TH,
        "missing_teams": missing or None,
        "notes": notes or None,
        # 当前订单缓存无法支撑、需另接数据源的指标（占位说明，前端照此渲染）
        "places": [
            {"key": "电联率", "label": "送达电联率", "reason": "订单缓存无电联字段"},
            {"key": "im_reply", "label": "IM 及时回复率", "reason": "订单缓存无 IM 字段"},
            {"key": "visit", "label": "新专送拜访率", "reason": "订单缓存无拜访字段"},
            {"key": "store_rate", "label": "门店达标率(沃尔玛/盒马/KA)", "reason": "全仓无相关数据源"},
            {"key": "accident", "label": "事故率", "reason": "仅有风控违规/处罚口径，无独立事故源"},
            {"key": "fee_amount", "label": "预估服务费(金额)", "reason": "各档定价/单均/膨胀系数在风神后台，未接入"},
        ],
    }
    _CACHE[date] = payload
    return payload


if __name__ == "__main__":
    import json as _json
    import argparse as _ap
    _a = _ap.ArgumentParser()
    _a.add_argument("--date", default=CACHE.today_ymd())
    _ns = _a.parse_args()
    from analytics import teams_config as TCFG
    teams = [(str(t), TEAM_NAMES.get(str(t), str(t))) for t in TCFG.get_teams()]
    print(_json.dumps(build_assessment(_ns.date, teams), ensure_ascii=False, indent=2, default=str))
