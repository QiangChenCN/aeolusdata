#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""实时数据看板 —— 站点概览指标计算（与标准达成看板解耦）。

只算实时数据看板卡片需要的指标，直接从 dashboard 标准缓存的原始三源(orders)
本地重算，零 HTTP 请求；不依赖 rider_dimension / achievement 等标准达成聚合。

指标口径（运单类按「骑手接单时间」归属北京时间自然日）：
  · 推配送单量  = 当天接单的全部运单（其他均不剔除；见 order_rules.count_pushed_orders）
  · 配送完成单  = 推配送单中状态=配送成功(state 40) 的运单
                  （即 count_pushed_orders 基础上再筛 order_rules.is_completed）
  · T8超时单    = 配送完成单中「超出平台期望时间 > 8 分钟」的运单
                  （超时时长口径见 order_rules.over_expect_seconds / is_t8_timeout）
  · T8准时率    = (配送完成单 - T8超时单) / 配送完成单，百分比；分母为 0 时 None
  · 投诉/差评/索赔 = 违规处罚明细中「违规分类=投诉/差评/餐货损 且 违规状态=成立」的条数
  · 物流责取消单 = 违规处罚明细中「违规分类=取消 且 违规状态=成立」的条数
  · 提前点送达单 = 违规处罚明细中「违规类型包含 提前点送达 且 违规状态=成立」的条数
                  （数据源与口径见 analytics.realtime.violations）
  · 不满意率    = (投诉单*5 + 差评单*5 + 索赔单) / 推配送单，百分比；分母为 0 时 None
  · 物流妥投率  = 配送完成单 / (配送完成单 + 物流责取消单 + 提前点送达单*2)，百分比；分母为 0 时 None

依赖：
  · analytics.cache        原始数据层读写 + 进程内结果缓存
  · analytics.order_rules  接单时间归属 / 完成态判定（与有效单口径同源）
  · analytics.teams_config 站点名兜底
  · analytics.realtime.violations   违规处罚明细（投诉/差评/索赔）口径
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
from analytics.realtime import violations as RV

BJ = datetime.timezone(datetime.timedelta(hours=8))
MODULE = "realtime_board"


def _log(msg):
    ts = datetime.datetime.now(BJ).strftime("%H:%M:%S")
    print("[%s] [realtime-board] %s" % (ts, msg), flush=True)


def count_delivery_completed(orders, date):
    """配送完成单：按骑手接单时间归属当天 且 状态=配送成功(state 40)。"""
    cnt = 0
    for o in (orders or []):
        ms = OR.accept_ms(o)
        if ms is None:
            continue
        if OR.ms_to_ymd(ms) == date and OR.is_completed(o):
            cnt += 1
    return cnt


def count_t8_timeout(orders, date):
    """T8 超时单：按骑手接单时间归属当天 且 配送成功 且 超平台期望时间 > 8 分钟。

    是「配送完成单」的子集（两者都要求当天接单 + 配送成功），因此
    T8准时率 = (配送完成单 - T8超时单) / 配送完成单 必然落在 [0, 1]。
    """
    cnt = 0
    for o in (orders or []):
        ms = OR.accept_ms(o)
        if ms is None:
            continue
        if OR.ms_to_ymd(ms) == date and OR.is_t8_timeout(o):
            cnt += 1
    return cnt


def ontime_rate(completed, t8_timeout):
    """T8 准时率（%）：(配送完成单 - T8超时单) / 配送完成单。分母为 0 返回 None。"""
    if not completed:
        return None
    return round((completed - t8_timeout) * 1000.0 / completed) / 10


def violation_metrics(team_id, date, pushed, completed):
    """违规处罚明细派生指标：投诉/差评/索赔/物流责取消/提前点送达 + 不满意率/物流妥投率。

    违规明细不可用（load_team 返回 None）时全部为 None，前端显示「—」；
    已刷新但当天 0 条时各计数为 0，比率按 0 计算。

    不可用包含两种情况：「从未刷新」与「本次拉取失败」（见 violations.save_team 的
    fetch_ok）。后者必须视为不可用 —— 否则盘上遗留的上一次成功数据会被当成
    本次数据继续算，数字照常显示但实际已陈旧、且无任何报错。
    """
    rows = RV.load_team(team_id, date)
    if rows is None:
        return {"complaint": None, "bad_review": None, "claim": None,
                "cancel_liable": None, "early_delivered": None,
                "unsat_rate": None, "fulfillment_rate": None}
    c = RV.count_violations(rows, team_id)
    return {
        "complaint": c["complaint"],
        "bad_review": c["bad_review"],
        "claim": c["claim"],
        "cancel_liable": c["cancel_liable"],
        "early_delivered": c["early_delivered"],
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


def build_one(team_id, date=None):
    """单站实时概览。date 缺省取北京时间当天。

    原始 orders 缺失即返回 need_refresh=True（与标准达成一致的约定：
    先点「刷新数据」拉取当天三源落盘）。命中进程内结果缓存直接返回。
    """
    team_id = str(team_id)
    if date is None:
        date = CACHE.today_ymd()
    cached = CACHE.get_result(MODULE, team_id, date, "", "cache")
    if cached is not None:
        return cached
    orders = CACHE.load_raw("orders", team_id, date)
    if orders is None:
        return {
            "team_id": team_id,
            "team_name": TEAM_NAMES.get(team_id, team_id),
            "need_refresh": True,
            "data_status": "no_data",
            "data_note": "今日运单明细尚未落盘，请先在「标准达成」点「刷新数据」拉取",
            "pushed_order_volume": None,
            "delivery_completed": None,
            "t8_timeout": None,
            "t8_ontime_rate": None,
            "complaint": None,
            "bad_review": None,
            "claim": None,
            "cancel_liable": None,
            "early_delivered": None,
            "unsat_rate": None,
            "fulfillment_rate": None,
        }
    pushed = OR.count_pushed_orders(orders, date, date)
    completed = count_delivery_completed(orders, date)
    t8_timeout = count_t8_timeout(orders, date)
    result = {
        "team_id": team_id,
        "team_name": TEAM_NAMES.get(team_id, team_id),
        "need_refresh": False,
        "data_status": "ok",
        "data_note": None,
        "pushed_order_volume": pushed,
        "delivery_completed": completed,
        "t8_timeout": t8_timeout,
        "t8_ontime_rate": ontime_rate(completed, t8_timeout),
    }
    result.update(violation_metrics(team_id, date, pushed, completed))
    # 违规派生指标不可用时，行级状态不能继续报 ok —— 那等于声称一切正常，而实际上
    # 投诉/差评/索赔/不满意率/物流妥投率这一半指标全是空的。降级为 partial 并说明原因，
    # 由前端渲染提示；运单类指标（推配送/完成/T8）仍然有效，故不是 no_data。
    if result.get("complaint") is None:
        result["data_status"] = "partial"
        result["data_note"] = _violation_note(team_id, date)
    CACHE.put_result(MODULE, team_id, date, "", "cache", result)
    return result


if __name__ == "__main__":
    import json as _json
    import argparse as _ap
    _a = _ap.ArgumentParser()
    _a.add_argument("--team", required=True)
    _a.add_argument("--date", default=CACHE.today_ymd())
    _ns = _a.parse_args()
    print(_json.dumps(build_one(_ns.team, _ns.date), ensure_ascii=False, indent=2))
