#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""不满意单自动化 · 主入口

用法：
  python -m jobs.unsat.main run            # 拉昨天数据 → 填表 → 发群（真实执行）
  python -m jobs.unsat.main run --no-send  # 只拉数填表，不发群
  python -m jobs.unsat.main run --date 2026-08-27
  python -m jobs.unsat.main run --sheet-url <在线表完整URL>   # 覆盖目标在线表
  python -m jobs.unsat.main serve          # 启动 FastAPI 回调服务（需后台配置）
  python -m jobs.unsat.main schedule       # 常驻调度（11:00 拉数）
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # jobs/
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "common"))

from . import config
from .store import log, init_db, upsert_orders
from . import sheet_writer, renderer, ding_out
import nodeflow  # 通用节点框架（common/nodeflow.py，main.py 顶部已把 common/ 加进 sys.path）


# ==================== 执行节点（server 步进条按顺序跑）====================
#   run : fetch → store → sheet → send
NODES_RUN = [
    {"id": "fetch", "name": "拉取不满意单", "desc": "拉昨天（或 --date）数据 + 拿原始文件下载链接"},
    {"id": "store", "name": "落库去重", "desc": "init_db + 按单号 upsert，供后续提醒去重"},
    {"id": "sheet", "name": "填在线表", "desc": "写入表格；已存在全部明细则跳过"},
    {"id": "send",  "name": "渲染并发群", "desc": "渲染图片 + 发群（--no-send 只渲染预览）"},
]


def node_fetch(ctx):
    from .fetcher import fetch
    rows, date_str, file_url = fetch(ctx["rows_date"])
    if not rows:
        raise nodeflow.Stop("无符合条件的明细，结束。")
    ctx["rows"], ctx["date_str"], ctx["file_url"] = rows, date_str, file_url
    ctx["n"] = len(rows)


def node_store(ctx):
    init_db()
    upsert_orders(ctx["rows"], ctx["date_str"])


def node_sheet(ctx):
    start, matrix = sheet_writer.run(ctx["rows"], ctx["date_str"], do_write=True)
    if start is None:
        log.info("表格已存在全部明细，跳过写表。")


def node_send(ctx):
    if not ctx["do_send"]:
        log.info("(--no-send) 跳过发群。渲染预览：%s",
                 renderer.render(ctx["rows"], ctx["date_str"]))
        return
    try:
        img = renderer.render(ctx["rows"], ctx["date_str"])
    except Exception as e:
        log.warning("图片渲染失败，降级为文字: %s", e)
        img = None
    ding_out.send_detail(ctx["rows"], ctx["date_str"], ctx["file_url"], img)
    log.info("已发群，共 %d 条 / 日期 %s", len(ctx["rows"]), ctx["date_str"])


for _n in NODES_RUN:
    _n["fn"] = {"fetch": node_fetch, "store": node_store,
                "sheet": node_sheet, "send": node_send}[_n["id"]]

def job_fetch(rows_date=None, do_send=True, begin=None, end=None):
    """主任务：拉数 → 填表 → 发群。返回明细条数。

    `begin` / `end` 供 server 步进条圈定区间（None = 全跑）。
    """
    todo, err = nodeflow.pick(NODES_RUN, begin, end)
    if err:
        raise ValueError(err)
    ctx = {"rows_date": rows_date, "do_send": do_send, "n": 0}
    code = nodeflow.execute(todo, ctx, title="[不满意单]")
    if code:
        raise SystemExit(code)
    return ctx.get("n", 0)


def _take_sheet_url(argv):
    """从 argv 里摘掉 --sheet-url（在线表地址），返回 (剩余参数, 地址 or None)。

    同时兼容 `--sheet-url=xxx` 与 `--sheet-url xxx` 两种写法。
    单独摘出来是因为它带取值，不能留在 sys.argv 里被后面的位置参数解析撞上。
    """
    rest, url, i = [], None, 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--sheet-url="):
            url = a.split("=", 1)[1]
        elif a == "--sheet-url":
            if i + 1 >= len(argv):
                print("✗ --sheet-url 缺少取值")
                sys.exit(1)
            url = argv[i + 1]
            i += 1
        else:
            rest.append(a)
        i += 1
    return rest, url


if __name__ == "__main__":
    # 先摘 --begin/--end，再按子命令校验（run 节点）
    argv = sys.argv[1:]
    begin, end, err = nodeflow.take_range(argv)

    # 摘 --sheet-url（在线表地址）：空值 = 不覆盖，沿用 config 默认/环境变量
    argv, sheet_url = _take_sheet_url(argv)
    sys.argv = [sys.argv[0]] + argv
    if err:
        print("✗ " + err)
        sys.exit(1)
    if sheet_url:
        try:
            config.set_sheet_url(sheet_url)
        except ValueError as e:
            print("✗ " + str(e))
            sys.exit(1)
        log.info("在线表地址（本次填写，已记住）: %s", config.SHEET_URL)
    elif config.SHEET_URL_SOURCE == "last":
        log.info("在线表地址（沿用上次）: %s", config.SHEET_URL)
    elif config.SHEET_URL_SOURCE == "env":
        log.info("在线表地址（来自 .env）: %s", config.SHEET_URL)
    else:
        log.info("在线表地址（内置默认）: %s —— 首次使用请在「文档地址」填本月的在线表链接，"
                 "填一次后会自动记住。", config.SHEET_URL)

    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"

    # 派发前先按子命令校验区间 —— 否则非法区间会走到 job_* 里抛异常、打出 traceback
    nodes = {"run": NODES_RUN}.get(cmd)
    if nodes:
        _, err = nodeflow.pick(nodes, begin, end)
        if err:
            print("✗ " + err)
            sys.exit(1)

    try:
        if cmd == "run":
            no_send = "--no-send" in sys.argv
            ds = None
            if "--date" in sys.argv:
                ds = sys.argv[sys.argv.index("--date") + 1]
            n = job_fetch(ds, do_send=not no_send, begin=begin, end=end)
            print("完成：%d 条" % n)
        elif cmd == "serve":
            from .callback import app
            import uvicorn
            uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8917")))
        elif cmd == "schedule":
            from .scheduler import start
            start()
        else:
            print(__doc__)
    except Exception as e:
        log.exception("执行异常: %s", e)
        sys.exit(1)
