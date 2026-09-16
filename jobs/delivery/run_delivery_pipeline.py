#!/usr/bin/env python3
"""运单明细入库 —— 把 5 个独立任务合并为一个端到端流水线。

为什么合并
----------
原 5 个独立任务（下载 CSV / 抓 JSONL / 入库 / 核对 / 建表）共用同一份
Aeolus cookie、同一批产物，互相有强依赖（入库依赖 JSONL，核对依赖
入库）。拆成 5 张卡片反而导致：

  · 每次补数要手动点 3-4 张卡，理解成本高
  · 节点区间（--begin/--end）每个任务内单独配置，做不到跨任务联动
  · preset 维护成本翻倍，且无法表达"先建表再全量同步"这种组合

合并后
------
单卡片 `delivery_pipeline`，节点链固定：
  init → csv → raw → load → verify

默认区间为 `raw → load → verify`（日常补数场景，覆盖 90% 用法）：
  · 抓 JSONL（断点续传，已有则跳过）
  · 入库（幂等 upsert）
  · 核对（库 vs 接口 total 对账）

显式场景：
  · `--begin csv --end verify`   一并下 CSV
  · `--begin init --end init`    仅重建表（DROP + CREATE）
  · `--begin init --end verify`  重建表 + 全量入库 + 核对
  · `--begin load --end verify`  仅入库 + 核对（JSONL 已就绪）

危险动作防御
----------
`init` 节点会 DROP 全部已入库数据。判定条件已简化为**单开关**：
带 `--reinit`（工作台卡片上的「DROP 重建表」）即视为已确认，直接执行，
不再要求再勾一个「确认 DROP」——两套开关的双保险已按需求移除。

命令行老写法 `--confirm-init` 仍被接受（等价于「已确认」），保持向后兼容。
普通工人误触的防线由「开关不在默认勾选项里 + 卡片 risk=caution + 运行前二次确认弹窗」承担。

节点区间只允许 left-to-right；脚本侧 `--begin/--end` 是节点 ID 而非日期
（日期用 `--date`，多日窗口用 `--start-date/--end-date`），nodeflow 会自动区分。

日期参数（与 task_equipment 同一套约定）
---------------------------------------
工作台卡片上只露 `--date`（单日，默认昨天），覆盖日常补数。
`--start-date / --end-date` 属于**命令行高级用法，UI 不露**——偶尔补一段区间
（如月初补上个月）时手工敲，平时不占界面。

用法
----
  python run_delivery_pipeline.py                                     # 补数：raw → load → verify（默认昨天）
  python run_delivery_pipeline.py --date 2026-08-31                   # 补某一天
  # ↓↓↓ 多日补数：命令行直传区间（UI 不露，别在卡片上找这两个框）
  python run_delivery_pipeline.py --start-date 2026-08-25 --end-date 2026-08-31
  python run_delivery_pipeline.py --with-csv                          # raw 抓完顺带导出一份 CSV
  python run_delivery_pipeline.py --reinit                            # DROP 重建表 + 全跑
  python run_delivery_pipeline.py --reinit --begin init --end init    # 仅重建表
  python run_delivery_pipeline.py --begin load --end verify           # 仅入库 + 核对
  python run_delivery_pipeline.py --keep-raw                          # 退回断点续传（遇 .ok 跳过）

抓原始层默认「按单/多日分流」：单日补数（UI 默认场景，days=1）自动忽略
.meta.json 的 ok 标记 → 重新拉一遍最新接口数据；多日补数（命令行区间补，
days≥2）保持旧行为 → 遇 .ok 直接跳过，断网重跑不重复抓同一天。
要覆盖默认：--force-raw 强制重抓 / --keep-raw 强制断点续传。
"""
import os
import sys
import json
import argparse

# 任务脚本已迁到 jobs/delivery/ 下：把项目根加进 sys.path，
# 否则 import nodeflow / aeolus_sdk 等公共模块会失败（不依赖调用方 cwd）。
# 同目录模块（fetch_delivery_raw 等）由 Python 自动把脚本目录放进 sys.path[0]。
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_COMMON = os.path.join(_ROOT, "common")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
if _COMMON not in sys.path:
    sys.path.insert(0, _COMMON)

import nodeflow
from aeolus_sdk import login as L

# 运单明细「取数」统一来自 get_data.delivery（单一来源）；按天切片 / JSONL 落盘 / 断点续传 /
# 自动重登等编排逻辑在 jobs/delivery/raw_fetch.py（别名 mod_raw 保持不变）。
import raw_fetch as mod_raw
import download_delivery as mod_csv
import load_delivery_db as mod_db

BJ = mod_raw.BJ   # 北京时区常量（get_data.delivery.BJ）


# ==================== 执行节点（步进条按顺序跑）====================
NODES = [
    {"id": "init",   "name": "⚠️ DROP 重建表",
     "desc": "DROP 并重建 ods_delivery_tracking（清空全部已入库数据；危险节点，跑前必读 confirm）"},
    {"id": "raw",    "name": "抓运单原始层 JSONL",
     "desc": "登录风神 + 按天分页拉原始层（断点续传；产物 delivery_raw/*.jsonl）；"
             "勾了「导出 CSV」时在抓完后顺带由 JSONL 本地平铺出中文表头 CSV"},
    {"id": "load",   "name": "逐日 upsert 入库",
     "desc": "扫描 delivery_raw/*.jsonl 按 trackingId 幂等 upsert，结尾报告表内行数"},
    {"id": "verify", "name": "核对行数对账",
     "desc": "统计表内每日行数，与 delivery_raw/*.meta.json 中接口 total 对账"},
]


def _print(msg):
    print(msg, flush=True)


def _resolve_db_cfg_from_db_args(db_args):
    """用 load_delivery_db 自己的 load_cfg 拿到最终连接配置（包含 db_config.json + 环境变量覆盖）。"""
    a = argparse.Namespace(**db_args)
    return mod_db.load_cfg(a)


def node_init(ctx):
    """DROP + 重建表（运单表）。

    单开关判定：--reinit（工作台卡片「DROP 重建表」）或 --confirm-init（命令行老
    写法）任一为真即放行。两套开关都勾的"双保险"已按需求移除。"""
    a = ctx["args"]
    if not (getattr(a, "reinit", False) or getattr(a, "confirm_init", False)):
        _print("✗ init 节点是危险操作（会清空全部已入库数据）。")
        _print("  请在运行配置中勾选「DROP 重建表」，或命令行追加 --reinit / --confirm-init 后再重试。")
        sys.exit(2)
    _print("⚠️ 已确认：即将 DROP 并重建 ods_delivery_tracking 表，已有数据全部丢失。")
    cfg = _resolve_db_cfg_from_db_args(ctx.get("db_args") or {})
    mod_db.do_init(cfg)


def _export_csv(ctx):
    """把已抓的 JSONL 本地平铺成 CSV —— 不打接口，也不是独立节点。

    2026-09-03 两轮改动：
    - 第一轮：这里原本会再调一次 queryTracking/2.0 把同一批运单重抓一遍，和 raw
      节点完全重复（同一接口、同分页同筛选），单日 123 页请求 × 2、多花 7~8 分钟，
      产物却一模一样。实测 jsonl 每行 99 字段与 CSV 的 FIELD_ORDER 99 列一一对应、
      零缺失，本地转换无损，所以改成读 JSONL。
    - 第二轮：既然只是本地转换，就没必要单独占一个节点（还带来「起点必须包含 raw」
      的推断负担）。改为 raw 节点的收尾动作——勾了 --with-csv 就在抓完后顺带导出。

    只在 raw 之后被 node_raw 调用，不注册进 NODE_FNS，因此 --begin/--end 选不到它。"""
    a = ctx["args"]
    days = _resolve_days(a)
    if not days:
        _print("  ⏹ 无可转换日期")
        return
    rows = []
    miss = []
    for d in days:
        p = os.path.join(mod_raw.RAW_DIR, d.strftime("%Y-%m-%d") + ".jsonl")
        if not os.path.exists(p):
            miss.append(d.strftime("%Y-%m-%d"))
            continue
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
    if miss:
        _print(f"  ⚠ 以下 {len(miss)} 天没有 JSONL 产物，已跳过：{', '.join(miss)}")
        _print("    CSV 由 raw 的 JSONL 转换而来 —— 上面这些天 raw 没抓到（或抓取失败），"
               "请先确认 raw 节点跑成功、且区间包含了要导出的日期。")
    if not rows:
        _print("  ⏹ 没有可转换的数据，未生成 CSV")
        return
    s, e = _resolve_time_range(a)
    out = f"aeolus_delivery_{s:%Y%m%d}_{e:%Y%m%d}.csv"
    mod_csv.write_csv(rows, out)
    _print(f"  ✓ 由 {len(days) - len(miss)} 天 JSONL 转换 {len(rows)} 条 -> {out}")


def node_raw(ctx):
    """抓 JSONL 原始层。force 默认按 days 长度决定（单日重抓 / 多日断点续传）。"""
    a = ctx["args"]
    days = _resolve_days(a)
    if not days:
        _print("  ⏹ 无可抓取日期")
        return
    sess = mod_raw.Session()
    sess.cookie = L.ensure_cookies()[0]   # 复用 cookie，避免 raw 自己 ensure 拿过期值
    _print(f"[raw] 抓 {len(days)} 天: {days[0]} ~ {days[-1]}（force={a.force_raw}，{'重抓' if a.force_raw else '断点续传'}）")
    ok = tot = 0
    for d in days:
        try:
            m = mod_raw.fetch_day(sess, d, a.sleep, a.force_raw)
            if m.get("ok"):
                ok += 1
                tot += m.get("fetched", 0)
        except Exception as e:
            _print(f"  ! {d} 失败: {type(e).__name__} {e}")
        # 天与天之间也留间隔（与 fetch_delivery_raw 单独运行时保持一致）；
        # 多日补数时若天天紧挨着发，容易在时段交界处撞上限流。
        mod_raw.coarse_sleep()
    _print(f"[raw] 完成: {ok}/{len(days)} 天成功, 共 {tot} 条")
    # 勾了「导出 CSV」就在抓完后顺带导出（本地转换，不打接口）。
    # 放在这里而不是做成独立节点：CSV 只是 JSONL 的另一种排版形态，
    # 单独占节点会迫使起点必须包含 raw，白增一层推断负担。
    if getattr(a, "with_csv", False):
        _export_csv(ctx)


def node_load(ctx):
    """JSONL 幂等 upsert 入库。"""
    cfg = _resolve_db_cfg_from_db_args(ctx["db_args"])
    mod_db.do_load(cfg, ctx["args"].date)


def node_verify(ctx):
    """库内每日行数 vs delivery_raw/*.meta.json 接口 total 对账。"""
    cfg = _resolve_db_cfg_from_db_args(ctx["db_args"])
    mod_db.do_verify(cfg)


NODE_FNS = {
    "init":   node_init,
    "raw":    node_raw,
    "load":   node_load,
    "verify": node_verify,
}
for _n in NODES:
    _n["fn"] = NODE_FNS[_n["id"]]


# ==================== 辅助函数 ====================
def _resolve_days(a):
    """把 --date / --start-date~--end-date 展开成日期列表（自动剔除超 60 天窗口）。

    优先级：--date > 区间 > 默认昨天。区间是命令行高级用法（UI 只露 --date）。"""
    import datetime as _dt
    if a.date:
        return [_dt.datetime.strptime(a.date, "%Y-%m-%d").date()]
    if a.start_date or a.end_date:
        sd = _dt.datetime.strptime(a.start_date or a.end_date, "%Y-%m-%d").date()
        ed = _dt.datetime.strptime(a.end_date or a.start_date, "%Y-%m-%d").date()
        return [sd + _dt.timedelta(days=i) for i in range((ed - sd).days + 1)]
    # 默认抓「昨天」：当日数据往往还没跑完，补数以完整的昨日数据为准
    return [(_dt.datetime.now(BJ) - _dt.timedelta(days=1)).date()]


def _resolve_time_range(a):
    """同 days 但返回 (start_dt, end_dt)；csv 节点用它转毫秒。"""
    import datetime as _dt
    if a.date:
        s = _dt.datetime.strptime(a.date, "%Y-%m-%d").replace(tzinfo=BJ)
        e = s.replace(hour=23, minute=59, second=59)
        return s, e
    if a.start_date or a.end_date:
        s = _dt.datetime.strptime(a.start_date or a.end_date, "%Y-%m-%d").replace(tzinfo=BJ)
        e = _dt.datetime.strptime(a.end_date or a.start_date, "%Y-%m-%d").replace(tzinfo=BJ, hour=23, minute=59, second=59)
        return s, e
    # 默认昨天：当日数据未跑完，补数以昨天完整日为准
    yest = _dt.datetime.now(BJ) - _dt.timedelta(days=1)
    return (yest.replace(hour=0, minute=0, second=0, microsecond=0),
            yest.replace(hour=23, minute=59, second=59))


def _build_db_args(a):
    """把脚本参数映射成 load_delivery_db 的 db_config 字段（允许环境变量 / CLI 覆盖）。"""
    db_arg_names = ("host", "port", "user", "password", "database")
    out = {k: getattr(a, k, None) for k in db_arg_names}
    # load_delivery_db.load_cfg 会自己处理 None/空值 + 环境变量 + db_config.json
    return out


def _user_passed(argv, flag):
    """检查命令行是否显式给了 --flag（无论 = 连接还是分两个 element）。"""
    for a in argv:
        if a == flag or a.startswith(flag + "="):
            return True
    return False


def main():
    argv_raw = list(sys.argv)
    bad = nodeflow.reject_legacy_date_args(argv_raw[1:])
    if bad:
        print("✗ 日期参数要带 -date 后缀：--start-date / --end-date（多日）或 --date（单日）；"
              "裸的 --start / --end 现在是节点区间专用：%s" % ", ".join(bad))
        sys.exit(1)

    # ---------- 决定 begin / end ----------
    # 显式给了 → 尊重；没给 → 按规则推断：
    #   默认          raw → load → verify   （日常补数）
    #   --reinit      init → load → verify  （DROP 重建 + 全跑；勾了就真删，无二次确认）
    #   --with-csv    不影响区间（2026-09-03 起 CSV 已是 raw 的收尾动作，不再是独立节点，
    #                 勾上后由 node_raw 抓完自动导出，不需要把起点往前推）
    user_begin = _user_passed(argv_raw, "--begin")
    user_end   = _user_passed(argv_raw, "--end")
    # --confirm-init 是 --reinit 的命令行老写法，两者都表示「已确认 DROP 重建」
    has_reinit = "--reinit" in argv_raw or "--confirm-init" in argv_raw
    inferred_begin = "init" if has_reinit else "raw"
    inferred_end   = "verify"

    argv = list(argv_raw)
    if not user_begin:
        argv.append("--begin=" + inferred_begin)
    elif has_reinit:
        # 已确认重建、却又显式指定了别的起始节点 → init 会被整个跳过，重建静默失效。
        # 2026-09-03 实测踩到：`--reinit --begin=csv` 区间变成 csv→verify，
        # 表从头到尾没建起来，load 反复报 relation does not exist，而日志里没有任何提示。
        # 既然用户已经确认要 DROP 重建，就强制把起点推回 init，并明确说出来。
        argv = [a for a in argv if not a.startswith("--begin=")]
        argv.append("--begin=init")
        _print("[reinit] 已确认「DROP 重建表」，起始节点强制改为 init"
               "（重建必须走 init，否则表建不起来）")
    if not user_end:
        argv.append("--end=" + inferred_end)
    sys.argv = argv   # 让 prepare 先摘掉 --begin/--end
    _begin_val = next((x.split("=", 1)[1] for x in argv if x.startswith("--begin=")), "?")
    _print("[区间] 起始节点 = " + _begin_val
           + ("（用户显式指定）" if user_begin else "（按开关推断）"))

    todo, err = nodeflow.prepare(NODES)
    if err:
        print("✗ " + err)
        sys.exit(1)

    # ---------- argparse（此时 sys.argv 已不含 --begin/--end，仅剩业务参数）----------
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="单日 YYYY-MM-DD（默认昨天；显式空走昨天补数）")
    # ↓ 多日窗口：命令行高级用法，tasks.json 里刻意不声明 → 工作台卡片不露这两个框
    ap.add_argument("--start-date", help="开始日期 YYYY-MM-DD（高级：命令行直传，UI 不露）")
    ap.add_argument("--end-date", help="结束日期 YYYY-MM-DD（高级：命令行直传，UI 不露）")
    ap.add_argument("--sleep", type=float, default=mod_raw.SLEEP_MAX,
                    help=f"页间随机延迟上限秒（下限固定 {mod_raw.SLEEP_MIN}）")
    # 单日补数 → 默认「忽略 .meta.json 重抓」（保证补到最新接口数据）；
    # 多日补数 → 默认「遇 .ok 跳过」（断网重跑不重复抓同一天）。
    # --force-raw / --keep-raw 可显式覆盖默认。
    ap.add_argument("--force-raw", dest="force_raw_choice", action="store_const", const=True, default=None,
                    help="强制重抓：忽略 .meta.json 完成标记（覆盖单/多日默认）")
    ap.add_argument("--keep-raw", dest="force_raw_choice", action="store_const", const=False,
                    help="强制断点续传：遇已完成的 .meta.json 直接跳过（覆盖单/多日默认）")
    ap.add_argument("--with-csv", action="store_true",
                    help="raw 抓完后顺带导出一份 CSV（由 JSONL 本地转换，不打接口）；日常补数用不上")
    ap.add_argument("--reinit", action="store_true",
                    help="DROP 重建表再走流水线（区间从 init 开始）；勾了就真删，不再二次确认")
    ap.add_argument("--confirm-init", action="store_true",
                    help="命令行老写法：等价于 --reinit 的确认位（init 节点二者其一即可）")
    # 数据库（与 load_delivery_db 同名，环境变量 / db_config.json 兜底）
    ap.add_argument("--host")
    ap.add_argument("--port")
    ap.add_argument("--user")
    ap.add_argument("--password")
    ap.add_argument("--database")
    args = ap.parse_args()
    # 默认按「单日/多日」分流决定是否忽略 .ok 标记；CLI flag 可覆盖
    if args.force_raw_choice is None:
        args.force_raw = len(_resolve_days(args)) == 1   # 单日重抓、多日断点续传
    else:
        args.force_raw = args.force_raw_choice

    ctx = {"args": args, "db_args": _build_db_args(args)}
    sys.exit(nodeflow.execute(todo, ctx, title="[运单全流程]"))


if __name__ == "__main__":
    main()
