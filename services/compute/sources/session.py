from analytics.core.paths import ROOT, PY_HOME, _ROOT  # noqa: E402,F401 <<<


# -*- coding: utf-8 -*-
"""sources/* 共用的「会话失效」类型与判定。

为什么要有这一层
----------------
同一件事被分散地实现了好几遍，且实现得不一致：

  · 各取数模块曾各自定义一个同名但**互不相认**的 `AuthError` —— 类型不同的异常在调用方
    无法统一捕获，于是每个调用方又各自写了一遍「重登重试」（当时是 orders_fetch.py 与
    schedule_statistics.py 各自的 Session，已随本地取数一并移除）。
  · violation 模块曾干脆没有会话异常，401 混在普通 RuntimeError 里往上抛，
    调用方分不清「没登录」和「服务出错」，只能静默失败（2026-09-22 事故）。

2026-09-23 起登录 / 重登已整体迁 NestJS：`POST /api/fetch/aeolus-relogin` 由 Nest 独占实现，
Nest 侧 `AeolusCookieService` 负责 validToken 探针 + 强制重登 + 进程内复用。Python 侧因此
**不再持有任何登录实现，也不再触发重登** —— 取数委托给 Nest 的 `/api/fetch/*`，Nest 返回的会话
失效错误由上层作为失败上报即可（Nest 会在内部自愈）。本模块只保留统一的异常类型与判定辅助。
"""

__all__ = [
    "SESSION_CODES", "AuthError", "ApiError",
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


