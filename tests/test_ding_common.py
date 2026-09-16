"""P0 安全网：common.ding_common 特性测试。

锁定 dws 命令解析与执行层行为（治理 §2.1 路径硬编码）：
- resolve_dws_cmd 的环境变量解析（DING_DWS_BIN 优先）
- dws_run 以参数列表（非 shell）调用 subprocess，返回 (out, err, code)；非零退出上抛 RuntimeError
- resolve_openids 的 DO_NOT_AT 排除与未知人回落（关键业务规则）
全部通过 monkeypatch 隔离外部进程，不真实执行 dws。
"""
import os
import subprocess
import pytest
from common import ding_common


def test_resolve_dws_cmd_honors_env(monkeypatch):
    monkeypatch.setenv("DING_DWS_BIN", "/opt/dws/dws")
    # 强制 isfile 对该路径为真，避免回退到 PATH / WorkBuddy 捆绑路径
    real_isfile = os.path.isfile
    monkeypatch.setattr(os.path, "isfile",
                        lambda p: p == "/opt/dws/dws" or real_isfile(p))
    cmd = ding_common.resolve_dws_cmd()
    assert cmd and cmd[0] == "/opt/dws/dws"


def test_dws_run_calls_subprocess_with_arg_list(monkeypatch):
    captured = {}

    class _Fake:
        returncode = 0
        stdout = ""
        stderr = ""

    def _fake_run(args, **kw):
        captured["args"] = list(args)
        captured["kw"] = kw
        return _Fake()

    monkeypatch.setattr(subprocess, "run", _fake_run)
    out, err, code = ding_common.dws_run(
        ["chat", "message", "send", "--group", "G", "--text", "hi", "--yes"])
    assert code == 0
    # 必须以参数列表传入，且禁止 shell=True（防命令注入）
    assert "chat" in captured["args"]
    assert captured["kw"].get("shell") is not True


def test_dws_run_propagates_nonzero(monkeypatch):
    # dws(raise_on_error=True) 在非零退出时上抛 RuntimeError（经 with_retry 重试后）
    class _Fake:
        returncode = 7
        stdout = ""
        stderr = ""

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Fake())
    with pytest.raises(RuntimeError):
        ding_common.dws_run(["chat", "x"])


def test_resolve_openids_skips_do_not_at_and_missing():
    # 锁住关键业务规则：DO_NOT_AT（陈强）被排除、未知人进 missing
    resolved, missing = ding_common.resolve_openids({"印立澳", "陈强", "未知人"})
    names = [n for n, _ in resolved]
    assert "印立澳" in names
    assert "陈强" not in names
    assert "未知人" in missing
