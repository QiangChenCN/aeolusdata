#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""服务质量考核设置（读取层）——实时看板计算得分的**唯一**目标来源。

配置由 Nest `ConfigService` 写入（页面：考核设置 → 服务质量设置），落盘：
    backend/data/.service_quality_targets.json
    {
      "version": 1, "updated_at": "...", "updated_by": "...",
      "months": {
        "<YYYY-MM>": {
          "weights": { "<metric>": number|null },          # 权重项：百分比 0~100
          "ranges":  { "<metric>": {"min":num,"max":num} }, # 调分项：得分区间（可负）
          "kinds":   { "<metric>": "weight"|"adjust"|null },# 计分方式：权重项 / 调分项
          "layering":{ "<metric>": "none"|"date"|"weather"|"date_weather" },  # 按考核项
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

import os
import json
import datetime as _dt

# 与 Nest config.service.ts 同口径：后端本地状态统一落 backend/data/（带点前缀）
SERVICE_QUALITY_FILE = os.path.join(_ROOT, "backend", "data", ".service_quality_targets.json")

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


def quality_settings(month=None):
    """读取某月服务质量考核设置。

    返回 {configured, month, weights, ranges, kinds, targets, updated_at, updated_by}
    - targets[metric][date_type][weather] = {t0, t60, t100}（缺失键 → None）
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