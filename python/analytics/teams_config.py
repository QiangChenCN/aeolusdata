#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""站点名兜底清单（TEAM_NAMES）—— 各分析模块共用的「站点 id → 名称」末位兜底来源。

注意：参与考核站点的权威来源已迁至全局「标准达成设置」（standard_grade_settings.json，
由 Nest ConfigService 读写）。本模块仅保留 TEAM_NAMES / get_team_names / get_teams，
供各分析模块做站点名兜底展示；其中 get_teams() 回落默认三站，仅作末位兜底。
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

_HERE = os.path.dirname(os.path.abspath(__file__))
_PATH = os.path.join(_HERE, "teams_config.json")

# 默认参与站点（用户日常看板的三个 -UB 站）
DEFAULT_TEAMS = ["917521130", "917521136", "917521139"]

# 已知站点兜底清单（id -> 站点名）—— **末位兜底**，不是主来源。
# 真实站点目录由风神上游接口提供，且取数已迁 NestJS（GET /api/fetch/teams，5 分钟缓存）。
# 兜底清单的**唯一来源**是 Nest 的 `FALLBACK_TEAMS`
# （backend/src/modules/fetch/teams-fetch.service.ts）；本清单只在 Nest 整体不可达时，
# 被 compute_api/handlers.py::_fetch_all_teams 用作末位兜底（绝不让选择器空白）。
# 新增 / 改名站点：改 Nest 的 FALLBACK_TEAMS 与前端 web/src/teams.js 两处。
TEAM_NAMES = {
    "917521130": "东莞市黄江镇站-UB",
    "917521136": "东莞市长安万科站-UB",
    "917521139": "东莞市大岭山大学城站-UB",
}


def get_team_names():
    """返回 {team_id: name} 兜底映射（深拷贝，避免调用方误改）。"""
    return dict(TEAM_NAMES)


def get_teams():
    """返回参与站点 id 列表（list[str]）。文件缺失 / 空 → 返回默认值（不落盘）。"""
    try:
        with open(_PATH, "r", encoding="utf-8") as f:
            obj = json.load(f)
    except Exception:
        return list(DEFAULT_TEAMS)
    ids = (obj or {}).get("teams")
    if not isinstance(ids, list):
        return list(DEFAULT_TEAMS)
    out = [str(x).strip() for x in ids if str(x).strip()]
    return out or list(DEFAULT_TEAMS)


if __name__ == "__main__":
    print(json.dumps({"teams": get_teams()}, ensure_ascii=False))
