#!/usr/bin/env python3
"""风控处罚 CSV 取数 —— 单一来源（被 appeal_reminder 与 unsat 共用）。

本文件只做一件事：调用风神风控处罚 download 接口
`xtop.lpd.quality.control.violation.violationOrderAeolusCenterApi.download/1.0`
拿到 CSV 签名下载链接并下载文本（GBK/UTF-8 自动解码）。

设计约定（见工作区永久记忆 get_data 约定）：
- 每个 get_data 模块 = 一个接口，只负责「打接口取数」
- 所有查询参数（start_ms / end_ms / cookie）均由调用方传入；本文件不做选日期（今天/昨天）
- 禁止在模块内做：统计 / 筛选 / 格式化 / 自动重登 / 落盘 / CLI
- 调用方（jobs/appeal/appeal_reminder.py、jobs/unsat/fetcher.py）各自负责日期窗口、落盘、筛选

对外能力：
- download_csv(start_ms, end_ms, cookie=None) -> (text, file_url)
  text 为解码后的 CSV 文本（GBK 优先，失败回退 UTF-8），file_url 为风神 OSS 签名下载链接。
"""
import json
import urllib.request
import urllib.error

from aeolus_sdk import login as L

API_URL = "https://httpizza.ele.me/xtop/xtop.lpd.quality.control.violation.violationOrderAeolusCenterApi.download/1.0"
STATIC_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
    "content-type": "application/json",
    "origin": "https://penalty.faas.ele.me",
    "referer": "https://penalty.faas.ele.me/ZSViolationPunish.html",
    "sec-ch-ua": '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
    "x-shard": "shardid=1",
}


def download_csv(start_ms, end_ms, cookie=None):
    """拉取 [start_ms, end_ms] 区间的风控处罚 CSV，返回 (text, file_url)。

    cookie 可选，不传则自动 ensure_cookies() 登录。
    返回 text 为解码后的 CSV 文本（GBK 优先，回退 UTF-8），file_url 为风神 OSS 签名链接。
    不含自动重登 / 落盘 / 筛选；会话失效由调用方捕获 401 后重登重试。
    """
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    body = json.dumps({"params": {"request": {
        "violationStartTime": start_ms, "violationEndTime": end_ms}}}).encode("utf-8")
    headers = dict(STATIC_HEADERS)
    headers["cookie"] = cookie
    req = urllib.request.Request(API_URL, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        j = json.loads(resp.read().decode("utf-8"))
    file_url = j["result"]["data"]["fileUrl"]
    raw = urllib.request.urlopen(file_url, timeout=60).read()
    # 饿了么后端返回的多为 GBK 字节；解码失败回退 UTF-8
    for enc in ("gbk", "utf-8"):
        try:
            return raw.decode(enc), file_url
        except UnicodeDecodeError:
            continue
    return raw.decode("gbk", "ignore"), file_url


__all__ = ["API_URL", "STATIC_HEADERS", "download_csv"]
