# -*- coding: utf-8 -*-
"""sources/* 共用的「转发到 NestJS 取数」客户端（薄封装）。

背景（ADR 修订 1，2026-09-22）：**取数不是计算** —— 打风神接口的事（分页 / 反爬节奏 /
限流退避 / 会话重登）整体归 NestJS。`sources/*` 因此从「接口客户端」变成「转发层」：
把参数交给 Nest 的 `/api/fetch/*`，把 Nest 返回的**原始数据结构**原样交回调用方 ——
上层（`analytics/*`、`analytics/assessment/*`）无需任何改动。

会话失效：Nest 的失败响应里带 `code`；`unwrap` 拿它与 `sources.session.SESSION_CODES`
比对，命中即抛 `AuthError`。重登已归 Nest 独占（Nest 侧 `AeolusCookieService` 负责 validToken
探针 + 强制重登），Python 侧不再触发重登 —— 会话失效错误由上层作为失败上报即可。
"""
import os

from analytics.core.paths import ROOT, PY_HOME, _ROOT  # noqa: E402,F401 <<<


import sys

from .session import SESSION_CODES, ApiError, AuthError

# `common/` 是 ROOT 下的顶层目录。compute_api 启动时已把它加入 sys.path，
# 但 `python dashboard/xxx.py`、`python -m ...` 等入口不一定 —— 这里兜底，
# 保证 `import nest_client` 在任意入口下都能解析。
_COMMON = os.path.join(PY_HOME, "common")
if _COMMON not in sys.path:
    sys.path.insert(0, _COMMON)

# 必须复用 `common.nest_client` 这同一个模块对象：main.py / handlers.py 都通过
# `common.nest_client` 设置会话令牌（`set_session_token`），若此处单独 `import nest_client`
# 会得到另一个模块实例，其会话令牌全局永远为空，导致考勤等取数请求不带 X-Token 被 Nest 401。
from common import nest_client  # noqa: E402


def nest_base():
    """NestJS 基址（见 `common/nest_client.nest_base`）。"""
    return nest_client.nest_base()


def call(path, payload=None, timeout=180):
    """POST 到 Nest 的 `/api/fetch/*`，返回完整响应体（扁平 `{ok, ...}`）。"""
    return nest_client.post_json(path, payload, timeout=timeout)


def unwrap(j, what):
    """按 `{ok, code, error}` 拆包；会话类错误统一抛 `AuthError`（触发重登）。

    返回响应体本身，字段由调用方按各接口的名字自取（考勤是 `raw`、排班是 `rows`、
    违规是 `text`/`file_url`）。
    """
    if isinstance(j, dict) and j.get("ok"):
        return j
    j = j if isinstance(j, dict) else {}
    code = str(j.get("code") or "")
    err = str(j.get("error") or j.get("message") or "未知错误")
    if code in SESSION_CODES:
        raise AuthError("%s 取数会话失效：%s" % (what, err))
    raise ApiError("%s 取数失败：%s" % (what, err), code)
