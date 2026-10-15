#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""考核看板运单原始数据读取：读自身落盘的 backend/data/运单明细-实时.json。

替代标准达成的 CACHE.load_raw("orders", ...)。考核看板运单由 Nest 端
AssessmentDeliveryFetchService 落盘（全站单文件、覆盖写、实时=截至当前当日），
本模块按 teamId 过滤后供 board / timeout 计算复用，零 HTTP 请求。
"""
import os
import json

from analytics import order_rules as OR

DELIVERY_FILE = "运单明细-实时.json"
TEAM_KEYS = ("teamId", "站点id", "teamID")


def _project_root():
    d = os.path.dirname(os.path.abspath(__file__))
    while d and os.path.basename(d) != "python":
        d = os.path.dirname(d)
    return os.path.dirname(d) if d else os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))


def _file_path():
    return os.path.join(_project_root(), "backend", "data", DELIVERY_FILE)


def _team_of(o):
    v = OR.order_val(o, TEAM_KEYS)
    return str(v).strip() if v not in (None, "") else None


def load_delivery_orders(team_id):
    """读考核看板自有运单落盘，按 team 过滤返回 list；文件缺失返回 None（调用方判 no_data）。

    文件存在但某站点 0 单时返回空 list（继续计算，指标为 0），仅当文件本身缺失/
    损坏才返回 None 以触发 need_refresh。
    """
    team_id = str(team_id)
    p = _file_path()
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception:
        return None
    rows = payload.get("rows") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return []
    return [o for o in rows if _team_of(o) == team_id]
