"""Notifier 抽象层：统一通知渠道入口（治理工作台重构思路 §2.4）。

get_notifier(channel, **cfg) 工厂按渠道名返回实现：
  - "dingtalk_cli"  : DingTalkCLINotifier  复用 dws CLI（默认，兼容现有）
  - "dingtalk_robot": DingTalkRobotNotifier 钉钉自定义机器人 webhook（需 webhook_url/secret）
  - "wecom_robot"   : WeComRobotNotifier    企微群机器人 webhook（需 webhook_url）

任务只产出 ReportPayload（标题 / 图片 URL / 文案 / @名单），由具体 Notifier 按渠道格式化发送。
同一份报表可同时推多个渠道，新增渠道零改任务代码。
"""
from .base import Notifier, ReportPayload
from .workbuddy_legacy import DingTalkCLINotifier
from .dingtalk_robot import DingTalkRobotNotifier
from .wecom_robot import WeComRobotNotifier

_FACTORIES = {
    "dingtalk_cli": DingTalkCLINotifier,
    "dingtalk_robot": DingTalkRobotNotifier,
    "wecom_robot": WeComRobotNotifier,
}


def get_notifier(channel: str = "dingtalk_cli", **cfg):
    """按渠道名构造 Notifier。默认 dingtalk_cli（复用现有 dws 发送，零配置可用）。"""
    if channel not in _FACTORIES:
        raise ValueError("未知通知渠道 %r；可选：%s" % (channel, ", ".join(_FACTORIES)))
    return _FACTORIES[channel](**cfg)


__all__ = [
    "Notifier", "ReportPayload", "get_notifier",
    "DingTalkCLINotifier", "DingTalkRobotNotifier", "WeComRobotNotifier",
]
