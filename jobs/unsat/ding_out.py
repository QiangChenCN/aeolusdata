#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""P3/P6 钉钉出站：发群消息 + @站长（自动跳过 DO_NOT_AT）。

当前实现走 dws CLI（本机 WorkBuddy 环境可用）；
部署到 2V4G 服务器时，把 send_markdown / send_file 两个函数替换为
DingTalk OpenAPI 实现即可，其余调用方无需改动。
"""
import os
import sys
import json
import subprocess

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # jobs/
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "common"))

from . import config
from .store import log

try:
    import ding_common
    def _dws_cmd():
        return ding_common.resolve_dws_cmd()
except Exception:
    def _dws_cmd():
        return [os.environ.get("DING_NODE_BIN", ""), os.environ.get("DING_DWS_JS", "")]


def resolve_openids(names):
    """姓名集合 → ([(name, openid)], 缺失姓名列表)，自动剔除 DO_NOT_AT。"""
    resolved, missing = [], set()
    for n in sorted(names or []):
        if not n or n in config.DO_NOT_AT:
            continue
        if n in config.MANAGER_OPENID:
            resolved.append((n, config.MANAGER_OPENID[n]))
        else:
            missing.add(n)
    return resolved, missing


def managers_of(station):
    return config.STATION_MANAGERS.get(station, [])


def _dws(args, times=3):
    import time
    last = None
    delay = 4
    for i in range(1, times + 1):
        cmd = _dws_cmd() + list(args) + ["--format", "json"]
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
        if r.returncode == 0:
            return r.stdout
        last = "dws 失败(%s): %s | %s" % (r.returncode, (r.stdout or "")[:300],
                                          (r.stderr or "")[:300])
        log.warning("钉钉发送第 %d/%d 次失败: %s", i, times, last)
        if i < times:
            time.sleep(delay)
            delay *= 2
    raise RuntimeError(last)


def send_markdown(text, group=None, at_names=None, at_ids=None):
    """发送 markdown 消息。at_names 为站长姓名集合（会自动剔除 DO_NOT_AT）。"""
    group = group or config.GROUP_ID
    ids = list(at_ids or [])
    missing = []
    if at_names:
        resolved, missing = resolve_openids(at_names)
        ids += [oid for _, oid in resolved]
    ids = list(dict.fromkeys(ids))
    if missing:
        log.warning("以下站长未解析到 id，已跳过 @：%s", missing)
    args = ["chat", "message", "send", "--group", group, "--text", text, "--yes"]
    if ids:
        args += ["--at-open-dingtalk-ids", ",".join(ids)]
    out = _dws(args)
    log.info("markdown 发送成功（@%d 人）", len(ids))
    return out, missing


def send_file(path, group=None, at_names=None):
    """发送本地文件（图片/视频以附件形式）。"""
    group = group or config.GROUP_ID
    ids = []
    if at_names:
        resolved, _ = resolve_openids(at_names)
        ids = [oid for _, oid in resolved]
    args = ["chat", "message", "send", "--group", group, "--msg-type", "file",
            "--file-path", path, "--yes"]
    if ids:
        args += ["--at-open-dingtalk-ids", ",".join(ids)]
    out = _dws(args)
    log.info("文件发送成功: %s", path)
    return out


def send_detail(rows, date_str, file_url, img_path=None):
    """发送当日明细：图片附件 + 说明文字 + @相关站点站长。"""
    stations = {r.get("站点", "") for r in rows}
    names = set()
    for s in stations:
        names |= set(managers_of(s))
    mentions = ""
    resolved, missing = resolve_openids(names)
    if resolved:
        mentions = " ".join("<@%s>" % oid for _, oid in resolved)

    text = (
        "## 不满意单明细（%s）\n"
        "**非超时 · 非不成立 共 %d 条 / %d 个站点**\n\n"
        "请各站点站长于 **24:00 前** 完成反馈（@本机器人 + 运单号）：\n"
        "① 原因分析（A列）　② 改善措施（B列）　③ **培训图片/视频（C列）**\n\n"
        "三要素齐全方视为合格，未合格将每小时提醒一次。\n\n"
        "📎 [下载原始数据](%s)\n\n%s"
    ) % (date_str, len(rows), len(stations), file_url, mentions)

    if img_path and os.path.exists(img_path):
        send_file(img_path, at_names=names)
    return send_markdown(text, at_names=names)


def send_reject(station, tracking_no, missing_items, reason=""):
    """LLM 判定不合格 → @站长说明缺什么。"""
    names = managers_of(station)
    text = (
        "## ⚠️ 反馈未通过（运单号 `%s`）\n"
        "**缺失项：** %s\n\n%s\n\n"
        "请补充后重新 @本机器人 + 运单号 提交。"
    ) % (tracking_no, "、".join(missing_items), reason or "")
    return send_markdown(text, at_names=names)
