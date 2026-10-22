# -*- coding: utf-8 -*-
"""数据权限 / 陈旧可见化 + 会话失效自愈 的行为回归。

覆盖三类「改坏了不会报错、只会静默失效」的行为 —— 正是最该被测试钉住的那类：

  · 违规明细拉取失败：必须落失败标记，load_team 返回 None，不能把盘上遗留的
    上一次成功数据当成当次有效数据继续算（数字照常显示、实际已陈旧、且无报错）。
  · 会话失效自愈：401 → 强制重登 → 只重试一次；非会话错误绝不重登。
  · sources/* 共享同一个 AuthError 类型（否则调用方无法统一捕获）。

注：原先还覆盖「refresh-all 的 x-scope 收敛」。该项已随全量刷新**编排**迁到 NestJS，
用例随之迁到 `backend/src/modules/fetch/refresh-runner.spec.ts` —— 跨语言两层各测各的，
比在 Python 里测一个已不存在的 handler 更准确。

落盘侧（写）已整体迁到 NestJS（`RawCacheService`），Python 不再写原始层，
故本文件只覆盖「读侧」行为：用**直接落盘的种子文件**验证（见 `_seed_violation`）。
单元测试不该依赖运行中的服务。
"""
import json
import os

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


import sys

import pytest
from analytics.core import cache as CACHE
from analytics.domains.assessment import violations as RV


# ---------------- 违规明细的陈旧可见化 ----------------

@pytest.fixture
def tmp_data(monkeypatch, tmp_path):
    """把原始层目录指到临时目录，避免污染 apps/api/runtime/raw 与 apps/api/runtime/assessment。"""
    monkeypatch.setattr(CACHE, "_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(RV, "ASSESS_RAW_DIR", str(tmp_path))
    return tmp_path


def _seed_violation(team, date, rows, ok=True, error=None):
    """直接落盘一份违规明细文件（形状为「跨语言契约」）。

    生产写入方现为 Nest 的 `AssessmentViolationFetchService`，全天违规合并为一份当天文件
    `apps/api/runtime/违规处罚明细-实时.json`（覆盖写）；本文件只钉读侧行为。
    rows 中每条记录需自带「团队ID」字段，读侧按团队ID过滤出本站点行。
    """
    payload = {
        "date": date,
        "fetched_at": "2026-09-21 20:45:15",
        "fetch_ok": bool(ok),
        "fetch_error": (None if ok else (str(error or "")[:300] or None)),
        "rows": rows or [],
    }
    with open(RV._own_path(date), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)


def test_no_data_returns_none(tmp_data):
    """从未落盘：load_team / load_team_raw 都是 None。"""
    assert RV.load_team("917521136", "2026-09-21") is None
    assert RV.load_team_raw("917521136", "2026-09-21") is None


def test_fetched_zero_rows_is_empty_list_not_none(tmp_data):
    """已刷新但当天 0 条：返回空列表，与「不可用」(None) 必须可区分。"""
    _seed_violation("917521136", "2026-09-21", [])
    got = RV.load_team("917521136", "2026-09-21")
    assert got == [], "0 条应返回 [] 而不是 None"
    assert RV.load_team_raw("917521136", "2026-09-21")["fetch_ok"] is True


def test_failed_fetch_hides_stale_rows(tmp_data):
    """本次拉取失败：不得把盘上遗留的上一次成功数据当成当次有效数据。"""
    tid, date = "917521136", "2026-09-21"
    rows = [{"团队ID": tid, "违规分类": "投诉", "违规状态": "成立"}]
    _seed_violation(tid, date, rows)
    assert RV.load_team(tid, date) is not None, "前置：成功落盘后应能读到"

    _seed_violation(tid, date, rows, ok=False,
                    error="模拟：违规明细接口返回空 result（code=401 未登录）")

    assert RV.load_team(tid, date) is None, "失败后必须视为不可用，不能继续显示旧数据"
    raw = RV.load_team_raw(tid, date)
    assert raw["fetch_ok"] is False
    assert "401" in (raw["fetch_error"] or ""), "失败原因要能读出来供前端/刷新状态显示"
    assert raw["rows"], "旧 rows 应保留，便于事后回查"


def test_recovered_fetch_restores_rows(tmp_data):
    """后续一次成功刷新应能覆盖失败标记，重新可用（不必人工清数据）。"""
    tid, date = "917521136", "2026-09-21"
    _seed_violation(tid, date, [{"团队ID": tid}])
    _seed_violation(tid, date, [{"团队ID": tid}], ok=False, error="模拟失败")
    assert RV.load_team(tid, date) is None

    _seed_violation(tid, date, [{"团队ID": tid}])
    assert RV.load_team(tid, date) is not None
    assert RV.load_team_raw(tid, date)["fetch_ok"] is True


# ---------------- 读侧行为 ----------------

def test_load_team_reads_own_namespace_and_ignores_shared_raw(tmp_data):
    """考核看板违规读侧只认自有单文件 违规处罚明细-实时.json；

    旧的共享 raw/violation_* 即使存在也读不到 —— 与标准达成 / 服务质量彻底解耦，不串数据。
    """
    tid, date = "917521136", "2026-09-21"
    # 旧共享命名空间落一份数据 —— 读侧必须无视
    with open(CACHE._path("violation", tid, date), "w", encoding="utf-8") as f:
        json.dump({"date": date, "team_id": tid, "fetched_at": "x",
                   "fetch_ok": True, "fetch_error": None,
                   "rows": [{"团队ID": tid}]}, f, ensure_ascii=False)
    assert RV.load_team(tid, date) is None, "不得读旧的共享 raw/violation_*"

    # 自有命名空间落同样数据 —— 读侧认
    _seed_violation(tid, date, [{"团队ID": tid}])
    assert RV.load_team(tid, date) is not None


# ---------------- 会话失效自愈：401 → 强制重登 → 重试一次 ----------------

def test_violation_api_error_is_runtime_error():
    """结构化异常必须仍是 RuntimeError，否则会打断既有捕获方。"""
    from sources import violation as V
    e = V.ViolationApiError("违规明细接口返回空 result（code=401 未登录）", "401")
    assert isinstance(e, RuntimeError)
    assert e.code == "401"


# 注：以下「会话失效自愈（401 → 强制重登 → 重试一次 / 至多一次 /
# 非会话错误不重登）」的编排已随违规取数迁到 NestJS（见
# violation-fetch.service.ts 的 downloadCsv），Python 侧 RV.fetch_rows 已删除，
# 相关用例随之移除 —— 跨语言两层各测各的。


# ---------------- sources/auth 共享原语本身 ----------------

def test_all_modules_share_one_autherror_type():
    """各 get_data 模块导出的 AuthError 必须是同一个类型 —— 否则调用方无法统一捕获。

    注：`delivery` / `delivery_export` 已随「本地运单拉取」一并删除（取数归 NestJS），
    这里只剩仍在用的 `schedule`。
    """
    from sources import session as GA
    from sources import schedule as SS

    assert SS.AuthError is GA.AuthError, "schedule 仍在用自己的本地 AuthError"


def test_python_no_longer_triggers_relogin():
    """重登已整体迁 NestJS；Python 侧不得再持有触发/编排重登的原语。"""
    from sources import session as GA

    assert not hasattr(GA, "call_with_relogin"), "Python 不应再触发重登"
    assert not hasattr(GA, "refresh_cookie"), "Python 不应再实现重登"
    assert not hasattr(GA, "is_session_error"), "is_session_error 仅随 call_with_relogin 存在"


# 注：原 3 个 `orders_fetch.Session` 用例（重登上限 / 重登后恢复 / 限流不重登）随之删除 ——
# 本地运单拉取路径已按「取数归 NestJS」移除，那次重登编排的等价实现在 Nest 侧
# （`fetch-pace` + `orders-fetch`，由 `refresh-runner.spec.ts` 覆盖编排层）。
