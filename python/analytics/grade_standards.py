#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「标准达成设置」（按月份 × 站点）。

数据模型（落盘 <python>/dashboard/standard/standard_grade_settings.json，由 Nest ConfigService 读写；
Python 计算侧按此路径读取，与看板、机器人同源）：

  {
    "schema_version": 2,
    "updated_at": "...", "updated_by": "...",
    "default": { "levels":[5 档], "threshold_pct": 80, "cap_pct": 100 },   # 默认档位模板
    "months": {
      "<YYYY-MM>": {
        "<team_id>": { "levels":[5 档], "threshold_pct":.., "cap_pct":.. }   # 独立配置
                   | { "use_default": true }                                # 沿用默认模板
      }
    }
  }

「参与考核站点」已移除：某月下【配置了记录的站点】即参与考核（有设置就默认考核）。
某月从未保存过时参与站点为空（由前端提示去配置），**不回落任何默认站点**。
迁移：旧单套 schema（顶层 levels/threshold/cap/participating_teams）读取时，顶层档位当默认模板、
顶层 participating_teams 套用到任何未单独配置的月份（旧配置本就不分月份），旧数据不丢。

对外：
  grade_settings(month)            → {schema_version, updated_at, updated_by, month, configured, default, teams:{tid:{...}}}
  graded_team_ids(month)           → 参与考核站点 id 列表（有配置记录即参与；该月从未配置 → 空列表）
  site_settings(month, team)       → 某 (月,站) 配置，回落默认模板
  site_levels(month, team)         → 6 档 level（level0=未定级 + 标准1..5），喂 rider_dimension / assessment_overview
  site_threshold_cap(month, team)  → (门槛%, 封顶%)；任一为 None 表示未设置
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

# 与 Nest ConfigService.stdDir 对齐：配置实际落盘于 <python>/dashboard/standard/
_GLOBAL_PATH = os.path.join(PY_HOME, "dashboard", "standard", "standard_grade_settings.json")

# 默认模板（首运行 / 新站点沿用），与「运力达成查询」机器人口径一致。
DEFAULT_LEVELS = [
    {"level": 1, "orders": 18, "hours": 6},
    {"level": 2, "orders": 21, "hours": 6},
    {"level": 3, "orders": 26, "hours": 6},
    {"level": 4, "orders": 32, "hours": 7},
    {"level": 5, "orders": 39, "hours": 8},
]
DEFAULT_THRESHOLD = 80.0
DEFAULT_CAP = 100.0


def _bj_now():
    return _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=8)))


def current_month():
    return _bj_now().strftime("%Y-%m")


def _read_global():
    if not os.path.exists(_GLOBAL_PATH):
        return None
    try:
        with open(_GLOBAL_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _norm_level(src, idx):
    if not isinstance(src, dict):
        src = {}
    try:
        orders = max(0, int(src.get("orders", 0)))
    except (ValueError, TypeError):
        orders = 0
    try:
        hours = max(0.0, min(24.0, float(src.get("hours", 0) or 0)))
    except (ValueError, TypeError):
        hours = 0.0
    return {"level": idx + 1, "orders": orders, "hours": round(hours, 2)}


def _norm_levels(arr):
    raw = arr if isinstance(arr, list) else []
    return [_norm_level(raw[i] if i < len(raw) else DEFAULT_LEVELS[i], i) for i in range(5)]


def _norm_pct(v, cap=None):
    """归一化百分比：None/空 → None（未设置）；否则 float，超范围 → None（避免脏数据）。"""
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (ValueError, TypeError):
        return None
    if f < 0 or (cap is not None and f > cap):
        return None
    return f


def _template(d):
    """解析默认档位模板：优先 default 键；兼容旧单套 schema（顶层 levels/threshold/cap）；否则内置默认。"""
    d = d or {}
    tmpl = d.get("default")
    if isinstance(tmpl, dict) and (
        isinstance(tmpl.get("levels"), list) or tmpl.get("threshold_pct") is not None or tmpl.get("cap_pct") is not None
    ):
        return {
            "levels": _norm_levels(tmpl.get("levels")),
            "threshold_pct": _norm_pct(tmpl.get("threshold_pct"), 100),
            "cap_pct": _norm_pct(tmpl.get("cap_pct")),
        }
    if isinstance(d.get("levels"), list) or d.get("threshold_pct") is not None or d.get("cap_pct") is not None:
        return {
            "levels": _norm_levels(d.get("levels")),
            "threshold_pct": _norm_pct(d.get("threshold_pct"), 100),
            "cap_pct": _norm_pct(d.get("cap_pct")),
        }
    return {
        "levels": _norm_levels(DEFAULT_LEVELS),
        "threshold_pct": DEFAULT_THRESHOLD,
        "cap_pct": DEFAULT_CAP,
    }


def _norm_site(cfg, dflt):
    if isinstance(cfg, dict) and cfg.get("use_default"):
        return {
            "levels": [dict(lv) for lv in dflt["levels"]],
            "threshold_pct": dflt["threshold_pct"],
            "cap_pct": dflt["cap_pct"],
            "use_default": True,
        }
    cfg = cfg or {}
    return {
        "levels": _norm_levels(cfg.get("levels")),
        "threshold_pct": _norm_pct(cfg.get("threshold_pct"), 100),
        "cap_pct": _norm_pct(cfg.get("cap_pct")),
        "use_default": False,
    }


def _legacy_team_ids(d):
    """旧单套 schema 的参与站点名单（顶层 participating_teams）。

    旧配置本就不分月份，迁移时把这份名单套用到【任何尚未单独配置的月份】，避免旧数据丢失。
    """
    if not isinstance(d, dict):
        return []
    p = d.get("participating_teams")
    if not isinstance(p, list):
        return []
    return [str(x).strip() for x in p if str(x).strip()]


def grade_settings(month=None):
    """读取某月「标准达成设置」；参与考核站点 = 该月下配置了记录的站点。

    该月从未配置时：
      - 旧单套 schema（有顶层 participating_teams）→ 套用旧名单（迁移，不丢旧数据）；
      - 否则 → 站点为空（前端据此提示「尚未配置」，不再回落默认三站）。
    """
    if not month:
        month = current_month()
    raw = _read_global()
    empty = not (raw and isinstance(raw, dict))
    dflt = _template(None if empty else raw)
    months = (raw.get("months") if (raw and isinstance(raw.get("months"), dict)) else {}) if not empty else {}
    entry = months.get(month) if (isinstance(months.get(month), dict)) else None
    teams = {}
    if entry is not None:
        for tid, cfg in entry.items():
            teams[str(tid)] = _norm_site(cfg, dflt)
    else:
        for tid in ([] if empty else _legacy_team_ids(raw)):
            teams[tid] = {
                "levels": [dict(lv) for lv in dflt["levels"]],
                "threshold_pct": dflt["threshold_pct"],
                "cap_pct": dflt["cap_pct"],
                "use_default": True,
            }
    return {
        "schema_version": (2 if empty else raw.get("schema_version", 2)) or 2,
        "updated_at": None if empty else raw.get("updated_at"),
        "updated_by": None if empty else raw.get("updated_by"),
        "month": month,
        "configured": entry is not None,
        "default": dflt,
        "teams": teams,
    }


def graded_team_ids(month=None):
    """参与考核站点 id 列表（有配置记录即参与；该月从未配置 → 空列表）。"""
    return [str(t) for t in grade_settings(month)["teams"].keys()]


def site_settings(month, team):
    """某 (月,站) 配置，回落默认模板。"""
    s = grade_settings(month)
    t = s["teams"].get(str(team))
    if t is None:
        d = s["default"]
        return {
            "levels": [dict(lv) for lv in d["levels"]],
            "threshold_pct": d["threshold_pct"],
            "cap_pct": d["cap_pct"],
            "use_default": True,
        }
    return t


def site_levels(month, team):
    """某 (月,站) 的 6 档 level（level0=未定级 + 标准1..5），喂 rider_dimension._grade / assessment_overview。"""
    t = site_settings(month, team)
    out = [{"level": 0, "name": "未定级", "min_valid_orders": 0, "min_valid_minutes": 0.0}]
    for i, lv in enumerate(t["levels"]):
        out.append({
            "level": i + 1,
            "name": "标准%d" % (i + 1),
            "min_valid_orders": int(lv["orders"]),
            "min_valid_minutes": float(lv["hours"]) * 60.0,
        })
    return out


def site_threshold_cap(month, team):
    """某 (月,站) 门槛/封顶百分比（小数）；任一为 None 表示未设置。"""
    t = site_settings(month, team)
    return t["threshold_pct"], t["cap_pct"]


if __name__ == "__main__":
    import json as _json
    print(_json.dumps(grade_settings(), ensure_ascii=False, indent=2))
