"""Notifier 抽象：把「消息发送」与任务逻辑解耦（治理工作台重构思路 §2.4）。

任务只产出 ReportPayload（标题 / 图片 URL / 文案 / @名单），由具体 Notifier 负责按渠道格式化发送。
同一份报表可同时推多个渠道，新增渠道零改任务代码。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Optional


@dataclass
class ReportPayload:
    """任务产出统一结构。"""
    title: str
    text: str = ""                              # markdown 正文
    image_url: Optional[str] = None             # 公网直链（Markdown 内联图）
    at: Iterable[str] = field(default_factory=list)   # @名单（姓名）：由 Notifier 按渠道映射成 id / 手机号
    group: Optional[str] = None                 # 目标群标识：具体 Notifier 解释；None=默认群


class Notifier:
    """发送渠道抽象基类。子类实现 send_* / notify。"""

    name = "base"

    def send_text(self, text: str, group: Optional[str] = None) -> None:
        raise NotImplementedError

    def send_markdown_image(self, title: str, text: str,
                            image_url: Optional[str] = None,
                            at: Iterable[str] = (),
                            group: Optional[str] = None) -> None:
        raise NotImplementedError

    def notify(self, payload: "ReportPayload") -> None:
        """默认实现：把 payload 转 markdown + 图片发送；子类可按渠道优化。"""
        self.send_markdown_image(payload.title, payload.text,
                                  payload.image_url, payload.at, payload.group)
