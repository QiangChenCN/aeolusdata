#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""实时数据看板 —— 配置层（所选站点 + 考核目标）。

原散落在 server.py 的实时看板配置逻辑统一迁至此：
  · 所选站点  .realtime_selection.json（按账号持久化，多端同步）
  · 考核目标  .realtime_targets.json（按场景分档阈值 + 权重）

本模块只做「文件读写 + 校验 + 种子」，不含 HTTP / 鉴权 / 数据权限，
那些留在 server.py 的路由处理器里。
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

import json
REALTIME_SEL_FILE = os.path.join(_ROOT, ".realtime_selection.json")
REALTIME_TARGETS_FILE = os.path.join(_ROOT, ".realtime_targets.json")


# ===================== 所选站点 =====================
def load_realtime_sel():
    """返回 {username: [team_id, ...]}；文件缺失/损坏返回 {}。"""
    try:
        with open(REALTIME_SEL_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


def save_realtime_sel(obj):
    """原子写所选站点（tmp + fsync + replace，权限 0o600）。"""
    tmp = REALTIME_SEL_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush(); os.fsync(f.fileno())
    os.replace(tmp, REALTIME_SEL_FILE)
    try:
        os.chmod(REALTIME_SEL_FILE, 0o600)
    except OSError:
        pass


# ===================== 考核目标 =====================
# 场景 = 日期类型(周中/周末) × 天气等级(正常/轻微/一般/严重) × 指标(7 项)。
# 每项规则含：方向(正向/负向) + 0分/60分/100分阈值 + 权重（同日期类型内去重合计 100）。
# 单项封顶 100 分（打分侧负责，存储侧仅保证阈值与权重合法）。
# 仅“目标设置”：不采集天气、不做实时打分；读取所有人可见，保存需 realtime:targets 权限。
RT_METRICS = [
    {"key": "delivery_rate",     "name": "物流妥投率",   "direction": "pos", "unit": "%"},
    {"key": "ontime_rate",       "name": "考核准时率",   "direction": "pos", "unit": "%"},
    {"key": "unsat_rate",        "name": "不满意率",     "direction": "neg", "unit": "%"},
    {"key": "compound_overtime", "name": "复合超时时长", "direction": "neg", "unit": "min"},
    {"key": "call_rate",         "name": "电联率",       "direction": "pos", "unit": "%"},
    {"key": "im_reply_rate",     "name": "IM及时回复率", "direction": "pos", "unit": "%"},
    {"key": "visit_rate",        "name": "新专送拜访",   "direction": "pos", "unit": "%"},
]
RT_DATE_TYPES = [{"key": "weekday", "name": "周中"}, {"key": "weekend", "name": "周末"}]
RT_WEATHER = [
    {"key": "normal",   "name": "正常天"},
    {"key": "light",    "name": "轻微恶天"},
    {"key": "moderate", "name": "一般恶天"},
    {"key": "severe",   "name": "严重恶天"},
]
RT_METRIC_DIR = {m["key"]: m["direction"] for m in RT_METRICS}
RT_METRIC_KEYS = set(RT_METRIC_DIR)
RT_DT_KEYS = set(d["key"] for d in RT_DATE_TYPES)
RT_WX_KEYS = set(w["key"] for w in RT_WEATHER)
# 方案默认权重（每项指标在「同一日期类型内」合计 100%）
RT_DEFAULT_WEIGHT = {"delivery_rate": 20, "ontime_rate": 30, "unsat_rate": 20,
                     "compound_overtime": 15, "call_rate": 5,
                     "im_reply_rate": 5, "visit_rate": 5}


def seed_realtime_targets():
    # 通用占位阈值（按方向给一组合理默认值，用户按实际微调）；方向以指标目录为准。
    pos_def = {"t0": 90.0, "t60": 95.0, "t100": 99.0}   # 越高越好(%)
    neg_pct = {"t0": 5.0,  "t60": 3.0,  "t100": 1.0}    # 越低越好(%)
    neg_min = {"t0": 30.0, "t60": 15.0, "t100": 5.0}    # 越低越好(min)
    rows = []
    for dt in RT_DATE_TYPES:
        for wx in RT_WEATHER:
            for m in RT_METRICS:
                if m["direction"] == "pos":
                    th = dict(pos_def)
                elif m["unit"] == "%":
                    th = dict(neg_pct)
                else:
                    th = dict(neg_min)
                rows.append({
                    "date_type": dt["key"], "weather": wx["key"], "metric": m["key"],
                    "direction": m["direction"],
                    "t0": th["t0"], "t60": th["t60"], "t100": th["t100"],
                    "weight": RT_DEFAULT_WEIGHT[m["key"]],
                })
    return {"version": 1, "updated_at": "", "updated_by": "", "rows": rows}


def load_realtime_targets():
    try:
        with open(REALTIME_TARGETS_FILE, "r", encoding="utf-8") as f:
            obj = json.load(f)
        if isinstance(obj, dict) and isinstance(obj.get("rows"), list) and obj["rows"]:
            return obj
    except (FileNotFoundError, ValueError):
        pass
    obj = seed_realtime_targets()
    save_realtime_targets(obj, "_seed_")
    return obj


def save_realtime_targets(obj, by):
    tmp = REALTIME_TARGETS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush(); os.fsync(f.fileno())
    os.replace(tmp, REALTIME_TARGETS_FILE)
    try:
        os.chmod(REALTIME_TARGETS_FILE, 0o600)
    except OSError:
        pass


def validate_realtime_targets(rows):
    """返回错误列表（空=通过）。校验维度：枚举合法 / 阈值单调且严格 / 权重合计 100 / 56 行齐全。"""
    errors = []
    seen = set()
    per_dt_metric = {}   # (date_type, metric) -> weight（去重，权重按指标在日期类型内合计）
    for idx, r in enumerate(rows):
        if not isinstance(r, dict):
            errors.append("第 %d 行不是有效对象" % (idx + 1)); continue
        dt, wx, mk = r.get("date_type"), r.get("weather"), r.get("metric")
        if dt not in RT_DT_KEYS:
            errors.append("第 %d 行：未知日期类型 %r" % (idx + 1, dt)); continue
        if wx not in RT_WX_KEYS:
            errors.append("第 %d 行：未知天气等级 %r" % (idx + 1, wx)); continue
        if mk not in RT_METRIC_KEYS:
            errors.append("第 %d 行：未知指标 %r" % (idx + 1, mk)); continue
        key = (dt, wx, mk)
        if key in seen:
            errors.append("重复配置：%s/%s/%s" % key); continue
        seen.add(key)
        direction = RT_METRIC_DIR[mk]
        try:
            t0, t60, t100 = float(r.get("t0")), float(r.get("t60")), float(r.get("t100"))
        except (TypeError, ValueError):
            errors.append("%s/%s/%s：阈值必须为数字" % key); continue
        try:
            w = float(r.get("weight"))
        except (TypeError, ValueError):
            errors.append("%s/%s/%s：权重必须为数字" % key); continue
        if w < 0:
            errors.append("%s/%s/%s：权重不能为负" % key)
        if direction == "pos":
            if not (t0 < t60 < t100):
                errors.append("%s/%s/%s：正向指标需 0分<60分<100分阈值（当前 %.3f/%.3f/%.3f）"
                              % (key + (t0, t60, t100)))
        else:
            if not (t0 > t60 > t100):
                errors.append("%s/%s/%s：负向指标需 0分>60分>100分阈值（当前 %.3f/%.3f/%.3f）"
                              % (key + (t0, t60, t100)))
        per_dt_metric[(dt, mk)] = w
    expect = len(RT_DT_KEYS) * len(RT_WX_KEYS) * len(RT_METRIC_KEYS)
    if len(seen) != expect:
        errors.append("配置行数不完整（应为 %d 行，实得 %d 行）" % (expect, len(seen)))
    for dt in RT_DT_KEYS:
        tot = sum(v for (d, _m), v in per_dt_metric.items() if d == dt)
        if abs(tot - 100.0) > 0.1:
            errors.append("日期类型 %s 权重合计 %.1f%%，应为 100%%" % (dt, tot))
    return errors
