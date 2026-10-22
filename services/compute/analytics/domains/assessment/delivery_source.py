#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""考核看板运单原始数据读取：读自身落盘的 apps/api/runtime/运单明细-实时.json。

替代标准达成的 CACHE.load_raw("orders", ...)。考核看板运单由 Nest 端
AssessmentDeliveryFetchService 落盘（全站单文件、覆盖写、实时=截至当前当日），
本模块按 teamId 过滤后供 board / timeout 计算复用，零 HTTP 请求。
"""
import os
import json

from analytics.core import order_rules as OR

DELIVERY_FILE = "运单明细-实时.json"
TEAM_KEYS = ("teamId", "站点id", "teamID")


def _project_root():
    d = os.path.dirname(os.path.abspath(__file__))
    # 仓库根：含 .git 或根 package.json（目录名无关）
    while d and d != os.path.dirname(d) and not (
        os.path.exists(os.path.join(d, ".git"))
        or os.path.exists(os.path.join(d, "package.json"))
    ):
        d = os.path.dirname(d)
    return d


def _file_path():
    return os.path.join(_project_root(), "apps", "api", "runtime", DELIVERY_FILE)


def _team_of(o):
    v = OR.order_val(o, TEAM_KEYS)
    return str(v).strip() if v not in (None, "") else None


def load_delivery_orders(team_id):
    """读考核看板自有运单落盘，按 team 过滤返回 list；不可用返回 None（调用方判 no_data）。

    「不可用」包含三种情况，都与违规明细读侧（violations.load_team）保持一致：
      · 文件缺失 / 损坏；
      · `fetch_ok` 为 False —— 本次取数失败（Nest 落盘时整份写 fetch_ok=false）。
        历史上此处不检查 fetch_ok，失败时文件被写成 `rows: []`，读侧返回空 list，
        订单类指标（推配送/完成/T8超时/高比单…）全部按 0 计算且 data_status 仍是 ok，
        与另一路刚拉成功的违规指标混算，表现为「站点消失 / 订单指标全 0」。
      · rows 不是 list（结构异常）。
    文件存在且 fetch_ok 为真、某站点 0 单时返回空 list（继续计算，指标为 0）。
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
    if not isinstance(payload, dict):
        return None
    if payload.get("fetch_ok") is False:
        return None
    rows = payload.get("rows")
    if not isinstance(rows, list):
        return None
    return [o for o in rows if _team_of(o) == team_id]


def fetch_status():
    """运单明细落盘文件的取数状态；文件缺失 / 损坏返回 None。

    返回 {fetch_ok, fetch_error, fetched_at, date}，供看板区分「从未拉取」与
    「本次拉取失败」并给出对应提示（后者必须明说，不能静默按无数据处理）。
    """
    p = _file_path()
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    return {
        "fetch_ok": payload.get("fetch_ok"),
        "fetch_error": payload.get("fetch_error"),
        "fetched_at": payload.get("fetched_at"),
        "date": payload.get("date"),
    }
