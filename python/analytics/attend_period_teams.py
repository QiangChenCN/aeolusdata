#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""时段出勤看板 —— 「站点管理」配置（系统设置 → 站点管理）。

用途：决定时段出勤各数据 tab（时段有效 / 骑手明细等）的**站点下拉候选范围**。
用户在系统设置里勾选需纳入的站点并保存，后续看板数据的拉取与展示即以此范围为口径
（默认仍为单站下钻，不自动跨站合并——与标准达成「参与站点」职责平行但彼此独立）。

存储：analytics/attend_period_teams.json  {"teams": ["917521136", ...]}
默认：三个常管 -UB 站（黄江镇 / 长安万科 / 大岭山大学城）。

本模块只做「读写配置」，不含取数 / 业务逻辑；写文件用原子写（先 .tmp 再 rename），
与 teams_config / period_config 一致，避免半截文件被读。
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
import threading

_HERE = os.path.dirname(os.path.abspath(__file__))
_PATH = os.path.join(_HERE, "attend_period_teams.json")
_LOCK = threading.Lock()

# 无配置时的回落来源：Nest 每次从风神拉取站点目录后落盘的 backend/data/teams.json（全部已知站点）。
_TEAMS_FILE = os.path.join(ROOT, "backend", "data", "teams.json")


def _known_team_ids():
    """读落盘站点目录文件，返回全部已知站点 id 列表（接口不可达时的回落来源）。"""
    try:
        with open(_TEAMS_FILE, "r", encoding="utf-8") as f:
            obj = json.load(f)
        return [str(t.get("id")).strip() for t in (obj or {}).get("teams") or []
                if str(t.get("id")).strip()]
    except Exception:
        return []


def _atomic_write(obj):
    """原子写：先写 .tmp 再 rename，避免半截文件被读。Windows / Linux 通用。"""
    tmp = _PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, _PATH)


def get_teams():
    """返回纳入站点的 id 列表（list[str]）。

    配置来源是 attend_period_teams.json（系统在「站点管理」里保存的结果）。
    文件缺失 / 空 → 回落到落盘文件里的全部已知站点（不再硬编码默认三站）。
    """
    try:
        with open(_PATH, "r", encoding="utf-8") as f:
            obj = json.load(f)
    except Exception:
        obj = None
    ids = (obj or {}).get("teams")
    if isinstance(ids, list):
        out = [str(x).strip() for x in ids if str(x).strip()]
        if out:
            return out
    # 无配置：回落落盘站点目录（全部已知站点）
    return _known_team_ids()


def set_teams(ids):
    """保存纳入站点 id 列表。返回 (ok, teams, msg)。

    校验：必须是非空字符串列表；去重但**保留顺序**（顺序即下拉展示顺序）。
    """
    if not isinstance(ids, list) or not ids:
        return False, get_teams(), "站点不能为空"
    clean, seen = [], set()
    for x in ids:
        s = str(x).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        clean.append(s)
    if not clean:
        return False, get_teams(), "站点不能为空"
    with _LOCK:
        try:
            _atomic_write({"teams": clean})
        except Exception as e:
            return False, get_teams(), "写入失败：%s: %s" % (type(e).__name__, e)
    return True, clean, ""


if __name__ == "__main__":
    print(json.dumps({"teams": get_teams()}, ensure_ascii=False))
