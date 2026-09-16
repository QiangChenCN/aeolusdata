#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标准达成 · 运单明细下载（仅取数 + 落盘，供标准达成计算复用）。

- 纯 HTTP，无需浏览器 / CDP，复用风神 SSO cookie（aeolus_sdk.login.ensure_cookies）
- 取数逻辑来自 get_data.delivery.fetch（分页 / 限流退避 pace 由本脚本控制；cookie 由本脚本 ensure），
  本文件只负责「按日期范围取数 → 落盘到 standard/」，不实现接口请求细节
- 只保留「下载运单明细」这一功能（不含 raw JSONL 入库 / 端到端流水线）
- 落盘位置固定为本文件同目录（dashboard/standard/），格式为 JSON（与「获取的数据 json 落盘」一致）

用法:
  python download_delivery.py                  # 默认今天全天（北京时间）
  python download_delivery.py --date 2026-08-23
  python download_delivery.py --start-date 2026-08-20 --end-date 2026-08-23
  python download_delivery.py --out out.json   # 指定输出路径
  python download_delivery.py --limit 200      # 调试：只下前 200 条

作为模块调用:
  from download_delivery import download
  rows, total, out = download("2026-09-09")    # 返回 (行列表, 接口total, 写出路径)
"""
import os
import sys
import json
import datetime
import argparse

# standard/ 比项目根深三层（dashboard/standard/<module>），bootstrap 需多退三层
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
# delivery_columns（中文表头映射）位于 jobs/delivery/，原脚本靠运行时目录导入；
# 这里显式把该目录加进 sys.path，复用同一份列定义，避免重复维护。
_COLS_DIR = os.path.join(_ROOT, "jobs", "delivery")
if _COLS_DIR not in sys.path:
    sys.path.insert(0, _COLS_DIR)

from aeolus_sdk import login as L
from get_data import delivery as D

# 标准达成工作区：运单明细统一落在本文件同目录（dashboard/standard/）
BASE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(BASE, exist_ok=True)


def write_json(rows, path):
    """写出 JSON（与「获取的数据 json 落盘」一致）。

    直接落 get_data.delivery.fetch 返回的接口原始 dict 列表（英文键名，保留完整字段），
    不再做中文表头扁平化——看板侧按英文键取值
    （achievement._count_valid_orders_by_date 经 order_rules 兼容中英文键）。
    """
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    return path


def parse_dt(s, end_of_day=False):
    """'YYYY-MM-DD' → 北京时间 datetime（带 8h 时区）。"""
    d = datetime.datetime.strptime(s, "%Y-%m-%d")
    if end_of_day:
        d = d.replace(hour=23, minute=59, second=59)
    else:
        d = d.replace(hour=0, minute=0, second=0)
    return d.replace(tzinfo=D.BJ)


def default_out_name(s, e):
    """落 standard/ 的默认命名：当天 → 实时运单明细.csv；单历史日 → 运单明细 - yyyymmdd.csv；
    区间 → 运单明细 - yyyymmdd_yyyymmdd.csv。"""
    today = datetime.datetime.now(D.BJ).date()
    sd, ed = s.date(), e.date()
    if sd == ed == today:
        return "实时运单明细.csv"
    if sd == ed:
        return f"运单明细 - {sd:%Y%m%d}.csv"
    return f"运单明细 - {sd:%Y%m%d}_{ed:%Y%m%d}.csv"


def download(date=None, start_date=None, end_date=None,
             page_size=50, limit=None, out=None):
    """按日期范围下载运单明细，落盘到 standard/（或 out 指定路径）。

    取数统一走 get_data.delivery.fetch（纯分页拉全量；limit 由本函数截断）。
    返回 (rows, total, out_path)；无数据时 out_path 为 None。
    """
    now = datetime.datetime.now(D.BJ)
    if date:
        s = parse_dt(date)
        e = parse_dt(date, end_of_day=True)
    elif start_date or end_date:
        sd = start_date or end_date
        ed = end_date or start_date
        s = parse_dt(sd)
        e = parse_dt(ed, end_of_day=True)
    else:
        s = now.replace(hour=0, minute=0, second=0, microsecond=0)
        e = now.replace(hour=23, minute=59, second=59)

    start_ms = int(s.timestamp() * 1000)
    end_ms = int(e.timestamp() * 1000)
    print(f"下载范围(北京时间): {s:%Y-%m-%d %H:%M:%S} ~ {e:%Y-%m-%d %H:%M:%S}")

    cookie, _ = L.ensure_cookies()
    rows = D.fetch(start_ms, end_ms, page_size=page_size, pace=0.5, cookie=cookie)
    if limit:
        rows = rows[:limit]
    print(f"本次下载 {len(rows)} 条")
    if not rows:
        print("无数据，未生成文件")
        return rows, len(rows), None
    if not out:
        out = os.path.join(BASE, default_out_name(s, e))
    write_json(rows, out)
    print(f"已写出: {out}")
    return rows, len(rows), out


def main():
    ap = argparse.ArgumentParser(description="标准达成 · 运单明细下载（复用 get_data.delivery）")
    ap.add_argument("--date", help="单日 YYYY-MM-DD，默认今天")
    ap.add_argument("--start-date", help="开始日期 YYYY-MM-DD")
    ap.add_argument("--end-date", help="结束日期 YYYY-MM-DD")
    ap.add_argument("--page-size", type=int, default=50, help="每页条数(≤50)")
    ap.add_argument("--out", default=None, help="指定输出 CSV 路径")
    ap.add_argument("--limit", type=int, default=None, help="最多下载条数(调试)")
    a = ap.parse_args()
    download(a.date, a.start_date, a.end_date, a.page_size, a.limit, a.out)


if __name__ == "__main__":
    main()
