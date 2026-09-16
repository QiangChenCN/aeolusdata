# -*- coding: utf-8 -*-
"""橙色风暴明细（QC 抽检判定列表）取数脚本。

数据源：GET https://httpizza.ele.me/alsc-lpd-omp-inspection-prod/qc/fs/judgement/queryQcList
        参数 hitTimeStart / hitTimeEnd（毫秒时间戳）/ pageIndex / pageSize

节点（server 步进条，默认全跑）：
  login 登录风神（复用本地有效 cookie，失效才重新登录）
  fetch 分页拉取 QC 列表（按时间范围自动翻页直到拉满 total）
  write 写出 JSON + 全字段 CSV + 精简 CSV，并打印统计

用法（脚本已迁到 jobs/orange_storm/）：
  .venv/Scripts/python.exe fetch_orange_storm.py --month 2026-08
  .venv/Scripts/python.exe fetch_orange_storm.py --start-date 2026-08-01 --end-date 2026-08-31
"""
import os
import sys
import csv
import json
import time
import argparse
from datetime import datetime, timedelta, timezone

# 脚本在 jobs/orange_storm/，公共模块（aeolus_sdk / nodeflow 等）在项目根：按脚本位置推算，不依赖 cwd
# 路径深度 = jobs/orange_storm/<file> -> 往上 3 级才是项目根
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_COMMON = os.path.join(ROOT, "common")
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
if _COMMON not in sys.path:
    sys.path.insert(0, _COMMON)
import nodeflow  # 节点框架（bootstrap 之后才能 import，因其不在标准库/venv）
from aeolus_sdk.login import ensure_cookies, COOKIE_FILE
from get_data import orange_storm   # 橙色风暴 QC 取数（单一来源；fetch_all 在此）

HERE = os.path.dirname(os.path.abspath(__file__))       # jobs/orange_storm
OUT_DIR = os.path.join(HERE, "out")                      # 产物统一进 out/
os.makedirs(OUT_DIR, exist_ok=True)

# 关键：cookie 必须落到 aeolus_sdk/cookie.txt（由 login.COOKIE_FILE 单一指定）。
# COOKIE_FILE 已是绝对路径（aeolus_sdk/cookie.txt），不依赖 cwd，从子目录运行也不会割裂登录态。
COOKIE_PATH = COOKIE_FILE

CST = timezone(timedelta(hours=8))
# 毫秒时间戳字段 -> 转为可读时间输出（原值保留在 <字段>_ms 列）
TS_FIELDS = {
    "hitTime", "photoTime", "completeTime", "appealTime", "overTime", "checkTime",
    "firstAuditCompleteTime", "doubleAuditCompleteTime", "rejudgeTime", "finalStatusTime",
    "punishTime", "appealExpireTime", "appealMaxCheckTime",
}


def ms_of(dt):
    return int(dt.timestamp() * 1000)


def fmt_ms(v):
    """毫秒时间戳 -> 'YYYY-MM-DD HH:MM:SS'（东八区）；0/空/非法返回空串。"""
    try:
        v = int(v)
    except (TypeError, ValueError):
        return ""
    if v <= 0:
        return ""
    if v > 1e14:  # 微秒，兜底
        v //= 1000
    return datetime.fromtimestamp(v / 1000, CST).strftime("%Y-%m-%d %H:%M:%S")


def flatten(row):
    """嵌套 dict/list -> JSON 字符串；时间戳字段追加可读列。"""
    out = {}
    for k, v in row.items():
        if isinstance(v, (dict, list)):
            out[k] = json.dumps(v, ensure_ascii=False) if v else ""
        elif v is None:
            out[k] = ""
        else:
            out[k] = v
        if k in TS_FIELDS:
            out[k + "_ms"] = out[k]
            out[k] = fmt_ms(v)
    return out


# 精简版列（常用字段），同时输出 *_slim.csv 方便直接查看
SLIM_COLS = [
    ("命中时间", lambda r, f: f["hitTime"]),
    ("日期", lambda r, f: f["hitTime"][:10]),
    ("团队", lambda r, f: f["teamName"]),
    ("骑手姓名", lambda r, f: f["knightName"]),
    ("骑手手机号", lambda r, f: f["knightMobile"]),
    ("骑手ID", lambda r, f: f["knightId"]),
    ("抽检类型", lambda r, f: f["qcTypeName"]),
    ("判定结果", lambda r, f: f["statusDesc"]),
    ("不通过原因", lambda r, f: "；".join(
        (x.get("reasonName") or "") for x in (r.get("reasons") or []))),
    ("处罚", lambda r, f: f["punishment"]),
    ("处罚金额", lambda r, f: f["punishDecimalAmount"]),
    ("申诉状态", lambda r, f: f["appealStatusDesc"]),
    ("运单号", lambda r, f: f["trackingId"]),
    ("抽检ID", lambda r, f: f["qcId"]),
    ("配送模式", lambda r, f: f["shippingMode"]),
]


def resolve_range(args):
    """根据 --month / --start-date/--end-date 计算毫秒时间戳范围。

    返回 (start_ms, end_ms, tag, s_dt, e_dt)。
    都不给时默认「上个月」（与原始行为一致）。
    """
    if args.start_date and args.end_date:
        s = datetime.strptime(args.start_date, "%Y-%m-%d").replace(tzinfo=CST)
        e = datetime.strptime(args.end_date, "%Y-%m-%d").replace(hour=23, minute=59, second=59, tzinfo=CST)
    elif args.month:
        y, m = [int(x) for x in args.month.split("-")]
        s = datetime(y, m, 1, tzinfo=CST)
        ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
        e = datetime(ny, nm, 1, tzinfo=CST) - timedelta(seconds=1)
    else:
        today = datetime.now(CST).replace(day=1)
        e = today - timedelta(seconds=1)
        s = e.replace(day=1)
    start_ms, end_ms = ms_of(s), ms_of(e) + 999
    tag = "%s_%s" % (s.strftime("%Y%m%d"), e.strftime("%Y%m%d"))
    return start_ms, end_ms, tag, s, e


# ==================== 执行节点（server 步进条按顺序跑）====================
NODES = [
    {"id": "login", "name": "登录风神", "desc": "复用本地有效 cookie，失效才重新登录"},
    {"id": "fetch", "name": "分页拉取 QC 列表", "desc": "按时间范围自动翻页直到拉满 total"},
    {"id": "write", "name": "写出数据文件", "desc": "写 JSON + 全字段 CSV + 精简 CSV，并打印统计"},
]


def node_login(ctx):
    cookie, status = ensure_cookies(path=COOKIE_PATH)
    print("[cookie] %s" % status)
    ctx["cookie"] = cookie


def node_fetch(ctx):
    rows, total = orange_storm.fetch_all(ctx["start_ms"], ctx["end_ms"], ctx["cookie"], ctx["page_size"])
    ctx["rows"] = rows
    ctx["total"] = total
    print("拉取完成：%d 条（接口 total=%d），耗时 %.1fs"
          % (len(rows), total, time.time() - ctx["t0"]))


def node_write(ctx):
    rows = ctx.get("rows")
    if not rows:
        raise nodeflow.Stop("无数据，未生成文件")

    tag = ctx["tag"]
    json_path = os.path.join(OUT_DIR, "orange_storm_%s.json" % tag)
    csv_path = os.path.join(OUT_DIR, "orange_storm_%s.csv" % tag)
    slim_path = os.path.join(OUT_DIR, "orange_storm_%s_slim.csv" % tag)

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)

    flat = [flatten(r) for r in rows]
    cols = []
    seen = set()
    for r in flat:
        for k in r:
            if k not in seen:
                seen.add(k)
                cols.append(k)
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(flat)

    with open(slim_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow([c[0] for c in SLIM_COLS])
        # r = 原始记录（嵌套结构 intact，供 reasons 等字段解析），f = 扁平化后的行
        for raw, f in zip(rows, flat):
            w.writerow([fn(raw, f) for _, fn in SLIM_COLS])

    print("已输出：")
    print("  JSON  %s" % os.path.abspath(json_path))
    print("  CSV   %s（%d 列，全字段）" % (os.path.abspath(csv_path), len(cols)))
    print("  CSV   %s（%d 列，精简版）" % (os.path.abspath(slim_path), len(SLIM_COLS)))

    # 简要统计
    from collections import Counter
    print("\n状态分布：", dict(Counter(r.get("statusDesc") or r.get("status") for r in rows)))
    print("抽检类型：", dict(Counter(r.get("qcTypeName") for r in rows)))
    print("覆盖团队：", len(set(r.get("teamName") for r in rows)), "个")


for _n in NODES:
    _n["fn"] = {"login": node_login, "fetch": node_fetch,
                "write": node_write}[_n["id"]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", help="整月，格式 YYYY-MM，如 2026-08")
    ap.add_argument("--start-date", help="开始日期 YYYY-MM-DD")
    ap.add_argument("--end-date", help="结束日期 YYYY-MM-DD")
    ap.add_argument("--page-size", type=int, default=200)

    # 先摘掉 --begin/--end（节点区间），再解析业务参数，否则 argparse 不认识会报错
    todo, err = nodeflow.prepare(NODES)
    if err:
        print("✗ " + err)
        sys.exit(1)
    args = ap.parse_args()

    start_ms, end_ms, tag, s, e = resolve_range(args)
    print("时间范围（东八区）：%s ~ %s" % (
        s.strftime("%Y-%m-%d %H:%M:%S"), e.strftime("%Y-%m-%d %H:%M:%S")))
    print("时间戳：%d ~ %d" % (start_ms, end_ms))

    ctx = {
        "start_ms": start_ms, "end_ms": end_ms, "tag": tag,
        "page_size": args.page_size, "t0": time.time(),
    }
    sys.exit(nodeflow.execute(todo, ctx, title="[橙色风暴]"))


if __name__ == "__main__":
    main()
