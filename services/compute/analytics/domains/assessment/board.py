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
                  （独立计算，口径见 analytics.domains.assessment.compound；与「配送超时看板」同公式但本看板自算、不公用其代码）
  · T8准时率    = (配送完成单 - T8超时单 - 虚假报备出餐慢未完成单 - 提前点送达*2)
                  / (配送完成单 + 高比单超时单)，百分比；违规派生项不可用时为 None
  · 投诉/差评/索赔 = 违规处罚明细中「违规分类=投诉/差评/餐货损 且 违规状态=成立」的条数
  · 物流责取消单 = 违规处罚明细中「违规分类=取消 且 违规状态=成立」的条数
  · 提前点送达单 = 违规处罚明细中「违规类型包含 提前点送达 且 违规状态=成立」的条数
                  （数据源与口径见 analytics.domains.assessment.violations）
  · 不满意率    = (投诉单*5 + 差评单*5 + 索赔单) / 推配送单，百分比；分母为 0 时 None
  · 物流妥投率  = 配送完成单 / (配送完成单 + 物流责取消单 + 提前点送达单*2)，百分比；分母为 0 时 None

依赖：
  · analytics.core.cache        原始数据层读写 + 进程内结果缓存
  · analytics.core.order_rules  接单时间归属 / 完成态判定（与有效单口径同源）
  · analytics.core.teams_config 站点名兜底
  · analytics.domains.assessment.violations   违规处罚明细（投诉/差评/索赔）口径
"""
import json
import os

from analytics.core.paths import ROOT, PY_HOME, _ROOT  # noqa: E402,F401 <<<


import sys
import datetime
from analytics.core import cache as CACHE
from analytics.core import order_rules as OR
from analytics.core.teams_config import TEAM_NAMES
from analytics.domains.assessment import violations as RV
from analytics.domains.assessment import delivery_source as DS
from analytics.domains.assessment import compound as COMP
from analytics.domains.assessment import service_quality as SQ
from analytics.core import im_source as ICS
from analytics.domains.assessment import visit_source as VS

EXTRA_METRICS = ("call_rate", "im_reply_rate", "visit_rate")


def _im_rates_for_range(team_id: str, start: str, end: str):
    """区间电联率 / IM 及时回复率：从 im_contact.db 按送达日期一次性读取并求和分子分母（线性可加）。

    口径与 period._im_rates 一致（中文列名、按站点过滤）；无数据返回 (None, None)。
    """
    if not ICS.pg_configured():
        return None, None
    rows = ICS.load_rows(start, end)
    if not rows:
        return None, None
    tid = ICS.to_text(team_id)
    call_v = call_t = im_v = im_t = 0.0
    for r in rows:
        if not isinstance(r, dict):
            continue
        if tid and ICS.to_text(r.get("站点id")) != tid:
            continue
        call_v += ICS.to_num(r.get("剔除后有效电联单量"))
        call_t += ICS.to_num(r.get("剔除后接单量"))
        im_v += ICS.to_num(r.get("IM及时回复单量"))
        im_t += ICS.to_num(r.get("IM咨询单量"))
    call_rate = round(call_v / call_t * 100, 2) if call_t > 0 else None
    im_reply_rate = round(im_v / im_t * 100, 2) if im_t > 0 else None
    return call_rate, im_reply_rate


def attach_extra_metrics(result, team_id, start, end, settings, date_type, weather, rates=None, realtime=False):
    """给看板结果补上三项无实时数据指标（电联率 / IM 及时回复率 / 新专送拜访）的
    **率值 + 得分(0-100) + 命中目标线(tiers)**，供前端表格列展示。

    · realtime=True（当天实时）：三项按满分(+15)假设计入总分——率值不单独取数（记 None，
      前端显示「-」），得分记满分 100；
    · realtime=False（历史区间）：rates 缺省时自行从 im_contact.db / visit 历史库按 [start,end]
      读取，算真实率值 + 按目标线算真实得分；值或 tiers 缺失 → None（前端「—」）；
    · 只在 result 上**新增展示字段**，不改 total_score。
    """
    try:
        if realtime:
            for metric in EXTRA_METRICS:
                result[metric] = None
                result[metric + "_score"] = 100
                result[metric + "_tiers"] = {}
            return result
        if rates is None:
            call_rate, im_reply_rate = _im_rates_for_range(team_id, start, end)
            visit_rate = VS.fetch_visit_rate_period(team_id, start, end)
            rates = {"call_rate": call_rate, "im_reply_rate": im_reply_rate, "visit_rate": visit_rate}
        for metric in EXTRA_METRICS:
            val = rates.get(metric)
            result[metric] = val
            tiers = SQ.metric_tiers(settings, metric, date_type, weather)
            direction = SQ.metric_direction(metric)
            sc = SQ.score_metric(val, tiers, direction) if (val is not None and tiers) else None
            result[metric + "_score"] = None if sc is None else round(sc, 2)
            result[metric + "_tiers"] = tiers if isinstance(tiers, dict) else {}
    except Exception as e:  # 三项为附加展示，绝不因它拖垮主看板
        result.setdefault("call_rate", None)
        result.setdefault("im_reply_rate", None)
        result.setdefault("visit_rate", None)
        for m in EXTRA_METRICS:
            result.setdefault(m + "_score", None)
            result.setdefault(m + "_tiers", {})
    return result

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

    是「配送完成单」的子集（两者都要求配送成功）；新口径 T8准时率还额外扣减
    虚假报备出餐慢未完成单与提前点送达*2，分母加高比单超时单（见 ontime_rate）。

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


def ontime_rate(completed, t8_timeout, false_report_slow_unfinished, early_delivered, gaobi_timeout):
    """T8 准时率（%）：
        (配送完成单 - T8超时单 - 虚假报备出餐慢未完成单 - 提前点送达*2)
        / (配送完成单 + 高比单超时单)
    任一输入为 None（违规明细不可用，无法精确计算）→ 返回 None；分母 ≤ 0 → 返回 None。
    """
    if completed is None or t8_timeout is None \
       or false_report_slow_unfinished is None or early_delivered is None or gaobi_timeout is None:
        return None
    num = completed - t8_timeout - false_report_slow_unfinished - 2 * early_delivered
    den = completed + gaobi_timeout
    if den <= 0:
        return None
    return num * 100.0 / den


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
# 取值字段 weatherGradeName（天气等级 中文别名同源）；数值档位或文本标签均可识别。
WEATHER_LEVEL_KEYS = ("weatherGradeName", "天气等级", "weatherLevel")


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


def _weather_cmp(v, cmp_, threshold):
    """占比 v（小数）与阈值 comparator 比较：cmp_ ∈ lte/lt/gte/gt。"""
    if cmp_ == "lte":
        return v <= threshold
    if cmp_ == "lt":
        return v < threshold
    if cmp_ == "gte":
        return v >= threshold
    if cmp_ == "gt":
        return v > threshold
    return False


def weather_level(orders, date=None):
    """考核单位当天天气分层（按「考核设置 → 天气分层设置」的判定链判定）：

    判定链按严重度升序（service_quality.weather_tiers(month)），每层为
    {name, logic, conditions:[{tags, names, grades, cmp, value}]}：tags 为勾选的天气标签
    （「天气标签设置」里的 1级/2级…），names 为其对应的天气等级，占比 = 命中运单数 / 全部运单；
    logic 为 and（满足全部条件，默认）/ or（满足任一条件）；
    判定按列表顺序逐层进行，首个命中即止；全部未命中归入最后一层（兜底）。
    该月**未配置**时返回 None（看板天气等级显示为空，评分按不区分天气处理），不回落业务默认。
    date 用于确定取哪个月份的配置（缺省当前北京时间月）。
    占比分母为当天全部运单（与「取到的全部运单」口径同源）；分母为 0 时返回首层。
    """
    tiers = SQ.weather_tiers(SQ.month_of(date))
    if not tiers:
        return None
    rows = []
    for o in (orders or []):
        raw = OR.order_val(o, WEATHER_LEVEL_KEYS)
        rows.append((_weather_grade(o), str(raw).strip() if raw is not None else ""))
    total = len(rows)
    if total == 0:
        return tiers[0]["name"]

    def _ratio(cond):
        """占比 = 命中该条件的运单数 / 全部运单。

        命中口径：运单 weatherGradeName 命中勾选的天气标签 / 标签对应的天气等级，
        或（兼容旧口径）命中勾选的等级序号。
        """
        names = set(cond.get("names") or []) | set(cond.get("tags") or [])
        sevs = set(cond.get("grades") or [])
        for nm in names:
            s = _weather_grade({"weatherGradeName": nm})
            if s:
                sevs.add(s)
        hit = 0
        for g, raw in rows:
            if (raw and raw in names) or (g in sevs):
                hit += 1
        return hit / total

    for t in tiers:
        conds = t.get("conditions") or []
        if not conds:
            continue
        hits = [_weather_cmp(_ratio(c), c["cmp"], c["value"] / 100.0) for c in conds]
        ok = any(hits) if t.get("logic") == "or" else all(hits)
        if ok:
            return t["name"]
    return tiers[-1]["name"]


# 服务质量配置的 weather 键，按天气分层严重度升序一一映射：
# 前 4 档 → normal/light/moderate/severe，第 5 档起 → wx4/wx5/…（与 service_quality.weather_cols 同规则）；
# 分层名未知/缺失回落 normal。
def weather_key(level_label, month=None):
    """把 weather_level() 的中文档位映射成配置 weather 键；未知/缺失回落 normal（不区分天气）。

    分层列表来自「考核设置 → 天气设置」该月配置；第 i 层 → 第 i 个天气键（序号一一对应，不钳制，
    键表见 SQ.weather_cols）；该月未配置（tiers 为空）或 label 为 None 时回落 normal。
    """
    keys = [c["key"] for c in SQ.weather_cols(month)]
    for i, t in enumerate(SQ.weather_tiers(month)):
        if t["name"] == str(level_label):
            return keys[i] if i < len(keys) else "normal"
    return "normal"


def _tiers_or_empty(cell):
    """目标格 → {t0,t60,t100}；非 dict 或任一端缺失 → {}（调用方按「未配置」处理）。"""
    if not isinstance(cell, dict):
        return {}
    t0, t60, t100 = cell.get("t0"), cell.get("t60"), cell.get("t100")
    if t0 is None or t60 is None or t100 is None:
        return {}
    return {"t0": t0, "t60": t60, "t100": t100}


def _compute_scores(result, orders, date):
    """按当天日型 × 天气取对应档位，用配置的 t0/t60/t100 算各指标 0~100 得分与总分。

    看板仅计算 4 项可取自订单/违规明细的指标（准时率/妥投率/不满意率/复合超时时长，权重合计 85），
    其余 3 项考核（电联率/IM回复率/新专送拜访，权重合计 15）看板不取数、按满分计入总分。
    故看板总分 = 4 项算得加权和(满分 85) + 15(其余项满分)，封顶 100。
    """
    month = SQ.month_of(date)
    settings = SQ.quality_settings(month)
    date_type = SQ.resolve_date_type(date, settings.get("date_overrides"))
    wx_label = weather_level(orders, date)
    wx = weather_key(wx_label, date)
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
    # 同时回出各指标**实际命中的三档目标线**（该日型 × 该天气档位下的 t0/t60/t100），
    # 供前端按「目标线」直接比较着色（≥t100 绿 / ≥t60 橙 / >t0 红 / ≤t0 深红），
    # 不经过得分公式——得分口径若调整，着色不受影响。阈值不齐 → {}（前端按未配置处理）。
    for out_key, metric in (
        ("t8_ontime_tiers", "ontime_rate"),
        ("fulfillment_tiers", "delivery_rate"),
        ("unsat_tiers", "unsat_rate"),
        ("compound_tiers", "compound_overtime"),
    ):
        result[out_key] = _tiers_or_empty(SQ.metric_tiers(settings, metric, date_type, wx))
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
    """考核看板数据最近一次入库时间（北京时间，YYYY-MM-DD HH:MM:SS）。

    取运单明细（delivery_realtime）与违规明细（violation_realtime）两路的最近入库时间
    （max），作为前端「更新时间」来源：页面刷新（仅读表重算、未真正取数）不再跳动，
    只在真正重新取数、表被覆盖写后才更新。

    取数失败不再写表（保留上一版数据），因此不存在「失败却刷新时间」的误导。
    """
    st = DS.detail_status(date)
    if not st:
        return None
    candidates = [
        str(v)
        for v in (st.get("delivery_fetched_at"), st.get("violation_fetched_at"))
        if v
    ]
    if not candidates:
        return None
    return max(candidates)


def build_one(team_id, date=None):
    """单站实时概览。date 缺省取北京时间当天。

    原始运单缺失即返回 need_refresh=True（运单明细由考核看板「刷新」按钮拉取落盘到
    apps/api/runtime/运单明细-实时.json，并非标准达成「刷新数据」）。命中进程内结果缓存直接返回。
    """
    team_id = str(team_id)
    if date is None:
        date = CACHE.today_ymd()
    cached = CACHE.get_result(MODULE, team_id, date, "", "alldata_v3")
    if cached is not None:
        return cached
    orders = DS.load_delivery_orders(team_id)
    if orders is None:
        # 区分「从未拉取」与「本次拉取失败」：后者必须明说，否则用户看到空看板无从判断
        st = DS.fetch_status()
        if st is not None and st.get("fetch_ok") is False:
            err = (st.get("fetch_error") or "").strip()
            note = "运单明细本次拉取失败，订单类指标暂不展示%s，请点本看板「刷新」重试" % (
                ("（%s）" % err) if err else "")
        else:
            note = "今日运单明细尚未落盘，请点本看板「刷新」拉取运单明细"
        return {
            "team_id": team_id,
            "team_name": TEAM_NAMES.get(team_id, team_id),
            "need_refresh": True,
            "data_status": "no_data",
            "data_note": note,
            "pushed_order_volume": None,
            "delivery_completed": None,
            "weather_level": None,
            "weather_key": None,
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
    _wx_label = weather_level(orders, date)
    result = {
        "team_id": team_id,
        "team_name": TEAM_NAMES.get(team_id, team_id),
        "need_refresh": False,
        "data_status": "ok",
        "data_note": None,
        "pushed_order_volume": pushed,
        "delivery_completed": completed,
        "weather_level": _wx_label,
        # 等级 → 服务质量配置 weather 键（按等级序号映射），供前端直接取分层目标，免再维护标签映射
        "weather_key": weather_key(_wx_label, date),
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
    }
    result.update(violation_metrics(team_id, date, pushed, completed, orders))
    # t8_ontime_rate 依赖违规派生项（虚假报备出餐慢未完成单 / 提前点送达），
    # 须等 violation_metrics 合并后再算；违规明细不可用时这些项为 None → 率值为 None。
    result["t8_ontime_rate"] = ontime_rate(
        completed, t8_timeout,
        result.get("false_report_slow_unfinished"),
        result.get("early_delivered"),
        gaobi_order,
    )
    # 评分：按当天日型 × 天气取配置阈值，算各指标得分与总分（写回 result 对应 score 字段）。
    _compute_scores(result, orders, date)
    # 三项无实时数据指标（电联率/IM及时回复率/新专送拜访）：当天实时按满分(+15)假设计入总分，
    # 率值显示「-」、得分记 100（展示用，不改 total_score）。
    attach_extra_metrics(result, team_id, date, date, None, None, None, realtime=True)
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
