#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""站点维度报表 —— 「门槛值 / 封顶值」百分比配置（按月存储，与 grade_standards 同风格）。

存盘 JSON：`dashboard/standard/threshold_config.json`（与 grade_standards 同目录；由 Nest 后端落盘，计算侧按此路径读取）
结构：
  {
    "schema_version": 2,
    "months": {
      "2026-09": {"threshold_pct": 80.0, "cap_pct": 100.0, "updated_at": "ISO8601"},
      "2026-08": {"threshold_pct": 75.0, "cap_pct": 95.0,  "updated_at": "ISO8601"}
    }
  }

语义：站点维度报表按
  门槛人数 = ceil(规模目标 × threshold_pct / 100)
  封顶人数 = floor(规模目标 × cap_pct / 100)
逐站计算；二者任一为 null（未设置）时对应单元格显示「未设置门槛值 / 未设置封顶值」。

录入/校验/保存与「标准目标设置」保持一致：原子写 + 留空=未设置。
门槛值校验 0~100；封顶值仅校验 >=0（允许超过 100，如 110% 表示封顶人数为规模目标×1.1）。

对外（month 缺省=当前年月，与 grade-standards 一致）：
  get(month=None)                        -> {"threshold_pct","cap_pct","updated_at"}
  save(threshold_pct, cap_pct, month=None)-> 校验后落盘；空/None 视为未设置
  counts(scale_target, month=None)      -> {"threshold_count","cap_count"}
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
import math
import datetime
import threading

BJ = datetime.timezone(datetime.timedelta(hours=8))

_HERE = os.path.dirname(os.path.abspath(__file__))
# 与 grade_standards.json 同目录，且对齐后端 ConfigService.stdDir：Nest 把用户设置的
# 门槛/封顶落盘于此（<root>/python/dashboard/standard/threshold_config.json），计算侧必须按此路径读取，
# 否则会读不到用户在 UI 设置的值而回退兜底 80/100。
_PATH = os.path.join(PY_HOME, "dashboard", "standard", "threshold_config.json")
_LOCK = threading.Lock()


def _now_iso():
    return datetime.datetime.now(BJ).strftime("%Y-%m-%dT%H:%M:%S+08:00")


def _cur_month():
    return datetime.datetime.now(BJ).strftime("%Y-%m")


def _read():
    if not os.path.exists(_PATH):
        return {"schema_version": 2, "months": {}}
    try:
        with open(_PATH, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        # 损坏文件不抛：兜底按空配置走，避免拖死看板
        return {"schema_version": 2, "months": {}}
    # 兼容 v1（无 months 的旧结构）：直接重置为空（旧文件值恒为 null，无实际损失）
    if not isinstance(d.get("months"), dict):
        return {"schema_version": 2, "months": {}}
    return d


def _write(data):
    """原子写：先写 .tmp 再 rename，避免半截文件被读。Windows 与 Linux 通用。"""
    tmp = _PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, _PATH)


def get(month=None):
    month = month or _cur_month()
    d = _read()
    m = d.get("months", {}).get(month, {})
    return {
        "month": month,
        "threshold_pct": m.get("threshold_pct"),
        "cap_pct": m.get("cap_pct"),
        "updated_at": m.get("updated_at"),
    }


def _norm_threshold(v):
    """归一化门槛值：空 / None → None（未设置）；否则转 float 并校验 0~100。"""
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (ValueError, TypeError):
        raise ValueError("门槛值须为数字")
    if f < 0 or f > 100:
        raise ValueError("门槛值须在 0~100 之间")
    return f


def _norm_cap(v):
    """归一化封顶值：空 / None → None（未设置）；否则转 float 并校验 >=0。

    封顶值允许超过 100（如 110 表示规模目标×1.1 向下取整）。
    """
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (ValueError, TypeError):
        raise ValueError("封顶值须为数字")
    if f < 0:
        raise ValueError("封顶值不能为负数")
    return f


def save(threshold_pct, cap_pct, month=None):
    """校验 + 落盘（按 month 独立存储）。返回保存后的值。"""
    month = month or _cur_month()
    t = _norm_threshold(threshold_pct)
    c = _norm_cap(cap_pct)
    with _LOCK:
        data = _read()
        months = data.setdefault("months", {})
        months[month] = {
            "threshold_pct": t,
            "cap_pct": c,
            "updated_at": _now_iso(),
        }
        data["schema_version"] = 2
        _write(data)
    return {"month": month, "threshold_pct": t, "cap_pct": c,
            "updated_at": months[month]["updated_at"]}


def counts(scale_target, month=None):
    """按全局百分比配置（指定月份，缺省当前月），计算门槛人数(向上取整) / 封顶人数(向下取整)。

    任一未设置或 scale_target 缺失 → 返回 None（前端据列名显示「未设置…」）。
    """
    d = get(month)
    tp = d.get("threshold_pct")
    cp = d.get("cap_pct")

    def _ceil(pct):
        if pct is None or scale_target is None:
            return None
        return int(math.ceil(scale_target * pct / 100.0))

    def _floor(pct):
        if pct is None or scale_target is None:
            return None
        return int(math.floor(scale_target * pct / 100.0))

    return {"threshold_count": _ceil(tp), "cap_count": _floor(cp)}


if __name__ == "__main__":
    import json as _json
    print(_json.dumps(get(), ensure_ascii=False, indent=2))
