#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""考核看板运单原始数据读取：读 PG 表 `delivery_realtime`（经 Nest 内部端点）。

2026-10-23 改源：不再读落盘文件 `apps/api/runtime/运单明细-实时.json` ——
考核看板的运单由 Nest `AssessmentDeliveryFetchService` 直接入库 `delivery_realtime`
（全站当天快照、覆盖写），本模块经内部端点
`GET /api/assessment-internal/orders`（机器令牌）读取，零文件、零 mtime 隐式状态。

失败语义**不变**：取不到（PG 未启用 / Nest 不可达 / 该站当天没入库）返回 None，
由调用方判 need_refresh，绝不当「0 单」静默算成 full-zero 指标；
「已入库但某站 0 单」返回空 list（继续计算，指标为 0）。
"""
from common import nest_client

ORDERS_PATH = "/api/assessment-internal/orders"
STATUS_PATH = "/api/assessment-internal/status"


def _get(path, params, timeout=60):
    """调用 Nest 内部端点；任何异常都转成 None（由上层按 need_refresh 处理）。"""
    try:
        j = nest_client.get_json(path, params, timeout=timeout)
    except Exception:
        return None
    return j if isinstance(j, dict) else None


def load_delivery_orders(team_id, date=None):
    """读考核看板自有运单明细（表 `delivery_realtime`，端点已按 team + date 过滤）。

    返回 list（可能为空 list：该站当天确实 0 单，继续参加计算）；
    不可用返回 None —— 调用方据此判 no_data / need_refresh。
    """
    params = {"team": str(team_id)}
    if date:
        params["date"] = str(date)
    j = _get(ORDERS_PATH, params)
    if not j or j.get("ok") is not True:
        return None
    rows = j.get("rows")
    if not isinstance(rows, list):
        return None
    return rows


def fetch_status(date=None):
    """运单明细入库状态 `{fetch_ok, fetch_error, fetched_at, date, total}`；不可用返回 None。

    现在失败时不再写「fetch_ok=false」标记（保留上一版数据），故这里只要能读到
    状态就一定是 ok —— 真正的「本次失败」由刷新接口返回给前端提示。
    """
    params = {"date": str(date)} if date else None
    j = _get(STATUS_PATH, params)
    if not j or j.get("ok") is not True:
        return None
    return {
        "fetch_ok": True,
        "fetch_error": None,
        "fetched_at": j.get("delivery_fetched_at") or None,
        "date": j.get("date"),
        "total": j.get("delivery_total"),
    }


def detail_status(date=None):
    """两路明细（运单 + 违规）的完整入库状态；不可用返回 None。

    供看板「更新时间」使用：只在真正重新取数、表被覆盖写后才变化，
    页面刷新（仅重算）不再跳动。
    """
    params = {"date": str(date)} if date else None
    j = _get(STATUS_PATH, params)
    if not j or j.get("ok") is not True:
        return None
    return j
