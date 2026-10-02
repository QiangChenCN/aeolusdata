#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""缓存访问层：原始层读取（本地）+ 落盘（委托 Nest）+ 进程内结果缓存。

2026-09-23 职责拆分（与「Python 只做大计算」一致）：

  · **读** —— 本进程直接读文件，这是计算的**输入端口**：
        load_raw / raw_exists / latest_cache_time
    计算的输入就在本地磁盘上，绕一圈 HTTP 没有收益。

  · **写** —— 全部委托 NestJS（`POST /api/cache/raw` → backend 的 `RawCacheService`）。
    取数已归 Nest，而「原始层落盘的时机」正是取数成功的瞬间；格式（路径 / 非空判定 /
    违规明细的 `fetch_ok` 包装）因此只写在 Nest 一侧，本模块只转发。
    保留 `save_raw` / `save_violation` 原名，使调用点零改动。

  · **进程内结果缓存** —— `get_result` / `put_result` / `clear_results` **不迁**：
    它是计算进程内的 memoization（省掉反复 json.load 数 MB 原始 JSON + 全量扫描 + 聚合）。
    迁到 Nest 等于让 Nest 缓存 Python 的内存对象，没有意义。

⚠️ **结果层已删除**：原 `analytics/cache/{rider,ach}_*.json` 与配套的 `save()`
  一并移除 —— 迁移时核实全仓**无任何读取方**（Python 无 `CACHE.load(` 调用，前端与 Nest
  也不读这些文件），是 write-only 死物。若将来需要结果级快照，应走 Nest 侧并提供读取方。

缓存键：(kind, team_id, date)，date 默认 = 北京时间当天。
落盘文件：`dashboard/data/{kind}_{team}_{date}.json`（四类原始数据同目录同生命周期）。

触发约定（2026-09-09 用户明确，仍然有效）：
  · 切站点 / 切维度  → 只读本地原始层重算，绝不实时拉取
  · 点「查询」按钮   → 才实时拉取，并刷新原始层
  · 排班目标当天不变 → 命中当天缓存即跳过拉取，一天只拉一次

本模块只做「读写文件 / 转发落盘」，不含任何取数 / 业务逻辑。
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

import json
import datetime
import threading

BJ = datetime.timezone(datetime.timedelta(hours=8))

# 目录约定（2026-09-11 重构：原始数据外迁到项目级共享目录，供多个看板复用）。
# ⚠️ 必须是**项目根**下的 dashboard/data，与唯一写入方（Nest RawCacheService）同目录。
#
# 2026-09-23 修正：原实现是 `dirname(dirname(__file__))/data`（本包的上级 + data），
# 落在 **python/dashboard/data**（代码目录内）。取数迁到 Nest 后，写入方是 Nest
# （写 <项目根>/dashboard/data），两边不一致 → 刷新后 Nest 写了新数据，Python 仍读
# 代码目录里那份过期原始层，表现为「刷新显示成功，但看板数字一直停留在某个历史时刻那一版」。
_DATA_DIR = os.path.join(ROOT, "dashboard", "data")

# 原始数据种类（落盘到 dashboard/data）。
# 2026-09-19 增加 violation：实时看板的「违规处罚明细」（投诉/差评/索赔口径数据源）。
RAW_KINDS = ("orders", "sched", "att", "violation")


def today_ymd():
    """返回北京时间当天 YYYY-MM-DD。"""
    return datetime.datetime.now(BJ).strftime("%Y-%m-%d")


def _path(kind, team, date):
    """原始层文件路径。**只读路径**：不再 makedirs —— 目录由写入方（Nest）创建，
    读不到就是「还没刷新」，不该因为一次读就凭空造出目录。"""
    return os.path.join(_DATA_DIR, "%s_%s_%s.json" % (kind, team, date))


# ===================== 原始数据层：读（计算的输入端口）=====================
# kind 取值：
#   orders  运单明细原始行            list[dict]
#   sched   排班目标展平行            list[dict]   （当天不变，每天只拉一次）
#   att     实时考勤原始快照          dict {"tc": <int>, "rows": [...], "fetched_at": ...}
#   violation 违规处罚明细            dict {"date":..., "team_id":..., "fetched_at":...,
#                                            "fetch_ok":..., "fetch_error":..., "rows": [...]}
#                                     （包一层 dict 使「已刷新但 0 条」与「未刷新」可区分）


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
    """取原始层各源（orders/sched/att/violation）中最近一次文件落盘的时间，
    北京时间，格式 `YYYY-MM-DD HH:MM:SS`（如 `2026-09-09 20:45:15`）。

    用于前端展示「实时数据未刷新 · 缓存：{时间} · 点查询按钮实时数据已刷新」。
    各源均无时返回 None（缓存未建立）。
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


def latest_cache_time_all(date=None):
    """所有站点、各源原始文件中最近一次落盘时间（北京时间，`YYYY-MM-DD HH:MM:SS`）。

    用于「全部站点」报表展示统一的取数时间；无文件返回 None。
    """
    if date is None:
        date = today_ymd()
    if not os.path.isdir(_DATA_DIR):
        return None
    latest = None
    suffix = "_%s.json" % date
    try:
        for fn in os.listdir(_DATA_DIR):
            if not fn.endswith(suffix):
                continue
            try:
                mt = os.path.getmtime(os.path.join(_DATA_DIR, fn))
                dt = datetime.datetime.fromtimestamp(mt, BJ).replace(microsecond=0)
                if latest is None or dt > latest:
                    latest = dt
            except Exception:
                pass
    except Exception:
        pass
    return latest.strftime("%Y-%m-%d %H:%M:%S") if latest else None


# ===================== 原始数据层：写（委托 Nest 落盘）=====================
def _is_empty(v):
    if v is None:
        return True
    if isinstance(v, (list, tuple, dict, str)):
        return len(v) == 0
    return False


def _call_nest(payload, what):
    """转发到 Nest 落盘端点；失败抛 RuntimeError。"""
    from common import nest_client
    r = nest_client.post_json("/api/cache/raw", payload, timeout=60)
    if not isinstance(r, dict) or not r.get("ok"):
        # 带上目标基址：落盘失败最常见的原因是「打到了另一个 Nest 实例 / 基址配错」，
        # 而 404 的正文只说路由不存在，看不出打给了谁。
        raise RuntimeError("%s 落盘失败（nest=%s）：%s"
                           % (what, nest_client.nest_base(), (r or {}).get("error") or r))
    return r


def save_raw(kind, team, payload, date=None):
    """原始数据落盘（转发 Nest 写文件）。成功返回 True。

    空 payload 在本地就先拦掉：没必要为「什么都没有」打一次 HTTP。
    （Nest 侧会再判一次 —— 双保险，防止别的调用方绕过这里。）
    """
    if kind not in RAW_KINDS:
        raise ValueError("未知原始数据类型: %r（可用 %s）" % (kind, "/".join(RAW_KINDS)))
    if _is_empty(payload):
        return False
    if date is None:
        date = today_ymd()
    r = _call_nest(
        {"kind": kind, "team": str(team), "date": str(date), "payload": payload},
        "%s_%s_%s" % (kind, team, date),
    )
    # 失效本进程的结果缓存：它就是**本进程**的内存对象，自己清最快
    # （Nest 不知道自己写的文件会脏掉哪个进程的哪条缓存）。
    invalidate_results(team, date)
    return bool(r.get("saved"))


def save_violation(team, date, rows, ok=True, error=None):
    """违规明细落盘（转发 Nest）。

    包装格式（`fetch_ok` / `fetch_error` / `fetched_at`）由 Nest 的 `saveViolation` 组装 ——
    该格式的读侧是 `analytics/realtime/violations.load_team_raw`，把「写」的知识集中到
    Nest 一侧后，这里只交原始行与成败标记。
    """
    r = _call_nest(
        {"kind": "violation", "team": str(team), "date": str(date),
         "rows": list(rows or []), "ok": bool(ok), "error": error},
        "violation_%s_%s" % (team, date),
    )
    invalidate_results(team, date)
    return bool(r.get("saved"))


# ===================== 进程内结果缓存 =====================
# 解决「切站点 / 切维度 / 首屏加载」每次都重新读数 MB 原始 JSON + 重跑聚合的体感卡顿。
# 生命周期：原始层写入后失效对应 team/date 的结果（save_raw / save_violation 里已接）；
# 等级标准 / 门槛配置变更时由对应接口调用 clear_results() 整体清空（避免旧口径）。
# 命中即返回浅拷贝（覆盖 source 字段），不改动缓存中的原对象。
_RESULT_LOCK = threading.Lock()
_RESULT_CACHE = {}  # key=(module, team, date, month, source) -> 聚合结果 dict


def _result_key(module, team_id, date, month, source):
    return (module, str(team_id), str(date), str(month), str(source))


def get_result(module, team_id, date, month=None, source="cache"):
    """命中进程内结果缓存则返回浅拷贝（覆盖 source 字段），未命中返回 None。

    用于 recompute / build_one：原始层已有落盘时直接复用上次算好的聚合结果，
    省掉对 orders 原始 JSON 的反复 json.load + 全量扫描 + 聚合。
    """
    k = _result_key(module, team_id, date, month, source)
    with _RESULT_LOCK:
        v = _RESULT_CACHE.get(k)
    if v is None:
        return None
    out = dict(v)
    out["source"] = source
    return out


def put_result(module, team_id, date, month, source, value):
    """写入进程内结果缓存。value 为已算好的聚合结果 dict。"""
    k = _result_key(module, team_id, date, month, source)
    with _RESULT_LOCK:
        _RESULT_CACHE[k] = value
    return value


def clear_results():
    """清空全部进程内结果缓存（等级标准 / 门槛配置变更后调用，避免读到旧口径）。"""
    with _RESULT_LOCK:
        _RESULT_CACHE.clear()


def invalidate_results(team_id, date):
    """失效该 team/date 下所有模块/口径的结果缓存。

    调用方有两类：
      · 本模块的 save_raw / save_violation（本进程刚写了原始层）；
      · `compute_api` 的 `/api/cache/invalidate` 端点 —— Nest 直接写文件后回调本进程清缓存。
    """
    tid, d = str(team_id), str(date)
    with _RESULT_LOCK:
        drop = [k for k in _RESULT_CACHE if k[1] == tid and k[2] == d]
        for k in drop:
            _RESULT_CACHE.pop(k, None)
