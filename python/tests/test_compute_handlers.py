# -*- coding: utf-8 -*-
"""计算 handler 库（`compute_api/handlers.py`）路由表完整性回归。

变更说明
--------
本文件原为 `tests/test_server_routes.py`，测的是根目录 `server.py`。随迁移收口：
  · `server.py` 的 HTTP 外壳（`class Handler` / `_serve_static_get` / `main()`）早已切除；
  · 其后 `server.py` 仅作为「compute_api 的 handler 库」被 `import server` 桥接；
  · 现已按 AST 依赖闭包把该计算子集精确迁入 `compute_api/handlers.py`，`server.py` 删除。

故断言对象改为 `handlers`。这些断言仍有价值：派发表不完整或 handler 不可调用，
会直接表现为 8900 上对应端点 404。
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

import pytest
from compute_api import handlers


def test_route_tables_complete():
    """每条路由的 handler 必须存在且可调用（compute_api 直接按表取用）。"""
    for name, fn in list(handlers.GET_ROUTES.items()) + list(handlers.POST_ROUTES.items()):
        assert fn is not None, "路由 %s 的 handler 为 None" % name
        assert callable(fn), "路由 %s 的 handler 不可调用" % name
    assert len(handlers.GET_ROUTES) > 0, "GET 路由表为空"
    assert len(handlers.POST_ROUTES) > 0, "POST 路由表为空"


def test_key_routes_present():
    """关键路由必须存在 —— 缺失会直接表现为对应端点 404。

    注意这里断言的是 **计算侧仍然负责** 的命名空间。
    鉴权 / 账号 / 角色 / 策略 / 数据权限 / todo / 任务运行 / 日志下载 / 产物预览
    等已由 NestJS 原生实现；teams / sheet / cookies/status / groups 由
    compute_api 自带端点实现 —— 它们**不在**派发表里才是正确的。
    """
    # 注意：refresh-all / refresh-all-status 已于 2026-09-23 迁为 Nest 原生端点，
    # 故不在此列（见下方 NEST_NATIVE）。
    for p in ("/api/standard/station-report",
              "/api/standard/achievement", "/api/standard/riders",
              "/api/realtime/station",
              "/api/attend-period/months", "/api/overview/standard"):
        assert p in handlers.GET_ROUTES, "缺少关键 GET 路由 %s" % p
    # /api/standard/teams-config 已随「参与考核站点」字段一并移除（改为
    # 标准达成设置里【按月份 × 站点】有配置即考核，由 Nest grade-global 端点负责）。
    for p in ("/api/attend-period/config",):
        assert p in handlers.POST_ROUTES, "缺少关键 POST 路由 %s" % p


# 已迁移到 NestJS 的端点（抽样）：计算侧不应再持有，否则又变成双份实现
NEST_NATIVE = (
    "/api/state", "/api/history", "/api/log", "/api/download", "/api/file",
    "/api/files", "/api/events", "/api/todo", "/api/todo/runs",
    "/api/admin/users", "/api/admin/roles", "/api/policy", "/api/data-perms",
    "/api/run", "/api/stop", "/api/cancel", "/api/teams", "/api/sheet",
    "/api/cookies/status",
    # 全量刷新（编排归 Nest：refresh.controller.ts + refresh-runner.service.ts）
    "/api/standard/refresh-all", "/api/standard/refresh-all-status",
)


def test_nest_native_routes_absent():
    """这些端点归 NestJS（或 compute 自带端点），计算派发表再出现即为回退。"""
    for p in NEST_NATIVE:
        assert p not in handlers.GET_ROUTES, "%s 不应再出现在计算 GET 表" % p
        assert p not in handlers.POST_ROUTES, "%s 不应再出现在计算 POST 表" % p


def test_no_python_side_data_permission_module():
    """数据权限规则只应有 NestJS 一份，Python 侧不得再持有。

    原 core/dataperm.py 会读 .data_perms.json 做兜底裁决，与 Nest 按 RBAC + 数据权限
    算出的 x-scope 并存 —— 两份规则一旦不一致就会互相打架。现在可见性一律由 compute
    的 _GatewayHandler 按 x-scope 提供（_visible_ids / _enforce_team_scope）。
    """
    import importlib

    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("core.dataperm")


def test_no_duplicate_todo_scheduler():
    """提醒事项的调度归 NestJS，计算进程不得再起第二个调度器。

    计算服务是独立进程（uvicorn 8900）。若这里再 `todo_sched.start(MGR)`，等于同时跑
    两套调度器（Nest 的 TodoSchedulerService 一套 + 本进程一套），同一事项存在被重复
    触发的风险。
    """
    assert not hasattr(handlers, "SCHED"), "计算侧不应再有 SCHED（调度归 NestJS）"
    assert not hasattr(handlers, "todo_sched"), "计算侧不应再 import todo_sched"
    assert not hasattr(handlers, "todo_store"), "计算侧不应再 import todo_store"


def test_no_workbench_side_effects():
    """计算 handler 库不得再持有工作台职责（均已迁 NestJS）。

    这些名字一旦回来，等于把已切除的「单体工作台」从后门引回来：
      · RunManager / MGR   —— 任务队列（Nest TaskRunnerService 负责）
      · API_TOKEN          —— 鉴权令牌（Nest TokenGuard 负责；计算进程不该持有）
      · serve_artifact /
        serve_under        —— 静态与产物托管（Nest ServeModule 负责）
      · diagnose           —— 错误诊断规则表（Nest diagnostics.util 负责）
      · load_registry /
        list_artifacts     —— 任务注册表与产物列举（Nest TasksModule 负责）
    """
    for name in ("RunManager", "MGR", "API_TOKEN", "_API_TOKEN_PATH",
                 "serve_artifact", "serve_under", "diagnose", "DIAG_RULES",
                 "load_registry", "list_artifacts", "_is_loopback_origin"):
        assert not hasattr(handlers, name), \
            "计算 handler 库不应再有 %s（该职责归 NestJS）" % name


def test_helpers_used_by_compute_api_exist():
    """compute_api 直接复用的纯函数必须在同模块内可调用。"""
    for fn in ("_fetch_all_teams", "_safe_resolve", "sheet_to_json"):
        assert callable(getattr(handlers, fn, None)), \
            "缺少被 compute_api 复用的函数 %s" % fn


def test_cookie_probes_migrated_to_nest():
    """登录态探针已迁 NestJS（`GET /api/cookies/status`），Python 侧不得再持有。

    一旦回流就会出现「两套探针、两套状态判定」——线上表现是顶部胶囊时好时坏且难定位。
    探针现由 `backend/src/modules/fetch/cookie-status.service.ts`（风神 validToken）与
    `quark-creds.service.ts`（DA 缓存 + 探针）独家提供。
    """
    for fn in ("check_cookie_status", "_check_aeolus_cookie", "_check_quark_cookie"):
        assert not hasattr(handlers, fn), \
            "登录态探针 %s 已迁 Nest，Python 侧不应再有" % fn


def test_teams_fetch_forwards_to_nest():
    """站点目录取数已迁 Nest：Python 侧只转发 `GET /api/fetch/teams`。

    守卫两件事：① 转发基址可解析（NEST_BASE / DING_NEST_BASE → loopback）；
    ② 本地 5 分钟缓存仍在，Nest 短暂不可用时不会每次打空。
    """
    assert callable(getattr(handlers, "_fetch_all_teams", None))
    assert callable(getattr(handlers, "_nest_base", None))
    assert handlers._nest_base().startswith("http")
    assert isinstance(handlers._TEAMS_CACHE, dict)
    assert handlers._TEAMS_CACHE_TTL == 300
