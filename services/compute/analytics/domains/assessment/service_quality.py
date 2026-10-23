#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""服务质量考核设置（读取层）——实时看板计算得分的**唯一**目标来源。

配置由 Nest `ConfigService` 写入（页面：考核设置 → 服务质量设置），落盘：
    apps/api/runtime/.service_quality_targets.json
    {
      "version": 1, "updated_at": "...", "updated_by": "...",
      "months": {
        "<YYYY-MM>": {
          "weights": { "<metric>": number|null },          # 权重项：百分比 0~100
          "ranges":  { "<metric>": {"min":num,"max":num} }, # 调分项：得分区间（可负）
          "kinds":   { "<metric>": "weight"|"adjust"|null },# 计分方式：权重项 / 调分项
          "layering":{ "<metric>": "none"|"date"|"weather"|"date_weather" },  # 按考核项
          "date_overrides": { "<YYYY-MM-DD>": "weekday"|"weekend" },  # 特殊日期：强制按周中/周末算
          "<metric>": { "<date_type>": { "<weather>": { "t0","t60","t100" } } }
        }
      }
    }

本模块只读不写（写入一律走 Nest，避免双份实现），对外：
  quality_settings(month)   → {configured, month, weights, ranges, kinds, layering, targets}
  target_rows(month)        → 扁平行 [{metric, date_type, weather, direction, unit,
                                     t0, t60, t100, weight, kind}]，打分侧直接遍历
  metric_direction(metric)  → 'pos' | 'neg'
  month_of(date_str)        → 'YYYY-MM'（从 YYYY-MM-DD 截取；非法入参回落当前北京时间月）

未保存过的月份 configured=False，且所有阈值/权重为 None —— 调用方须显式处理「未配置」，
本模块**不回落任何默认目标值**（与页面「没保存就提示」的口径一致）。

天气维度说明：数据侧目前**不采集天气**，调用方拿不到真实天气时通常按 'normal' 取值；
保留 4 档是为了配置与业务口径对齐，不代表已有天气数据源。
"""

from analytics.core.paths import ROOT, PY_HOME, _ROOT, dirs# noqa: E402,F401 <<<


import os
import re
import json
import datetime as _dt

# 与 Nest config.service.ts 同口径：后端本地状态统一落 apps/api/runtime/（带点前缀）
SERVICE_QUALITY_FILE = dirs.runtime(".service_quality_targets.json")

# 考核项 / 日期类型 / 天气：与 Nest ConfigService 的 RT_METRICS / RT_DATE_TYPES / RT_WEATHER 逐字对应。
# 单一来源仍是 Nest（写入方）；此处仅为计算侧的只读目录，避免打分逻辑硬编码指标名。
SQ_METRICS = [
    {"key": "delivery_rate",     "name": "物流妥投率",   "direction": "pos", "unit": "%"},
    {"key": "ontime_rate",       "name": "考核准时率",   "direction": "pos", "unit": "%"},
    {"key": "unsat_rate",        "name": "不满意率",     "direction": "neg", "unit": "%"},
    {"key": "compound_overtime", "name": "复合超时时长", "direction": "neg", "unit": "s"},
    {"key": "call_rate",         "name": "电联率",       "direction": "pos", "unit": "%"},
    {"key": "im_reply_rate",     "name": "IM及时回复率", "direction": "pos", "unit": "%"},
    {"key": "visit_rate",        "name": "新专送拜访",   "direction": "pos", "unit": "%"},
]
SQ_DATE_TYPES = [{"key": "weekday", "name": "周中"}, {"key": "weekend", "name": "周末"}]
SQ_WEATHER = [
    {"key": "normal",   "name": "正常天"},
    {"key": "light",    "name": "轻微恶天"},
    {"key": "moderate", "name": "一般恶天"},
    {"key": "severe",   "name": "严重恶天"},
]
SQ_METRIC_DIR = {m["key"]: m["direction"] for m in SQ_METRICS}
SQ_METRIC_UNIT = {m["key"]: m["unit"] for m in SQ_METRICS}

# 考核项是否分层：三档阈值在「日期类型 / 天气」两维上的区分粒度。
#   none 不分层 / date 日期分层 / weather 天气分层 / date_weather 日期天气分层（默认）
SQ_LAYERING = [
    {"key": "none", "name": "不分层"},
    {"key": "date", "name": "日期分层"},
    {"key": "weather", "name": "天气分层"},
    {"key": "date_weather", "name": "日期天气分层"},
]
_LAYERING_KEYS = set(x["key"] for x in SQ_LAYERING)
DEFAULT_LAYERING = "date_weather"

_TIERS = ("t0", "t60", "t100")

# 特殊日期覆盖表的日期键格式（YYYY-MM-DD）。
_RE_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def current_month():
    """当前北京时间月份 YYYY-MM。"""
    return _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=8))).strftime("%Y-%m")


def month_of(date_str=None):
    """从 'YYYY-MM-DD' 取 'YYYY-MM'；空/非法回落当前月。"""
    s = str(date_str or "").strip()
    if len(s) >= 7 and s[4] == "-" and s[:4].isdigit() and s[5:7].isdigit():
        return s[:7]
    return current_month()


def metric_direction(metric):
    """'pos'（越高越好）/ 'neg'（越低越好）；未知指标返回 None。"""
    return SQ_METRIC_DIR.get(str(metric))


def resolve_date_type(date_str, overrides=None):
    """返回某日期的日型（'weekday' | 'weekend'）。

    先按日历判定（周六/周日 → weekend，其余 → weekday），再套用特殊日期覆盖表
    overrides（{ 'YYYY-MM-DD': 'weekday' | 'weekend' }，来自 quality_settings(month)['date_overrides']）。
    覆盖表用于把「原本周中按周末算 / 原本周末按周中算」的日期拉回对应日型。

    注意：评分侧真正按日型选阈值 为后续任务；此函数仅提供「按日期解析日型」的统一入口，
    避免打分层各自解析日历/覆盖表导致口径漂移。
    """
    s = str(date_str or "").strip()[:10]
    base = "weekday"
    try:
        d = _dt.date.fromisoformat(s)
        base = "weekend" if d.isoweekday() >= 6 else "weekday"
    except ValueError:
        pass
    if isinstance(overrides, dict):
        ov = overrides.get(s)
        if ov in ("weekday", "weekend"):
            return ov
    return base


def _num(v):
    """阈值/权重归一化：空 → None；非数字或负数 → None（不抛，避免脏配置打断看板）。"""
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (ValueError, TypeError):
        return None
    if f != f or f in (float("inf"), float("-inf")) or f < 0:  # NaN / inf / 负数
        return None
    return f


def _read_all():
    try:
        with open(SERVICE_QUALITY_FILE, encoding="utf-8") as f:
            d = json.load(f)
    except (FileNotFoundError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def score_metric(value, tiers, direction):
    """把考核项达成值按三档阈值映射为 0~100 得分（分段线性）。

    tiers = {"t0","t60","t100"}；任一为 None → 返回 None（阈值未配置，无法打分）。
    direction = 'pos'（越高越好，要求 t0<t60<t100）或 'neg'（越低越好，要求 t0>t60>t100）。
    锚点：t0→0 分、t60→60 分、t100→100 分；区间外夹取到 0/100，区间内线性插值。
    """
    if value is None or not isinstance(tiers, dict):
        return None
    t0, t60, t100 = tiers.get("t0"), tiers.get("t60"), tiers.get("t100")
    if t0 is None or t60 is None or t100 is None:
        return None
    try:
        if direction == "pos":
            if t60 == t0 or t100 == t60:
                return None  # 档位退化，无法插值
            if value <= t0:
                return 0.0
            if value >= t100:
                return 100.0
            if value <= t60:
                return 60.0 * (value - t0) / (t60 - t0)
            return 60.0 + 40.0 * (value - t60) / (t100 - t60)
        # neg：越高越差，锚点镜像（t0 最大→0 分，t100 最小→100 分）
        if t0 == t60 or t60 == t100:
            return None
        if value >= t0:
            return 0.0
        if value <= t100:
            return 100.0
        if value >= t60:
            return 60.0 * (t0 - value) / (t0 - t60)
        return 60.0 + 40.0 * (t60 - value) / (t60 - t100)
    except (TypeError, ZeroDivisionError):
        return None


def metric_tiers(settings, metric, date_type, weather):
    """取某考核项在 (date_type, weather) 下的三档阈值；缺失层级回落到代表格。"""
    targets = settings.get("targets") if isinstance(settings.get("targets"), dict) else {}
    m = targets.get(metric)
    if not isinstance(m, dict):
        return {}
    dt = m.get(date_type)
    if not isinstance(dt, dict):
        dt = m.get("weekday")  # 日期维度缺失时回落周中代表格
    if not isinstance(dt, dict):
        return {}
    cell = dt.get(weather)
    if not isinstance(cell, dict):
        cell = dt.get("normal")  # 天气维度缺失时回落正常天代表格
    return cell if isinstance(cell, dict) else {}


def compute_team_scores(raw, settings, date_type, weather):
    """给定各考核项原始达成值，按配置算各指标 0~100 得分与总分。

    raw: { "<metric>": value }（value 单位须与配置阈值一致，如 % / 秒）。
    返回 { "<metric>": 0~100 分或 None, "total_score": 总分或 None }。

    各指标得分：用 (date_type, weather) 对应档位三档阈值做分段线性映射；阈值不全 → None。
    总分：仅在【所有指标 kinds 均已设置】且【每个指标都能算出分】时计算——
      · 权重项：贡献 = 得分 × (权重%/100)
      · 调分项：贡献 = min + 得分/100 × (max-min)（得分区间可负）
      总分 = Σ贡献（不归一化）；满分 = 权重项权重之和。
      说明：完整 7 项权重合计 100 → 满分 100；而考核看板只取其中 4 项（权重合计 85），
      故看板总分满分 85、而非 100（历史上曾 /wsum×100 归一化，会把 85 膨胀成 100，已修正）。
    任一指标缺权重/区间或得分为 None → 总分 None（配置不完整，不臆造总分）。
    """
    scores = {}
    for metric, value in raw.items():
        if metric not in SQ_METRIC_DIR:
            continue
        cell = metric_tiers(settings, metric, date_type, weather)
        sc = score_metric(value, cell, SQ_METRIC_DIR.get(metric))
        scores[metric] = None if sc is None else round(sc, 2)
    kinds = settings.get("kinds") if isinstance(settings.get("kinds"), dict) else {}
    weights = settings.get("weights") if isinstance(settings.get("weights"), dict) else {}
    ranges = settings.get("ranges") if isinstance(settings.get("ranges"), dict) else {}
    total = None
    if scores and all(kinds.get(m) in ("weight", "adjust") for m in scores):
        num = 0.0
        wsum = 0.0
        ok = True
        for m, sc in scores.items():
            if sc is None:
                ok = False
                break
            k = kinds.get(m)
            if k == "weight":
                w = weights.get(m)
                if w is None:
                    ok = False
                    break
                num += sc * (float(w) / 100.0)
                wsum += float(w)
            else:  # adjust：得分区间 remap 到 [min, max]
                r = ranges.get(m)
                if not isinstance(r, dict) or r.get("min") is None or r.get("max") is None:
                    ok = False
                    break
                num += float(r["min"]) + (sc / 100.0) * (float(r["max"]) - float(r["min"]))
        if ok and wsum > 0:
            # 不归一化：总分 = 权重项加权和（满分 = Σ权重）。看板只取 4 项 → 满分 85。
            total = round(num, 2)
    scores["total_score"] = total
    return scores


def quality_settings(month=None):
    """读取某月服务质量考核设置。

    返回 {configured, month, weights, ranges, kinds, targets, date_overrides, updated_at, updated_by}
    - targets[metric][date_type][weather] = {t0, t60, t100}（缺失键 → None）
    - date_overrides = { "YYYY-MM-DD": "weekday"|"weekend" }（特殊日期覆盖表，缺失 → {}）
    - weights[metric] = 百分比（仅「权重项」有意义，0~100）
    - ranges[metric]  = {min, max} 得分区间（仅「调分项」有意义，可负）
    - 未保存过的月份 configured=False，所有值为 None（**不回落默认**）
    """
    month = month or current_month()
    all_ = _read_all()
    months = all_.get("months") if isinstance(all_.get("months"), dict) else {}
    entry = months.get(month) if isinstance(months.get(month), dict) else {}
    weights_raw = entry.get("weights") if isinstance(entry.get("weights"), dict) else {}
    ranges_raw = entry.get("ranges") if isinstance(entry.get("ranges"), dict) else {}
    kinds_raw = entry.get("kinds") if isinstance(entry.get("kinds"), dict) else {}
    layering_raw = entry.get("layering") if isinstance(entry.get("layering"), dict) else {}

    # 特殊日期覆盖表：{ "YYYY-MM-DD": "weekday"|"weekend" }（前端设置页写入，本次仅读取暴露；
    # 评分侧按日期匹配、套用覆盖后的日型阈值 为后续任务）。
    ov_raw = entry.get("date_overrides") if isinstance(entry.get("date_overrides"), dict) else {}
    date_overrides = {
        k: v for k, v in ov_raw.items()
        if isinstance(k, str) and _RE_DATE.fullmatch(k) and v in ("weekday", "weekend")
    }

    weights = {}
    ranges = {}
    kinds = {}
    layering = {}
    for m in SQ_METRICS:
        w = weights_raw.get(m["key"])
        # 兼容早期按 {weekday, weekend} 分开存的形态：取周中优先，其次周末
        if isinstance(w, dict):
            w = w.get("weekday", w.get("weekend"))
        weights[m["key"]] = _num(w)
        r = ranges_raw.get(m["key"]) if isinstance(ranges_raw.get(m["key"]), dict) else {}
        ranges[m["key"]] = {"min": _num(r.get("min")), "max": _num(r.get("max"))}
        k = kinds_raw.get(m["key"])
        kinds[m["key"]] = k if k in ("weight", "adjust") else None
        lv = layering_raw.get(m["key"])
        layering[m["key"]] = lv if lv in _LAYERING_KEYS else DEFAULT_LAYERING

    targets = {}
    for m in SQ_METRICS:
        per_metric = {}
        m_src = entry.get(m["key"]) if isinstance(entry.get(m["key"]), dict) else {}
        for dt in SQ_DATE_TYPES:
            per_wx = {}
            dt_src = m_src.get(dt["key"]) if isinstance(m_src.get(dt["key"]), dict) else {}
            for wx in SQ_WEATHER:
                cell = dt_src.get(wx["key"]) if isinstance(dt_src.get(wx["key"]), dict) else {}
                per_wx[wx["key"]] = {t: _num(cell.get(t)) for t in _TIERS}
            per_metric[dt["key"]] = per_wx
        targets[m["key"]] = per_metric

    return {
        "configured": bool(months) and month in months,
        "month": month,
        "weights": weights,
        "ranges": ranges,
        "kinds": kinds,
        "layering": layering,
        "targets": targets,
        "date_overrides": date_overrides,
        "updated_at": all_.get("updated_at"),
        "updated_by": all_.get("updated_by"),
    }


def target_rows(month=None):
    """把某月配置摊平成行列表，便于打分侧按 (日期类型, 天气, 指标) 遍历。

    每行 = {metric, metric_name, date_type, weather, direction, unit,
            t0, t60, t100, weight, score_min, score_max, kind, layering}
    - kind == 'weight' → weight 为百分比（0~100），score_min/max 为 None
    - kind == 'adjust' → score_min/score_max 为得分区间（可负），weight 为 None
    - 三档全为 None 表示该格未设置目标值，调用方须跳过
    - layering 说明该指标的三档在两维上的区分粒度（打分时可跳过非锚点场景）
    """
    s = quality_settings(month)
    rows = []
    for dt in SQ_DATE_TYPES:
        for wx in SQ_WEATHER:
            for m in SQ_METRICS:
                cell = s["targets"][m["key"]][dt["key"]][wx["key"]]
                rg = s["ranges"].get(m["key"]) or {}
                rows.append({
                    "metric": m["key"],
                    "metric_name": m["name"],
                    "date_type": dt["key"],
                    "weather": wx["key"],
                    "direction": m["direction"],
                    "unit": m["unit"],
                    "t0": cell["t0"],
                    "t60": cell["t60"],
                    "t100": cell["t100"],
                    "weight": s["weights"].get(m["key"]),
                    "score_min": rg.get("min"),
                    "score_max": rg.get("max"),
                    "kind": s["kinds"].get(m["key"]),
                    "layering": s["layering"].get(m["key"]),
                })
    return rows


if __name__ == "__main__":
    import json as _json
    import sys as _sys2
    _m = _sys2.argv[1] if len(_sys2.argv) > 1 else None
    print(_json.dumps(quality_settings(_m), ensure_ascii=False, indent=2))