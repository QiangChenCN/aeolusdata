#!/usr/bin/env python3
"""站长任务看板取数 —— 单一来源。

本文件只做一件事：调用风神站长任务列表接口
`xtop.ryze.fs.agency.team.task.listByPage/1.0` 分页拉取任务（默认 status=started）。

设计约定（见工作区永久记忆 get_data 约定）：
- 每个 get_data 模块 = 一个接口，只负责「打接口取数」
- 所有查询参数（cookie / status / page_size）均由调用方传入；本文件不做筛选/统计/渲染
- 禁止在模块内做：筛选「已开始」/ 计算剩余时间 / 格式化 / 自动重登 / 落盘 / CLI
- 「筛已开始 + 剩余时间 + 渲染」归调用方（jobs/board/task_board.py）

对外能力：
- fetch(status="started", page_size=100, cookie=None) -> list[dict]   分页拉全量任务
"""
import json
import urllib.request
import urllib.error

from aeolus_sdk import login as L

API_URL = "https://httpizza.ele.me/xtop/xtop.ryze.fs.agency.team.task.listByPage/1.0"

HEADERS_BASE = {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "origin": "https://a.ele.me",
    "referer": "https://a.ele.me/",
    "user-agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0"),
}


def fetch(cookie=None, status="started", page_size=100):
    """分页拉取指定状态的站长任务，返回任务 dict 列表（全量）。

    cookie 可选，不传则自动 ensure_cookies() 登录；status 为查询参数（默认 started）。
    分页由本函数内部处理（允许）。
    不含自动重登 / 筛选 / 格式化；会话失效由调用方捕获后重登重试。
    """
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    headers = dict(HEADERS_BASE)
    headers["cookie"] = cookie
    all_tasks, page, total = [], 1, 0
    while True:
        payload = json.dumps({"params": {"queryVO": {
            "pageSize": page_size, "pageIndex": page,
            "status": status,
        }}}).encode()
        req = urllib.request.Request(API_URL, data=payload, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=30) as resp:
            j = json.loads(resp.read().decode("utf-8"))
        data = (j.get("result") or {}).get("data") or {}
        tasks = data.get("data") or []
        total = data.get("total") or 0
        all_tasks.extend(tasks)
        if len(all_tasks) >= total or not tasks:
            break
        page += 1
    return all_tasks


__all__ = ["API_URL", "HEADERS_BASE", "fetch"]
