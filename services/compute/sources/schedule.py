# >>> python-home bootstrap (added by layout migration) >>>
import os as _os
import sys as _sys

def _find_python_home():
    d = _os.path.dirname(_os.path.abspath(__file__))
    # 计算服务代码根：同时含 analytics/ 与 compute_api/ 子目录
    while d and not (
        _os.path.isdir(_os.path.join(d, "analytics"))
        and _os.path.isdir(_os.path.join(d, "compute_api"))
    ):
        d = _os.path.dirname(d)
    return d

def _find_repo_root():
    d = _os.path.dirname(_os.path.abspath(__file__))
    # 仓库根：含 .git 或根 package.json
    while d and d != _os.path.dirname(d) and not (
        _os.path.exists(_os.path.join(d, ".git"))
        or _os.path.exists(_os.path.join(d, "package.json"))
    ):
        d = _os.path.dirname(d)
    return d

PY_HOME = _find_python_home()
ROOT = _find_repo_root()
_ROOT = ROOT
if PY_HOME and PY_HOME not in _sys.path:
    _sys.path.insert(0, PY_HOME)
# <<< python-home bootstrap <<<


#!/usr/bin/env python3
"""排班目标（排班统计）取数 —— **转发层**（单一来源）。

⚠️ 2026-09-23：**取数已迁 NestJS**（ADR 修订 1）。本文件不再自己打风神接口，只把参数
转发给 `POST /api/fetch/sched-raw`（Nest 侧含网络/限流退避与会话失效判定）。返回形状与
迁移前**逐字一致**（`result.data`，按天列表），调用方（`analytics/achievement.py`、
`analytics/*`）无需改动。

设计约定（见工作区永久记忆 get_data 约定）：
- 每个 get_data 模块 = 一个接口；转发层也只负责「把这个接口的原始数据拿回来」
- 所有查询参数（cookie / team_id / start_date / end_date）均由调用方传入
- 禁止在模块内做：自动重登 / 展平(flatten) / 写盘 / CLI
- 「Session 自动重登 / 调用编排」归调用方；排班展平已收进 `sources.flatten_schedule`
  （原 analytics/schedule_statistics.py 的 flatten 与之逐行重复，2026-09-24 合并删除）

对外能力：
- query(team_id, start_date, end_date, retries=8, cookie=None) -> rows
  单站请求，返回 result.data（按天列表）
- build_body(team_id, start_date, end_date)   组装请求体（现由 Nest 侧组装，此函数保留作对照）
- AuthError                                   会话失效异常（由上层作为失败上报）

上游接口地址与请求头**只保留在 Nest 侧**（`backend/src/modules/fetch/schedule-fetch.service.ts`）：
本模块不再持有任何风神 URL / headers 常量（2026-09-24 清理）。
"""
import datetime

from . import _http
from .session import AuthError  # noqa: E402

def _as_date_str(d):
    """接受 'YYYY-MM-DD' 字符串或 datetime.date，统一返回 'YYYY-MM-DD'。"""
    if isinstance(d, datetime.date):
        return d.strftime("%Y-%m-%d")
    return str(d)


def build_body(team_id, start_date, end_date):
    """组装请求体（`teamId` 强转 int、日期归一为 `YYYY-MM-DD`）。

    保留作**对照/测试**用：请求体现已由 Nest 侧组装
    （`schedule-fetch.service.ts::query`，口径与此一致）。
    """
    return {"params": {"request": {
        "teamId": int(team_id),
        "startDate": _as_date_str(start_date),
        "endDate": _as_date_str(end_date),
    }}}


def query(team_id, start_date, end_date, retries=8):
    """单站排班统计 → `result.data`（按天列表）。

    `retries` 仅为**签名兼容**保留：网络/限流退避现由 Nest 承担
    （`schedule-fetch.service.ts`，退避节奏 `2+2n` / `3+3n` 与迁移前逐字一致）。
    会话失效（result 为 null / 401 / 账户下线）抛 `AuthError`，由上层作为失败上报
    （重登已归 Nest 独占，Python 不再触发）。
    """
    j = _http.unwrap(
        _http.call(
            "/api/fetch/sched-raw",
            {"team_id": team_id, "start": _as_date_str(start_date), "end": _as_date_str(end_date)},
        ),
        "排班",
    )
    return j.get("rows") or []


__all__ = ["AuthError", "build_body", "query"]
