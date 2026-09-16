"""core 层装配自检（不真实发送、不迁移业务）。

用法：python -m core._selftest
验证：
  1. Notifier 抽象 + 三种实现可构造
  2. DingTalkCLINotifier(dry_run) 能正确拼出 dws 命令
  3. DingTalkRobotNotifier 加签 URL 生成正确（不 POST）
  4. WeComRobotNotifier 构造正确
  5. TaskRegistry 注册 + 列举
  6. NodeflowTask 用内置 NODES dry_run 执行
"""
from __future__ import annotations

import os
import sys

# 让 `python -m core._selftest` 也能找到项目根
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core import (Notifier, ReportPayload, get_notifier,
                  TaskRegistry, TaskMeta, TaskRuntime, NodeflowTask, Stage)


def test_notifier_dryrun():
    n = get_notifier("dingtalk_cli", dry_run=True)
    assert isinstance(n, Notifier)
    p = ReportPayload(title="实时在线", text="## 实时在线\n明细 3 人",
                      image_url="https://x/y.png",
                      at=["印立澳", "黄志兵"], group="GROUP_X")
    print("— DingTalkCLINotifier(dry_run) —")
    n.notify(p)          # 仅打印命令，不真发


def test_robot_sign():
    from core.notifier.dingtalk_robot import DingTalkRobotNotifier
    r = DingTalkRobotNotifier(
        webhook_url="https://oapi.dingtalk.com/robot/send?access_token=TOK",
        secret="SEC")
    url = r._signed_url()
    assert "sign=" in url and "timestamp=" in url, url
    print("— DingTalkRobotNotifier 加签 URL 样例 —\n  " + url)


def test_wecom():
    from core.notifier.wecom_robot import WeComRobotNotifier
    w = WeComRobotNotifier(webhook_url="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K")
    assert w.name == "wecom_robot"
    print("— WeComRobotNotifier 构造 OK —")


def test_registry():
    reg = TaskRegistry()
    reg.register(TaskMeta(id="attendance", name="实时在线", group="考勤",
                          description="各站点实时在线播报"))
    reg.register(TaskMeta(id="board", name="站长任务看板", group="看板"))
    assert len(reg.list()) == 2
    assert len(reg.by_group("考勤")) == 1
    print("— TaskRegistry 注册 %d 个任务：%s —"
          % (len(reg.list()), [t.id for t in reg.list()]))


def test_nodeflow_task():
    class DemoTask(NodeflowTask):
        id = "demo"
        NODES = [
            {"id": "fetch", "name": "拉取", "desc": "x", "fn": lambda c: c.update(fetch=1)},
            {"id": "send", "name": "发送", "desc": "x", "fn": lambda c: None},
        ]

    rt = TaskRuntime()
    res = rt.run(DemoTask(), {})
    assert res.ok, res.error
    print("— NodeflowTask 执行 OK：%s —" % res.steps)


if __name__ == "__main__":
    test_notifier_dryrun()
    test_robot_sign()
    test_wecom()
    test_registry()
    test_nodeflow_task()
    print("\n[PASS] core 抽象骨架自检全部通过（未真实发送任何消息）")
