from analytics.core.paths import ROOT, PY_HOME, _ROOT  # noqa: E402,F401 <<<


#!/usr/bin/env python3
"""实时考勤取数 —— **转发层**（单一来源）。

⚠️ 2026-09-23：**取数已迁 NestJS**（ADR 修订 1）。本文件不再自己打风神接口，只把参数
转发给 `POST /api/fetch/attendance-raw`。返回形状与迁移前**逐字一致**（接口原始 JSON），
调用方（`analytics/rider_dimension.py`、`analytics/achievement.py`）无需改动。

设计约定（见工作区永久记忆 get_data 约定）：
- 每个 get_data 模块 = 一个接口；转发层也只负责「把这个接口的原始数据拿回来」
- 所有查询参数（team_id / time_code）均由调用方传入；不做选站点 / 统计 / 筛选
- 统计 / 筛选 / 格式化 / 落盘归调用方，不在此处

上游接口地址与请求头**只保留在 Nest 侧**（`apps/api/src/modules/fetch/attendance-fetch.service.ts`）：
本模块不再持有任何风神 URL / headers 常量（2026-09-24 清理），以免留下
「Python 也知道上游接口」的误导 —— 取数归 Nest，Python 只转发。

「站点发现（选站点）」见 NestJS 的 `GET /api/teams`。
"""
from . import _http

def fetch_team(team_id, time_code):
    """单站点实时考勤 → 接口原始 JSON（含 result.data 骑手列表）。

    参数：team_id（站点）、time_code（时段码）。登录态由 Nest 自行补齐，Python 不传 cookie、
    也不触发重登（重登已归 Nest 独占）。会话失效会抛 `sources.session.AuthError`，
    由上层作为失败上报。
    """
    j = _http.unwrap(
        _http.call(
            "/api/fetch/attendance-raw",
            {"team_id": team_id, "time_code": time_code},
        ),
        "考勤",
    )
    return j.get("raw") or {}


__all__ = ["fetch_team"]
