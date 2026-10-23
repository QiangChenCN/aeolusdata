#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""考核看板 —— 违规处罚明细（投诉 / 差评 / 索赔口径数据源）。

⚠️ 取数已迁 Nest（2026-10-13 剥离）：考核看板的违规取数由 Nest
`AssessmentViolationFetchService` 独立完成（打风神接口 → 解析 → 入库），
与标准达成 / 服务质量的取数代码完全解耦。

落盘 → 入库（2026-10-23）：明细不再写 `apps/api/runtime/违规处罚明细-实时.json`，
改为写入 PG 表 `violation_realtime`（当天快照）与 `violation`（历史）；
本模块经 Nest 内部端点
`GET /api/assessment-internal/violations` 读取，只负责按口径统计。

指标口径（考核看板）：
  · 投诉单       = 违规分类=投诉   且 违规状态=成立的记录数
  · 差评单       = 违规分类=差评   且 违规状态=成立的记录数
  · 索赔单       = 违规分类=餐货损 且 违规状态=成立的记录数
  · 物流责取消单 = 违规分类=取消   且 违规状态=成立的记录数
  · 提前点送达单 = 违规类型**包含**「提前点送达」且 违规状态=成立的记录数
  · 不满意率     = (投诉单*5 + 差评单*5 + 索赔单) / 推配送单（百分比）
  · 物流妥投率   = 完成单量 / (完成单量 + 物流责取消单 + 提前点送达单*2)（百分比）

说明：
  · 站点归属按明细行「团队ID」，与 orders 的 teamId 是同一套站点 id。
  · 「违规状态」只有「成立 / 不成立」两种，只计「成立」。
  · 前四项看「违规分类」（精确相等）；「提前点送达单」看「违规类型」（子串包含）。
  · 两个比率的分母口径由调用方传入（推配送单量 / 完成单量）。

读侧 load_team_raw 从全站行里按「团队ID」过滤出本站点行（load_team / count_violations 不变）。
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
import datetime

from common import nest_client
from analytics.core import order_rules as OR

BJ = datetime.timezone(datetime.timedelta(hours=8))

# 考核看板自有违规明细：PG 表 `violation_realtime`（当天快照），
# 经 Nest 内部端点读取（端点按天返回全站行，本模块不再解析全站文件）。
VIOLATIONS_PATH = "/api/assessment-internal/violations"

# 指标键 ← CSV「违规分类」原始名（精确相等）。
CATEGORIES = {
    "投诉": "complaint",
    "差评": "bad_review",
    "餐货损": "claim",
    "取消": "cancel_liable",
}
# 指标键 ← CSV「违规类型」原始名的子串（真实取值形如 `提前点送达（索赔）`，故用包含匹配）。
TYPE_CONTAINS = {
    "提前点送达": "early_delivered",
}
STATUS_ESTABLISHED = "成立"
# 全部可在 count_violations 中统计的指标键（顺序即前端展示顺序）。
METRIC_KEYS = ("complaint", "bad_review", "claim", "cancel_liable", "early_delivered")
# 「会话失效」错误码等已由 Nest 侧统一处理，本模块不再持有副本。

TEAM_ID_KEYS = ("团队ID", "teamId")
CAT_KEYS = ("违规分类", "category")
TYPE_KEYS = ("违规类型", "type")
STATUS_KEYS = ("违规状态", "status")
REASON_KEYS = ("违规原因", "reason")

# 虚假报备商户出餐慢取消：违规类型子串 + 违规原因子串（业务确认口径）
FALSE_REPORT_TYPE_SUB = "违规取消"
FALSE_REPORT_REASON_SUB = "虚假报备了商户出货慢"

# 违规明细 ↔ 运单「高比单」JOIN 用的运单标识键：违规明细用「运单号」，运单明细用
# 「运单id / trackingId」，订单号 orderNo 作兜底键。同一运单在两侧取数口径下可能以
# 不同标识出现，故多键建索引，提升命中率（保守：未命中不计入高比单）。
WAYBILL_JOIN_KEYS = ("运单id", "trackingId", "订单号", "orderNo")


def _pick(row, keys):
    """多键兼容取值：返回第一个存在且非空的键的（去空白）字符串值。"""
    for k in keys:
        if k in row and row[k] not in (None, ""):
            return str(row[k]).strip()
    return ""


def day_range(date_str):
    """北京时间自然日 date_str 的 (start_ms, end_ms)：00:00:00.000 ~ 23:59:59.999。"""
    d = datetime.date.fromisoformat(date_str)
    start = datetime.datetime.combine(d, datetime.time(0, 0, 0), tzinfo=BJ)
    end = datetime.datetime.combine(d, datetime.time(23, 59, 59, 999000), tzinfo=BJ)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def parse_csv(text):
    """违规处罚 CSV 文本 → list[dict]（各字段去首尾空白）。

    空文本直接抛错：avoid 把「取数失败」当成「当天 0 条违规」落盘。
    （解析逻辑保留：供单测 / 调试使用；生产路径由 Nest 侧完成解析后落盘 dict。）
    """
    import csv
    import io
    if not (text or "").strip():
        raise RuntimeError("违规处罚 CSV 为空（疑似取数失败）")
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        rec = {k: (v or "").strip() for k, v in r.items() if k}
        if rec:
            out.append(rec)
    return out


def count_violations(rows, team_id=None):
    """按口径统计各项违规单量，返回 METRIC_KEYS 全键（缺失即 0）。

    team_id 可选：传入时只统计该站点记录（防御性；落盘数据本已按站点隔离）。
    「违规分类」精确匹配；「违规类型」用子串包含（同一记录可能同时命中两者，
    属不同维度，各自独立计数）。
    """
    counts = dict.fromkeys(METRIC_KEYS, 0)
    want = str(team_id).strip() if team_id is not None else None
    for r in (rows or []):
        if want is not None and _pick(r, TEAM_ID_KEYS) != want:
            continue
        if _pick(r, STATUS_KEYS) != STATUS_ESTABLISHED:
            continue
        key = CATEGORIES.get(_pick(r, CAT_KEYS))
        if key:
            counts[key] += 1
        vtype = _pick(r, TYPE_KEYS)
        if vtype:
            for sub, mk in TYPE_CONTAINS.items():
                if sub in vtype:
                    counts[mk] += 1
    return counts


def count_false_report_slow_unfinished(rows, team_id=None):
    """虚假报备商户出餐慢取消单：违规处罚明细中「违规类型含『违规取消』且 违规原因含
    『虚假报备了商户出货慢』且 违规状态=成立」的条数（业务确认口径）。

    区别于原 board.count_abnormal_unfinished：后者误用了运单明细的『是否异常报备』
    布尔字段，与违规处罚明细无关，导致数字失真。本函数改读违规明细，与投诉/差评/索赔/
    物流责取消同数据源、同「只计成立」口径。
    """
    cnt = 0
    want = str(team_id).strip() if team_id is not None else None
    for r in (rows or []):
        if want is not None and _pick(r, TEAM_ID_KEYS) != want:
            continue
        if _pick(r, STATUS_KEYS) != STATUS_ESTABLISHED:
            continue
        if FALSE_REPORT_TYPE_SUB not in _pick(r, TYPE_KEYS):
            continue
        if FALSE_REPORT_REASON_SUB not in _pick(r, REASON_KEYS):
            continue
        cnt += 1
    return cnt


def unsat_rate(complaint, bad_review, claim, pushed_order_volume):
    """不满意率(%)：(投诉单*5 + 差评单*5 + 索赔单) / 推配送单。分母为 0 返回 None。"""
    if not pushed_order_volume:
        return None
    score = (complaint or 0) * 5 + (bad_review or 0) * 5 + (claim or 0)
    return score * 100.0 / pushed_order_volume


def fulfillment_rate(delivery_completed, cancel_liable, early_delivered):
    """物流妥投率(%)：完成单量 / (完成单量 + 物流责取消单 + 提前点送达单*2)。分母为 0 返回 None。

    分子为「完成单量」（board 传入的 delivery_completed，即当天接单且配送成功的运单数）。
    """
    completed = delivery_completed or 0
    den = completed + (cancel_liable or 0) + (early_delivered or 0) * 2
    if not den:
        return None
    return completed * 100.0 / den


def group_by_team(rows):
    """按「团队ID」分组；团队ID 缺失的记录归入 '_unknown'。"""
    grouped = {}
    for r in rows:
        key = _pick(r, TEAM_ID_KEYS) or "_unknown"
        grouped.setdefault(key, []).append(r)
    return grouped


# ───────────────────── 高比单（物流责取消）JOIN 统计 ─────────────────────
def build_waybill_highvalue_map(delivery_orders):
    """运单标识 → 是否高比单(bool)，供违规明细按「运单号」JOIN 判定高比单。

    仅用运单侧数据（表 `delivery_realtime`，经内部端点读取）；键取 WAYBILL_JOIN_KEYS（运单id /
    trackingId / 订单号 多键兜底），值用 order_rules.is_high_value_order（与
    高比单T8超时 gaobi_order 同一「是否高比单」判定口径，保证两张高比单卡片一致）。
    """
    m = {}
    for o in (delivery_orders or []):
        w = str(OR.order_val(o, WAYBILL_JOIN_KEYS) or "").strip()
        if w:
            m[w] = OR.is_high_value_order(o)
    return m


def count_gaobi_cancel_liable(rows, team_id, hv_map):
    """高比单物流责取消：违规分类=取消 且 违规状态=成立 且 运单号命中高比单运单。

    与 count_violations 的 cancel_liable 同口径取「成立的取消」，再按「运单号」JOIN
    运单明细的「是否高比单」做二次过滤（仅明确命中高比单才计；运单号缺失 / 在配送快照
    中无对应记录 / 非高比单都不计入，保守口径）。
    """
    cnt = 0
    want = str(team_id).strip() if team_id is not None else None
    for r in (rows or []):
        if want is not None and _pick(r, TEAM_ID_KEYS) != want:
            continue
        if _pick(r, STATUS_KEYS) != STATUS_ESTABLISHED:
            continue
        # 仅在「违规分类=取消」命中 cancel_liable 时才计（与 count_violations 同口径取数）
        if CATEGORIES.get(_pick(r, CAT_KEYS)) != "cancel_liable":
            continue
        w = str(r.get("运单号", "")).strip()
        if hv_map.get(w):
            cnt += 1
    return cnt


# ───────────────────────── 读侧：读考核看板自有 PG 数据 ─────────────────────────
def _fetch_day_payload(date):
    """经 Nest 内部端点读某天**全站**违规明细；不可用（Nest 不可达 / PG 未启用）返回 None。"""
    try:
        j = nest_client.get_json(VIOLATIONS_PATH, {"date": str(date)}, timeout=60)
    except Exception:
        return None
    return j if isinstance(j, dict) else None


def load_team_raw(team_id, date):
    """读站点违规明细的原始包装 dict（含 fetched_at / rows）；不可用返回 None。

    数据源为 PG 表 `violation_realtime`（全站当天一份，与旧「全站单文件」同形态）：
    该表没有 team_id 列，明细行自带「团队ID」，故在此按团队ID过滤出本站点行，
    重建与单站点等价的包装，使 load_team / board 的调用方无需感知底层是表还是文件。
    """
    j = _fetch_day_payload(date)
    if not j or j.get("ok") is not True:
        return None
    all_rows = j.get("rows")
    if not isinstance(all_rows, list):
        return None
    team_rows = [r for r in all_rows if _pick(r, TEAM_ID_KEYS) == str(team_id)]
    return {
        "date": j.get("date") or date,
        "team_id": str(team_id),
        "fetched_at": j.get("fetched_at"),
        "fetch_ok": True,
        "fetch_error": None,
        "rows": team_rows,
    }


def load_team(team_id, date):
    """读站点违规明细 list[dict]；「未入库 / 读不到」返回 None（与「已入库但 0 条」区分）。"""
    raw = load_team_raw(team_id, date)
    if raw is None:
        return None
    if raw.get("fetch_ok") is False:
        return None
    rows = raw.get("rows")
    return rows if isinstance(rows, list) else None


__all__ = [
    "BJ", "VIOLATIONS_PATH", "CATEGORIES", "TYPE_CONTAINS",
    "STATUS_ESTABLISHED", "METRIC_KEYS", "WAYBILL_JOIN_KEYS",
    "day_range", "parse_csv", "count_violations", "unsat_rate", "fulfillment_rate",
    "group_by_team", "build_waybill_highvalue_map", "count_gaobi_cancel_liable",
    "load_team_raw", "load_team",
]
