#!/usr/bin/env python3
"""按日抓取 aeolus 运单详情原始数据，落 JSONL（入库前的保底原始层）。

取数逻辑（HTTP 请求 / cookie 会话 / 分页切片 / 落盘）已全部抽到
`get_data/delivery.py` 作为单一来源，本文件只负责：
- 节点编排：plan 算日期范围 → fetch 抓原始层
- CLI 参数解析

为什么要先落 JSONL 再入库：
- 接口只保留最近 60 天，过期不可回溯 —— 原始 JSON 落盘后，数据库结构/引擎怎么改都能随时重放
- 支持断点续传：已完成的日期直接跳过

接口约束（2026-08-24 实测，详见 get_data/delivery.py 模块 docstring）：
- 查询开始时间不能早于 60 天前
- 单次查询跨度 ≤ 7 天（本脚本按天查，天然满足）
- pageSize ≤ 50；页码上限 current*pageSize < 10000（单日 >9000 单需按时段切片）

用法:
  python fetch_delivery_raw.py --start-date 2026-06-25 --end-date 2026-06-30
  python fetch_delivery_raw.py --date 2026-06-25
  python fetch_delivery_raw.py --start-date 2026-06-25 --end-date 2026-06-30 --force

节点区间（server 步进条）：plan → fetch
注意：日期参数叫 --start-date / --end-date 而非 --start / --end，
因为 --end 归节点区间专用（见 nodeflow.prepare）。
"""
import os
import sys
import datetime

# 任务脚本已迁到 jobs/delivery/ 下：把项目根加进 sys.path，
# 否则 `from get_data import delivery` / `import nodeflow` / `from aeolus_sdk import login`
# 等公共模块会失败（不依赖调用方 cwd）。
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# 取数（纯 HTTP）来自 get_data.delivery；本文件的「按天切片 / JSONL 落盘 / 断点续传 / 自动重登」
# 编排逻辑已抽到同目录 raw_fetch.py（不污染 get_data）。别名 D 保持不变。
import raw_fetch as D
import argparse

# ==================== 执行节点（server 步进条按顺序跑）====================
NODES = [
    {"id": "plan",  "name": "计算日期范围", "desc": "按 --date / --start-date~--end-date 展开待抓日期，剔除超 60 天窗口的"},
    {"id": "fetch", "name": "逐日抓原始层", "desc": "登录风神 + 按天分页抓 JSONL，存 delivery_raw/"},
]


def node_plan(ctx):
    a = ctx["args"]
    if a.date:
        days = [datetime.datetime.strptime(a.date, "%Y-%m-%d").date()]
    elif a.start_date:
        s = datetime.datetime.strptime(a.start_date, "%Y-%m-%d").date()
        e = datetime.datetime.strptime(a.end_date or a.start_date, "%Y-%m-%d").date()
        days = [s + datetime.timedelta(days=i) for i in range((e - s).days + 1)]
    else:
        days = [datetime.datetime.now(D.BJ).date()]

    limit = datetime.datetime.now(D.BJ).date() - datetime.timedelta(days=60)
    bad = [d for d in days if d < limit]
    if bad:
        D.log(f"警告: {bad[0]}~{bad[-1]} 早于 60 天窗口({limit} 起)，接口不可查，已跳过")
        days = [d for d in days if d >= limit]
    if not days:
        raise nodeflow.Stop("无可抓取日期")
    ctx["days"] = days


def node_fetch(ctx):
    a = ctx["args"]
    sess = D.Session()
    D.log(f"计划抓取 {len(ctx['days'])} 天: {ctx['days'][0]} ~ {ctx['days'][-1]}")
    summary = []
    for d in ctx["days"]:
        try:
            summary.append(D.fetch_day(sess, d, a.sleep, a.force))
        except Exception as e:
            D.log(f"{d} 失败: {type(e).__name__} {e}")
            summary.append({"date": str(d), "ok": False, "error": str(e)})
        D.coarse_sleep()          # 天与天之间
    okc = sum(1 for m in summary if m.get("ok"))
    tot = sum(m.get("fetched", 0) for m in summary)
    D.log(f"完成: {okc}/{len(summary)} 天成功，共 {tot} 条")


for _n in NODES:
    _n["fn"] = {"plan": node_plan, "fetch": node_fetch}[_n["id"]]


def main():
    import nodeflow
    # 老写法 --start/--end 是日期，现在 --end 归节点区间专用
    bad = nodeflow.reject_legacy_date_args(sys.argv[1:])
    if bad:
        print("✗ 日期参数已改名为 --start-date / --end-date"
              "（--end 现在是节点区间专用）：%s" % ", ".join(bad))
        sys.exit(1)

    ap = argparse.ArgumentParser()
    ap.add_argument("--date")
    ap.add_argument("--start-date")
    ap.add_argument("--end-date")
    ap.add_argument("--sleep", type=float, default=D.SLEEP_MAX,
                    help=f"页间随机延迟上限秒（下限固定 {D.SLEEP_MIN}，默认 0.1~{D.SLEEP_MAX}）")
    ap.add_argument("--force", action="store_true", help="忽略已完成标记重抓")

    todo, err = nodeflow.prepare(NODES)   # 先摘掉 --begin/--end，再交给 argparse
    if err:
        print("✗ " + err)
        sys.exit(1)
    args = ap.parse_args()

    sys.exit(nodeflow.execute(todo, {"args": args}, title="[运单原始层]"))


if __name__ == "__main__":
    main()
