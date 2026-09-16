"""DingTalkCLINotifier：复用 common.ding_common 的 dws CLI 发送（治理 §2.1 路径硬编码已在该模块内解决）。

这是现有桌面 / 服务器 dws 出口的适配器：任务从此只调 notifier.notify(payload)，
不再直接 import ding_common 拼 dws 参数。dws 命令前缀由 ding_common.resolve_dws_cmd()
解析（DING_DWS_BIN / PATH / WorkBuddy 回退）——换机 / 换服务器只需配环境变量，不改代码。

发送参数对齐现有 jobs（如 attendance.run_send）：
    dws chat message send --group <cid> --text <markdown> --yes [--at-open-dingtalk-ids <ids>]
"""
from __future__ import annotations

import os
import sys
from typing import Iterable, Optional

from .base import Notifier, ReportPayload

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from common import ding_common


class DingTalkCLINotifier(Notifier):
    name = "dingtalk_cli"

    def __init__(self, group: Optional[str] = None, dry_run: bool = False):
        """
        group    : 默认目标群 cid；None 回落 ding_common.GROUP_ID（生产群）
        dry_run  : True 时只打印将要执行的 dws 命令，不真正调用（用于验证装配 / 测试）
        """
        self.default_group = group or ding_common.GROUP_ID
        self.dry_run = dry_run

    def _send(self, args):
        if self.dry_run:
            print("[dry_run] dws %s" % " ".join(args))
            return
        ding_common.dws_run(args)

    def send_text(self, text, group=None):
        self._send(["chat", "message", "send", "--group", group or self.default_group,
                    "--text", text, "--yes"])

    def send_markdown_image(self, title, text, image_url=None, at=(), group=None):
        gid = group or self.default_group
        content = text or ("# " + title)
        if image_url:
            content += "\n\n![%s](%s)" % (title, image_url)
        args = ["chat", "message", "send", "--group", gid, "--text", content, "--yes"]
        if at:
            resolved, missing = ding_common.resolve_openids(set(at))
            if resolved:
                args += ["--at-open-dingtalk-ids", ",".join(oid for _, oid in resolved)]
        self._send(args)

    def notify(self, payload: ReportPayload):
        self.send_markdown_image(payload.title, payload.text,
                                  payload.image_url, payload.at, payload.group)
