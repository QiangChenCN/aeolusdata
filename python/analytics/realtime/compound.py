#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单均复合超时时长 —— 考核方案口径（2026-10-10）。

指标口径
--------
单均复合超时时长 = (轻度 + 普通 + 严重超时时长) / 剔除前有效完单

· 分母「剔除前有效完单」：有效完成单（配送成功 + 未作弊 + 非逆向 + 非改派，
  复用 order_rules.is_valid_order 单一来源）；
  「剔除前」= 分母不做圈单剔除（兜底/二呼/二次配送的剔除只作用于分子）。
  ⚠️ 归属：统计**导出文件内的全部订单**，不再按「终态时间」归属到某一天
  （与 timeout 口径一致：用户要求按导出所有订单统计）。
· 圈单（仅作用分子）：
  - 大网考核单范围 / 兜底单 / 二次配送单：运单明细**没有**对应标记字段，
    无法识别，当前不剔除（待数据源补齐字段后再收口）。
  - 二呼单：isSecondCall=真 且 配送成功（站点承接并妥投）→ 剔除。
· 超时秒数 X = 骑手送达时间 - 基准时间：
  - 即时单：基准 = 平台期望送达时间 platformExpectAt（点值毫秒）；
  - 预订单：platformExpectAt 为「起~止」时间片字符串，基准 = 区间终点
    （最晚送达时间，即"生效时间片"口径）；为点值时直接用该点值
    （"未生效时间片"近似同口径）。
  - 「出餐后呼单 → 基准由预测T+8min 改为骑士T」：明细无呼单类型字段，
    暂不实现（同上，待字段补齐）。
· 分段公式（X = 超时秒数，严重档封顶 90 分钟；与考核方案表格一致）：
      X <= 480            → 0（不考核，T8 准时送达）
      480 < X <= 900      → X - 480
      900 < X <= 1800     → 420 + (X - 900) * 1.5
      X > 1800            → min(420 + 900*1.5 + (X - 1800) * 4, 5400)

归属
----
运单按「终态时间」（trackingFinishAt / 运单完成时间）归属到考核周期（日/月），
与订单落盘窗口（按运单完成时间拉数）一致，跨午夜单不会漏。

月累计
------
month_summary(team_id, date)：从当月 1 号累加到 date，逐日读原始层聚合，
结果走进程内缓存（cache.get_result / put_result，month 维度键）。
"""
import datetime

from analytics import cache as CACHE
from analytics import order_rules as OR

BJ = datetime.timezone(datetime.timedelta(hours=8))

# ---- 取数键（live 英文键 / 导出中文键兼容）----
PLATFORM_EXPECT_KEYS = OR.PLATFORM_EXPECT_KEYS          # platformExpectAt / 平台期望时间
DELIVER_KEYS = OR.DELIVER_KEYS                          # deliverAt / 骑手送达时间
FINISH_KEYS = ("trackingFinishAt", "运单完成时间")        # 终态时间（保留供 finish_ms 兜底，已不再用于归属过滤）
TYPE_KEYS = ("trackingType", "运单类型", "配送类型名称")   # 即时单 / 预订单
SECOND_CALL_KEYS = ("isSecondCall", "是否二呼单")

# ---- 分段阈值（秒）----
T_NONE = 480        # <=8min 不考核
T_LIGHT = 900       # (8,15] 轻度
T_NORMAL = 1800     # (15,30] 普通；>30 严重
SEVERE_CAP = 5400   # 严重超时时长封顶 90 分钟

CATEGORY_NONE = "none"
CATEGORY_LIGHT = "light"
CATEGORY_NORMAL = "normal"
CATEGORY_SEVERE = "severe"


def _parse_ms(v):
    """毫秒时间戳 / 'YYYY-MM-DD HH:MM:SS' → 毫秒 int；无法解析返回 None。"""
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    try:
        return int(s)
    except (ValueError, TypeError):
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return int(datetime.datetime.strptime(s, fmt)
                       .replace(tzinfo=BJ).timestamp() * 1000)
        except ValueError:
            continue
    return None


def _range_end_ms(v):
    """'起~止' 时间片字符串 → 区间终点（最晚送达时间）毫秒。"""
    s = str(v or "").strip()
    if "~" not in s:
        return None
    end = s.split("~")[-1].strip()
    return _parse_ms(end)


def baseline_ms(o):
    """超时基准时间（毫秒）：即时单=平台期望时间；预订单/区间串=区间终点。"""
    raw = OR.order_val(o, PLATFORM_EXPECT_KEYS)
    if raw is None:
        return None
    s = str(raw).strip()
    if "~" in s:
        return _range_end_ms(s)
    return _parse_ms(s)


def lateness_seconds(o):
    """超时秒数 X = 骑手送达时间 - 基准时间；无法判定返回 None。"""
    deliver = _parse_ms(OR.order_val(o, DELIVER_KEYS))
    base = baseline_ms(o)
    if deliver is None or base is None:
        return None
    return (deliver - base) / 1000.0


def is_second_call(o):
    """二呼单判定：isSecondCall / 是否二呼单 为真。"""
    return OR._is_truthy_flag(OR.order_val(o, SECOND_CALL_KEYS))


def in_scope(o):
    """圈单判定（分子口径）：配送成功 且 非二呼单。

    说明：大网考核单范围 / 兜底单 / 二次配送单无标记字段，无法剔除；
    二呼单按「站点承接并最终妥投」近似 = 本明细中配送成功的二呼单。
    """
    if not OR.is_completed(o):
        return False
    return not is_second_call(o)


def category(x):
    """超时秒数 → 分档：none / light / normal / severe。"""
    if x is None or x <= T_NONE:
        return CATEGORY_NONE
    if x <= T_LIGHT:
        return CATEGORY_LIGHT
    if x <= T_NORMAL:
        return CATEGORY_NORMAL
    return CATEGORY_SEVERE


def compound_overtime_sec(x):
    """考核方案分段公式（秒）。X=None 或 <=480 → 0；严重档封顶 90 分钟。"""
    if x is None or x <= T_NONE:
        return 0.0
    if x <= T_LIGHT:
        return x - T_NONE
    if x <= T_NORMAL:
        return 420.0 + (x - T_LIGHT) * 1.5
    return min(420.0 + 900.0 * 1.5 + (x - T_NORMAL) * 4.0, float(SEVERE_CAP))


def finish_ms(o):
    """终态时间（毫秒）：运单完成时间，缺失兜底骑手送达时间。"""
    ms = _parse_ms(OR.order_val(o, FINISH_KEYS))
    if ms is None:
        ms = _parse_ms(OR.order_val(o, DELIVER_KEYS))
    return ms


def analyze_daily(orders, date):
    """单日复合超时聚合：分子（加权超时时长秒）+ 分母（剔除前有效完单）+ 分档计数。

    归属：统计导出文件内的全部订单，不再按终态时间归属日（与 timeout 口径一致）。
    返回 dict：numerator_sec / denominator / avg_min / counts / assessed /
    excluded_second_call / excluded_no_baseline。
    """
    counts = {CATEGORY_NONE: 0, CATEGORY_LIGHT: 0, CATEGORY_NORMAL: 0, CATEGORY_SEVERE: 0}
    numerator = 0.0
    denominator = 0
    assessed = 0
    excluded_second_call = 0
    excluded_no_baseline = 0
    # 按「导出的全部订单」统计，不再按终态时间归属日过滤（与 timeout 一致：用户要求）。
    for o in (orders or []):
        # 分母：剔除前有效完单（不圈单）
        if OR.is_valid_order(o):
            denominator += 1
        # 分子：圈单 + 可计算基准
        if not in_scope(o):
            if is_second_call(o) and OR.is_completed(o):
                excluded_second_call += 1
            continue
        x = lateness_seconds(o)
        if x is None:
            excluded_no_baseline += 1
            continue
        assessed += 1
        counts[category(x)] += 1
        numerator += compound_overtime_sec(x)
    avg_sec = round(numerator / denominator, 2) if denominator > 0 else None
    return {
        "numerator_sec": round(numerator, 1),
        "denominator": denominator,
        "avg_sec": avg_sec,
        "counts": counts,
        "assessed": assessed,
        "excluded_second_call": excluded_second_call,
        "excluded_no_baseline": excluded_no_baseline,
    }


__all__ = [
    "PLATFORM_EXPECT_KEYS", "DELIVER_KEYS", "FINISH_KEYS", "TYPE_KEYS", "SECOND_CALL_KEYS",
    "T_NONE", "T_LIGHT", "T_NORMAL", "SEVERE_CAP",
    "CATEGORY_NONE", "CATEGORY_LIGHT", "CATEGORY_NORMAL", "CATEGORY_SEVERE",
    "baseline_ms", "lateness_seconds", "is_second_call", "in_scope", "category",
    "compound_overtime_sec", "finish_ms", "analyze_daily",
]
