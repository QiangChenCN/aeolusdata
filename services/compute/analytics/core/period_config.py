#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""时段出勤 —— 各时段起止时间 / 单量要求 / 时段权重配置（按月组织）。

存储方案：单文件单月。每月一个 JSON，文件名即体现月份归属：
    analytics/period_config_YYYY-MM.json

选择该方案的理由（性能 / 可维护性权衡）：
  - 配置体量极小（单月 ≤ 数十个时段），单文件 JSON 足够，无需分片或数据库；
  - 月份归属直接写在文件名上，运维/排障一眼可辨，互不串扰；
  - 历史月份天然隔离：只读不写，写操作只在「当前月及以后」生效。

文件结构：
  {
    "schema_version": 3,
    "month": "2026-09",
    "updated_at": "ISO8601",
    "periods": [
      {"start": "00:00", "end": "01:30", "name": "凌晨1", "orders": 1, "weight": 100,
       "period_duration_h": 1.5, "effective_online_req_h": 1.5},
      ...
    ]
  }

两个「时长」概念（务必区分，实现中不得混淆）：
  - period_duration_h       时段时长 = 结束 − 开始（左闭右开 [start, end)），自动计算，非考核目标；
  - effective_online_req_h  有效在线时长要求 = 该时段内骑手需达成的有效在线时长，是考核目标值，
                            可编辑（落盘），缺省取时段时长。

时段权重 weight：百分比系数（0–100），缺省 100，可编辑，须在 0–100 之间。

未保存月份口径（2026-11-10 起，不回落默认）：
  文件缺失时 load() 返回 periods=[] 且 configured=False；计算侧据此判定「该月未配置时段」，
  不回落任何内置默认规则，也不静默产出「全时段未配置、达成率 0」的假数据。
  调用方须显式处理 configured=False / periods 为空，并提示用户到「考核设置 → 时段设置」保存配置。

对外接口：
  current_month()          -> "YYYY-MM"
  list_months()            -> {"months":[...降序], "current":"YYYY-MM"}
  load(month=None)         -> {schema_version, month, updated_at, configured, periods, editable}
  save(periods, month=None)-> 校验后落盘；返回完整配置
  unconfigured_note(month, configured=False) -> 无时段规则月份的统一提示文案
  norm_weight(v)           -> 时段权重归一化（0-100，缺省/非法 100）
"""
import os

from analytics.core.paths import ROOT, PY_HOME, _ROOT  # noqa: E402,F401 <<<


import re
import json
import glob
import datetime
import threading

BJ = datetime.timezone(datetime.timedelta(hours=8))

_HERE = os.path.dirname(os.path.abspath(__file__))
_LOCK = threading.Lock()
_TIME_RE = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
_PREFIX = "period_config_"
_SUFFIX = ".json"


def _now_iso():
    return datetime.datetime.now(BJ).strftime("%Y-%m-%dT%H:%M:%S+08:00")


def current_month():
    """当前真实月份（本地时区），作为「可编辑」的分界。"""
    return datetime.date.today().strftime("%Y-%m")


def _path_for(month):
    return os.path.join(_HERE, _PREFIX + month + _SUFFIX)


def _duration_h(start, end):
    """左闭右开区间 [start, end) 的时长（小时）= 时段时长，支持跨日。

    当 end < start 时，视为 end 为次日（加 1440 分钟）。
    当 start == end 时（如 00:00-00:00），视为正好跨到次日，时长为 24 小时。
    因右端点不含，[00:00,00:00) 即一整天。
    """
    sh, sm = start.split(":")
    eh, em = end.split(":")
    mins = (int(eh) * 60 + int(em)) - (int(sh) * 60 + int(sm))
    if mins <= 0:
        mins += 1440
    return round(mins / 60.0, 2)


def _editable_for(month):
    return month >= current_month()


def unconfigured_note(month, configured=False):
    """无时段规则月份的统一提示文案（计算侧与接口层共用，避免口径分叉）。

    configured=True 表示用户已显式保存过空配置，文案需区分「没保存」与「保存为空」。
    """
    m = str(month)[:7]
    if configured:
        return "%s 月份已保存为空配置（无任何时段），如需参与考核请到「考核设置 → 时段设置」添加时段" % m
    return "%s 月份未配置时段，请到「考核设置 → 时段设置」保存配置后刷新" % m


def norm_weight(v):
    """时段权重归一化（0-100）；缺失 / 非法 / 越界一律回落 100（等价于不降权）。

    配置侧与计算侧共用，避免各模块各写一份兜底逻辑。
    """
    try:
        if v is None or v == "":
            return 100.0
        w = float(v)
        if w < 0 or w > 100:
            return 100.0
        return round(w, 2)
    except (ValueError, TypeError):
        return 100.0


def _read(month):
    p = _path_for(month)
    if not os.path.exists(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        # 损坏文件不抛，交上层按缺失处理
        return None
    if not isinstance(d.get("periods"), list):
        return None
    return d


def _write(month, data):
    """原子写：先写 .tmp 再 rename，避免半截文件被读。Windows / Linux 通用。"""
    tmp = _path_for(month) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, _path_for(month))


def load(month=None):
    """读取某月配置（缺省=当前月）。

    返回字段：
      month        实际月份
      periods      时段列表（文件缺失 / 损坏时为空列表，不回落任何默认规则）
      configured   该月是否已保存过配置（文件存在即为 True，即便 periods 为空）
      updated_at   最近更新时间（缺失时为 None）
      editable     该月是否可编辑（month < 当前月 -> False）

    时段时长 period_duration_h 始终由起止时间重算（避免落盘冗余字段漂移）；
    有效在线时长要求 effective_online_req_h 缺省取时段时长（兼容旧文件 duration_h）；
    时段权重 weight 缺省 100（旧文件 1.0 视为 100）。
    """
    month = month or current_month()
    d = _read(month)
    if d is None:
        # 未保存月份：无默认兜底，直接给空规则；计算侧据此走「未配置」口径。
        periods = []
        updated_at = None
    else:
        periods = [dict(x) for x in d.get("periods", [])]
        updated_at = d.get("updated_at")
    for p in periods:
        # 时段时长 = 结束 − 开始（左闭右开），自动计算
        try:
            p["period_duration_h"] = _duration_h(p["start"], p["end"])
        except Exception:
            p["period_duration_h"] = None
        # 有效在线时长要求：优先用已存值，否则用旧 duration_h 兜底，再否则用时段时长
        if p.get("effective_online_req_h") is None:
            p["effective_online_req_h"] = p.get("duration_h", p["period_duration_h"])
        try:
            p["effective_online_req_h"] = round(float(p["effective_online_req_h"]), 2)
        except Exception:
            p["effective_online_req_h"] = p["period_duration_h"]
        # 时段权重：百分比（0-100），缺省 100，旧文件 1.0 视为 100
        try:
            weight = float(p.get("weight") if p.get("weight") is not None else 100)
            if weight < 0 or weight > 100:
                weight = 100
            p["weight"] = round(weight, 2)
        except Exception:
            p["weight"] = 100
    return {
        "schema_version": 3,
        "month": month,
        "updated_at": updated_at,
        "configured": d is not None,
        "periods": periods,
        "editable": _editable_for(month),
    }


def _norm_period(p, idx):
    """单条时段配置校验与归一化。"""
    if not isinstance(p, dict):
        raise ValueError("时段项须为对象")
    start = str(p.get("start") or "").strip()
    end = str(p.get("end") or "").strip()
    name = str(p.get("name") or "").strip()
    if not _TIME_RE.match(start):
        raise ValueError("开始时间格式须为 HH:MM: %s" % start)
    if not _TIME_RE.match(end):
        raise ValueError("结束时间格式须为 HH:MM: %s" % end)
    # 合法性：允许跨日（end < start，如 22:00-00:00），也允许 start == end（表示跨到次日 00:00，即 24 小时）。
    # 注意：_duration_h 会把 end <= start 的情况按次日计算。
    if not name:
        raise ValueError("时段名称不能为空")
    try:
        orders = int(p.get("orders"))
    except (ValueError, TypeError):
        raise ValueError("单量要求须为整数")
    if orders < 0:
        raise ValueError("单量要求不能为负数")
    # 有效在线时长要求：考核目标值，须为非负数
    try:
        req = float(p.get("effective_online_req_h"))
    except (ValueError, TypeError):
        raise ValueError("有效在线时长要求须为数字")
    if req < 0:
        raise ValueError("有效在线时长要求不能为负数")
    # 时段权重：百分比（0-100）
    try:
        weight = float(p.get("weight") if p.get("weight") is not None else 100)
    except (ValueError, TypeError):
        raise ValueError("时段权重须为数字")
    if weight < 0 or weight > 100:
        raise ValueError("时段权重须在 0-100 之间（百分比）")
    return {"start": start, "end": end, "name": name, "orders": orders,
            "weight": round(weight, 2),
            "period_duration_h": _duration_h(start, end),
            "effective_online_req_h": round(req, 2)}


def save(periods, month=None):
    """校验 + 落盘（按月单文件）。历史月份（< 当前月）拒绝写入。"""
    month = month or current_month()
    if month < current_month():
        raise ValueError("历史月份（%s）不可编辑" % month)
    if not isinstance(periods, list):
        raise ValueError("periods 须为数组")
    # 不在此处强制按 start 重排：顺序以调用方传入为准（前端支持手动拖拽排序），
    # 保留用户调整后的行序。下游 rider_period_detail 按 name/time 字典匹配且各自排序，
    # 故数组顺序不影响考核计算正确性。
    normed = [_norm_period(x, i) for i, x in enumerate(periods)]
    with _LOCK:
        data = {
            "schema_version": 3,
            "month": month,
            "updated_at": _now_iso(),
            "periods": normed,
        }
        _write(month, data)
    return data


def list_months():
    """已落盘配置的月份列表（降序）+ 当前月（即便无文件也列出）。"""
    files = glob.glob(os.path.join(_HERE, _PREFIX + "????-??" + _SUFFIX))
    months = []
    for f in files:
        bn = os.path.basename(f)
        m = bn[len(_PREFIX):-len(_SUFFIX)]
        if re.match(r"^\d{4}-\d{2}$", m):
            months.append(m)
    cur = current_month()
    if cur not in months:
        months.append(cur)
    months = sorted(set(months), reverse=True)
    return {"months": months, "current": cur}


if __name__ == "__main__":
    import json as _json
    print("current:", current_month())
    print(_json.dumps(load(), ensure_ascii=False, indent=2))
