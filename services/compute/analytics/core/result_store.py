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

from analytics.core.paths import ROOT, PY_HOME, _ROOT, dirs# noqa: E402,F401 <<<


import json

RESULT_DIR = dirs.runtime("results")


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
