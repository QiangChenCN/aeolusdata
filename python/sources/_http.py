# -*- coding: utf-8 -*-
"""sources/* 共用的「转发到 NestJS 取数」客户端（薄封装）。

背景（ADR 修订 1，2026-09-22）：**取数不是计算** —— 打风神接口的事（分页 / 反爬节奏 /
限流退避 / 会话重登）整体归 NestJS。`sources/*` 因此从「接口客户端」变成「转发层」：
把参数交给 Nest 的 `/api/fetch/*`，把 Nest 返回的**原始数据结构**原样交回调用方 ——
上层（`analytics/*`、`analytics/realtime/*`）无需任何改动。

会话失效：Nest 的失败响应里带 `code`；`unwrap` 拿它与 `sources.session.SESSION_CODES`
比对，命中即抛 `AuthError`，让 `call_with_relogin` 照旧强制重登后重试
（重登也已迁 Nest：`POST /api/fetch/aeolus-relogin` —— Python 侧不再持有任何登录实现）。
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


def call_with_cookie(path, payload, cookie, timeout=180):
    """同上，但把调用方传入的 cookie 一并转发。

    为什么保留 cookie 透传：会话失效时上层（`call_with_relogin`）会强制重登并拿到新
    cookie，转发它可让后续调用直接复用该新会话（不传则由 Nest 读共享 cookie.txt）。
    空值不传，避免覆盖 Nest 侧的默认取值。
    """
    p = dict(payload or {})
    if cookie:
        p["cookie"] = cookie
    return call(path, p, timeout=timeout)


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
