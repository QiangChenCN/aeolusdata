"""考核看板 —— 历史区间聚合（build_period）。

把「实时 / 历史」统一为区间化计算入口：
  · build_range(team, start, end)
      - 区间退化为单日且为今天  → 走 build_one（实时，+15 假设）
      - 其余                     → 走 build_period（历史，三项真实值）

build_period 的核心口径（遵循 assessment_overview.py 的「拼计数再算率」原则，**禁止对日率取平均**）：
  1. 遍历区间内每一天，按 (date_type, weather) 归入单元格；
  2. 同格多日订单 / 违规**池化**后重算各率（all_dates=True），再 compute_team_scores 得该格得分；
  3. 跨格按「单量占比」加权得总分与各率。

三项无实时数据指标：
  · 电联率 / IM 回复率：从 im_contact.db 按送达日期累积（区间求和分子分母，线性可加）。
  · 商家拜访率：从 assessment_history.db 的 visit_history 读区间真实值（缺失则降级 +15）。

历史原始明细来自 assessment_history.db（Nest 取数落盘），今天且历史缺失时回退到实时 JSON 层。
"""
from __future__ import annotations

import json
from datetime import date as _date, timedelta
from common.pg import connect

from analytics.core import order_rules as OR
from analytics.core import teams_config as TC
from analytics.domains.assessment import service_quality as SQ
from analytics.domains.assessment import violations as RV
from analytics.domains.assessment import delivery_source as DS
from analytics.domains.assessment import compound as COMP
from analytics.domains.assessment import board as RTB
from analytics.core import im_source as ICS
from analytics.domains.assessment import visit_source as VS

EXTRA_METRICS = ("call_rate", "im_reply_rate", "visit_rate")
DEFAULT_EXTRA_WEIGHT = 5  # 三项各 5 分，合计 15，与实时 +15 假设对齐


# ----------------------------------------------------------------------------
# 历史库读取（Nest 写 / Python 读，PostgreSQL only，不再保留 SQLite）
# ----------------------------------------------------------------------------
def _read_history_rows(table: str, team_id: str, date: str):
    """读某队某日的历史明细（payload 已解析为 dict 列表）。未配置/无记录返回 None。

    表名来自固定白名单（delivery），非用户输入，可安全内插。
    """
    con = connect()
    if con is None:
        return None
    try:
        with con.cursor() as cur:
            cur.execute(
                f"SELECT payload FROM {table} WHERE team_id = %s AND date = %s",
                (team_id, date),
            )
            rows = [json.loads(r[0]) for r in cur.fetchall()]
        return rows
    except Exception:
        return None
    finally:
        con.close()


def _read_violation_history_rows(team_id: str, date: str):
    """读某队某日的历史违规明细（表 `violation`）；无/不可用返回 None。

    与 `_read_history_rows` 的差异：历史违规表列名是 `stat_date` + `raw_json`
    （历史运单表是 `date` + `payload`），且没有 team_id 列 —— 明细行自带「团队ID」，
    按站点过滤在此解析行内容完成（与实时明细同口径）。
    """
    con = connect()
    if con is None:
        return None
    try:
        with con.cursor() as cur:
            cur.execute("SELECT raw_json FROM violation WHERE stat_date = %s", (date,))
            rows = [json.loads(r[0]) for r in cur.fetchall()]
    except Exception:
        return None
    finally:
        con.close()
    return [r for r in rows if RV._pick(r, RV.TEAM_ID_KEYS) == str(team_id)]


def _date_iter(start: str, end: str):
    s = _date.fromisoformat(start)
    e = _date.fromisoformat(end)
    cur = s
    while cur <= e:
        yield cur.isoformat()
        cur += timedelta(days=1)


# ----------------------------------------------------------------------------
# 单格（date_type × weather）计算
# ----------------------------------------------------------------------------
def _cell_scores(pooled_orders, pooled_violations, team_id, date_type, settings, extra_values):
    """返回该格的：4 项率值、4 项得分、三项贡献、单量、复合超时，以及计数。

    天气档位由池化订单分布算出（中文标签 → config key），与 build_one 口径一致。
    """
    pushed = OR.count_pushed_orders(pooled_orders, None, None, all_dates=True)
    completed = RTB.count_delivery_completed(pooled_orders, None, all_dates=True)
    t8 = RTB.count_t8_timeout(pooled_orders, None, all_dates=True)
    gaobi = RTB.count_gaobi_orders(pooled_orders, None, all_dates=True)
    comp = COMP.analyze_daily(pooled_orders, None)
    hv_map = RV.build_waybill_highvalue_map(pooled_orders)
    violations = RV.count_violations(pooled_violations, team_id)
    complaint = violations["complaint"]
    bad_review = violations["bad_review"]
    claim = violations["claim"]
    cancel_liable = violations["cancel_liable"]
    early_delivered = violations["early_delivered"]
    gaobi_cancel_liable = RV.count_gaobi_cancel_liable(pooled_violations, team_id, hv_map)
    false_report_slow_unfinished = RV.count_false_report_slow_unfinished(
        pooled_violations, team_id
    )

    ontime = RTB.ontime_rate(completed, t8, false_report_slow_unfinished, early_delivered, gaobi)
    # 「物流妥投率」口径与 build_one 一致：RV.fulfillment_rate（违规派生），非 completed/pushed。
    delivery = RV.fulfillment_rate(completed, cancel_liable, early_delivered)
    unsat = RV.unsat_rate(complaint, bad_review, claim, pushed)
    compound_overtime = comp.get("avg_sec")

    weather_label = (
        RTB.weather_level(pooled_orders, settings.get("month"))
        if pooled_orders else None
    )
    wx = RTB.weather_key(weather_label, settings.get("month"))

    raw = {
        "ontime_rate": ontime,
        "delivery_rate": delivery,
        "unsat_rate": unsat,
        "compound_overtime": compound_overtime,
    }
    scores = SQ.compute_team_scores(raw, settings, date_type, wx) or {}
    # 三项无实时数据指标：有真实值按格打分，缺失按满分（默认权重）假设
    extra = sum(
        _extra_contribution(settings, m, extra_values.get(m), date_type, wx)
        for m in EXTRA_METRICS
    )
    return {
        "pushed": pushed,
        "completed": completed,
        "t8": t8,
        "gaobi": gaobi,
        "complaint": complaint,
        "bad_review": bad_review,
        "claim": claim,
        "cancel_liable": cancel_liable,
        "early_delivered": early_delivered,
        "gaobi_cancel_liable": gaobi_cancel_liable,
        "false_report_slow_unfinished": false_report_slow_unfinished,
        "ontime_rate": ontime,
        "fulfillment_rate": delivery,
        "unsat_rate": unsat,
        "compound_overtime": compound_overtime,
        "t8_ontime_score": scores.get("ontime_rate"),
        "fulfillment_score": scores.get("delivery_rate"),
        "unsat_score": scores.get("unsat_rate"),
        "compound_overtime_score": scores.get("compound_overtime"),
        "total_score": scores.get("total_score"),
        "tiers": _cell_tiers(settings, date_type, wx),
        "tier_scores": {
            m: {t["key"]: t["score"] for t in lst}
            for m, lst in (settings.get("tiers") or {}).items() if lst
        },
        "date_type": date_type,
        "weather_label": weather_label,
        "weather": wx,
        "extra_score": extra,
    }


def _extra_contribution(settings, metric, value, date_type, weather):
    """三项指标的单元格得分贡献；value 为 None（缺失真实值）→ 按满分（默认权重）假设。"""
    weights = settings.get("weights") or {}
    w = weights.get(metric)
    w = w if isinstance(w, (int, float)) else DEFAULT_EXTRA_WEIGHT
    if value is None:
        return float(w)  # 实时 +15 假设的等价：该项记满分
    tiers = SQ.metric_tiers(settings, metric, date_type, weather)
    direction = SQ.metric_direction(metric)
    tier_map = settings.get("tiers") if isinstance(settings.get("tiers"), dict) else {}
    sc = SQ.score_metric(value, tiers, direction, scores=tier_map.get(metric)) if tiers else None
    if sc is None:
        return float(w)
    return float(sc) * (float(w) / 100.0)


def _cell_tiers(settings, date_type, weather):
    """构造与 build_one 同源的逐指标目标线（frontend 表格列着色用）。"""
    out = {}
    for metric, out_key in (
        ("ontime_rate", "t8_ontime_tiers"),
        ("delivery_rate", "fulfillment_tiers"),
        ("unsat_rate", "unsat_tiers"),
        ("compound_overtime", "compound_tiers"),
    ):
        t = SQ.metric_tiers(settings, metric, date_type, weather)
        out[out_key] = t if isinstance(t, dict) else {}
    return out


# ----------------------------------------------------------------------------
# 区间聚合
# ----------------------------------------------------------------------------
def build_period(team_id: str, start: str, end: str) -> dict:
    today = RTB.CACHE.today_ymd()
    # 历史区间**不含今天**：今日数据仍在实时累积、尚未完结，若并入会把未定态的今日
    # 混入历史加权，造成口径漂移。含今天的区间一律把 end 裁剪到昨天；今天请看实时模式。
    yesterday = (_date.fromisoformat(today) - timedelta(days=1)).isoformat()
    clamped_end = min(end, yesterday)
    settings = SQ.quality_settings(SQ.month_of(clamped_end))
    if start > clamped_end:
        r = _empty_period(
            team_id, start, end, settings,
            {"call_rate": None, "im_reply_rate": None, "visit_rate": None},
        )
        r["data_note"] = "所选区间不含历史日期（今天为实时数据、不参与历史聚合；查看今天请用实时模式）"
        return r
    end = clamped_end

    # 三项真实值（电联/IM 按区间从 im_contact.db 聚合；拜访从历史库读）
    call_rate, im_reply_rate = _im_rates(team_id, start, end)
    visit_rate = VS.fetch_visit_rate_period(team_id, start, end)
    extra_values = {
        "call_rate": call_rate,
        "im_reply_rate": im_reply_rate,
        "visit_rate": visit_rate,
    }

    # 按单元格池化
    cells: dict[tuple, dict] = {}
    for d in _date_iter(start, end):
        delivery_rows = _read_history_rows("delivery", team_id, d)
        if delivery_rows is None:
            delivery_rows = DS.load_delivery_orders(team_id) if d == today else []
        # 历史违规处罚明细：PG 表 `violation`（由考核违规取数按天写入）。
        violation_rows = _read_violation_history_rows(team_id, d)
        if violation_rows is None:
            violation_rows = RV.load_team(team_id, d) if d == today else []
        if violation_rows is None:
            violation_rows = []

        if not delivery_rows and not violation_rows:
            continue

        date_type = SQ.resolve_date_type(d, settings.get("date_overrides"))
        wx_label = RTB.weather_level(delivery_rows, d) if delivery_rows else None
        key = (date_type, wx_label)
        bucket = cells.setdefault(
            key, {"orders": [], "violations": []}
        )
        bucket["orders"].extend(delivery_rows)
        bucket["violations"].extend(violation_rows)

    if not cells:
        return _empty_period(team_id, start, end, settings, extra_values)

    agg = {
        "pushed": 0, "completed": 0, "t8": 0, "gaobi": 0,
        "complaint": 0, "bad_review": 0, "claim": 0,
        "cancel_liable": 0, "early_delivered": 0,
        "gaobi_cancel_liable": 0, "false_report_slow_unfinished": 0,
        "ontime_rate": 0.0, "fulfillment_rate": 0.0, "unsat_rate": 0.0,
        "compound_overtime": 0.0,
        "t8_ontime_score": 0.0, "fulfillment_score": 0.0,
        "unsat_score": 0.0, "compound_overtime_score": 0.0,
        "total_score": 0.0,
        "sum_volume": 0,
    }
    dominant = None
    dominant_volume = -1
    # 计数类字段跨单元格「求和」（线性可加）；率值/得分类「单量加权」（≈池化后重算）。
    COUNTS = (
        "pushed", "completed", "t8", "gaobi", "complaint", "bad_review", "claim",
        "cancel_liable", "early_delivered", "gaobi_cancel_liable",
        "false_report_slow_unfinished",
    )
    RATES = (
        "ontime_rate", "fulfillment_rate", "unsat_rate", "compound_overtime",
        "t8_ontime_score", "fulfillment_score", "unsat_score",
        "compound_overtime_score", "total_score",
    )
    for key, bucket in cells.items():
        date_type, _wx_label = key
        c = _cell_scores(
            bucket["orders"], bucket["violations"], team_id, date_type, settings, extra_values
        )
        vol = c["pushed"] or 0
        if vol <= 0:
            continue
        cell_total = (c["total_score"] or 0) + c["extra_score"]
        cell_total = min(100.0, cell_total)
        c["total_score"] = cell_total

        for k in COUNTS:
            agg[k] += (c[k] or 0)
        for k in RATES:
            agg[k] += (c[k] or 0) * vol
        agg["sum_volume"] += vol
        if vol > dominant_volume:
            dominant_volume = vol
            dominant = c

    vol_total = agg.pop("sum_volume")
    if vol_total > 0:
        for k in RATES:
            agg[k] = round(agg[k] / vol_total, 2)
        # 计数保持跨日/跨格求和，不除体积

    weather_level = dominant["weather_label"] if dominant else None
    adverse = (agg["gaobi_cancel_liable"] + agg["false_report_slow_unfinished"])
    adverse_ratio = round(adverse / agg["pushed"] * 100, 2) if agg["pushed"] else 0.0
    fulfillment_rate = (
        RV.fulfillment_rate(agg["completed"], agg["cancel_liable"], agg["early_delivered"])
    )
    tiers = (dominant or {}).get("tiers") or {}

    result = {
        "team_id": team_id,
        "team_name": TC.TEAM_NAMES.get(team_id, team_id),
        "pushed_order_volume": agg["pushed"],
        "delivery_completed": agg["completed"],
        "t8": agg["t8"],
        "gaobi": agg["gaobi"],
        "weather_level": weather_level,
        "adverse_ratio": adverse_ratio,
        "complaint": agg["complaint"],
        "bad_review": agg["bad_review"],
        "claim": agg["claim"],
        "cancel_liable": agg["cancel_liable"],
        "early_delivered": agg["early_delivered"],
        "gaobi_cancel_liable": agg["gaobi_cancel_liable"],
        "false_report_slow_unfinished": agg["false_report_slow_unfinished"],
        "t8_ontime_rate": agg["ontime_rate"],
        "unsat_rate": agg["unsat_rate"],
        "fulfillment_rate": fulfillment_rate,
        "avg_compound_overtime_sec": agg["compound_overtime"],
        "t8_ontime_score": agg["t8_ontime_score"],
        "fulfillment_score": agg["fulfillment_score"],
        "unsat_score": agg["unsat_score"],
        "compound_overtime_score": agg["compound_overtime_score"],
        "total_score": agg["total_score"],
        "t8_ontime_tiers": tiers.get("t8_ontime_tiers", {}),
        "fulfillment_tiers": tiers.get("fulfillment_tiers", {}),
        "unsat_tiers": tiers.get("unsat_tiers", {}),
        "compound_tiers": tiers.get("compound_tiers", {}),
        "tiers": tiers,
        "score_settings": settings,
        "need_refresh": False,
        "data_status": "ok",
        "data_note": f"历史区间 {start}~{end} 加权汇总（单量占比加权）",
        "data_refreshed_at": None,
        "teams": [team_id],
        "meta": {"mode": "period", "start": start, "end": end},
    }
    # 三项无实时数据指标：补率值 + 得分 + tiers（展示用；复用已算的 extra_values，不重复查库）。
    _dt = dominant["date_type"] if dominant else SQ.resolve_date_type(end, settings.get("date_overrides"))
    _wx = dominant["weather"] if dominant else RTB.weather_key(None)
    RTB.attach_extra_metrics(result, team_id, start, end, settings, _dt, _wx, rates=extra_values)
    return result


def _empty_period(team_id, start, end, settings, extra_values):
    result = {
        "team_id": team_id,
        "team_name": TC.TEAM_NAMES.get(team_id, team_id),
        "pushed_order_volume": 0,
        "delivery_completed": 0,
        "t8": 0, "gaobi": 0, "weather_level": None, "adverse_ratio": 0.0,
        "complaint": 0, "bad_review": 0, "claim": 0, "cancel_liable": 0,
        "early_delivered": 0, "gaobi_cancel_liable": 0,
        "false_report_slow_unfinished": 0,
        "t8_ontime_rate": 0.0, "unsat_rate": 0.0,
        "fulfillment_rate": 0.0, "avg_compound_overtime_sec": 0.0,
        "t8_ontime_score": 0.0, "fulfillment_score": 0.0, "unsat_score": 0.0,
        "compound_overtime_score": 0.0, "total_score": 0.0,
        "t8_ontime_tiers": {}, "fulfillment_tiers": {}, "unsat_tiers": {},
        "compound_tiers": {}, "tiers": {},
        "score_settings": settings,
        "call_rate": extra_values.get("call_rate"),
        "im_reply_rate": extra_values.get("im_reply_rate"),
        "visit_rate": extra_values.get("visit_rate"),
        "need_refresh": False,
        "data_status": "empty",
        "data_note": f"历史区间 {start}~{end} 无明细数据（尚未落库）",
        "data_refreshed_at": None,
        "teams": [team_id],
        "meta": {"mode": "period", "start": start, "end": end},
    }
    # 三项无实时数据指标：即便运单明细未落库，也按已有率值补得分+tiers（展示用）。
    _dt = SQ.resolve_date_type(end, settings.get("date_overrides"))
    RTB.attach_extra_metrics(result, team_id, start, end, settings, _dt, RTB.weather_key(None), rates=extra_values)
    return result


def _im_rates(team_id: str, start: str, end: str):
    """区间电联率 / IM 回复率：从 im_contact.db 按区间一次性读取并求和分子分母（线性可加）。"""
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


def build_range(team_id: str, start: str, end: str) -> dict:
    """区间化入口：单日且为今天 → 实时 build_one；其余 → 历史 build_period。"""
    today = RTB.CACHE.today_ymd()
    if start == end and start == today:
        return RTB.build_one(team_id, today)
    return build_period(team_id, start, end)
