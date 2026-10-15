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

落盘侧（写）自 2026-09-23 起在 NestJS（`RawCacheService`，Python 的 `cache.save_*` 只转发），
故本文件：
  · 「读侧拿到某种文件时的行为」用**直接落盘的种子文件**验证（见 `_seed_violation`）；
  · 「转发是否发出正确的请求」用打桩 `nest_client.post_json` 验证。
两者都不需要有一个在跑的 Nest —— 单元测试不该依赖运行中的服务。
"""
import json
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
from analytics import cache as CACHE
from analytics.assessment import violations as RV


# ---------------- 违规明细的陈旧可见化 ----------------

@pytest.fixture
def tmp_data(monkeypatch, tmp_path):
    """把原始层目录指到临时目录，避免污染 backend/data/raw 与 backend/data/assessment。"""
    monkeypatch.setattr(CACHE, "_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(RV, "ASSESS_RAW_DIR", str(tmp_path))
    return tmp_path


def _seed_violation(team, date, rows, ok=True, error=None):
    """直接落盘一份违规明细文件（形状为「跨语言契约」）。

    生产写入方现为 Nest 的 `AssessmentViolationFetchService`，全天违规合并为一份当天文件
    `backend/data/违规处罚明细-实时.json`（覆盖写）；本文件只钉读侧行为。
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


# ---------------- 落盘已委托 Nest：转发契约 ----------------

def _stub_post(monkeypatch, result=None):
    """打桩 nest_client.post_json，返回记录到的 (path, payload) 列表。"""
    from common import nest_client

    sent = []

    def _fake(path, payload=None, timeout=None):
        sent.append((path, payload))
        return result or {"ok": True, "saved": True}

    monkeypatch.setattr(nest_client, "post_json", _fake)
    return sent


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


def test_save_raw_refuses_empty_payload_without_calling_nest(tmp_data, monkeypatch):
    """空 payload 本地就拦掉：不该为空数据打一次 HTTP（Nest 侧还会再判一次）。"""
    sent = _stub_post(monkeypatch)
    assert CACHE.save_raw("orders", "917521136", [], "2026-09-21") is False
    assert sent == []
    with pytest.raises(ValueError):
        CACHE.save_raw("not-a-kind", "917521136", [{"a": 1}], "2026-09-21")
    assert sent == []


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


def test_call_with_relogin_respects_max(monkeypatch):
    """max_relogin=N → 最多 N 次重登，即总共 N+1 次尝试。"""
    from sources import session as GA

    attempts = []

    def fn(cookie=None):
        attempts.append(cookie)
        if len(attempts) <= 3:
            raise GA.AuthError("会话失效")
        return "ok"

    monkeypatch.setattr(GA, "refresh_cookie", lambda: "c%d" % len(attempts))

    out, cookie = GA.call_with_relogin(fn, cookie="c0", max_relogin=5)
    assert out == "ok"
    assert len(attempts) == 4, "第 4 次成功即止，不必用满 max_relogin"
    assert attempts == ["c0", "c1", "c2", "c3"], "每次重登后必须用新 cookie"


def test_call_with_relogin_backoff_called_before_relogin(monkeypatch):
    """backoff 回调应在每次重登前被调用（给服务端留出新会话生效窗口）。"""
    from sources import session as GA

    backoffs, refreshed = [], []

    def fn(cookie=None):
        raise GA.AuthError("会话失效")

    monkeypatch.setattr(GA, "refresh_cookie", lambda: (refreshed.append(1), "new")[1])

    with pytest.raises(GA.AuthError):
        GA.call_with_relogin(fn, cookie="c0", max_relogin=3,
                             backoff=lambda n: backoffs.append(n))

    assert backoffs == [0, 1, 2]
    assert len(refreshed) == 3


def test_call_with_relogin_does_not_retry_other_errors(monkeypatch):
    """非会话错误（限流/服务异常）一律不重试 —— 避免一出故障就反复登录。"""
    from sources import session as GA

    calls = []

    def fn(cookie=None):
        calls.append(cookie)
        raise RuntimeError("请求太频繁")

    monkeypatch.setattr(
        GA, "refresh_cookie",
        lambda: pytest.fail("非会话错误不应触发重登"))

    with pytest.raises(RuntimeError):
        GA.call_with_relogin(fn, cookie="c0", max_relogin=5)
    assert len(calls) == 1


# 注：原 3 个 `orders_fetch.Session` 用例（重登上限 / 重登后恢复 / 限流不重登）随之删除 ——
# 本地运单拉取路径已按「取数归 NestJS」移除，那次重登编排的等价实现在 Nest 侧
# （`fetch-pace` + `orders-fetch`，由 `refresh-runner.spec.ts` 覆盖编排层）。
