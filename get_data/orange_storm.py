#!/usr/bin/env python3
"""橙色风暴（QC 抽检判定）取数 —— 单一来源。

本文件只做一件事：调用 QC 抽检列表接口
GET https://httpizza.ele.me/alsc-lpd-omp-inspection-prod/qc/fs/judgement/queryQcList
按时间范围分页拉取判定列表。

设计约定（见工作区永久记忆 get_data 约定）：
- 每个 get_data 模块 = 一个接口，只负责「打接口取数」
- 所有查询参数（start_ms / end_ms / cookie / page_size）均由调用方传入；本文件不做选月/SELECT/格式化
- 禁止在模块内做：时间戳格式化 / 字段展平 / 写 CSV / 自动重登 / CLI
- 「解析 --month/--start-date、flatten、SLIM_COLS、写盘」归调用方（jobs/orange_storm/fetch_orange_storm.py）

对外能力：
- fetch_all(start_ms, end_ms, cookie=None, page_size=200) -> (rows, total)   分页拉全量
"""
import os
import json
import time
import ssl
import urllib.request
import urllib.error

from aeolus_sdk import login as L

API = "https://httpizza.ele.me/alsc-lpd-omp-inspection-prod/qc/fs/judgement/queryQcList"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0")

# 默认强校验证书；仅 DISABLE_TLS_VERIFY=1 时回退不校验（见 aeolus_sdk/login.py 说明）
if os.environ.get("DISABLE_TLS_VERIFY") == "1":
    _CTX = ssl.create_default_context()
    _CTX.check_hostname = False
    _CTX.verify_mode = ssl.CERT_NONE
else:
    _CTX = ssl.create_default_context()


def http_json(url, cookie, timeout=60, retries=3):
    headers = {
        "accept": "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
        "cookie": cookie,
        "origin": "https://a.ele.me",
        "referer": "https://a.ele.me/",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "user-agent": UA,
    }
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as ex:
            last = ex
            time.sleep(1.5 * (i + 1))
    raise RuntimeError("请求失败: %s" % last)


def fetch_all(start_ms, end_ms, cookie=None, page_size=200):
    """分页拉取 [start_ms, end_ms] 的 QC 判定列表，返回 (rows, total)。

    cookie 可选，不传则自动 ensure_cookies() 登录。
    不含自动重登 / 格式化 / 写盘；会话失效由调用方捕获后重登重试。
    """
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    rows, page, total = [], 1, None
    while True:
        url = "%s?hitTimeStart=%d&hitTimeEnd=%d&pageIndex=%d&pageSize=%d" % (
            API, start_ms, end_ms, page, page_size)
        j = http_json(url, cookie)
        if j.get("code") != 200:
            raise RuntimeError("接口返回异常: %s" % str(j)[:300])
        d = (j.get("data") or {})
        if total is None:
            total = d.get("total", 0)
        batch = d.get("data") or []
        if not batch:
            break
        rows.extend(batch)
        if len(rows) >= total or len(batch) < page_size:
            break
        page += 1
        time.sleep(0.3)
    return rows, total


__all__ = ["API", "UA", "http_json", "fetch_all"]
