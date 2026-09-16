"""P0 安全网：core.notifier 特性测试（characterization tests）。

锁定 Notifier 抽象层的行为：legacy 适配器命令拼装、robot 加签、registry 注册。
全部为内存断言，不真实发送任何消息（legacy 用 dry_run 捕获命令行）。
"""
import io
import contextlib
from core import get_notifier, ReportPayload, TaskRegistry, TaskMeta


def test_legacy_notifier_dryrun_command_shape():
    n = get_notifier("dingtalk_cli", dry_run=True)
    p = ReportPayload(title="实时在线", text="## 实时在线\n明细 3 人",
                      image_url="https://x/y.png",
                      at=["印立澳", "黄志兵"], group="GROUP_X")
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        n.notify(p)
    out = buf.getvalue()
    # 命令必须包含 dws 入口、目标群、markdown 文本、yes 开关
    assert "dws chat message send" in out
    assert "--group GROUP_X" in out
    assert "--text" in out
    assert "![实时在线](https://x/y.png)" in out
    assert "--yes" in out


def test_legacy_notifier_resolves_at_to_openids(monkeypatch):
    # 用 monkeypatch 替代真实 dws 解析，验证 @ 名单被翻译成 openDingTalkId
    from common import ding_common
    monkeypatch.setattr(ding_common, "resolve_openids",
                        lambda names: ([("印立澳", "OPENID_A")], set()))
    n = get_notifier("dingtalk_cli", dry_run=True)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        n.notify(ReportPayload(title="t", text="x", at=["印立澳"], group="G"))
    assert "--at-open-dingtalk-ids OPENID_A" in buf.getvalue()


def test_robot_sign_url_contains_sign_and_timestamp():
    from core.notifier.dingtalk_robot import DingTalkRobotNotifier
    r = DingTalkRobotNotifier(
        webhook_url="https://oapi.dingtalk.com/robot/send?access_token=TOK",
        secret="SEC")
    url = r._signed_url()
    assert "sign=" in url and "timestamp=" in url
    assert url.startswith("https://oapi.dingtalk.com/robot/send?")


def test_wecom_notifier_constructs():
    from core.notifier.wecom_robot import WeComRobotNotifier
    w = WeComRobotNotifier(webhook_url="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K")
    assert w.name == "wecom_robot"


def test_get_notifier_unknown_channel_raises():
    import pytest
    with pytest.raises(ValueError):
        get_notifier("not_a_channel")


def test_registry_register_and_list():
    reg = TaskRegistry()
    reg.register(TaskMeta(id="attendance", name="实时在线", group="考勤",
                          description="各站点实时在线播报"))
    reg.register(TaskMeta(id="board", name="站长任务看板", group="看板"))
    assert len(reg.list()) == 2
    assert [t.id for t in reg.by_group("考勤")] == ["attendance"]
    assert len(reg.schedulable()) == 2


def test_registry_duplicate_id_rejected():
    import pytest
    reg = TaskRegistry()
    reg.register(TaskMeta(id="x", name="X"))
    with pytest.raises(ValueError):
        reg.register(TaskMeta(id="x", name="X2"))
