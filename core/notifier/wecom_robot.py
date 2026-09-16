"""WeComRobotNotifier：企业微信群机器人 webhook + key（纯 HTTP，不依赖 dws）。

配置：webhook_url（企微机器人完整 URL，含 key=...）。
消息体：{"msgtype":"markdown","markdown":{"content":...}}。
@ 语法：content 内用 <@userid>，并在 mentioned_list 列出 userid。
参考：企业微信开放平台「群机器人」文档。
"""
from __future__ import annotations

import json
import urllib.request
from typing import Iterable, Optional

from .base import Notifier, ReportPayload


class WeComRobotNotifier(Notifier):
    name = "wecom_robot"

    def __init__(self, webhook_url: str, timeout: float = 10.0):
        if not webhook_url:
            raise ValueError("WeComRobotNotifier 需要 webhook_url（企微机器人 URL）")
        self.webhook_url = webhook_url
        self.timeout = timeout

    def _post(self, payload: dict) -> dict:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self.webhook_url, data=data,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def send_markdown_image(self, title, text, image_url=None, at=(), group=None,
                            mentioned_list=()):
        content = text or ("# " + title)
        if image_url:
            content += "\n\n![%s](%s)" % (title, image_url)
        if at:
            for u in at:
                content += "\n<@%s>" % u
        body = {"msgtype": "markdown", "markdown": {"content": content}}
        users = list(mentioned_list) if mentioned_list else []
        if at and not users:
            users = list(at)
        if users:
            body["markdown"]["mentioned_list"] = users
        return self._post(body)

    def send_text(self, text, group=None, mentioned_list=()):
        body = {"msgtype": "text", "text": {"content": text}}
        users = list(mentioned_list) if mentioned_list else []
        if users:
            body["text"]["mentioned_list"] = users
        return self._post(body)

    def notify(self, payload: ReportPayload):
        self.send_markdown_image(payload.title, payload.text, payload.image_url,
                                 at=payload.at, group=payload.group)
