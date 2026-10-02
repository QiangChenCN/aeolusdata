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

#!/usr/bin/env python3
"""实时考勤取数 —— **转发层**（单一来源）。

⚠️ 2026-09-23：**取数已迁 NestJS**（ADR 修订 1）。本文件不再自己打风神接口，只把参数
转发给 `POST /api/fetch/attendance-raw`。返回形状与迁移前**逐字一致**（接口原始 JSON），
调用方（`analytics/rider_dimension.py`、`analytics/achievement.py`）无需改动。

设计约定（见工作区永久记忆 get_data 约定）：
- 每个 get_data 模块 = 一个接口；转发层也只负责「把这个接口的原始数据拿回来」
- 所有查询参数（team_id / time_code / cookie）均由调用方传入；不做选站点 / 统计 / 筛选
- 统计 / 筛选 / 格式化 / 自动重登 / 落盘归调用方，不在此处

上游接口地址与请求头**只保留在 Nest 侧**（`backend/src/modules/fetch/attendance-fetch.service.ts`）：
本模块不再持有任何风神 URL / headers 常量（2026-09-24 清理），以免留下
「Python 也知道上游接口」的误导 —— 取数归 Nest，Python 只转发。

「站点发现（选站点）」见 NestJS 的 `GET /api/teams`。
"""
from . import _http

def fetch_team(team_id, time_code, cookie=None):
    """单站点实时考勤 → 接口原始 JSON（含 result.data 骑手列表）。

    参数：team_id（站点）、time_code（时段码）；cookie 可选。
    会话失效会抛 `sources.session.AuthError`（由本层按 Nest 返回的 code 判定），
    调用方可用 `call_with_relogin` 重登重试 —— 与迁移前行为一致。
    """
    j = _http.unwrap(
        _http.call_with_cookie(
            "/api/fetch/attendance-raw",
            {"team_id": team_id, "time_code": time_code},
            cookie,
        ),
        "考勤",
    )
    return j.get("raw") or {}


__all__ = ["fetch_team"]
