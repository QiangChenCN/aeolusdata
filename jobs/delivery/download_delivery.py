#!/usr/bin/env python3
"""纯 HTTP 下载 aeolus 运单数据（xtop.agencyTrackingFs.queryTracking/2.0），写 CSV。

- 无需浏览器 / CDP，复用风神 SSO cookie（aeolus_sdk.login.ensure_cookies）
- 取数逻辑（query / 分页 / 会话失效重登）统一来自 get_data.delivery，本文件不直接发请求
- 按完成时间(trackingFinishStart/End)分页拉取全部运单
- 输出 UTF-8-BOM CSV（Excel 直接可开），表头为中文（delivery_columns.FIELD_CN）

用法:
  python download_delivery.py                  # 默认今天全天（北京时间）
  python download_delivery.py --date 2026-08-23
  python download_delivery.py --start-date 2026-08-20 --end-date 2026-08-23
  python download_delivery.py --page-size 100 --out out.csv
  python download_delivery.py --limit 200      # 调试：只下前 200 条

节点区间（server 步进条）：login → query → write
  python download_delivery.py --begin query --end write   # cookie 已有效时跳过登录
注意：日期参数叫 --start-date / --end-date 而非 --start / --end，
因为 --end 归节点区间专用（见 nodeflow.prepare）。
"""
import os
import sys
import json
import csv
import time
import argparse
import datetime

# 任务脚本已迁到 jobs/delivery/ 下：把项目根加进 sys.path
# （delivery_columns / aeolus_sdk / nodeflow / get_data 等在项目根），不依赖调用方 cwd。
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
BASE = os.path.dirname(os.path.abspath(__file__))       # jobs/delivery
# 运单明细 CSV 落盘到 jobs/delivery/out（原始产物目录），文件名 aeolus_delivery_YYYYMMDD_YYYYMMDD.csv
OUT_DIR = os.path.join(BASE, "out")
os.makedirs(OUT_DIR, exist_ok=True)
from aeolus_sdk import login as L
from delivery_columns import FIELD_CN, FIELD_ORDER
# 运单明细取数统一来源
from get_data import delivery as D

MAX_PAGE_SIZE = 50  # 接口拒绝 >50（PAGE_SIZE_OVER_RANGE）


def write_csv(rows, path):
    extra = []
    for r in rows:
        for k in r.keys():
            if k not in FIELD_ORDER and k not in extra:
                extra.append(k)
    header = [FIELD_CN.get(c, c) for c in FIELD_ORDER] + \
             [FIELD_CN.get(c, c) for c in extra]
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for r in rows:
            w.writerow([r.get(c, "") for c in FIELD_ORDER] +
                       [r.get(c, "") for c in extra])
    return path


def parse_dt(s, end_of_day=False):
    d = datetime.datetime.strptime(s, "%Y-%m-%d")
    if end_of_day:
        d = d.replace(hour=23, minute=59, second=59)
    else:
        d = d.replace(hour=0, minute=0, second=0)
    return d.replace(tzinfo=D.BJ)


def default_out_name(s, e):
    """默认文件名 aeolus_delivery_YYYYMMDD_YYYYMMDD.csv（与 jobs/delivery/out 历史产物一致）。"""
    return f"aeolus_delivery_{s:%Y%m%d}_{e:%Y%m%d}.csv"


# ==================== 执行节点（server 步进条按顺序跑）====================
NODES = [
    {"id": "login", "name": "登录风神", "desc": "复用本地有效 cookie，失效才重新登录"},
    {"id": "query", "name": "分页拉运单", "desc": "按日期范围分页调运单接口（带会话失效重试）"},
    {"id": "write", "name": "写出 CSV", "desc": "扁平化后写 jobs/delivery/out/aeolus_delivery_YYYYMMDD_YYYYMMDD.csv"},
]


def node_login(ctx):
    cookie, status = L.ensure_cookies()
    if not cookie:
        raise RuntimeError("未获取到风神 cookie，登录失败")
    print("cookie: %s（%d 字符）" % (status, len(cookie)))


def node_query(ctx):
    now = datetime.datetime.now(D.BJ)
    a = ctx["args"]
    if a.date:
        s = parse_dt(a.date)
        e = parse_dt(a.date, end_of_day=True)
    elif a.start_date or a.end_date:
        sd = a.start_date or a.end_date
        ed = a.end_date or a.start_date
        s = parse_dt(sd)
        e = parse_dt(ed, end_of_day=True)
    else:
        s = now.replace(hour=0, minute=0, second=0, microsecond=0)
        e = now.replace(hour=23, minute=59, second=59)

    ctx["s"], ctx["e"] = s, e
    start_ms = int(s.timestamp() * 1000)
    end_ms = int(e.timestamp() * 1000)
    print(f"下载范围(北京时间): {s:%Y-%m-%d %H:%M:%S} ~ {e:%Y-%m-%d %H:%M:%S}")

    # 取数统一走 get_data.delivery.fetch（纯分页拉全量；cookie/限流由调用方控制）
    cookie, _ = L.ensure_cookies()
    rows = D.fetch(start_ms, end_ms, page_size=a.page_size, pace=0.5, cookie=cookie)
    if a.limit:
        rows = rows[:a.limit]
    print(f"本次下载 {len(rows)} 条")
    if not rows:
        raise nodeflow.Stop("无数据，未生成文件")
    ctx["rows"] = rows


def node_write(ctx):
    out = ctx["args"].out
    if not out:
        out = os.path.join(OUT_DIR, default_out_name(ctx["s"], ctx["e"]))
    write_csv(ctx["rows"], out)
    print(f"已写出: {out}")


for _n in NODES:
    _n["fn"] = {"login": node_login, "query": node_query, "write": node_write}[_n["id"]]


def main():
    import nodeflow
    # 老写法 --start/--end 是日期，现在 --end 归节点区间专用
    # （只在取值像日期时才报，避免误伤 --end fetch 这种节点用法）
    bad = nodeflow.reject_legacy_date_args(sys.argv[1:])
    if bad:
        print("✗ 日期参数已改名为 --start-date / --end-date"
              "（--end 现在是节点区间专用）：%s" % ", ".join(bad))
        sys.exit(1)

    # 注意：日期参数刻意叫 --start-date / --end-date，避免与节点区间的
    # --begin / --end 撞名（--end 归 nodeflow 专用，见 nodeflow.prepare）
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="单日 YYYY-MM-DD，默认今天")
    ap.add_argument("--start-date", help="开始日期 YYYY-MM-DD")
    ap.add_argument("--end-date", help="结束日期 YYYY-MM-DD")
    ap.add_argument("--page-size", type=int, default=100)
    ap.add_argument("--out", default=None)
    ap.add_argument("--limit", type=int, default=None, help="最多下载条数(调试)")

    todo, err = nodeflow.prepare(NODES)   # 先摘掉 --begin/--end，再交给 argparse
    if err:
        print("✗ " + err)
        sys.exit(1)
    args = ap.parse_args()

    sys.exit(nodeflow.execute(todo, {"args": args}, title="[运单CSV]"))


if __name__ == "__main__":
    main()
