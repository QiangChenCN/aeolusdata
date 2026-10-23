#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""配送超时看板 —— 运单明细计算源（读 Nest 的实时运单明细 PG 表，零本地文件）。

历史（2026-10-21 改源）：
  原先本看板复用**考核看板**落盘的 `apps/api/runtime/运单明细-实时.json` 做计算源 ——
  既没有自己的数据源（考核侧不刷新就出不了数），也没有站包 isolation：两边看板共用
  同一份落盘文件，谁改抓取/清洗口径都会同时影响对方。

  现在改成本看板**自有的实时运单明细**：由 Nest `DeliveryTimeoutRefreshService`
  抓全站运单写入 PG 表 `delivery_realtime`，本模块经内部端点
  `GET /api/delivery-timeout-internal/orders`（机器令牌）读取。
  Python 侧零文件读取：没有 mtime/FileExists 之类的隐式状态，缺失与否由接口显式告知。

失败语义：与旧 `delivery_source.load_delivery_orders` 保持一致 ——
  取不到（表未就绪 / Nest 不可达 / 该站当天没数据）返回 None，
  由 timeout.build_one 判 need_refresh=True，绝不当「0 单」静默算成 full-zero 指标。
"""
from common import nest_client

ORDERS_PATH = "/api/delivery-timeout-internal/orders"
STATUS_PATH = "/api/delivery-timeout-internal/status"


def _get(path, params, timeout=60):
    """调用 Nest 内部端点；任何异常都转成 None（由上层按 need_refresh 处理）。"""
    try:
        j = nest_client.get_json(path, params, timeout=timeout)
    except Exception:
        return None
    return j if isinstance(j, dict) else None


def load_with_meta(team_id, date=None):
    """读某站点某天的实时运单明细，返回 `(rows, fetched_at)`。

    · rows 为原始行 list（可能为空 list：该站当天确实 0 单，继续参加计算）；
    · 取数不可用返回 `(None, None)` —— 调用方据此判 need_refresh。
    """
    params = {"team": str(team_id)}
    if date:
        params["date"] = str(date)
    j = _get(ORDERS_PATH, params)
    if not j or j.get("ok") is not True:
        return None, None
    rows = j.get("rows")
    if not isinstance(rows, list):
        return None, None
    return rows, (j.get("fetched_at") or None)


def load_orders(team_id, date=None):
    """只要明细行；不可用返回 None（接口与旧 delivery_source 同名函数一致）。"""
    rows, _ = load_with_meta(team_id, date)
    return rows


def fetched_at(team_id, date=None):
    """该站点本轮入库时间（北京时间字符串）；不可用返回 None。供前端展示「取数时间」。"""
    _, at = load_with_meta(team_id, date)
    return at


def fetch_status(date=None):
    """某天全站入库状态 `{total, fetched_at}`；不可用返回 None（用于刷新文案诊断）。"""
    params = {"date": str(date)} if date else None
    j = _get(STATUS_PATH, params)
    if not j or j.get("ok") is not True:
        return None
    return {"total": j.get("total"), "fetched_at": j.get("fetched_at") or None}
