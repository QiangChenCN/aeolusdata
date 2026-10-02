#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""骑手等级标准（按站点 × 月份 配置表）。

存盘 JSON：`analytics/grade_standards.json`
结构：
  {
    存盘 JSON：<python>/dashboard/standard/grade_standards.json
    （配置写入方已迁 Nest：backend/src/modules/config/config.service.ts 的 stdDir；
     Python 计算侧必须读同一份，否则 UI 保存的标准不会生效。）
    结构：
      {
        "schema_version": 1,
        "updated_at": "ISO8601",
        "months": {
          "2026-09": {
            "917521130": {"order":[18,27,33,40,50], "duration_h":[6,6,6,7,8]},
            "917521136": {...}, "917521139": {...}
          }
        }
      }


对外：
  defaults()                                          → {team_id: {order, duration_h}}（业务硬编码兜底）
  get_all(month)                                      → 同上，叠加已配置项覆盖
  get(team_id, month)                                 → 单条；未配则回退到 defaults()
  save(team_id, month, order, duration_h) -> dict     → 落盘；验值后写
  build_levels(team_id, month)                        → 5 档 level dict（直接喂 rider_dimension._grade）
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

_HERE = os.path.dirname(os.path.abspath(__file__))
# 关键：配置实际由 Nest ConfigService 落盘到 <python>/dashboard/standard/
# （迁移后写入方已迁 Nest，见 backend/src/modules/config/config.service.ts 的 stdDir）。
# 此前本文件随包搬家到 analytics/ 后 _PATH 仍指向 analytics/ 下的孤立副本，导致 UI 保存的
# 等级标准与骑手等级计算读取的不是同一份文件 —— 标准改了但计算永远用默认（旧）阈值。
# 现改为读 Nest 写入的共享文件；不要再改回 analytics/ 下的孤立副本。
_PY_DIR = PY_HOME if PY_HOME else os.path.dirname(_HERE)
_PATH = os.path.join(_PY_DIR, "dashboard", "standard", "grade_standards.json")
_LOCK = threading.Lock()

# 兜底默认值（与老板 2026-09-09 给的截图一致，黄江/万科/大岭山三站同配置）。
# 标准 = 有效单量(全天)、时长(小时、全天有效在线)。两轴均达标才记到该级（最高命中级）。
DEFAULT_BY_TEAM = {
    "917521130": {"order": [18, 27, 33, 40, 50], "duration_h": [6, 6, 6, 7, 8]},
    "917521136": {"order": [18, 27, 33, 40, 50], "duration_h": [6, 6, 6, 7, 8]},
    "917521139": {"order": [18, 27, 33, 40, 50], "duration_h": [6, 6, 6, 7, 8]},
}


def _now_iso():
    return datetime.datetime.now(BJ).strftime("%Y-%m-%dT%H:%M:%S+08:00")


def _read():
    if not os.path.exists(_PATH):
        return {"schema_version": 1, "updated_at": _now_iso(), "months": {}}
    try:
        with open(_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        # 损坏文件不抛：兜底按空配置走，避免拖死看板
        return {"schema_version": 1, "updated_at": _now_iso(), "months": {}}


def _write(data):
    """原子写：先写 .tmp 再 rename，避免半截文件被读。Windows 与 Linux 通用。"""
    tmp = _PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, _PATH)


def _val_list(v, n=5, vtype=int):
    """归一化输入为长度 n 的列表：缺位补 0，多位截断，非数值容错。"""
    out = []
    for x in (v or []):
        try:
            out.append(vtype(x))
        except (ValueError, TypeError):
            out.append(0)
        if len(out) >= n:
            break
    while len(out) < n:
        out.append(0)
    return out


def defaults():
    return {tid: {"order": list(v["order"]), "duration_h": list(v["duration_h"])}
            for tid, v in DEFAULT_BY_TEAM.items()}


def _norm_pct(v, cap=None):
    """归一化百分比：空/None → None（未设置）；否则 float，校验 0~100（cap 允许 >100）。"""
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (ValueError, TypeError):
        return None
    if f < 0 or (cap is not None and f > cap):
        return None
    return f


def get_all(month):
    """取某月的全表（已配项覆盖默认项）；含 schema 元数据便于前端判断。

    每条 team 记录除 order/duration_h 外，还含：
      · enabled          : 是否参与考核（默认 True）
      · threshold_pct    : 门槛(%)，None=未设置 → 回落全局 threshold_config
      · cap_pct          : 封顶(%)，None=未设置 → 回落全局 threshold_config
    participating：本月经「参与考核」的站点 id 列表（含 enabled 回落默认三站逻辑）。
    """
    month = (month or _current_month()).strip()
    data = _read()
    configured = (data.get("months") or {}).get(month) or {}
    dflt = defaults()

    def _merge(rec):
        return {
            "order": _val_list(rec.get("order")),
            "duration_h": _val_list(rec.get("duration_h"), vtype=float),
            "enabled": rec.get("enabled", True) is not False,
            "threshold_pct": _norm_pct(rec.get("threshold_pct"), cap=200),
            "cap_pct": _norm_pct(rec.get("cap_pct"), cap=200),
        }

    merged = {}
    for tid, d in dflt.items():
        cfg = configured.get(tid) or {}
        merged[tid] = _merge(cfg if cfg else {"order": d["order"], "duration_h": d["duration_h"]})
    # 兜底清单以外也回填（已配置的未知站也带上，方便前端渲染）
    for tid, cfg in configured.items():
        if tid not in merged:
            merged[tid] = _merge(cfg)
    return {
        "month": month,
        "schema_version": data.get("schema_version", 1),
        "updated_at": data.get("updated_at"),
        "configured_ids": list(configured.keys()),
        "participating": participating_teams(month),
        "teams": merged,
        "defaults": dflt,
    }


def participating_teams(month):
    """本月经「参与考核」的站点 id 列表。

    · 若该月已有任何配置记录 → 取其中 enabled 不为 False 的站点（显式配置，按需启停）；
    · 若月份记录存在但已被清空（用户移除了全部站点）→ 返回空，由前端提示无参与站，
      不再回落默认三站（避免「移除全部」后被悄悄复活为默认三站）；
    · 仅当该月从未配置过（连月份记录都不存在）→ 回落默认三站，保证首运行看板非空。
    """
    month = (month or _current_month()).strip()
    data = _read()
    months = data.get("months") or {}
    configured = months.get(month) or {}
    if not configured:
        if month in months:
            return []
        return [str(t) for t in DEFAULT_BY_TEAM.keys()]
    return [str(t) for t, cfg in configured.items()
            if (cfg.get("enabled", True) is not False)]


def get_config(team_id, month):
    """取某站某月的完整配置（含 enabled/threshold_pct/cap_pct）。
    未配回退默认；并标注 configured / enabled / participating。"""
    all_data = get_all(month)
    tid = str(team_id)
    rec = dict(all_data["teams"].get(tid, {}))
    rec["team_id"] = tid
    rec["month"] = all_data["month"]
    rec["configured"] = tid in (all_data.get("configured_ids") or [])
    rec["enabled"] = rec.get("enabled", True) is not False
    rec["participating"] = tid in (all_data.get("participating") or [])
    return rec


def get(team_id, month):
    """取单站单月：未配回退默认。"""
    all_data = get_all(month)
    tid = str(team_id)
    if tid in all_data["teams"]:
        rec = dict(all_data["teams"][tid])
        rec["team_id"] = tid
        rec["month"] = all_data["month"]
        return rec
    # 未知站：用 defaults() 的第一行兜底（避免回 None 阻塞调用方）
    d = defaults().get(tid) or next(iter(defaults().values()))
    return {
        "team_id": tid, "month": all_data["month"],
        "order": list(d["order"]), "duration_h": list(d["duration_h"]),
    }


def save(team_id, month, order, duration_h, enabled=True,
          threshold_pct=None, cap_pct=None):
    """校验 + 落盘。返回保存后的记录（含 enabled/threshold_pct/cap_pct）。

    门槛/封顶均为百分比；考核人数分母（天应排）取自排班目标，不再单独配置。
    """
    tid = str(team_id).strip()
    mo = str(month).strip()
    if not tid or not mo:
        raise ValueError("team_id 与 month 不能为空")
    if not mo or len(mo) != 7 or mo[4] != "-":
        raise ValueError("month 须为 YYYY-MM 格式")
    o = _val_list(order)
    d_h = _val_list(duration_h, vtype=float)
    # 归一化：负数置 0，时长上限 24
    o = [max(0, x) for x in o]
    d_h = [max(0.0, min(24.0, float(x))) for x in d_h]
    en = (enabled is not False)
    tp = _norm_pct(threshold_pct, cap=200)
    cp = _norm_pct(cap_pct, cap=200)
    with _LOCK:
        data = _read()
        data.setdefault("months", {})
        data["months"].setdefault(mo, {})
        data["months"][mo][tid] = {
            "order": o, "duration_h": d_h,
            "enabled": en,
            "threshold_pct": tp,
            "cap_pct": cp,
        }
        data["updated_at"] = _now_iso()
        _write(data)
    return {"team_id": tid, "month": mo, "order": o, "duration_h": d_h,
            "enabled": en,
            "threshold_pct": tp, "cap_pct": cp}


def delete(team_id, month):
    """删除某 (team_id, month) 的等级标准配置（仅删该月，不动其它月）。

    返回 {"team_id","month","existed":bool}。若本就未配置也返回 ok（幂等）。
    """
    tid = str(team_id).strip()
    mo = str(month).strip()
    if not tid or not mo:
        raise ValueError("team_id 与 month 不能为空")
    if len(mo) != 7 or mo[4] != "-":
        raise ValueError("month 须为 YYYY-MM 格式")
    with _LOCK:
        data = _read()
        months = data.setdefault("months", {})
        m = months.get(mo) or {}
        existed = tid in m
        if existed:
            del m[tid]
            months[mo] = m
            data["updated_at"] = _now_iso()
            _write(data)
    return {"team_id": tid, "month": mo, "existed": existed}


def _levels_from_rec(orders, durs_h):
    """由 (order[5], duration_h[5]) 拼出 6 档 level（level 0 = 未定级），喂 _grade。"""
    levels = [{"level": 0, "name": "未定级", "min_valid_orders": 0, "min_valid_minutes": 0.0}]
    for i in range(5):
        levels.append({
            "level": i + 1,
            "name": "标准%d" % (i + 1),
            "min_valid_orders": int(orders[i] or 0),
            "min_valid_minutes": float(durs_h[i] or 0.0) * 60.0,
        })
    return levels


def _current_month():
    return datetime.datetime.now(BJ).strftime("%Y-%m")


def build_levels(team_id, month):
    """按 (team_id, month) 拼出 5 档 level（level 0 = 未定级），喂 rider_dimension._grade。

    每档：min_valid_orders（个，int）= cfg.order[i]
          min_valid_minutes（分，float）= cfg.duration_h[i] * 60
    名称固定为「标准1..标准5」，与业务口径一致（不再混用 见习/初级 等业务称谓）。

    配置由 Nest ConfigService 落盘到 _PATH（<python>/dashboard/standard/grade_standards.json），
    本模块已指向该共享文件；当月无配置时回落硬编码默认（保持首运行看板非空）。
    """
    rec = get(team_id, month)
    return _levels_from_rec(_val_list(rec["order"]),
                            _val_list(rec["duration_h"], vtype=float))


if __name__ == "__main__":
    import argparse as _ap
    ap = _ap.ArgumentParser()
    ap.add_argument("--month", default=_current_month())
    ns = ap.parse_args()
    print(json.dumps(get_all(ns.month), ensure_ascii=False, indent=2))
