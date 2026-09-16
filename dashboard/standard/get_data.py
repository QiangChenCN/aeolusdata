#!/usr/bin/env python3
"""标准达成看板 —— 三源取数入口（兼容 shim）。

历史：本文件曾直接封装排班目标 / 实时考勤 / 运单明细三套接口。
现取数逻辑已抽取、解耦到 **dashboard/get_data**（看板公共取数模块，单一来源），
本文件仅做转发（re-export），保证旧调用方与 CLI 行为不变。

底层 HTTP 细节在根 get_data/，看板友好签名在 dashboard.get_data/，
「标准达成」看板（dashboard/standard）与此处都从 dashboard.get_data 取数，互不耦合。
"""
import os
import sys
import json
import argparse

# 把项目根加进 sys.path，使 `from dashboard.get_data...` 不依赖运行 cwd。
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from dashboard.get_data import (
    fetch_schedule, fetch_attendance, fetch_delivery,
    flatten_schedule, ensure_cookies, TEAM_NAMES,
)
from aeolus_sdk import login as L

__all__ = [
    "fetch_schedule", "fetch_attendance", "fetch_delivery",
    "flatten_schedule", "ensure_cookies", "TEAM_NAMES",
]


# ===================== CLI =====================
def main():
    ap = argparse.ArgumentParser(description="标准达成看板取数（三源合一入口，仅取数不聚合）")
    ap.add_argument("--source", choices=["schedule", "attendance", "delivery", "all"],
                    default="all", help="取哪个源；默认 all 全部")
    ap.add_argument("--team", required=True, help="站点 teamId，如 917521136")
    ap.add_argument("--start", required=True,
                    help="schedule/attendance 用 YYYY-MM-DD；delivery 用毫秒时间戳")
    ap.add_argument("--end", required=True,
                    help="schedule 用 YYYY-MM-DD；delivery 用毫秒时间戳；attendance 忽略")
    ap.add_argument("--time-code", default=None, help="attendance 的时段码（必填）")
    ap.add_argument("--page-size", type=int, default=50)
    ap.add_argument("--period", default="0-86400")
    ap.add_argument("--pace", type=float, default=0.0)
    ap.add_argument("--pretty", action="store_true", help="缩进美化输出")
    args = ap.parse_args()

    cookie, _ = ensure_cookies()
    out = {}

    if args.source in ("schedule", "all"):
        out["schedule"] = fetch_schedule(cookie, args.team, args.start, args.end)

    if args.source in ("attendance", "all"):
        if not args.time_code:
            sys.stderr.write("[error] attendance 必须显式传 --time-code\n")
            sys.exit(2)
        out["attendance"] = fetch_attendance(args.team, args.time_code, cookie)

    if args.source in ("delivery", "all"):
        out["delivery"] = fetch_delivery(
            cookie, args.start, args.end, args.page_size, args.period, args.pace)

    indent = 2 if args.pretty else None
    print(json.dumps(out, ensure_ascii=False, indent=indent))


if __name__ == "__main__":
    main()
