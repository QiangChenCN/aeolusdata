"""DingTalkRobotNotifier：钉钉自定义机器人 webhook + 加签（不依赖 dws，更轻）。

配置：webhook_url（机器人 Webhook，含 token）+ secret（加签密钥）。
加签算法：HMAC-SHA256(base64)，timestamp 为毫秒。
@ 限制：自定义机器人只能按手机号（atMobiles）@ 群内成员，不能用 openDingTalkId；
故 @ 名单需用 `at_mobiles` 显式传入（配置驱动，见 §3.5 配置外置）。

参考：钉钉开放平台「自定义机器人」文档。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import urllib.parse
import urllib.request
from typing import Iterable, Optional

from .base import Notifier, ReportPayload


class DingTalkRobotNotifier(Notifier):
    name = "dingtalk_robot"

    def __init__(self, webhook_url: str, secret: str = "", timeout: float = 10.0):
        if not webhook_url:
            raise ValueError("DingTalkRobotNotifier 需要 webhook_url（机器人 Webhook）")
        self.webhook_url = webhook_url
        self.secret = secret
        self.timeout = timeout

    def _signed_url(self) -> str:
        if not self.secret:
            return self.webhook_url
        ts = str(round(time.time() * 1000))
        string_to_sign = "%s\n%s" % (ts, self.secret)
        hmac_code = hmac.new(self.secret.encode("utf-8"),
                             string_to_sign.encode("utf-8"),
                             digestmod=hashlib.sha256).digest()
        sign = urllib.parse.quote_plus(base64.b64encode(hmac_code))
        sep = "&" if "?" in self.webhook_url else "?"
        return "%s%ssign=%s&timestamp=%s" % (self.webhook_url, sep, sign, ts)

    def _post(self, payload: dict) -> dict:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self._signed_url(), data=data,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def send_markdown_image(self, title, text, image_url=None, at=(), group=None,
                            at_mobiles=()):
        content = text or ("# " + title)
        if image_url:
            content += "\n\n![%s](%s)" % (title, image_url)
        body = {"msgtype": "markdown", "markdown": {"title": title, "text": content}}
        mobiles = list(at_mobiles) if at_mobiles else []
        if mobiles:
            body["at"] = {"atMobiles": mobiles}
        return self._post(body)

    def send_text(self, text, group=None, at_mobiles=()):
        body = {"msgtype": "text", "text": {"content": text}}
        mobiles = list(at_mobiles) if at_mobiles else []
        if mobiles:
            body["at"] = {"atMobiles": mobiles}
        return self._post(body)

    def notify(self, payload: ReportPayload):
        # robot 的 @ 需手机号，ReportPayload.at 是姓名，这里不自动映射（避免误 @）
        self.send_markdown_image(payload.title, payload.text, payload.image_url,
                                 group=payload.group)
