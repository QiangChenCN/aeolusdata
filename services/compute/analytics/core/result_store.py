#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""考核看板计算结果持久化（落盘到自有目录，不与其他看板共用）。

约定：计算结果统一放中性目录 `apps/api/runtime/results/`（不再带 `assessment` 字样，彻底迁出旧
`assessment/` 命名空间），文件名加 `assessment_` 前缀以区分归属、避免与其他看板结果撞名：
`assessment_{kind}_{team}_{date}.json`（kind ∈ station / timeout / ...）。

读侧仍以「原始层 + 实时计算」为主（保证新鲜），这里仅作**耐用快照**落盘，
满足「计算结果放自己目录」的约定，且绝不因读写失败影响看板响应。
"""
import os

# >>> python-home bootstrap (added by layout migration) >>>
import os as _os
import sys as _sys

def _find_python_home():
    d = _os.path.dirname(_os.path.abspath(__file__))
    # 计算服务代码根：同时含 analytics/ 与 compute_api/ 子目录
    while d and not (
        _os.path.isdir(_os.path.join(d, "analytics"))
        and _os.path.isdir(_os.path.join(d, "compute_api"))
    ):
        d = _os.path.dirname(d)
    return d

def _find_repo_root():
    d = _os.path.dirname(_os.path.abspath(__file__))
    # 仓库根：含 .git 或根 package.json
    while d and d != _os.path.dirname(d) and not (
        _os.path.exists(_os.path.join(d, ".git"))
        or _os.path.exists(_os.path.join(d, "package.json"))
    ):
        d = _os.path.dirname(d)
    return d

PY_HOME = _find_python_home()
ROOT = _find_repo_root()
_ROOT = ROOT
if PY_HOME and PY_HOME not in _sys.path:
    _sys.path.insert(0, PY_HOME)
# <<< python-home bootstrap <<<


import json

RESULT_DIR = os.path.join(ROOT, "apps", "api", "runtime", "results")


def save_result(kind, team, date, payload):
    """把计算结果（dict）落盘到自有目录；任何异常静默忽略，不影响主流程。"""
    try:
        os.makedirs(RESULT_DIR, exist_ok=True)
        p = os.path.join(RESULT_DIR, f"assessment_{kind}_{team}_{date}.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
    except Exception:
        pass


def load_result(kind, team, date):
    """读计算结果快照；不存在 / 损坏返回 None。"""
    p = os.path.join(RESULT_DIR, f"assessment_{kind}_{team}_{date}.json")
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


__all__ = ["RESULT_DIR", "save_result", "load_result"]
