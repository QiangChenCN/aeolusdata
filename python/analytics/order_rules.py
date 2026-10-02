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

# ---- 平台期望 / 超时口径（实时数据看板 T8 超时单，2026-09-19）----
# 「超平台期望送达时长」由平台算好，导出为 'HH:MM:SS' 字符串，恒等于
#   （骑手送达时间 deliverAt - 平台期望时间 platformExpectAt）。
# 注意 platformExpectAt 有约 1 成运单导出为「区间字符串」（如 '11:25:00~11:45:00'），
# 这类单平台不给「是否超时」结论（时长为 00:00:00），一律按「未超时」处理。
# 平台自带 isOverPlatformExpect 是「>0 即超」；T8 把阈值提到 8 分钟（见下）。
PLATFORM_EXPECT_KEYS = ("platformExpectAt", "平台期望时间")
DELIVER_KEYS = ("deliverAt", "骑手送达时间")
OVER_EXPECT_KEYS = ("overPlatformExpectDuration", "超平台期望送达时长")

# T8 超时阈值：超出平台期望时间超过 8 分钟即记「T8 超时单」。
T8_TIMEOUT_MIN = 8

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


def is_reverse_order(o):
    """逆向单判定：isReverse / 是否逆向单 为真即记逆向单。"""
    for k in EXCLUDE_TYPE_KEYS["reverse"]:
        if k in o and o[k] not in (None, ""):
            if _is_truthy_flag(o[k]):
                return True
    return False


def is_reassign_order(o):
    """改派单判定：isReassign / 是否改派 为真即记改派单。"""
    for k in EXCLUDE_TYPE_KEYS["reassign"]:
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


def parse_hms_seconds(v):
    """'HH:MM:SS' / 'MM:SS' → 秒；空 / 非法返回 None。"""
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    parts = s.split(":")
    if len(parts) not in (2, 3):
        return None
    try:
        nums = [int(float(p)) for p in parts]
    except (ValueError, TypeError):
        return None
    if len(nums) == 3:
        h, m, sec = nums
    else:
        h, m, sec = 0, nums[0], nums[1]
    return h * 3600 + m * 60 + sec


def over_expect_seconds(o):
    """超出平台期望时间的秒数（>0 即超时）；无法判定返回 None。

    优先取平台已算好的「超平台期望送达时长」('HH:MM:SS')；该字段缺失时用
    「骑手送达时间 - 平台期望时间」兜底（两者均为毫秒时间戳）。两者都拿不到
    （如 platformExpectAt 是区间字符串）返回 None。
    """
    sec = parse_hms_seconds(order_val(o, OVER_EXPECT_KEYS))
    if sec is not None:
        return sec
    deliver = order_val(o, DELIVER_KEYS)
    expect = order_val(o, PLATFORM_EXPECT_KEYS)
    if deliver is None or expect is None:
        return None
    try:
        d_ms, e_ms = int(deliver), int(expect)
    except (ValueError, TypeError):
        return None
    return int((d_ms - e_ms) / 1000)


def is_t8_timeout(o, threshold_min=None):
    """T8 超时单判定：配送成功 且 超出平台期望时间 > 8 分钟。

    「超时」时长以平台「超平台期望送达时长」为准（= 骑手送达时间 - 平台期望时间），
    与 isOverPlatformExpect（>0 即超）同源，但阈值提升到 8 分钟。阈值可覆盖。
    无法判定超时时长的单不计入（返回 False）。
    """
    if not is_completed(o):
        return False
    thr = T8_TIMEOUT_MIN if threshold_min is None else threshold_min
    sec = over_expect_seconds(o)
    return sec is not None and sec > thr * 60


def count_pushed_orders(orders, start, end=None):
    """推配送单量：运单明细中「按骑手接单时间(acceptAtLast，缺失兜底创建时间)归属到
    [start, end] 北京时间自然日」的订单数。

    口径（实时数据看板，2026-09-19）：统计**所有**订单，按骑手接单时间归属当天，
    **其他都不剔除** —— 不要求配送完成、不排除逆向单/改派单/作弊/异常报备。
    无法归属（任何时间字段都缺失）的运单跳过。

    已知取舍（与历史看板一致，实时看板当前阶段不处理）：运单明细以「终态时间」窗口
    落盘（阶段 0，见 Nest 的 fetch/refresh-all.service.ts::refreshOrders），因此「接单当天、次日完成」的跨午夜单
    不会落在当天文件里 —— 该单量在当天会被少算，留待历史看板阶段再纠偏。
    """
    end = end or start
    cnt = 0
    for o in (orders or []):
        ms = accept_ms(o)
        if ms is None:
            continue
        d = ms_to_ymd(ms)
        if start <= d <= end:
            cnt += 1
    return cnt


__all__ = [
    "BJ", "RIDER_ID_KEYS", "RIDER_NAME_KEYS", "TEAM_KEYS",
    "CREATE_KEYS", "ACCEPT_KEYS", "EXCLUDE_TYPE_KEYS",
    "PLATFORM_EXPECT_KEYS", "DELIVER_KEYS", "OVER_EXPECT_KEYS", "T8_TIMEOUT_MIN",
    "order_val", "norm_team", "filter_by_team", "is_excluded_type", "is_completed",
    "is_valid_order", "is_reverse_order", "is_reassign_order",
    "accept_ms", "ms_to_ymd", "parse_hms_seconds",
    "over_expect_seconds", "is_t8_timeout", "count_pushed_orders",
]
