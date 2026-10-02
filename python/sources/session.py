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

# -*- coding: utf-8 -*-
"""sources/* 共用的「会话失效」约定与重登重试原语。

为什么要有这一层
----------------
同一件事被分散地实现了好几遍，且实现得不一致：

  · 各取数模块曾各自定义一个同名但**互不相认**的 `AuthError` —— 类型不同的异常在调用方
    无法统一捕获，于是每个调用方又各自写了一遍「重登重试」（当时是 orders_fetch.py 与
    schedule_statistics.py 各自的 Session，已随本地取数一并移除）。
  · violation 模块曾干脆没有会话异常，401 混在普通 RuntimeError 里往上抛，
    调用方分不清「没登录」和「服务出错」，只能静默失败（2026-09-22 事故）。

另一个绕不开的事实：登录自检**不能全指望** —— 拿一个已失效的 cookie 去打接口只会得到 401。
所以这里必须支持**强制**重登，而不能只依赖自动复用路径。
（2026-09-23 起登录已迁 NestJS：`POST /api/fetch/aeolus-relogin`，其 `ensure()` 会先做
validToken 探针；本原语保留为「收到会话失效 → 强登 → 重试一次」的兜底。）

本模块提供统一的类型 / 判定 / 重试原语；具体节奏（重试几次、退避多久）仍由调用方
决定 —— 遵循 get_data 既有约定：模块内只负责打接口，重试编排归调用方。
"""

__all__ = [
    "SESSION_CODES", "AuthError", "ApiError",
    "is_session_error", "refresh_cookie", "call_with_relogin",
]

# 代表「会话失效」的接口错误码。
# 401 是 HTTP 语义码；UNAUTHORIZED 是该接口 401 时 error.name 的实际取值。
SESSION_CODES = ("401", "UNAUTHORIZED")


class AuthError(Exception):
    """会话失效（单点登录被顶号 / cookie 过期）。sources/* 统一使用这一个类型。"""


class ApiError(RuntimeError):
    """接口错误，带 code。继承 RuntimeError 以兼容既有「捕获 RuntimeError」的调用方。

    code 让调用方能区分「会话失效」与「其它业务/服务错误」，不必依赖
    message 字符串匹配（脆弱：文案一改就失效）。
    """

    def __init__(self, message, code=""):
        super().__init__(message)
        self.code = str(code or "")


def is_session_error(exc):
    """判定异常是否代表「会话失效」—— 即值得强制重登后重试。"""
    if isinstance(exc, AuthError):
        return True
    code = getattr(exc, "code", None)
    return code is not None and str(code) in SESSION_CODES


def refresh_cookie():
    """强制重登，返回新 cookie。

    2026-09-23：登录已迁 NestJS —— 取数归 Nest，登录作为取数的前置能力也归 Nest。
    本函数只转发 `POST /api/fetch/aeolus-relogin`，Python 侧不再实现 SSO。
    """
    from . import _http
    j = _http.unwrap(_http.call("/api/fetch/aeolus-relogin", {}, timeout=120), "风神重登")
    return j.get("cookie") or ""


def call_with_relogin(fn, *args, cookie=None, max_relogin=1, backoff=None, **kwargs):
    """调 fn(*args, cookie=cookie, **kwargs)；遇会话失效则强制重登后重试。

    max_relogin  允许的「重登 + 重试」次数（默认 1，即总共最多打两次）
    backoff      可选回调 backoff(attempt)，在重登**前**调用
                 （给服务端留出新会话生效的窗口）

    返回 (result, cookie)：cookie 可能已被刷新，调用方应保存下来供后续调用复用。

    刻意的设计（别改动这几条，每一条都对应一次真实事故）：
      · 只重试「会话失效」；其它错误（限流 / 服务异常）原样上抛 ——
        避免一出故障就无意义地反复登录。
      · 重登本身失败时抛出**原始取数错误**，不用登录异常掩盖真实原因。
      · 重试次数有限，绝不无限循环。
    """
    for attempt in range(max_relogin + 1):
        try:
            return fn(*args, cookie=cookie, **kwargs), cookie
        except Exception as e:
            if not is_session_error(e) or attempt == max_relogin:
                raise
            if backoff:
                backoff(attempt)
            try:
                cookie = refresh_cookie()
            except Exception:
                # 重登失败：抛原始取数错误，别让登录异常盖掉真正的原因
                raise e
