#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""站点名与参与站点配置。

站点名**唯一来源**是 Nest 每次从风神拉取站点目录后落盘的 `apps/api/runtime/teams.json`
（GET /api/fetch/teams 成功即写盘）。本模块只做「读盘」，不再内置任何硬编码站点清单
（原 TEAM_NAMES / DEFAULT_TEAMS 已移除）。所有需要站点名 / 站点列表的读取都走这份落盘文件。

参与站点（标准达成「参与站点」/ 时段出勤「纳入站点」）的**用户配置**仍由各自 json 文件
（teams_config.json / attend_period_teams.json）承载；仅在配置文件缺失时回落到落盘文件里的
全部已知站点，不再硬编码默认三站。
"""
import os
import time
import json

# 统一路径契约：取代各模块重复的 bootstrap（见 analytics/core/paths.py）。
from analytics.core.paths import ROOT, PY_HOME, _ROOT, dirs# noqa: E402,F401


_HERE = os.path.dirname(os.path.abspath(__file__))
_PATH = os.path.join(_HERE, "teams_config.json")
# 站点目录落盘文件：Nest 每次从风神拉取站点目录成功后写入（与订单落盘同根 apps/api/runtime）。
_TEAMS_FILE = dirs.runtime("teams.json")

_TN_CACHE = {"data": None, "ts": 0}
_TN_TTL = 60  # 秒；Nest 每 5 分钟刷新一次落盘文件，这里缓存 60s 足够


def get_team_names():
    """读 `apps/api/runtime/teams.json` → {team_id: name}（站点名唯一来源，不再硬编码）。

    进程内缓存 60s；文件不存在 / 损坏时返回上一次的成功结果（首次则为空）。
    """
    now = time.time()
    if _TN_CACHE["data"] is not None and (now - _TN_CACHE["ts"]) < _TN_TTL:
        return _TN_CACHE["data"]
    data = {}
    try:
        with open(_TEAMS_FILE, "r", encoding="utf-8") as f:
            obj = json.load(f)
        for t in (obj or {}).get("teams") or []:
            tid = str((t or {}).get("id") or "").strip()
            nm = (t or {}).get("name")
            if tid and nm:
                data[tid] = str(nm)
    except Exception:
        data = _TN_CACHE["data"] or {}
    _TN_CACHE["data"] = data
    _TN_CACHE["ts"] = now
    return data


class _TeamNamesProxy:
    """向后兼容旧调用点（`TEAM_NAMES.get / .items / dict.update`）。

    旧代码多用 `TEAM_NAMES.get(team_id, default)` 取站点名；这里代理到落盘文件，
    避免改动标准达成 / 时段出勤 / 运单等大量调用点。
    """

    def get(self, key, default=None):
        v = get_team_names().get(str(key))
        return v if v is not None else default

    def __getitem__(self, key):
        return get_team_names().get(str(key), str(key))

    def keys(self):
        return get_team_names().keys()

    def items(self):
        return get_team_names().items()

    def __contains__(self, key):
        return str(key) in get_team_names()

    def __iter__(self):
        return iter(get_team_names())


# 向后兼容别名：旧 `from analytics.core.teams_config import TEAM_NAMES` 仍可用，自动指向落盘文件。
TEAM_NAMES = _TeamNamesProxy()


def get_teams():
    """返回参与站点 id 列表（list[str]）。

    配置来源是 teams_config.json（系统在「参与站点」里保存的结果）。文件缺失 / 空 →
    回落到落盘文件里的全部已知站点（不再硬编码默认三站）。
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
    return list(get_team_names().keys())


if __name__ == "__main__":
    print(json.dumps({"teams": get_teams()}, ensure_ascii=False))
