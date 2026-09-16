#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标准达成看板 —— 本地落盘缓存（按 站点 × 日期）。

用途：降低对风神接口的实时依赖，杜绝「切站点 / 切维度」触发实时请求。

两层缓存（2026-09-09 重构）：
  1. 原始层（save_raw / load_raw）—— 运单明细 / 排班目标 / 实时考勤三源原始落盘。
     切站点、切维度时读这一层在**本地重算**，零 HTTP 请求。
  2. 结果层（save / load）—— 聚合结果快照，保留兼容，主流程已不再依赖。

触发约定（2026-09-09 用户明确）：
  · 切站点 / 切维度      → 只走本地重算，绝不实时拉取
  · 点「查询」按钮       → 才实时拉取，并刷新原始层
  · 排班目标当天不变     → 命中当天缓存即跳过拉取，一天只拉一次

缓存键：(kind, team_id, date)，date 默认 = 北京时间当天。
落盘文件：原始三源(orders/sched/att) → dashboard/data/{kind}_{team}_{date}.json；
          结果层(ach/rider) → dashboard/standard/cache/{kind}_{team}_{date}.json

注意：
  · 结果层只写「成功」结果（source != "error"），失败不覆盖已有缓存。
  · 原始层只写非空数据，避免把已有数据冲成空。
  · 本模块只做「读写文件」，不含任何取数 / 业务逻辑。
"""
import os
import json
import datetime

BJ = datetime.timezone(datetime.timedelta(hours=8))

# 目录约定（2026-09-11 重构：三源原始数据外迁到项目级共享目录）。
#   · 原始三源 orders/sched/att  →  dashboard/data/{kind}_{team}_{date}.json
#      （供「标准达成」「时段出勤」等多个看板复用，跨模块共享）
#   · 结果层 ach/rider 等遗留聚合快照 → 仍在 dashboard/standard/cache/
#      （主流程已不再依赖，仅保留兼容）
_STANDARD_DIR = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR = os.path.join(os.path.dirname(_STANDARD_DIR), "data")
_CACHE_DIR = os.path.join(_STANDARD_DIR, "cache")

# 原始三源种类（落盘到 dashboard/data，供跨看板复用）。
RAW_KINDS = ("orders", "sched", "att")


def today_ymd():
    """返回北京时间当天 YYYY-MM-DD。"""
    return datetime.datetime.now(BJ).strftime("%Y-%m-%d")


def _path(kind, team, date):
    # 原始三源(orders/sched/att)落到项目级共享目录 dashboard/data；
    # 其余(ach/rider 等结果层)仍在 dashboard/standard/cache。
    d = _DATA_DIR if kind in RAW_KINDS else _CACHE_DIR
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "%s_%s_%s.json" % (kind, team, date))


def load(kind, team, date=None):
    """读取落盘缓存；不存在 / 损坏返回 None。"""
    if date is None:
        date = today_ymd()
    p = _path(kind, team, date)
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save(kind, team, payload, date=None):
    """落盘缓存；成功返回 True。仅写成功结果。"""
    if not isinstance(payload, dict):
        return False
    if payload.get("source") == "error":
        return False
    if date is None:
        date = today_ymd()
    p = _path(kind, team, date)
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        return True
    except Exception:
        return False


def exists(kind, team, date=None):
    if date is None:
        date = today_ymd()
    return os.path.exists(_path(kind, team, date))


# ===================== 原始数据层 =====================
# 2026-09-09 重构：缓存标的从「聚合结果」下沉到「原始三源」。
# 切站点 / 切维度时用落盘的原始三源本地重算（零 HTTP 请求），
# 只有点「查询」才实时拉取并刷新原始层。
#
# kind 取值：
#   orders  运单明细原始行            list[dict]
#   sched   排班目标展平行            list[dict]   （当天不变，每天只拉一次）
#   att     实时考勤原始快照          dict {"tc": <int>, "rows": [...], "fetched_at": ...}
#                                     （tc 随数据一起落盘，重算时复用拉取时的时段，
#                                       避免「拉的是午高峰、重算按晚高峰算」的口径漂移）
#
# 写入保护：payload 为 None / 空容器时不写，避免把已有数据冲成空。
# 原始三源种类 RAW_KINDS 定义见文件头（落盘目录 dashboard/data）。


def _is_empty(v):
    if v is None:
        return True
    if isinstance(v, (list, tuple, dict, str)):
        return len(v) == 0
    return False


def save_raw(kind, team, payload, date=None):
    """落盘原始数据（非空才写）。成功返回 True。"""
    if kind not in RAW_KINDS:
        raise ValueError("未知原始数据类型: %r（可用 %s）" % (kind, "/".join(RAW_KINDS)))
    if _is_empty(payload):
        return False
    if date is None:
        date = today_ymd()
    p = _path(kind, team, date)
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        return True
    except Exception:
        return False


def load_raw(kind, team, date=None):
    """读取原始数据；不存在 / 损坏返回 None。"""
    if date is None:
        date = today_ymd()
    p = _path(kind, team, date)
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def raw_exists(kind, team, date=None):
    if date is None:
        date = today_ymd()
    return os.path.exists(_path(kind, team, date))


def latest_cache_time(team, date=None):
    """取 (orders, sched, att) 三源原始层中最近一次文件落盘的时间，
    北京时间，格式 `YYYY-MM-DD HH:MM:SS`（如 `2026-09-09 20:45:15`）。

    用于前端展示「实时数据未刷新 · 缓存：{时间} · 点查询按钮实时数据已刷新」。
    三源均无时返回 None（缓存未建立）。
    """
    if date is None:
        date = today_ymd()
    latest = None
    for kind in RAW_KINDS:
        p = _path(kind, team, date)
        if not os.path.exists(p):
            continue
        try:
            mt = os.path.getmtime(p)
            dt = datetime.datetime.fromtimestamp(mt, BJ).replace(microsecond=0)
            if latest is None or dt > latest:
                latest = dt
        except Exception:
            pass
    return latest.strftime("%Y-%m-%d %H:%M:%S") if latest else None
