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
"""风控处罚 CSV 取数 —— **转发层**（单一来源）。

⚠️ 2026-09-23：**取数已迁 NestJS**（ADR 修订 1）。本文件不再自己打风神接口，只把参数
转发给 `POST /api/fetch/violation-csv`（Nest 侧两步：POST 取签名链接 → GET 下载 OSS）。
返回形状与迁移前**逐字一致**（元组 `(text, file_url)`），调用方
（`analytics/assessment/violations.py`）无需改动。

设计约定（见工作区永久记忆 get_data 约定）：
- 每个 get_data 模块 = 一个接口；转发层也只负责「把这个接口的原始数据拿回来」
- 所有查询参数（start_ms / end_ms / cookie）均由调用方传入；不做选日期（今天/昨天）
- 禁止在模块内做：统计 / 筛选 / 格式化 / 自动重登 / 落盘 / CLI

上游接口地址与请求头**只保留在 Nest 侧**（`backend/src/modules/fetch/violation-fetch.service.ts`）：
本模块不再持有任何风神 URL / headers 常量（2026-09-24 清理）。
"""
from . import _http
from .session import ApiError  # noqa: E402  统一的 get_data 会话失效约定

class ViolationApiError(ApiError):
    """风控处罚明细接口错误（继承 `sources.session.ApiError` 这一统一类型）。

    保留此类是为了兼容既有引用；转发层现在直接抛 `ApiError` / `AuthError`。
    """


def download_csv(start_ms, end_ms):
    """拉取 [start_ms, end_ms] 区间的风控处罚 CSV，返回 `(text, file_url)`。

    text 为解码后的 CSV 文本（GBK 优先，回退 UTF-8），file_url 为风神 OSS 签名链接。
    不含落盘 / 筛选；会话失效抛 `AuthError`，由上层作为失败上报（重登已归 Nest 独占）。
    """
    j = _http.unwrap(
        _http.call(
            "/api/fetch/violation-csv",
            {"start_ms": int(start_ms), "end_ms": int(end_ms)},
        ),
        "违规明细",
    )
    return j.get("text") or "", j.get("file_url") or ""


__all__ = ["download_csv", "ViolationApiError"]
