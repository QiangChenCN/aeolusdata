#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标准达成看板 —— 有效单口径（单一来源）。

为什么单独抽出来
----------------
「有效单量」的判定同时被两个维度使用：
  · 站点维度 achievement.py   —— 全天实际单量（对比排班目标 9999 全天行的 predict_order）
  · 骑手维度 rider_dimension.py —— 骑手全天有效单量（对比等级标准阈值）

口径一旦两边各写一份就会漂移（历史上正是如此：站点维度用创建时间 + 时段窗口，
骑手维度用接单时间 + 有效性过滤）。因此把「取键 / 有效性 / 日期归属」集中到这里，
两边只 import，不再各自实现。

口径定义（2026-09-10 用户修正版）
------------------------------
  有效单 = 骑手接单时间归属当天（北京时间自然日 00:00:00 ~ 23:59:59.999）
           + 配送完成（stateDesc=配送成功 / state=40）
           + 非作弊（isCheat 为假）
           + 非逆向单（isReverse 为假）
           + 非改派单（isReassign 为假）

  说明（2026-09-10 修正）：剔除条件**不再包含「异常上报 isAbnormalReport」**。
  异常上报只代表骑手反馈了一个现场情况（商户出货慢 / 联系不到顾客 等），
  并不代表订单本身未完成 —— 已「配送成功」的单即便报了异常，也应计入有效单。
  历史版本曾把 isAbnormalReport 列为剔除条件，案例：伍政荣 9-10 当天 8 单
  因 1 单异常上报被误剔，正确应为 4 单有效单（已批量修正）。

日界与跨天
----------
  · 归属日期一律取「骑手接单时间」的**北京时间**日期，不按创建时间、不按完成时间。
  · 跨午夜的订单（如夜宵 22:00 接单、00:30 完成）归属到**接单那一天**，
    因此不存在「同一单被两天各计一次」的问题。
  · 调用方若需严格去重，用 trackingId 建集合（见 achievement._count_valid_orders_by_date）。

对外能力
--------
  order_val(o, keys)      多键兼容取值（中英文 / 新旧接口键名）
  is_valid_order(o)       有效单判定（上面 5 条全满足）
  is_completed(o)         仅「是否配送完成」（用于「今日有单」补齐未排班骑手）
  accept_ms(o)            归属时间戳：接单时间优先，缺失兜底创建时间
  ms_to_ymd(ms)           毫秒 → 北京时间 'YYYY-MM-DD'
  norm_team(v)            站点 ID 归一化（比较用）
"""
import datetime

BJ = datetime.timezone(datetime.timedelta(hours=8))

# ---- 取数键兼容：live 用风神原始英文键，样本/旧接口用中文键 ----
RIDER_ID_KEYS = ("knightId", "骑手ID", "riderId", "riderID")
RIDER_NAME_KEYS = ("knightName", "骑手姓名", "riderName")
TEAM_KEYS = ("teamId", "团队ID")
CREATE_KEYS = ("trackingCreatedAt", "运单创建时间", "createTime", "orderCreateTime")
# 骑手「接单时间」：订单日期归属以此为准（2026-09-09 用户要求）
ACCEPT_KEYS = ("acceptAtLast", "最近接单时间", "骑手接单时间")

# 剔除类型键（live 用 isReverse/isReassign 布尔；样本用中文键）
EXCLUDE_TYPE_KEYS = {
    "reverse": ("isReverse", "是否逆向单"),
    "reassign": ("isReassign", "是否改派"),
}

# 假值集合：这些一律视为「否 / 未标记」
_FALSY = ("0", "0.0", "", "false", "none", "null")


def order_val(o, keys):
    """多键兼容取值：返回第一个存在且非空的键的值。"""
    for k in keys:
        if k in o and o[k] not in (None, ""):
            return o[k]
    return None


def norm_team(v):
    """站点 ID 归一化，便于跨源比较（避免 '917521136' vs 917521136 不等）。"""
    return str(v).strip() if v is not None else None


def filter_by_team(orders, team_id):
    """按站点隔离运单：保留 team 字段缺失或 == team_id 的运单。

    明细接口返回的是「账号权限下全站」数据，没有站点参数。落盘前必须按站点
    隔离，否则 per-team 的原始层缓存文件会混入其它站点数据 —— 多站点汇总时
    重复计数（见 assessment_overview._build_trend 把各站 orders 文件合并统计）。
    过滤口径与聚合侧 _aggregate_rider_data 完全一致：team 字段显式属于别的站
    才丢弃，缺失（无法判定归属）则保留，与聚合计算行为保持单一来源。
    """
    team_str = str(team_id).strip()
    out = []
    for o in (orders or []):
        ot = order_val(o, TEAM_KEYS)
        if ot is None or str(ot).strip() == team_str:
            out.append(o)
    return out


def _is_truthy_flag(v):
    """把 布尔 / "1" / "true" / 数字 统一判成「是否标记」。"""
    if v is None:
        return False
    return str(v).strip().lower() not in _FALSY


def is_excluded_type(o):
    """剔除类型：逆向单(isReverse) / 改派单(isReassign) 不计入有效单。
    值为真即剔除；缺失或假值不剔除。"""
    for keys in EXCLUDE_TYPE_KEYS.values():
        for k in keys:
            if k in o and o[k] not in (None, ""):
                if _is_truthy_flag(o[k]):
                    return True
    return False


def is_completed(o):
    """完成单判定（「今日有单」口径）：状态 = 配送完成（40 / 配送成功）。
    不叠加作弊/异常上报过滤 —— 只认「是否送达完成」。"""
    desc = str(order_val(o, ("状态描述", "stateDesc", "statusDesc", "statusName")) or "")
    if desc == "配送成功":
        return True
    st = order_val(o, ("状态", "state", "status", "statusCode", "orderStatus"))
    return str(st) in ("40", "40.0", "配送成功")


def is_valid_order(o):
    """有效单判定：配送完成 + 未作弊 + 非逆向单 + 非改派单。

    2026-09-10 修正：移除「异常上报 isAbnormalReport」剔除条件。
    异常上报不影响单子是否实际完成，已「配送成功」即视为有效。
    """
    desc = str(order_val(o, ("状态描述", "stateDesc", "statusDesc", "statusName")) or "")
    if desc:
        if desc == "配送成功":
            valid_status = True
        else:
            # 含「成功」也算（部分接口描述写法），其余一律判无效
            valid_status = "成功" in desc and "未" not in desc and "不" not in desc
    else:
        st = order_val(o, ("状态", "state", "status", "statusCode", "orderStatus"))
        valid_status = str(st) in ("40", "40.0", "配送成功")
    if not valid_status:
        return False
    if _is_truthy_flag(order_val(o, ("是否作弊", "isCheat", "cheatFlag"))):
        return False
    if is_excluded_type(o):
        return False
    return True


def accept_ms(o):
    """订单归属时间戳（毫秒）：骑手接单时间优先，缺失时兜底用创建时间。
    返回 None 表示无法归属（调用方应跳过，避免算到错误的日期）。"""
    raw = order_val(o, ACCEPT_KEYS)
    if raw is None:
        raw = order_val(o, CREATE_KEYS)
    if raw is None:
        return None
    try:
        return int(raw)
    except (ValueError, TypeError):
        return None


def ms_to_ymd(ms):
    """毫秒时间戳 → 北京时间 'YYYY-MM-DD'（日界判定的唯一依据）。"""
    return datetime.datetime.fromtimestamp(int(ms) / 1000, tz=BJ).strftime("%Y-%m-%d")


__all__ = [
    "BJ", "RIDER_ID_KEYS", "RIDER_NAME_KEYS", "TEAM_KEYS",
    "CREATE_KEYS", "ACCEPT_KEYS", "EXCLUDE_TYPE_KEYS",
    "order_val", "norm_team", "filter_by_team", "is_excluded_type", "is_completed",
    "is_valid_order", "accept_ms", "ms_to_ymd",
]
