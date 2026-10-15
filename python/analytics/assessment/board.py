#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""实时数据看板 —— 站点概览指标计算（与标准达成看板解耦）。

只算实时数据看板卡片需要的指标，直接从 dashboard 标准缓存的原始三源(orders)
本地重算，零 HTTP 请求；不依赖 rider_dimension / achievement 等标准达成聚合。

指标口径（运单类：2026-10-14 起改为「用取到的全部运单」，不再按骑手接单时间归属当天；
  跨天接单的运单（如昨晚接单、今日完成）也计入当日看板，解决「130 vs 207」口径差；
  仅考核看板如此，标准达成 / 超时看板 / 大屏仍用接单日归属口径）：
  · 推配送单量  = 全部已落盘运单（每条都算一单，含跨天接单；见 order_rules.count_pushed_orders 的 all_dates）
  · 配送完成单  = 全部运单中状态=配送成功(state 40) 的运单（order_rules.is_completed）
  · T8超时单    = 配送完成单中「超出平台期望时间 > 8 分钟」的运单
                  （超时时长口径见 order_rules.over_expect_seconds / is_t8_timeout）
  · 高笔单      = 配送完成单中「是否高笔单(是)」的运单
                  （判定见 order_rules.is_high_value_order；与 T8 同为配送完成单子集）
  · 复合超时时长(单均, 秒) = 考核方案分段加权超时总时长 / 剔除前有效完单
                  （独立计算，口径见 analytics.assessment.compound；与「配送超时看板」同公式但本看板自算、不公用其代码）
  · T8准时率    = (配送完成单 - T8超时单) / 配送完成单，百分比；分母为 0 时 None
  · 投诉/差评/索赔 = 违规处罚明细中「违规分类=投诉/差评/餐货损 且 违规状态=成立」的条数
  · 物流责取消单 = 违规处罚明细中「违规分类=取消 且 违规状态=成立」的条数
  · 提前点送达单 = 违规处罚明细中「违规类型包含 提前点送达 且 违规状态=成立」的条数
                  （数据源与口径见 analytics.assessment.violations）
  · 不满意率    = (投诉单*5 + 差评单*5 + 索赔单) / 推配送单，百分比；分母为 0 时 None
  · 物流妥投率  = 配送完成单 / (配送完成单 + 物流责取消单 + 提前点送达单*2)，百分比；分母为 0 时 None

依赖：
  · analytics.cache        原始数据层读写 + 进程内结果缓存
  · analytics.order_rules  接单时间归属 / 完成态判定（与有效单口径同源）
  · analytics.teams_config 站点名兜底
  · analytics.assessment.violations   违规处罚明细（投诉/差评/索赔）口径
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
from analytics import order_rules as OR
from analytics.teams_config import TEAM_NAMES
from analytics.assessment import violations as RV
from analytics.assessment import delivery_source as DS
from analytics.assessment import compound as COMP
from analytics import service_quality as SQ

BJ = datetime.timezone(datetime.timedelta(hours=8))
MODULE = "assessment_board"


def _log(msg):
    ts = datetime.datetime.now(BJ).strftime("%H:%M:%S")
    print("[%s] [assessment-board] %s" % (ts, msg), flush=True)


def count_delivery_completed(orders, date, all_dates=False):
    """配送完成单：状态=配送成功(state 40)。

    考核看板专用口径（all_dates=True，2026-10-14 起）：不再按骑手接单时间归属当天，
    直接用「取到的全部运单」中配送成功的单，解决「130 vs 207」的口径差。
    all_dates=False 时保留原口径（接单时间归属当天）。
    """
    cnt = 0
    for o in (orders or []):
        if not OR.is_completed(o):
            continue
        if all_dates:
            cnt += 1
            continue
        ms = OR.accept_ms(o)
        if ms is None:
            continue
        if OR.ms_to_ymd(ms) == date:
            cnt += 1
    return cnt


def count_t8_timeout(orders, date, all_dates=False):
    """T8 超时单：配送成功 且 超平台期望时间 > 8 分钟。

    是「配送完成单」的子集（两者都要求配送成功），因此
    T8准时率 = (配送完成单 - T8超时单) / 配送完成单 必然落在 [0, 1]。

    考核看板专用口径（all_dates=True）：不再按骑手接单时间归属当天，直接用全部运单。
    all_dates=False 保留原口径（接单时间归属当天）。
    """
    cnt = 0
    for o in (orders or []):
        if not OR.is_t8_timeout(o):
            continue
        if all_dates:
            cnt += 1
            continue
        ms = OR.accept_ms(o)
        if ms is None:
            continue
        if OR.ms_to_ymd(ms) == date:
            cnt += 1
    return cnt


def ontime_rate(completed, t8_timeout):
    """T8 准时率（%）：(配送完成单 - T8超时单) / 配送完成单。分母为 0 返回 None。"""
    if not completed:
        return None
    return (completed - t8_timeout) * 100.0 / completed


def count_gaobi_orders(orders, date, all_dates=False):
    """高比单T8超时：T8 超时单（配送成功且超平台期望 > 8 分钟）中、且为「高比单」者。

    即 is_t8_timeout(o) 且 is_high_value_order(o)；is_t8_timeout 已隐含配送成功，无需再判 is_completed。
    与 timeout.py 的 high_value_timeout 口径一致（is_high_value_order and is_comp and is_t8_timeout）。

    考核看板专用口径（all_dates=True）：不再按骑手接单时间归属当天，直接用全部运单。
    all_dates=False 保留原口径（接单时间归属当天）。
    """
    cnt = 0
    for o in (orders or []):
        if not (OR.is_t8_timeout(o) and OR.is_high_value_order(o)):
            continue
        if all_dates:
            cnt += 1
            continue
        ms = OR.accept_ms(o)
        if ms is None:
            continue
        if OR.ms_to_ymd(ms) == date:
            cnt += 1
    return cnt


# ---- 天气等级（考核看板新增列，2026-10-14）----
# 订单天气严重度档位：0=正常，1=轻微恶劣天气，2=恶劣天气，3=极恶劣天气，4=罕见恶劣天气。
# 取值字段 weatherLevel（天气等级 中文别名同源）；数值档位或文本标签均可识别。
WEATHER_LEVEL_KEYS = ("weatherLevel", "天气等级")


def _weather_grade(o):
    """单条运单的天气严重度档位（0~4）。无法判定 → 0（正常）。"""
    v = OR.order_val(o, WEATHER_LEVEL_KEYS)
    if v is None:
        return 0
    s = str(v).strip()
    if s in ("1",):
        return 1
    if s in ("2",):
        return 2
    if s in ("3",):
        return 3
    if s in ("4",):
        return 4
    if s in ("0", "正常", ""):
        return 0
    # 文本标签（业务定义口径）
    if "罕见" in s:
        return 4
    if "轻微" in s:
        return 1
    if "恶劣" in s:
        return 3 if "极" in s else 2
    return 0


def weather_level(orders):
    """考核单位当天天气等级（分层口径，业务定义 2026-10-14）：

      正常天   ：当天 1/2/3/4 级恶劣天气接单量占比 ≤ 10%
      轻微恶天 ：1234 级占比 > 10% 且 2/3/4 级占比 ≤ 10%
      一般恶天 ：234 级占比 > 10% 且 3/4 级占比 < 35%
      严重恶天 ：34 级占比 ≥ 35%

    占比 = 对应档位运单数 / 全部运单（与「取到的全部运单」口径同源）。
    全部为正常（无恶劣天气）即 正常天；分母为 0 时也返回 正常天。
    """
    total = 0
    c1234 = c234 = c34 = 0
    for o in (orders or []):
        total += 1
        g = _weather_grade(o)
        if g >= 1:
            c1234 += 1
        if g >= 2:
            c234 += 1
        if g >= 3:
            c34 += 1
    if total == 0:
        return "正常天"
    r1234 = c1234 / total
    r234 = c234 / total
    r34 = c34 / total
    if r1234 <= 0.10:
        return "正常天"
    if r234 <= 0.10:
        return "轻微恶天"
    if r34 < 0.35:
        return "一般恶天"
    return "严重恶天"


# 看板天气档位（中文标签）→ 服务质量配置的 weather 键（normal/light/moderate/severe）。
_WEATHER_KEY_MAP = {
    "正常天": "normal",
    "轻微恶天": "light",
    "一般恶天": "moderate",
    "严重恶天": "severe",
}


def weather_key(level_label):
    """把 weather_level() 的中文档位映射成配置 weather 键；未知/缺失回落 normal。"""
    return _WEATHER_KEY_MAP.get(level_label, "normal")


def _compute_scores(result, orders, date):
    """按当天日型 × 天气取对应档位，用配置的 t0/t60/t100 算各指标 0~100 得分与总分。

    看板仅计算 4 项可取自订单/违规明细的指标（准时率/妥投率/不满意率/复合超时时长，权重合计 85），
    其余 3 项考核（电联率/IM回复率/新专送拜访，权重合计 15）看板不取数、按满分计入总分。
    故看板总分 = 4 项算得加权和(满分 85) + 15(其余项满分)，封顶 100。
    """
    month = SQ.month_of(date)
    settings = SQ.quality_settings(month)
    date_type = SQ.resolve_date_type(date, settings.get("date_overrides"))
    wx = weather_key(weather_level(orders))
    raw = {
        "ontime_rate": result.get("t8_ontime_rate"),
        "delivery_rate": result.get("fulfillment_rate"),
        "unsat_rate": result.get("unsat_rate"),
        "compound_overtime": result.get("avg_compound_overtime_sec"),
    }
    scores = SQ.compute_team_scores(raw, settings, date_type, wx)
    result["t8_ontime_score"] = scores.get("ontime_rate")
    result["fulfillment_score"] = scores.get("delivery_rate")
    result["unsat_score"] = scores.get("unsat_rate")
    result["compound_overtime_score"] = scores.get("compound_overtime")
    # 其余 3 项（电联率/IM回复率/新专送拜访，合计 15 分）看板不考核、按满分计入。
    _total = scores.get("total_score")
    if _total is not None:
        _total = round(min(100.0, _total + 15.0), 2)
    result["total_score"] = _total


def adverse_ratio(orders):
    """恶单占比（%）：当天 1/2/3/4 级恶劣天气接单量 / 全部运单 × 100（不取整，保留全部精度；前端展示最多 3 位）。

    即天气等级分层口径里的「1234 级恶劣天气接单量占比」——它 > 10% 即脱离正常天、
    进入恶天判定区间（>10% 且 234 级 ≤10% → 轻微恶天；更高档由 234/34 占比决定）。
    无运单返回 None。
    """
    total = 0
    c = 0
    for o in (orders or []):
        total += 1
        if _weather_grade(o) >= 1:
            c += 1
    if total == 0:
        return None
    return c * 100.0 / total


def violation_metrics(team_id, date, pushed, completed, delivery_orders=None):
    """违规处罚明细派生指标：投诉/差评/索赔/物流责取消/提前点送达 + 高比单物流责取消
    + 不满意率/物流妥投率。

    违规明细不可用（load_team 返回 None）时全部为 None，前端显示「—」；
    已刷新但当天 0 条时各计数为 0，比率按 0 计算。

    不可用包含两种情况：「从未刷新」与「本次拉取失败」（见 Nest 侧
    AssessmentViolationFetchService 落盘的 fetch_ok）。后者必须视为不可用 —— 否则盘上
    遗留的上一次成功数据会被当成本次数据继续算，数字照常显示但实际已陈旧、且无任何报错。

    delivery_orders：同站点运单明细（DS.load_delivery_orders），用于「高比单物流责取消」
    按运单号 JOIN「是否高比单」二次过滤；为 None 时 gaobi_cancel_liable 记 None（与
    违规明细不可用同等对待，前端显示「—」）。
    """
    rows = RV.load_team(team_id, date)
    if rows is None:
        return {"complaint": None, "bad_review": None, "claim": None,
                "cancel_liable": None, "early_delivered": None,
                "gaobi_cancel_liable": None,
                "false_report_slow_unfinished": None,
                "unsat_rate": None, "fulfillment_rate": None}
    c = RV.count_violations(rows, team_id)
    hv_map = RV.build_waybill_highvalue_map(delivery_orders)
    gaobi_cancel = RV.count_gaobi_cancel_liable(rows, team_id, hv_map)
    fr = RV.count_false_report_slow_unfinished(rows, team_id)
    return {
        "complaint": c["complaint"],
        "bad_review": c["bad_review"],
        "claim": c["claim"],
        "cancel_liable": c["cancel_liable"],
        "early_delivered": c["early_delivered"],
        "gaobi_cancel_liable": gaobi_cancel,
        "false_report_slow_unfinished": fr,
        "unsat_rate": RV.unsat_rate(c["complaint"], c["bad_review"], c["claim"], pushed),
        "fulfillment_rate": RV.fulfillment_rate(
            completed, c["cancel_liable"], c["early_delivered"]),
    }


def _violation_note(team_id, date):
    """违规明细不可用时的一句话说明：区分「从未拉取」与「本次拉取失败」。"""
    raw = RV.load_team_raw(team_id, date)
    base = "投诉/差评/索赔/不满意率/物流妥投率等违规派生指标暂无数据"
    if raw is None:
        return "违规明细尚未拉取，" + base
    if raw.get("fetch_ok") is False:
        err = (raw.get("fetch_error") or "").strip()
        return "违规明细本次拉取失败，%s%s" % (base, ("（%s）" % err) if err else "")
    return "违规明细不可用，" + base


def latest_assessment_data_time(date=None):
    """考核看板数据最近一次取数/落盘时间（北京时间，YYYY-MM-DD HH:MM:SS）。

    取违规明细与运单明细两份全站单文件的最新落盘时间（max），作为前端「更新时间」来源，
    使页面刷新（仅读盘重算、未真正取数）不再跳动，只在真正重新取数、底层数据文件被覆盖写后才更新。
    """
    candidates = []
    for fn in ("违规处罚明细-实时.json", "运单明细-实时.json"):
        p = os.path.join(ROOT, "backend", "data", fn)
        if os.path.exists(p):
            try:
                mt = os.path.getmtime(p)
                candidates.append(datetime.datetime.fromtimestamp(mt, BJ).replace(microsecond=0))
            except Exception:
                pass
    if not candidates:
        return None
    return max(candidates).strftime("%Y-%m-%d %H:%M:%S")


def build_one(team_id, date=None):
    """单站实时概览。date 缺省取北京时间当天。

    原始运单缺失即返回 need_refresh=True（运单明细由考核看板「刷新」按钮拉取落盘到
    backend/data/运单明细-实时.json，并非标准达成「刷新数据」）。命中进程内结果缓存直接返回。
    """
    team_id = str(team_id)
    if date is None:
        date = CACHE.today_ymd()
    cached = CACHE.get_result(MODULE, team_id, date, "", "alldata_v3")
    if cached is not None:
        return cached
    orders = DS.load_delivery_orders(team_id)
    if orders is None:
        return {
            "team_id": team_id,
            "team_name": TEAM_NAMES.get(team_id, team_id),
            "need_refresh": True,
            "data_status": "no_data",
            "data_note": "今日运单明细尚未落盘，请点本看板「刷新」拉取运单明细",
            "pushed_order_volume": None,
            "delivery_completed": None,
            "weather_level": None,
            "adverse_ratio": None,
            "total_score": None,
            "t8_ontime_score": None,
            "fulfillment_score": None,
            "unsat_score": None,
            "compound_overtime_score": None,
            "t8_timeout": None,
            "gaobi_order": None,
            "compound_overtime_sec": 0,
            "avg_compound_overtime_sec": None,
            "false_report_slow_unfinished": None,
            "t8_ontime_rate": None,
            "complaint": None,
            "bad_review": None,
            "claim": None,
            "cancel_liable": None,
            "gaobi_cancel_liable": None,
            "early_delivered": None,
            "unsat_rate": None,
            "fulfillment_rate": None,
        }
    # 考核看板口径（2026-10-14 起）：用「取到的全部运单」，不再按骑手接单时间归属当天，
    # 即跨天接单（如昨晚接单、今日完成）的运单也计入当日看板，解决「130 vs 207」口径差。
    pushed = OR.count_pushed_orders(orders, date, date, all_dates=True)
    completed = count_delivery_completed(orders, date, all_dates=True)
    t8_timeout = count_t8_timeout(orders, date, all_dates=True)
    gaobi_order = count_gaobi_orders(orders, date, all_dates=True)
    comp = COMP.analyze_daily(orders, date)
    result = {
        "team_id": team_id,
        "team_name": TEAM_NAMES.get(team_id, team_id),
        "need_refresh": False,
        "data_status": "ok",
        "data_note": None,
        "pushed_order_volume": pushed,
        "delivery_completed": completed,
        "weather_level": weather_level(orders),
        "adverse_ratio": adverse_ratio(orders),
        "total_score": None,
        "t8_ontime_score": None,
        "fulfillment_score": None,
        "unsat_score": None,
        "compound_overtime_score": None,
        "t8_timeout": t8_timeout,
        "gaobi_order": gaobi_order,
        "compound_overtime_sec": comp["numerator_sec"],
        "avg_compound_overtime_sec": comp["avg_sec"],
        "t8_ontime_rate": ontime_rate(completed, t8_timeout),
    }
    result.update(violation_metrics(team_id, date, pushed, completed, orders))
    # 评分：按当天日型 × 天气取配置阈值，算各指标得分与总分（写回 result 对应 score 字段）。
    _compute_scores(result, orders, date)
    # 违规派生指标不可用时，行级状态不能继续报 ok —— 那等于声称一切正常，而实际上
    # 投诉/差评/索赔/不满意率/物流妥投率这一半指标全是空的。降级为 partial 并说明原因，
    # 由前端渲染提示；运单类指标（推配送/完成/T8）仍然有效，故不是 no_data。
    if result.get("complaint") is None:
        result["data_status"] = "partial"
        result["data_note"] = _violation_note(team_id, date)
    CACHE.put_result(MODULE, team_id, date, "", "alldata_v3", result)
    return result


if __name__ == "__main__":
    import json as _json
    import argparse as _ap
    _a = _ap.ArgumentParser()
    _a.add_argument("--team", required=True)
    _a.add_argument("--date", default=CACHE.today_ymd())
    _ns = _a.parse_args()
    print(_json.dumps(build_one(_ns.team, _ns.date), ensure_ascii=False, indent=2))
