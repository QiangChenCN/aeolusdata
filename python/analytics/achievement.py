#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标准达成看板 —— 三源聚合（单一脚本，dashboard/standard）。

把「排班目标 / 运单明细 / 实时考勤」三源在 站×日期 维度上关联，
算出标准达成率，供前端 /api/standard/achievement 渲染。

达成率口径（**全天口径**，2026-09-09 起；不再逐时段判定）
------------------------------------------------------
  · 人数标准达成率 = 全天实际排班人数 / 全天预测人数
  · 单量标准达成率 = 全天有效单量     / 全天预测单量
  · 综合标准达成率 = (人数达成率 + 单量达成率) / 2   （两维等权，仅作概览）

「全天」数据从哪来
------------------
  · 目标值：排班目标 timeList 里 **timeCode=9999** 的那一行就是官方全天汇总行，
    直接取 actual_num / predict_num / predict_order，不做任何时段累加。
    （各时段 predict_num 累加会得到 338 这种虚高值，全天真实预测人数是 79 ——
      人数是「排班人数」不是「人次数」，累加属于重复计数。）
  · 实际单量：运单明细按有效单口径聚合，见 analytics.order_rules：
    骑手接单时间归属北京时间当天 + 配送完成 + 非作弊 + 非异常 + 非逆向 + 非改派，
    并按 trackingId 兜底去重（同一单只计一次）。

边界取值（不拿缺失当 0）
------------------------
  no_target  无 9999 全天行   → 达成率 null，状态「无数据」
  no_orders  有目标无运单     → 人数照算，单量维度 null，状态「无数据」
  partial    区间含今天       → 照算，附提示「数据随当天推进持续增长」
  ok         数据完整         → 正常判定 达成 / 未达成

三源分工（调用方只传业务参数，屏障破关交给各 auth 包）：
  · 排班目标   → sources.schedule（风神 SSO）  当天不变，一天只拉一次
  · 运单明细   → 阶段 0（NestJS 一次拉全量 → 按 teamId 分组落盘）；本模块只读已落盘数据
  · 实时考勤   → get_data.attendance（风神 SSO，仅用于「当前排班未上线」快照）

本模块只做「取数编排 + 关联聚合」，不实现 HTTP 细节（那些在 sources/ 与各 auth 包里）。

两条路径（2026-09-09 重构：缓存标的从「聚合结果」下沉到「原始三源」）
  compute(team_id, start, end)    实时拉取 —— 仅点「查询」按钮时走
                                  拉三源 → 原始层落盘 → _build 组装
  recompute(team_id, start, end)  本地重算 —— 切站点 / 切维度时走，零 HTTP 请求
                                  读落盘三源 → _build 组装；缺数据只提示，不自动拉取

对外 API：
  compute(team_id, start, end)   -> dict   实时拉取路径
  recompute(team_id, start, end) -> dict   本地重算路径
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
import json
import datetime
from sources.attendance import fetch_team as _att_fetch
from analytics import cache as CACHE
from analytics import order_rules as OR

BJ = datetime.timezone(datetime.timedelta(hours=8))

from analytics.teams_config import TEAM_NAMES  # 站点名唯一兜底源（teams_config.py）

# ---- 全天口径常量（2026-09-09 起，标准达成一律按整天统计，不再逐时段判定）----
# 排班目标 timeList 中 timeCode=9999 的那一行就是「全天」汇总行，
# 直接拿它做目标值：actual_num/predict_num 是当天排班人数（不是人次数，不能各时段累加），
# predict_order 是全天预测单量。除 9999 外的行（100/111/…/151、2=休息）一律不参与达成计算。
DAY_TIME_CODE = "9999"
REST_TIME_CODE = "2"
# 达成阈值：达成率 ≥ 100% 才算「达成」
ACHIEVE_THRESHOLD = 1.0

# 考勤 workStatus 语义（与 jobs/attendance/attendance.py 一致）
REST_STATES = {2}        # 小休（暂离）
OFFLINE_STATES = {3}     # 下线（有排班但未在线装备）


def _log(msg):
    ts = datetime.datetime.now(BJ).strftime("%H:%M:%S")
    print(f"[{ts}] [achievement] {msg}", flush=True)


# ===================== 时间工具 =====================
def _ymd_to_ms(s, end_of_day=False):
    """'YYYY-MM-DD' → 北京时间毫秒。end_of_day=True 取 23:59:59.999。"""
    y, m, d = (int(x) for x in s.split("-"))
    if end_of_day:
        dt = datetime.datetime(y, m, d, 23, 59, 59, 999000, tzinfo=BJ)
    else:
        dt = datetime.datetime(y, m, d, 0, 0, 0, 0, tzinfo=BJ)
    return int(dt.timestamp() * 1000)


def _ms_to_bj(ms):
    return datetime.datetime.fromtimestamp(int(ms) / 1000, tz=BJ)


def _hm_to_min(s):
    if not s:
        return None
    s = str(s).strip()
    if ":" in s:
        try:
            a, b = s.split(":")
            return int(a) * 60 + int(b)
        except ValueError:
            return None
    try:
        return int(s)
    except ValueError:
        return None


def _in_slot(tod_min, start_min, end_min):
    """判断当日分钟数 tod_min 是否落在 [start_min, end_min) 时段内。
    跨午夜时段（如 22:00→00:00，start>end）按 [start,24:00)∪[00:00,end) 处理。
    休息/全天（00:00-00:00）返回 False（不计入单量归属）。"""
    if start_min is None or end_min is None:
        return False
    if start_min == 0 and end_min == 0:
        return False
    if start_min <= end_min:
        return start_min <= tod_min < end_min
    return tod_min >= start_min or tod_min < end_min


# ===================== 运单聚合（全天口径）=====================
def _norm_tc(v):
    """时段码归一化：9999 / 2 可能是 int 或 str，统一成 str 再比较。"""
    return None if v is None else str(v).strip()


def _is_day_row(r):
    return _norm_tc(r.get("time_code")) == DAY_TIME_CODE


def _day_target_rows(sched_rows):
    """挑出排班目标里代表「全天」的行（timeCode=9999），每个日期至多一行。

    全天目标是接口的官方口径：predict_num 是当天预测排班**人数**（不是各时段人次之和），
    直接取用即可；历史上把各时段 predict_num 累加会得到 338 这种虚高值（全天真实 79）。
    """
    out, seen = [], set()
    for r in sched_rows or []:
        if not _is_day_row(r):
            continue
        d = r.get("shift_date")
        if d in seen:          # 同一天重复出现的全天行只取第一条，避免重复计数
            continue
        seen.add(d)
        out.append(r)
    return out


def _day_bounds(start, end):
    """[start, end] 内每个北京自然日的 (ymd, start_ms, end_ms) 列表，供整数日界归属。"""
    out = []
    d = datetime.date(*(int(x) for x in start.split("-")))
    end_d = datetime.date(*(int(x) for x in end.split("-")))
    while d <= end_d:
        ymd = d.strftime("%Y-%m-%d")
        out.append((ymd, _ymd_to_ms(ymd, False), _ymd_to_ms(ymd, True)))
        d += datetime.timedelta(days=1)
    return out


def _count_valid_orders_by_date(orders, team_id, start, end):
    """全天实际单量：按「骑手接单时间」归属北京时间日期 + 有效单口径。

    口径见 analytics.order_rules（与骑手维度同一份，避免漂移）：
    配送完成 + 非作弊 + 非逆向单 + 非改派单
    （2026-09-10 修正：移除「异常上报 isAbnormalReport」剔除条件，详见 order_rules 注释）。

    - 归属日期用接单时间，跨午夜单归属接单那天，不会被两天各计一次
    - trackingId 兜底去重：同一单只计一次（切片抓取边界可能重复）
    - 只统计本 team_id 的单（demo CSV 含多站，live 已按站过滤）
    - 日界归属改用整数毫秒比较（预生成 [start,end] 各自然日起止 ms），
      避免逐单构造 datetime / strftime（订单量大时省掉大量对象创建）
    返回 { 'YYYY-MM-DD': 有效单量 }
    """
    bounds = _day_bounds(start, end)
    counts = {}
    seen = set()
    team_str = OR.norm_team(team_id)
    mismatched = 0
    for o in orders or []:
        if not OR.is_valid_order(o):
            continue
        if team_str:
            ot = OR.norm_team(OR.order_val(o, OR.TEAM_KEYS))
            if ot and ot != team_str:
                mismatched += 1
                continue
        ms = OR.accept_ms(o)
        if ms is None:
            continue
        # 整数日界归属：找 ms 落在哪个自然日（通常至多一个命中）
        d = None
        for ymd, s, e in bounds:
            if s <= ms <= e:
                d = ymd
                break
        if d is None:
            continue
        tid = o.get("trackingId")
        if tid is not None:
            if tid in seen:
                continue
            seen.add(tid)
        counts[d] = counts.get(d, 0) + 1
    if mismatched:
        _log("全天单量统计跳过非本站点单 %d 条" % mismatched)
    return counts


# ===================== 考勤快照 =====================
def _current_slot(sched_rows):
    """从排班目标里找「今天当前北京时间」所在的时段，返回 (timeCode, timeName) 或 None。"""
    today = datetime.datetime.now(BJ).strftime("%Y-%m-%d")
    now_min = datetime.datetime.now(BJ).hour * 60 + datetime.datetime.now(BJ).minute
    best = None
    for r in sched_rows:
        if r.get("shift_date") != today:
            continue
        sm = _hm_to_min(r.get("start_time"))
        em = _hm_to_min(r.get("end_time"))
        if _in_slot(now_min, sm, em):
            best = (r.get("time_code"), r.get("time_name"))
            break
    return best


def _time_name(sched_rows, tc):
    """按 time_code 反查时段名（本地重算时还原「拉取那一刻的时段」用）。"""
    if tc is None:
        return None
    for r in sched_rows:
        if str(r.get("time_code")) == str(tc):
            return r.get("time_name")
    return None


def fetch_attendance(team_id, sched_rows, cookie=None):
    """实时拉取「当前时段」考勤，返回落盘用 payload {"tc","time_name","rows","fetched_at"}。

    当前不在任何排班时段内时返回 None（对应前端「不在时段内」提示）。
    """
    slot = _current_slot(sched_rows)
    if not slot:
        return None
    tc, tn = slot
    data = _att_fetch(int(team_id), tc, cookie=cookie)
    riders = (data.get("result") or {}).get("data") or []
    return {"tc": tc, "time_name": tn, "rows": riders,
            "fetched_at": datetime.datetime.now(BJ).isoformat(timespec="seconds")}


def _snapshot_from_rows(sched_rows, att_payload):
    """把考勤 payload（tc + rows）算成前端快照统计。

    实时路径与本地重算路径共用：区别只在于 payload 是新拉的还是从落盘读的。
    时段码直接取 payload 里记录的 tc（而非当前时间），保证「拉的是午高峰
    就按午高峰算」，不会因用户晚点切 tab 而漂移。
    """
    if not att_payload:
        return {"time_code": None, "time_name": None,
                "sched": None, "online": None, "offline": None, "rest": None,
                "note": "当前不在任何排班时段内"}
    tc = att_payload.get("tc")
    riders = att_payload.get("rows") or []
    in_slot = [r for r in riders if tc in (r.get("timeCode") or [])]
    sched = len(in_slot)
    online = sum(1 for r in in_slot
                 if r.get("workStatus") not in REST_STATES
                 and r.get("workStatus") not in OFFLINE_STATES)
    offline = sum(1 for r in in_slot if r.get("workStatus") in OFFLINE_STATES)
    rest = sum(1 for r in in_slot if r.get("workStatus") in REST_STATES)
    tn = att_payload.get("time_name")
    if tn is None:
        tn = _time_name(sched_rows, tc)
    return {"time_code": tc, "time_name": tn,
            "sched": sched, "online": online, "offline": offline, "rest": rest,
            "note": None}




# ===================== 主聚合（全天口径）=====================
def _rate(actual, target):
    """达成率（百分数，保留 1 位）。分子或分母缺失/为 0 时返回 None（不是 0）。"""
    if actual is None or target in (None, 0):
        return None
    return round(actual / target * 1000) / 10


def _enrich(day_rows, order_counts, has_orders):
    """按「整天」组装明细行：一行 = 一个日期的全天达成情况。

    达成率口径：
      · 人数达成率 = 全天实际排班人数 / 全天预测人数   （两个值都来自 9999 全天行）
      · 单量达成率 = 全天有效单量     / 全天预测单量   （分子由运单明细按有效单口径聚合）
      · 综合达成率 = (人数达成率 + 单量达成率) / 2       （两维等权，仅作概览）

    达标状态 achieved：
      · True  = 人数与单量达成率均 ≥ 100%
      · False = 任一维度 < 100%
      · None  = 该维度无数据（不拿缺失当 0，也不算未达成）
    """
    out = []
    for r in day_rows:
        d = r.get("shift_date")
        pn = r.get("predict_num")
        po = r.get("predict_order")
        an = r.get("actual_num")
        ao = order_counts.get(d) if has_orders else None
        person_rate = _rate(an, pn)
        order_rate = _rate(ao, po)
        if person_rate is not None and order_rate is not None:
            combined = (person_rate + order_rate) / 2
        else:
            combined = person_rate if person_rate is not None else order_rate
        person_ok = None if person_rate is None else (person_rate >= ACHIEVE_THRESHOLD * 100)
        order_ok = None if order_rate is None else (order_rate >= ACHIEVE_THRESHOLD * 100)
        if person_ok is None or order_ok is None:
            achieved = None
            status_label = "无数据"
        else:
            achieved = bool(person_ok and order_ok)
            status_label = "达成" if achieved else "未达成"
        out.append({
            "shift_date": d,
            "time_code": r.get("time_code"),
            "time_name": r.get("time_name") or "全天",
            "actual_num": an,
            "predict_num": pn,
            "person_rate": person_rate,
            "person_achieved": person_ok,
            "predict_order": po,
            "actual_order": ao,
            "order_rate": order_rate,
            "order_achieved": order_ok,
            "combined_rate": (round(combined * 10) / 10) if combined is not None else None,
            "achieved": achieved,
            "status_label": status_label,
        })
    return out


def _summary(day_rows, order_counts, has_orders):
    """跨日期汇总整天数据（默认只查一天，此时与单行一致）。

    注意：人数按「人天」累加（每天排班人数相加），与单量累加同为区间合计口径。
    缺失维度返回 None，不置 0。
    """
    s_act = s_pred = s_order_t = s_order_a = 0.0
    n_person = n_order = 0
    for r in day_rows:
        d = r.get("shift_date")
        pn, po, an = r.get("predict_num"), r.get("predict_order"), r.get("actual_num")
        if pn not in (None, 0) and an is not None:
            s_act += an
            s_pred += pn
            n_person += 1
        if has_orders and po not in (None, 0):
            s_order_t += po
            s_order_a += order_counts.get(d, 0)
            n_order += 1
    person_rate = _rate(s_act, s_pred)
    order_rate = _rate(s_order_a, s_order_t) if has_orders else None
    if person_rate is not None and order_rate is not None:
        combined = (person_rate + order_rate) / 2
    else:
        combined = person_rate if person_rate is not None else order_rate
    if person_rate is None or order_rate is None:
        achieved = None
        status_label = "无数据"
    else:
        achieved = bool(person_rate >= ACHIEVE_THRESHOLD * 100
                        and order_rate >= ACHIEVE_THRESHOLD * 100)
        status_label = "达成" if achieved else "未达成"
    return {
        "person_rate": person_rate,
        "order_rate": order_rate,
        "combined_rate": (round(combined * 10) / 10) if combined is not None else None,
        "achieved": achieved,
        "status_label": status_label,
        "total_predict_num": round(s_pred) if s_pred else None,
        "total_actual_num": round(s_act) if s_act else None,
        "total_predict_order": round(s_order_t) if s_order_t else None,
        "total_actual_order": round(s_order_a) if (has_orders and s_order_a) else None,
        "day_count": n_person,
    }


def _data_status(day_rows, has_orders, start, end):
    """边界情况判定：明确「无数据」而不是把缺失当 0。

      no_target  排班目标里没有 9999 全天行 → 人数/单量目标都无从比较
      no_orders  有目标但没有运单数据     → 只算人数维度，单量维度记无数据
      partial    统计区间含当天且当天未走完 → 数据仍在增长，仅提示不阻断
      ok         数据完整
    """
    if not day_rows:
        return "no_target", "排班目标无全天数据（缺少 timeCode=9999 行）"
    if not has_orders:
        return "no_orders", "无运单明细数据，单量维度无法计算"
    today = datetime.datetime.now(BJ).strftime("%Y-%m-%d")
    if start <= today <= end:
        return "partial", "统计区间含今天，数据随当天推进持续增长"
    return "ok", None


def _build(team_id, start, end, sched_rows, orders, att_payload, source,
           reuse_order_counts=None):
    """把三源原始数据组装成前端结果结构（纯本地计算，不发任何 HTTP 请求）。

    实时路径（compute）与本地重算路径（recompute）共用本函数，
    区别只在于三源是新拉的还是从落盘读的。
    """
    team_name = TEAM_NAMES.get(team_id, "team " + team_id)
    has_orders = bool(orders)
    # reuse_order_counts：刷新期由 RD._build 算好的团队级有效单（与 _count_valid_orders_by_date
    # 等价），直接复用，省掉 AC 对 orders 的二次全扫描。未提供时走原路径。
    order_counts = (reuse_order_counts if reuse_order_counts is not None
                   else (_count_valid_orders_by_date(orders, team_id, start, end)
                         if has_orders else {}))
    day_rows = _day_target_rows(sched_rows)
    attendance = _snapshot_from_rows(sched_rows, att_payload) if sched_rows else None
    rows = _enrich(day_rows, order_counts, has_orders)
    summary = _summary(day_rows, order_counts, has_orders)
    status, note = _data_status(day_rows, has_orders, start, end)
    if not day_rows:
        _log("排班目标中未找到全天行（timeCode=%s），达成率记为无数据" % DAY_TIME_CODE)
    # cache_time 仅 cache 路径返回（live 路径实时刚拉，概念上不存在「缓存」）；
    # 取三源原始层最近一次文件落盘的北京时间，ISO 8601 格式。
    cache_time = CACHE.latest_cache_time(team_id, start) if source == "cache" else None
    return {
        "ok": True,
        "source": source,
        "error": None,
        "team": team_id,
        "teamName": team_name,
        "start": start,
        "end": end,
        "summary": summary,
        "rows": rows,
        "attendance": attendance,
        "need_refresh": False,
        "data_status": status,
        "data_note": note,
        "basis": "day",   # 口径标记：按整天统计（前端据此渲染文案）
        "cache_time": cache_time,   # 缓存路径下的最近落盘时间，前端提示条渲染
    }


def _empty(team_id, start, end, source, error=None, need_refresh=False):
    """统一空 / 错误结构。need_refresh=True 时前端提示「请点查询拉取实时数据」。"""
    tid = str(team_id)
    return {
        "ok": True,
        "source": source,
        "error": error,
        "team": tid,
        "teamName": TEAM_NAMES.get(tid, "team " + tid),
        "start": start,
        "end": end,
        "summary": None,
        "rows": [],
        "attendance": None,
        "need_refresh": need_refresh,
        "data_status": "no_data" if need_refresh else "no_target",
        "data_note": ("今日尚无落盘数据，请点「查询」拉取" if need_refresh
                      else "暂无排班目标全天数据"),
        "basis": "day",
    }


def compute(team_id, start, end, reuse_orders=False, reuse_att=False,
             reuse_order_counts=None):
    """实时拉取路径 —— 仅点「查询」按钮时走。

    拉三源 → 原始层落盘 → 调 _build 组装。要点：
      · 运单明细复用阶段 0 落盘结果（取数归 NestJS，本地拉取路径已移除）
        + 超 8000 按时段切片 + AuthError 自动重登 5 次
      · 排班目标当天不变：命中当天缓存直接跳过拉取，一天只拉一次
      · 考勤连同当时的时段码 tc 一起落盘，供本地重算复用同一口径

    reuse_orders=True（全量刷新用）：若当天运单原始层已有落盘就直接复用，
    不再重复拉一遍 —— 骑手维度已经拉过同一站点同一天的运单，
    避免一次全量刷新里每站运单被拉两次（耗时翻倍 + 平白增加限流风险）。
    """
    team_id = str(team_id)
    date = start
    try:
        # 取数（排班 / 考勤 / 运单）都已迁 NestJS：刷新编排（RefreshAllService）先落盘
        # sched/att/orders 原始层，这里只读取、不再自行拉取或回写。
        # 任一必要源缺失即视为「尚未刷新」，返回 need_refresh 由前端提示点查询。
        cookie = None

        # 1) 排班目标（已由 Nest 刷新落盘）
        sched_rows = CACHE.load_raw("sched", team_id, date)
        if sched_rows is None:
            return _empty(team_id, start, end, "none", need_refresh=True)

        # 2) 运单明细：**唯一来源是阶段 0** —— NestJS 一次拉全量（终态时间 trackingFinish）
        #    再按 teamId 分组落盘。本地拉取路径已按「取数归 NestJS」移除，不再有第二套实现兜底。
        #    reuse_orders 现在的含义是「阶段 0 已完成」：为真时缺文件视为当日 0 单（不是错误），
        #    为假说明共享阶段没跑成，直接明确失败。
        if not reuse_orders:
            raise RuntimeError("运单明细只能由阶段 0（NestJS 全量取数）落盘；本地拉取路径已移除")
        orders = CACHE.load_raw("orders", team_id, date) or []
        _log("运单明细复用已落盘 %d 条" % len(orders))

        # 3) 实时考勤（已由 Nest 刷新落盘；reuse_att 仅作语义保留，实际都从原始层读）
        att_payload = CACHE.load_raw("att", team_id, date)
        if att_payload is None:
            return _empty(team_id, start, end, "none", need_refresh=True)
    except Exception as e:
        return _empty(team_id, start, end, "error",
                      "%s: %s" % (type(e).__name__, e))

    res = _build(team_id, start, end, sched_rows, orders, att_payload, "live",
                 reuse_order_counts=reuse_order_counts)
    CACHE.put_result("achievement", team_id, date, None, "live", res)
    CACHE.put_result("achievement", team_id, date, None, "cache", res)
    return res


def recompute(team_id, start, end):
    """本地重算路径 —— 切站点 / 切维度时走，零 HTTP 请求。

    直接读原始层落盘的三源重算。缺任一必要源（排班目标 / 运单明细）
    就返回 need_refresh=True，由前端提示用户点「查询」拉取实时数据 ——
    绝不因为「没缓存」就自动发起实时请求。
    """
    team_id = str(team_id)
    date = start
    cached = CACHE.get_result("achievement", team_id, date, None, "cache")
    if cached is not None:
        return cached
    sched_rows = CACHE.load_raw("sched", team_id, date)
    orders = CACHE.load_raw("orders", team_id, date)
    att_payload = CACHE.load_raw("att", team_id, date)
    if sched_rows is None or orders is None:
        return _empty(team_id, start, end, "none", need_refresh=True)
    _log("本地重算 排班%d行 运单%d条 考勤%s" % (
        len(sched_rows), len(orders),
        ("%d人" % len(att_payload.get("rows") or [])) if att_payload else "无"))
    res = _build(team_id, start, end, sched_rows, orders or [], att_payload, "cache")
    CACHE.put_result("achievement", team_id, date, None, "cache", res)
    return res


if __name__ == "__main__":
    import json as _json
    import argparse as _ap
    _a = _ap.ArgumentParser()
    _a.add_argument("--team", default="917521136")
    _a.add_argument("--start", default="2026-09-07")
    _a.add_argument("--end", default="2026-09-13")
    _ns = _a.parse_args()
    print(_json.dumps(compute(_ns.team, _ns.start, _ns.end),
                      ensure_ascii=False, indent=2))
