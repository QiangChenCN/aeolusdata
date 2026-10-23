#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""配送超时看板 —— 站点维度配送时效统计（汇总 + 骑手下钻 + 订单明细）。

与「实时数据看板」同源：直接从本地运单原始层（orders）重算，零 HTTP 请求；
超时时长口径与 order_rules.over_expect_seconds / is_t8_timeout 完全一致。

指标口径（运单按「骑手接单时间」归属北京时间自然日）：
  · 推配送单量    = 当天接单的全部运单（count_pushed_orders，不剔除任何状态）
  · 配送成功单量  = 当天接单且 状态=配送成功(state 40) 的运单
  · 超时单量(T8)  = 配送成功 且 超平台期望时间 > 8 分钟（is_t8_timeout）
  · 准时率(T8加权) = (T8准时单 - 虚假报备出餐慢取消单 - 提前点送达单*2) / (有效完单 + 高笔单T8非准时单*1 + 星巴克非准时单*2)
  · 单均复合超时时长 = 考核方案口径（轻度+普通+严重加权超时 / 剔除前有效完单），
    按【终态时间】归属；实现见 compound.py（字段 compound_overtime_sec /
    avg_compound_overtime_sec / compound_detail）。单位：秒。

  注：原「配送中单量 / 预估超时单量 / 预估准时率」已移除——运单刷新按「运单完成时间」拉数，
  在途单无完成时间而被排除，数据源无法提供在途单，相关指标无数据支撑。
  · 严重度分桶    = 仅对超时单按「超多少分钟」分三档：8-15 / 15-30 / ≥30

下钻数据（供前端 click 站点→骑手→订单）：
  · riders：本站内「准时率未达 100%」的骑手（即超时单量 > 0），含该骑手的
            delivered / timeout / ontime_rate / overtime_min / timeout_orders(明细)

严重度分档边界（含上界）：8 分 < 超时长 ≤ 15 分 → "8-15"；15 分 < 超时长 ≤ 30 分 → "15-30"；
超时长 > 30 分 → ">=30"（is_t8_timeout 已保证超时长 > 8 分，故每个超时单必落一档）。

依赖：
  · analytics.core.cache        原始数据层读写 + 进程内结果缓存
  · analytics.core.order_rules  完成态 / 超时 / 取值 / 接单时间归属（与有效单口径同源）
  · analytics.domains.assessment.board 配送完成单计数 / 准时率（单一来源，避免重复实现）
  · 站点名：由前端经专用站点目录接口（GET /api/teams，风神全量站点）解析后覆盖，
            本模块不再内置硬编码站点名兜底清单
"""
import os

from analytics.core.paths import ROOT, PY_HOME, _ROOT  # noqa: E402,F401 <<<


import datetime
from analytics.core import cache as CACHE
from analytics.core import order_rules as OR
from analytics.domains.delivery_timeout import data_source as DTS
from analytics.domains.assessment import compound as COMP
from analytics.domains.assessment import violations as VIOL

BJ = datetime.timezone(datetime.timedelta(hours=8))
MODULE = "assessment_timeout_v2"   # v2: ontime_rate 改为 T8 加权口径（新增 t8_rate_detail）

# 严重度分桶键（与前端约定一致）
BUCKET_LIGHT = "8-15"     # 8 分 < 超时长 ≤ 15 分
BUCKET_MID = "15-30"      # 15 分 < 超时长 ≤ 30 分
BUCKET_HEAVY = ">=30"     # 超时长 > 30 分

STATE_DESC_KEYS = ("状态描述", "stateDesc", "statusDesc", "statusName")
RIDER_ID_KEYS = ("knightId", "骑手ID", "riderId", "riderID")
RIDER_NAME_KEYS = ("knightName", "骑手姓名", "riderName")

# T8 加权准时率取数键（运单维度）
FALSE_MARK_REASON_KEYS = ("虚假标记原因", "falseMarkReason")                 # 虚假标记项原因
MERCHANT_NAME_KEYS = ("平台商家名称", "merchantName", "platformMerchantName")  # 商户名（星巴克识别）
STATE_KEYS = ("状态", "state", "status", "statusCode", "orderStatus")

# 运单明细取数键（中文键样本 / 英文键 live 兼容）
ORDER_ID_KEYS = ("运单ID", "trackingId", "orderId")                       # 运单ID
FLOW_NO_KEYS = ("商家订单流水号", "merchantOrderSerial", "订单号", "orderNo",   # 流水号 = 风神导出「商家订单流水号」（每日商家序号），兜底订单号 / 平台运单ID
                 "平台运单ID", "platformOrderId")
MERCHANT_ID_KEYS = ("平台商家ID", "merchantId", "shopId")                 # 商家ID
TEAM_NAME_KEYS = ("团队/站点名称", "teamName", "站点名称")                  # 站点姓名（订单自带，兜底用）
ARRIVE_KEYS = ("最近到店时间", "arriveAt", "骑手到店时间")                 # 到店时间
PICKUP_KEYS = ("最近取货时间", "pickupAt", "骑手取餐时间")                 # 取餐时间
DELIVER_AT_KEYS = ("完成时间", "运单完成时间", "deliverAt", "骑手送达时间")  # 送达时间（完成）
EXPECT_KEYS = ("平台期望时间", "platformExpectAt", "当前预计送达时间")       # 平台期望时间


def _severity_bucket(over_min):
    """超时分钟 → 严重度分桶键（字段 over_min 已保证 > 8）。"""
    if over_min <= 15:
        return BUCKET_LIGHT
    if over_min <= 30:
        return BUCKET_MID
    return BUCKET_HEAVY


def _to_min(sec):
    """秒 → 保留 1 位小数的分钟。"""
    return round(sec / 60.0, 1)


def _int_ms(v):
    """取值 → 毫秒整数（非法返回 None）。

    兼容两类输入：数字 / 数字字符串（毫秒）、以及 'YYYY-MM-DD HH:MM:SS'
    （或 'YYYY-MM-DD HH:MM'）形式的中文字符串时间——真实落盘数据同时带有
    「英文毫秒键」与「中文字符串时间键」两套，命中字符串键时也能正确转毫秒。
    """
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip()
    if not s:
        return None
    try:
        return int(s)
    except (ValueError, TypeError):
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return int(datetime.datetime.strptime(s, fmt).replace(tzinfo=BJ).timestamp() * 1000)
        except ValueError:
            continue
    return None


def _fmt_ms(ms):
    """毫秒时间戳 → 北京时间 'YYYY-MM-DD HH:MM:SS'；非法返回 None。"""
    if ms is None:
        return None
    try:
        return datetime.datetime.fromtimestamp(int(ms) / 1000, tz=BJ).strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError, OverflowError):
        return None


def _fmt_expect(v):
    """平台期望时间：毫秒时间戳 → 北京时间字符串；'HH:MM:SS' 区间/时刻字符串原样返回。"""
    if v is None:
        return None
    s = str(v).strip()
    # 形如 '11:25:00' 或 '11:25:00~11:45:00' 的字符串直接保留（无日期，仅时刻）
    if ":" in s and not s.lstrip("-").replace("~", "").isdigit():
        return s
    try:
        return _fmt_ms(int(v))
    except (ValueError, TypeError):
        return s


def _dur_sec(a, b):
    """两段毫秒时间戳之差（秒）；任一缺失返回 None。"""
    if a is None or b is None:
        return None
    try:
        return int(round((int(b) - int(a)) / 1000.0))
    except (ValueError, TypeError):
        return None


def _rider_key(o):
    rid = OR.order_val(o, RIDER_ID_KEYS)
    if rid not in (None, ""):
        return str(rid)
    rname = OR.order_val(o, RIDER_NAME_KEYS)
    if rname not in (None, ""):
        return "name:" + str(rname)
    return "未知"


def is_delivery_failed(o):
    """配送失败判定：状态描述=配送失败 或 状态=90。"""
    desc = str(OR.order_val(o, STATE_DESC_KEYS) or "")
    if desc == "配送失败":
        return True
    st = str(OR.order_val(o, STATE_KEYS) or "")
    return st in ("90", "90.0")


def is_false_slow_cancel(o):
    """虚假报备出餐慢取消单：配送失败 且 虚假标记原因含『商户不出货』。"""
    if not is_delivery_failed(o):
        return False
    reason = str(OR.order_val(o, FALSE_MARK_REASON_KEYS) or "")
    return "商户不出货" in reason


def is_starbucks(o):
    """星巴克订单判定：平台商家名称含『星巴克』子串。"""
    return "星巴克" in str(OR.order_val(o, MERCHANT_NAME_KEYS) or "")


def analyze(orders, date, now_ms, early_delivered=0):
    """纯计算：给定已加载的 orders 列表、归属日、当前北京时间毫秒。

    返回站点维度统计 + 骑手下钻数据（不含 team 元信息，由 build_one 装配）。
    """
    # 配送成功单量 / 超时 / 准时率：按「导出的全部订单」统计，不再按归属日（接单时间）过滤，
    # 避免跨天单、缺接单时间单被排除（用户要求：按导出所有订单统计）。
    completed = sum(1 for o in (orders or []) if OR.is_completed(o))
    timeout = 0
    buckets = {BUCKET_LIGHT: 0, BUCKET_MID: 0, BUCKET_HEAVY: 0}
    max_over = None
    details = []                     # 超时订单明细（按超时分钟降序）
    riders = {}                      # 骑手聚合（仅含超时单的骑手）
    valid_completed = 0              # 有效完单（配送完成+未作弊+非逆向+非改派）
    false_slow_cancel = 0            # 虚假报备出餐慢取消单
    high_value_timeout = 0           # 高笔单 T8 非准时单
    starbucks_timeout = 0            # 星巴克非准时单

    for o in (orders or []):
        # 不再按归属日过滤：导出文件内的每一单都参与统计
        is_comp = OR.is_completed(o)
        # T8 加权准时率取数项：统一以「配送成功」单为口径（分子分母同一人群，
        # 不再用 is_valid_order 过滤，避免逆向/改派等单进出不一致）。
        if is_false_slow_cancel(o):
            false_slow_cancel += 1
        if OR.is_high_value_order(o) and is_comp and OR.is_t8_timeout(o):
            high_value_timeout += 1
        if is_starbucks(o) and is_comp and OR.is_t8_timeout(o):
            starbucks_timeout += 1
        if is_comp:
            valid_completed += 1
            # 骑手维度：先登记骑手并累加「配送成功单量」（所有完单都计，不止超时单）
            rk = _rider_key(o)
            r = riders.setdefault(rk, {
                "rider_id": OR.order_val(o, RIDER_ID_KEYS),
                "rider_name": OR.order_val(o, RIDER_NAME_KEYS),
                "delivered": 0, "timeout": 0,
                "overtime_min": 0.0, "timeout_orders": [],
            })
            r["delivered"] += 1
            if OR.is_t8_timeout(o):
                timeout += 1
                sec = OR.over_expect_seconds(o)
                if sec is None:
                    continue
                over_min = _to_min(sec)
                # 复合超时时长(秒)：考核方案分段公式，作用于「超时秒数 = 送达 - 平台期望」
                _x = COMP.lateness_seconds(o)
                compound_sec = COMP.compound_overtime_sec(_x) if _x is not None else 0.0
                buckets[_severity_bucket(over_min)] += 1
                if max_over is None or over_min > max_over:
                    max_over = over_min
                accept_ms = _int_ms(OR.order_val(o, OR.ACCEPT_KEYS))
                arrive_ms = _int_ms(OR.order_val(o, ARRIVE_KEYS))
                pickup_ms = _int_ms(OR.order_val(o, PICKUP_KEYS))
                deliver_ms = _int_ms(OR.order_val(o, DELIVER_AT_KEYS))
                expect_raw = OR.order_val(o, EXPECT_KEYS)
                det = {
                    # —— 维度 ——
                    "order_id": OR.order_val(o, ORDER_ID_KEYS),
                    "flow_no": OR.order_val(o, FLOW_NO_KEYS),
                    "rider_id": r["rider_id"],
                    "rider_name": r["rider_name"],
                    "merchant_id": OR.order_val(o, MERCHANT_ID_KEYS),
                    "merchant_name": OR.order_val(o, MERCHANT_NAME_KEYS),
                    # —— 时间戳（北京时间字符串） ——
                    "accept_time": _fmt_ms(accept_ms),        # 骑手接单时间
                    "arrive_time": _fmt_ms(arrive_ms),        # 骑手到店时间
                    "pickup_time": _fmt_ms(pickup_ms),        # 骑手取餐时间
                    "deliver_time": _fmt_ms(deliver_ms),      # 骑手送达时间
                    "expect_time": _fmt_expect(expect_raw),   # 平台期望时间
                    # —— 时长（秒） ——
                    "arrive_dur_sec": _dur_sec(accept_ms, arrive_ms),   # 到店时长 = 到店 - 接单
                    "wait_dur_sec": _dur_sec(arrive_ms, pickup_ms),    # 等餐时长 = 取餐 - 到店
                    "deliver_dur_sec": _dur_sec(pickup_ms, deliver_ms),# 配送时长 = 送达 - 取餐
                    # —— 超时指标 ——
                    "over_min": over_min,                                  # 超平台期望时长（分钟）
                    "compound_overtime_sec": round(compound_sec, 1),       # 复合超时时长（秒，考核方案分段）
                    "severity": _severity_bucket(over_min),
                    "is_high_value": OR.is_high_value_order(o),           # 是否高比单（高笔单），用于「高比单T8超时」下钻过滤
                }
                details.append(det)
                r["timeout"] += 1
                r["overtime_min"] += over_min
                r["timeout_orders"].append(det)

    details.sort(key=lambda d: d["over_min"], reverse=True)

    # T8 准时单 = 有效完单 - （有效）超时单，二者同口径，准时率必落 [0,100]
    t8_ontime = valid_completed - timeout

    # 骑手下钻：仅保留「准时率未达 100%」（即超时单量 > 0）的骑手
    rider_list = []
    for r in riders.values():
        if r["timeout"] > 0:
            r["ontime_rate"] = (r["delivered"] - r["timeout"]) * 100.0 / r["delivered"]
            # 单均复合超时时长（分钟）= 超时单复合超时总时长 / 配送成功单量
            r["avg_overtime_min"] = round(r["overtime_min"] / r["delivered"], 2) if r["delivered"] else None
            r["overtime_min"] = round(r["overtime_min"], 1)
            rider_list.append(r)
    rider_list.sort(key=lambda r: r["avg_overtime_min"] if r["avg_overtime_min"] is not None else -1, reverse=True)

    # 推配送单量 = 导出的全部订单（不再按接单时间归属日过滤）
    pushed = len(orders) if isinstance(orders, list) else len((orders or {}).get("orders") or [])

    # 单均复合超时时长（考核方案口径，终态时间归属，见 compound.py）
    comp = COMP.analyze_daily(orders, date)

    # T8 加权准时率（站点级）：分子扣减作弊/违规类「虚高准时」，分母加权难送订单
    #   T8准时单 = 有效完单 - 有效超时单（同口径，必落 [0,100]）
    #   分子 = T8准时单 - 虚假报备出餐慢取消单 - 提前点送达单*2   （*2 = 违规惩罚加倍）
    #   分母 = 有效完单 + 高笔单T8非准时单*1 + 星巴克非准时单*2
    _num = t8_ontime - false_slow_cancel - early_delivered * 2
    _den = valid_completed + high_value_timeout * 1 + starbucks_timeout * 2
    t8_rate = _num * 100.0 / _den if _den else None

    return {
        "pushed_order_volume": pushed,
        "delivery_completed": completed,
        "timeout_total": timeout,
        "ontime_rate": t8_rate,
        "t8_rate_detail": {
            "t8_ontime": t8_ontime,
            "false_slow_cancel": false_slow_cancel,
            "early_delivered": early_delivered,
            "valid_completed": valid_completed,
            "high_value_timeout": high_value_timeout,
            "starbucks_timeout": starbucks_timeout,
        },
        "compound_overtime_sec": comp["numerator_sec"],
        "avg_compound_overtime_sec": comp["avg_sec"],
        "compound_detail": comp,
        "max_over_min": max_over,
        "buckets": buckets,
        "timeout_orders": details,
        "riders": rider_list,
    }


def build_one(team_id, date=None):
    """单站配送超时统计。date 缺省取北京时间当天；now 取当前北京时间。

    原始运单缺失即返回 need_refresh=True（运单由本看板「刷新」写入 PG 实时运单明细表，
    不再依赖考核看板的落盘文件）。命中进程内结果缓存直接返回。
    """
    team_id = str(team_id)
    if date is None:
        date = CACHE.today_ymd()
    cached = CACHE.get_result(MODULE, team_id, date, "", "cache")
    if cached is not None:
        return cached
    orders = DTS.load_orders(team_id, date)
    if orders is None:
        return {
            "team_id": team_id,
            "team_name": team_id,
            "need_refresh": True,
            "data_status": "no_data",
            "data_note": "今日运单明细尚未入库，请点本看板「刷新」拉取运单明细",
            "pushed_order_volume": None,
            "delivery_completed": None,
            "timeout_total": None,
            "ontime_rate": None,
            "compound_overtime_sec": 0,
            "avg_compound_overtime_sec": None,
            "compound_detail": None,
            "max_over_min": None,
            "buckets": {BUCKET_LIGHT: None, BUCKET_MID: None, BUCKET_HEAVY: None},
            "timeout_orders": [],
            "riders": [],
        }
    # 提前点送达单（违规 CSV，站级）用于 T8 加权准时率分子扣减
    vrows = VIOL.load_team(team_id, date)
    vc = VIOL.count_violations(vrows, team_id) if vrows else {}
    early_delivered = (vc or {}).get("early_delivered", 0)
    now_ms = int(datetime.datetime.now(BJ).timestamp() * 1000)
    metrics = analyze(orders, date, now_ms, early_delivered)
    result = {
        "team_id": team_id,
        "team_name": team_id,
        "need_refresh": False,
        "data_status": "ok",
        "data_note": None,
    }
    result.update(metrics)
    CACHE.put_result(MODULE, team_id, date, "", "cache", result)
    return result


if __name__ == "__main__":
    import json as _json
    import argparse as _ap
    _a = _ap.ArgumentParser()
    _a.add_argument("--team", required=True)
    _a.add_argument("--date", default=CACHE.today_ymd())
    _ns = _ap.parse_args()
    print(_json.dumps(build_one(_ns.team, _ns.date), ensure_ascii=False, indent=2))
