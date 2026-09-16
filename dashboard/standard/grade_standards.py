#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""骑手等级标准（按站点 × 月份 配置表）。

存盘 JSON：`dashboard/standard/grade_standards.json`
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
import json
import datetime
import threading

BJ = datetime.timezone(datetime.timedelta(hours=8))

_HERE = os.path.dirname(os.path.abspath(__file__))
_PATH = os.path.join(_HERE, "grade_standards.json")
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


def get_all(month):
    """取某月的全表（已配项覆盖默认项）；含 schema 元数据便于前端判断。"""
    month = (month or _current_month()).strip()
    data = _read()
    configured = (data.get("months") or {}).get(month) or {}
    dflt = defaults()
    merged = {}
    for tid, d in dflt.items():
        cfg = configured.get(tid) or {}
        merged[tid] = {
            "order": _val_list(cfg.get("order") or d["order"]),
            "duration_h": _val_list(cfg.get("duration_h") or d["duration_h"], vtype=float),
        }
    # 兜底清单以外也回填（已配置的未知站也带上，方便前端渲染）
    for tid, cfg in configured.items():
        if tid not in merged:
            merged[tid] = {
                "order": _val_list(cfg.get("order")),
                "duration_h": _val_list(cfg.get("duration_h"), vtype=float),
            }
    return {
        "month": month,
        "schema_version": data.get("schema_version", 1),
        "updated_at": data.get("updated_at"),
        "configured_ids": list(configured.keys()),
        "teams": merged,
        "defaults": dflt,
    }


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


def save(team_id, month, order, duration_h):
    """校验 + 落盘。返回保存后的记录。"""
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
    with _LOCK:
        data = _read()
        data.setdefault("months", {})
        data["months"].setdefault(mo, {})
        data["months"][mo][tid] = {"order": o, "duration_h": d_h}
        data["updated_at"] = _now_iso()
        _write(data)
    return {"team_id": tid, "month": mo, "order": o, "duration_h": d_h}


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


def build_levels(team_id, month):
    """按 (team_id, month) 拼出 5 档 level（level 0 = 未定级），喂 rider_dimension._grade。

    每档：min_valid_orders（个，int）= cfg.order[i]
          min_valid_minutes（分，float）= cfg.duration_h[i] * 60
    名称固定为「标准1..标准5」，与业务口径一致（不再混用 见习/初级 等业务称谓）。
    """
    rec = get(team_id, month)
    orders = rec["order"]
    durs_h = rec["duration_h"]
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


if __name__ == "__main__":
    import argparse as _ap
    ap = _ap.ArgumentParser()
    ap.add_argument("--month", default=_current_month())
    ns = ap.parse_args()
    print(json.dumps(get_all(ns.month), ensure_ascii=False, indent=2))
