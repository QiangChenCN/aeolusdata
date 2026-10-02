#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""实时数据看板 —— 违规处罚明细（投诉 / 差评 / 索赔口径数据源）。

数据源：风神「风控处罚」CSV（取数走 get_data.violation.download_csv 单一来源）。
本模块负责：日期窗口 → 取数 → 按站点分组 → 落盘原始层 → 本地按口径统计。

指标口径（实时数据看板，2026-09-19）：
  · 投诉单       = 违规分类=投诉   且 违规状态=成立的记录数
  · 差评单       = 违规分类=差评   且 违规状态=成立的记录数
  · 索赔单       = 违规分类=餐货损 且 违规状态=成立的记录数
  · 物流责取消单 = 违规分类=取消   且 违规状态=成立的记录数
  · 提前点送达单 = 违规类型**包含**「提前点送达」且 违规状态=成立的记录数
  · 不满意率     = (投诉单*5 + 差评单*5 + 索赔单) / 推配送单（百分比）
  · 物流妥投率   = 完成单量 / (完成单量 + 物流责取消单 + 提前点送达单*2)（百分比）

说明：
  · 站点归属按 CSV「团队ID」，与 orders 的 teamId 是同一套站点 id。
  · 「违规状态」只有「成立 / 不成立」两种，只计「成立」。
  · 前四项看「违规分类」（精确相等，见 CATEGORIES）；「提前点送达单」看
    「违规类型」（子串包含，见 TYPE_CONTAINS）—— 真实取值形如 `提前点送达（索赔）`，
    故必须用包含而非相等。
  · 两个比率的分母口径由调用方传入（推配送单量 / 完成单量），见unsat_rate / fulfillment_rate。
  · 落盘 dashboard/data/violation_{team}_{date}.json，与 orders 同目录同生命周期；
    包一层 dict，使「已刷新但 0 条」与「未刷新」可区分（save_raw 拒绝空 payload）。
"""
import os

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

import sys
import csv
import io
import datetime
from analytics import cache as CACHE

BJ = datetime.timezone(datetime.timedelta(hours=8))
RAW_KIND = "violation"

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
# 「会话失效」错误码的单一来源现在是 sources.session.SESSION_CODES，
# 判定逻辑也在 sources.session.is_session_error —— 这里不再保留副本。

TEAM_ID_KEYS = ("团队ID", "teamId")
CAT_KEYS = ("违规分类", "category")
TYPE_KEYS = ("违规类型", "type")
STATUS_KEYS = ("违规状态", "status")


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
    """
    if not (text or "").strip():
        raise RuntimeError("违规处罚 CSV 为空（疑似取数失败）")
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        rec = {k: (v or "").strip() for k, v in r.items() if k}
        if rec:
            out.append(rec)
    return out


def fetch_rows(start_ms, end_ms, cookie=None):
    """取 [start_ms, end_ms] 时间窗的违规明细（透传 get_data.violation 单一来源）。

    会话自愈：实现 sources/violation.py 文档约定已久的
    「会话失效由调用方捕获后重登重试」。

    为什么仍要留着这层：会话失效一旦发生，这一跳必须能自愈，而不是把 401 直接吐给上层。
    2026-09-23 起重登本身已归 Nest（`POST /api/fetch/aeolus-relogin`，Nest 的 ensure()
    会先做 validToken 探针）；本函数保留的是「捕获 → 强登 → 重试一次」的编排。

    因此捕获会话类错误后强制重登再取一次；只重试一次，仍失败则原样上抛。
    """
    from sources import session as GA
    from sources import violation as V

    def _download(start_ms, end_ms, cookie=None):
        text, _url = V.download_csv(start_ms, end_ms, cookie=cookie)
        return parse_csv(text)

    # 重登重试逻辑不再本地实现，统一走 sources.session.call_with_relogin
    rows, _cookie = GA.call_with_relogin(
        _download, int(start_ms), int(end_ms), cookie=cookie, max_relogin=1)
    return rows


def group_by_team(rows):
    """按「团队ID」分组；团队ID 缺失的记录归入 '_unknown'（调用方一般不使用）。"""
    grouped = {}
    for r in rows:
        key = _pick(r, TEAM_ID_KEYS) or "_unknown"
        grouped.setdefault(key, []).append(r)
    return grouped


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


def unsat_rate(complaint, bad_review, claim, pushed_order_volume):
    """不满意率(%)：(投诉单*5 + 差评单*5 + 索赔单) / 推配送单。分母为 0 返回 None。"""
    if not pushed_order_volume:
        return None
    score = (complaint or 0) * 5 + (bad_review or 0) * 5 + (claim or 0)
    return round(score * 1000.0 / pushed_order_volume) / 10


def fulfillment_rate(delivery_completed, cancel_liable, early_delivered):
    """物流妥投率(%)：完成单量 / (完成单量 + 物流责取消单 + 提前点送达单*2)。分母为 0 返回 None。

    分子为「完成单量」（board 传入的 delivery_completed，即当天接单且配送成功的运单数）。
    """
    completed = delivery_completed or 0
    den = completed + (cancel_liable or 0) + (early_delivered or 0) * 2
    if not den:
        return None
    return round(completed * 1000.0 / den) / 10


def save_team(team_id, date, rows, ok=True, error=None):
    """按站点落盘原始违规明细 —— 实际写入在 Nest（`cache.save_violation` 转发）。

    ok=False 表示「本次拉取失败」：**仍然落盘**（保留旧 rows 便于事后回查），但置
    fetch_ok=False，使 load_team 返回 None → 实时看板显示「—」。
    为什么必须记这个标记：同一天往往会被反复刷新。若某次拉取失败却什么都不写，
    盘上留着上一次成功的旧数据，看板会把旧数据当成当天数据继续算 —— 数字照常
    显示、但已经失真，且完全无报错（2026-09-22 排查 401 时发现的静默失真风险）。

    包装格式（date / team_id / fetched_at / fetch_ok / fetch_error / rows）由 Nest 组装，
    读侧是 `load_team_raw` —— 这样「该格式长什么样」全仓只有一处定义。
    """
    return CACHE.save_violation(str(team_id), date, rows, ok=ok, error=error)


def load_team_raw(team_id, date):
    """读站点违规明细的原始落盘 dict（含 fetch_ok / fetch_error / fetched_at）；未落盘返回 None。"""
    raw = CACHE.load_raw(RAW_KIND, str(team_id), date)
    return raw if isinstance(raw, dict) else None


def load_team(team_id, date):
    """读站点违规明细 list[dict]；「未刷新」或「本次拉取失败」都返回 None（与「已刷新但 0 条」区分）。"""
    raw = load_team_raw(team_id, date)
    if raw is None:
        return None
    if raw.get("fetch_ok") is False:
        return None   # 拉取失败：不把盘上的旧数据当成本次有效数据
    rows = raw.get("rows")
    return rows if isinstance(rows, list) else None


def mark_failed(team_id, date, error):
    """标记该站点该日期「本次违规明细拉取失败」：保留旧 rows 便于回查，但置 fetch_ok=False。"""
    old = (load_team_raw(team_id, date) or {}).get("rows") or []
    return save_team(team_id, date, old, ok=False, error=error)


def fetch_grouped(start_date, end_date):
    """取 [start_date, end_date]（北京时间自然日闭区间）违规明细并按站点分组。

    一次取数供全量刷新使用（接口无站点参数，返回账号权限下全部站点）。
    """
    start_ms = day_range(start_date)[0]
    end_ms = day_range(end_date)[1]
    return group_by_team(fetch_rows(start_ms, end_ms))


__all__ = [
    "BJ", "RAW_KIND", "CATEGORIES", "TYPE_CONTAINS", "STATUS_ESTABLISHED", "METRIC_KEYS",
    "day_range", "parse_csv", "fetch_rows", "group_by_team",
    "count_violations", "unsat_rate", "fulfillment_rate",
    "save_team", "load_team_raw", "load_team", "mark_failed", "fetch_grouped",
]
