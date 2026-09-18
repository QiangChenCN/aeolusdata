#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""骑手装备点亮提醒（节点化端到端）

整段走 7 个节点（server 步进条按声明顺序执行）：

  1. fetch    取数（委托 get_data.rider_equipment.fetch_report_view）
  2. save     落盘 rider_equipment_raw.json + 解析导出 rider_equipment.csv
  3. report   打印响应摘要与列 schema（排查用）
  4. filter   从 rider_equipment.csv 筛未点亮记录；0 条则中止后续
  5. render   出 rider_equipment_warning.png + 同步导出 rider_equipment_unlit.csv
  6. upload   PNG 上传 MinIO 拿公网直链（供 markdown 内联图）
  7. send     解析目标群 + @ 对应站长 + 发钉钉

CLI（节点区间 + 业务参数）：
  python task_equipment.py                                  # 跑全部 7 节点
  python task_equipment.py --no-at                          # 跑全部，但 send 不 @ 站长
  python task_equipment.py --no-send                        # 只跑 fetch→upload，不发钉钉
  python task_equipment.py --begin filter --end send        # 复用磁盘 CSV/PNG 重发
  python task_equipment.py --group "台账安全处理群"     # 覆盖目标群名
  python task_equipment.py --date 2026-09-02                # 自定义日期（默认昨天）
  python task_equipment.py --start-date 2026-09-01 \
                          --end-date 2026-09-01             # 自定义日期窗口（高级：命令行直传，UI 不露）

节点区间选择（同 task_board）：
  · --begin / --end 接收节点 id
  · 必须同时给出，end 不得早于 begin
  · 只跑 [begin, end] 内的节点（按声明顺序，跳过其余）
  · 任一节点失败：终止流水线并以非零退出（后续节点不再跑）

依赖：
  - aeolus_sdk（SSO cookie / Quark 报表 SDK，登录 + 兑换 + 取数 + 解析全在一处）
  - ding_common（GROUP_ID / resolve_openids / dws_run / setup_logging /
                  TEAM_TO_STATION / STATION_MANAGERS）
  - minio_common（upload_to_minio）
  - find_group（按群名解析 cid / 测试群）
  - da_auth（DA_TOKEN 兑换；由 quark_sdk.creds 在 get_data.rider_equipment.fetch_report_view 内调用）
  - rider_equipment_report（load_and_filter / build_display / render_image /
                            DISPLAY_COLS / format_date）

历史：
  · 2026-09-03 由 fetch_rider_equipment.py + send_equipment_report.py 合并，
    对齐 task_board.py 的「节点化 + 区间选择 + 子节点独立重入」范式。
  · 2026-09-03 fetch 节点用到的全量 helper（UA/URL/HEADERS/凭证加载/token
    提取/DA 健康/报文体/重试循环等）整体迁入 get_data.rider_equipment，task 侧
    只剩「调一行 → 写结果」。后续新报表任务可直接复用 get_data.rider_equipment
    的 fetch_report_view()。
"""
import sys
import os
import csv
import logging

sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))  # 项目根（公共模块所在）
import venv_guard  # 自动切换至项目 .venv

BASE = os.path.dirname(os.path.abspath(__file__))      # jobs/equipment
ROOT = os.path.dirname(os.path.dirname(BASE))          # 项目根（公共模块所在）
OUT_DIR = os.path.join(BASE, "out")                    # 产物统一进 out/
os.makedirs(OUT_DIR, exist_ok=True)
sys.path.insert(0, BASE)

import rider_equipment_report as R  # noqa: E402
import nodeflow  # noqa: E402  # 节点函数用 nodeflow.Stop，main 用 prepare/execute
from get_data import rider_equipment as RE  # noqa: E402  # 骑手装备点亮明细取数（标准 get_data 模块）
from ding_common import (  # noqa: E402
    resolve_openids, dws_run, setup_logging,
    TEAM_TO_STATION, STATION_MANAGERS,
)
from minio_common import upload_to_minio  # noqa: E402
from find_group import resolve_group_id, list_all_groups  # noqa: E402

# 取数所有 helper 都迁到了 get_data.rider_equipment，这里只保留任务内部需要的常量。
QUARK_DEFAULT_START = RE.DEFAULT_START  # T-1
QUARK_DEFAULT_END = RE.DEFAULT_END
QUARK_DEFAULT_AS_OF = RE.DEFAULT_AS_OF
parse_rows = RE.parse_rows
summarize = RE.summarize
schema_hint = RE.schema_hint
named_headers = RE.named_headers
export_csv = RE.export_csv

# 产物路径
RAW_PATH = os.path.join(OUT_DIR, "rider_equipment_raw.json")
CSV_PATH = os.path.join(OUT_DIR, "rider_equipment.csv")
UNLIT_CSV_PATH = os.path.join(OUT_DIR, "rider_equipment_unlit.csv")
IMG_PATH = os.path.join(OUT_DIR, "rider_equipment_warning.png")
LOG_PATH = os.path.join(OUT_DIR, "task_equipment_send.log")

# 默认目标群：台账安全处理群
DEFAULT_GROUP = "台账安全处理群"


# ──────────────────────────────────────────────────────────────
# fetch 阶段工具函数 —— 已迁入 get_data.rider_equipment
#
# 一行委托取代原 ~270 行 helper：
#   RE.fetch_report_view(base=BASE, ...)   # RE = get_data.rider_equipment
# 下方 save / report 节点复用的 parse_rows / summarize / schema_hint
# / named_headers / DEFAULT_* 通过模块顶部 import 段直接绑到 SDK。
#
# 已迁出的 helpers（全部走了 SDK）：
#   - UA / URL / HEADERS / FIELD_GUIDS / DATASET_GUID
#   - load_aeo_cookie / load_quark_cookie
#   - get_report_url / _curl_get / _unescape_js_string / _extract_page_tokens
#   - auto_fetch_tokens / probe_da_health
#   - build_payload / fetch
#   - export_csv （SDK 内有 named_headers+export_csv 同款，按需复用）
#   - summarize / parse_rows / schema_hint （SDK 同款，上方 import 段绑名复用）
# 新报表任务：直接 import get_data.rider_equipment 一行即可。


# ──────────────────────────────────────────────────────────────
# send 阶段工具函数（原 send_equipment_report.py 整体迁入）
# ──────────────────────────────────────────────────────────────
def collect_at(rows_kept):
    """数据里出现过的站点 -> 对应站长姓名集合 -> (openid 列表, 缺失姓名)。"""
    names = set()
    for row in rows_kept:
        station = TEAM_TO_STATION.get(row.get("站点名称", ""), "")
        for m in STATION_MANAGERS.get(station, []):
            names.add(m)
    resolved, missing = resolve_openids(names)
    return [oid for _, oid in resolved], sorted(missing)


def build_markdown(date_str, n, img_url, ids):
    mentions = " ".join("<@%s>" % i for i in ids) if ids else ""
    return (
        "## 骑手装备未点亮明细\n"
        "**统计日期：** %s　**未点亮 共 %d 条**\n\n"
        "![未点亮明细](%s)\n\n"
        "请相关站点站长及时跟进装备点亮情况：%s"
        % (date_str, n, img_url, mentions)
    )


# ──────────────────────────────────────────────────────────────
# CLI 解析（先调 nodeflow.prepare 摘掉 --begin/--end，再来这里）
# ──────────────────────────────────────────────────────────────
def parse_args():
    """解析业务参数。

    --start-date / --end-date / --as-of / --token / --secure / --meta-time 仅排查用，
    默认不进 UI（不进 tasks.json params，靠 sys.argv 直传）。
    """
    argv = list(sys.argv[1:])
    start = end = as_of = token = secure = meta_time = None
    no_at = no_send = False
    group_arg = DEFAULT_GROUP
    date = None   # 单日快捷：--date X 等价于 --start-date X --end-date X

    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--no-at":       no_at = True;  i += 1; continue
        if a == "--no-send":     no_send = True; i += 1; continue
        if a == "--group" and i + 1 < len(argv):
            group_arg = argv[i + 1]; i += 2; continue
        if a.startswith("--group="):
            group_arg = a.split("=", 1)[1]; i += 1; continue
        if a == "--date" and i + 1 < len(argv):
            date = argv[i + 1]; i += 2; continue
        if a.startswith("--date="):
            date = a.split("=", 1)[1]; i += 1; continue
        if a == "--start-date" and i + 1 < len(argv):
            start = argv[i + 1]; i += 2; continue
        if a.startswith("--start-date="):
            start = a.split("=", 1)[1]; i += 1; continue
        if a == "--end-date" and i + 1 < len(argv):
            end = argv[i + 1]; i += 2; continue
        if a.startswith("--end-date="):
            end = a.split("=", 1)[1]; i += 1; continue
        if a == "--as-of" and i + 1 < len(argv):
            as_of = argv[i + 1]; i += 2; continue
        if a.startswith("--as-of="):
            as_of = a.split("=", 1)[1]; i += 1; continue
        if a == "--token" and i + 1 < len(argv):
            token = argv[i + 1]; i += 2; continue
        if a.startswith("--token="):
            token = a.split("=", 1)[1]; i += 1; continue
        if a == "--secure" and i + 1 < len(argv):
            secure = argv[i + 1]; i += 2; continue
        if a.startswith("--secure="):
            secure = a.split("=", 1)[1]; i += 1; continue
        if a == "--meta-time" and i + 1 < len(argv):
            meta_time = argv[i + 1]; i += 2; continue
        if a.startswith("--meta-time="):
            meta_time = a.split("=", 1)[1]; i += 1; continue
        print(f"✗ 未知参数：{a}")
        sys.exit(1)

    # --date 是一站到底的快捷方式：把起止都钉到同一日；起止单独给过时不被覆盖。
    if date and not (start and end):
        start = end = date

    return {
        "start": start or QUARK_DEFAULT_START,
        "end": end or QUARK_DEFAULT_END,
        "as_of": as_of or QUARK_DEFAULT_AS_OF,
        "token": token,
        "secure": secure,
        "meta_time": meta_time,
        "no_at": no_at,
        "no_send": no_send,
        "group": group_arg,
    }


# ──────────────────────────────────────────────────────────────
# 节点定义（7 节点，单一事实来源）
# ──────────────────────────────────────────────────────────────
NODES = [
    {"id": "fetch",  "name": "取数",
     "desc": "健康探针 → WidgetAction 取数（DA cookie 优先复用缓存，含 3 次抗顶号重试）"},
    {"id": "save",   "name": "落盘原始层+CSV",
     "desc": "写 rider_equipment_raw.json + 解析导出 rider_equipment.csv"},
    {"id": "report", "name": "打印摘要",
     "desc": "打印响应摘要与列 schema（排查用）"},
    {"id": "filter", "name": "筛选未点亮",
     "desc": "从 rider_equipment.csv 筛出未点亮记录；0 条则中止后续"},
    {"id": "render", "name": "渲染明细图",
     "desc": "出 rider_equipment_warning.png + 同步导出 rider_equipment_unlit.csv"},
    {"id": "upload", "name": "上传 MinIO",
     "desc": "PNG 上传 MinIO 拿公网直链（供 markdown 内联图）"},
    {"id": "send",   "name": "发送钉钉群",
     "desc": "解析目标群 + @ 对应站长 + 发 markdown"},
]


# ──────────────────────────────────────────────────────────────
# 节点函数
# ──────────────────────────────────────────────────────────────
def node_fetch(ctx):
    """取数 —— 全部委托 get_data.rider_equipment.fetch_report_view。

    SDK 内部负责：Aeolus 登录态 → DA cookie（缓存优先，探活失败才重兑）→
    健康探针 → 三件套 token → WidgetAction → 解析，含抗 SSO 顶号重试。
    原 ~50 行循环现在压缩为 1 行 SDK 调用。
    """
    rep = RE.fetch_report_view(
        base=BASE,
        start_date=ctx["start"],
        end_date=ctx["end"],
        as_of=ctx["as_of"],
        token_override=ctx.get("token"),
        secure_override=ctx.get("secure"),
        meta_time_override=ctx.get("meta_time"),
        verbose=True,
    )
    if not rep["ok"]:
        # 失败集中上报：上层 nodeflow.execute 会以 exit 非 0 终止流水线
        log.error("[fetch] 取数失败：code=%s %s", rep["code"], rep["warning"])
        raise nodeflow.Stop(rep["warning"] or rep["code"])
    ctx["raw"] = rep["raw"]
    ctx["rows"] = rep["rows"]
    ctx["headers"] = rep["headers"]
    ctx["labels"] = rep["labels"]
    log.info(
        "[fetch] ok: attempts=%d cookie_used=%s elapsed=%ss rows=%d",
        rep["attempts"], rep["cookie_used"], rep["elapsed_sec"], len(rep["rows"]),
    )

def node_save(ctx):
    """落盘 raw + 解析导出 CSV。"""
    raw = ctx.get("raw")
    if raw is None:
        if not os.path.exists(RAW_PATH):
            raise RuntimeError("没有原始数据，先跑 fetch 节点")
        raw = open(RAW_PATH, encoding="utf-8").read()
        print("[save] 复用磁盘原始响应 -> %s" % RAW_PATH, flush=True)
        ctx["raw"] = raw

    with open(RAW_PATH, "w", encoding="utf-8") as f:
        f.write(raw)
    print("[save] raw -> %s" % RAW_PATH, flush=True)

    headers, rows, label_map = parse_rows(raw)
    print("[parse] %d 列, %d 行" % (len(headers), len(rows)), flush=True)
    named_headers = [label_map.get(h, h) for h in headers]
    export_csv(named_headers, rows, CSV_PATH)
    ctx["headers"], ctx["rows"], ctx["label_map"] = headers, rows, label_map


def node_report(ctx):
    """打印响应摘要 + 列 schema。"""
    print("==== 响应摘要 ====", flush=True)
    print(summarize(ctx["raw"]), flush=True)
    schema_hint(ctx["headers"], ctx["rows"], ctx["label_map"])
    print("=== DONE ===", flush=True)


def node_filter(ctx):
    """从 rider_equipment.csv 筛未点亮记录；0 条则中止。"""
    header, all_rows, kept = R.load_and_filter()
    if not kept:
        raise nodeflow.Stop("无未点亮记录，跳过发送。")
    ctx["all_rows"] = all_rows
    ctx["kept"] = kept
    ctx["date_str"] = R.format_date(kept[0].get("日期", ""))
    log.info("未点亮 %d 条（总 %d 行），统计日期 %s",
             len(kept), len(all_rows), ctx["date_str"])


def node_render(ctx):
    """出 PNG + 同步导出 unlit.csv。"""
    if "kept" not in ctx:
        # 子节点独立重入：filter 没跑过
        node_filter(ctx)
    display = R.build_display(ctx["kept"])
    ctx["img_path"] = R.render_image(display, len(ctx["all_rows"]), ctx["date_str"])
    log.info("图片已生成: %s", ctx["img_path"])

    # 同步导出筛选 CSV（与本地报表一致，避免 unlit.csv 停留在旧日期）
    with open(UNLIT_CSV_PATH, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow([d for d, _, _ in R.DISPLAY_COLS])
        for r in display:
            w.writerow(r)
    log.info("已同步筛选 CSV: %s", UNLIT_CSV_PATH)


def node_upload(ctx):
    """PNG 上传 MinIO 拿公网直链。"""
    img_path = ctx.get("img_path")
    if not img_path or not os.path.exists(img_path):
        raise RuntimeError("还没有图片，先跑 render 节点")
    ctx["img_url"] = upload_to_minio(img_path, prefix="equip")
    log.info("图片已上传: %s", ctx["img_url"])


def _resolve_target(val):
    """把 --group 的值解析成 (gid, 群名)，兼容两种写法。

    - openConversationId（cid 开头）：工作台群选择器给的就是这个，直接用。
      群名只为日志好看去反查一次，查不到就用 id 本身，绝不因此阻塞发送。
    - 群名：命令行手工跑的老习惯，走 find_group 按匹配度解析。
    """
    v = (val or "").strip()
    if not v:
        raise SystemExit("目标群为空")
    if v.startswith("cid"):
        try:
            for g in list_all_groups():
                if g.get("openConversationId") == v:
                    return v, (g.get("title") or v)
        except Exception:
            pass
        return v, v
    return resolve_group_id(v)


def node_send(ctx):
    """解析目标群 + @ 站长 + 发钉钉。"""
    if not ctx.get("img_url"):
        img_path = ctx.get("img_path") or IMG_PATH
        if not os.path.exists(img_path):
            raise RuntimeError("还没有图片，先跑 render 节点")
        ctx["img_url"] = upload_to_minio(img_path, prefix="equip")
        log.info("（send 节点补上传）%s", ctx["img_url"])

    gid, title = _resolve_target(ctx["group"])
    log.info("目标群: %s (%s)", title, gid)

    ids, missing = collect_at(ctx["kept"])
    if ctx["no_at"]:
        ids = []
    if missing:
        log.warning("以下站长未解析到 openDingTalkId，已跳过 @：%s", missing)
    log.info("将 @ 站长 openid: %s", ids)

    text = build_markdown(ctx["date_str"], len(ctx["kept"]), ctx["img_url"], ids)
    log.info("待发送 Markdown:\n%s", text)

    if ctx["no_send"]:
        log.info("(--no-send) 未实际发送。")
        return

    args = ["chat", "message", "send", "--group", gid, "--text", text, "--yes"]
    if ids and not ctx["no_at"]:
        args += ["--at-open-dingtalk-ids", ",".join(ids)]
    out, err, code = dws_run(args)
    log.info("发送完成: code=%s %s", code, (out or "")[:300])


for _n in NODES:
    _n["fn"] = {
        "fetch":  node_fetch,
        "save":   node_save,
        "report": node_report,
        "filter": node_filter,
        "render": node_render,
        "upload": node_upload,
        "send":   node_send,
    }[_n["id"]]


# ──────────────────────────────────────────────────────────────
# 入口
# ──────────────────────────────────────────────────────────────
def main():
    # 日期参数刻意叫 --start-date / --end-date，避免与节点区间的 --end 撞名。
    bad = nodeflow.reject_legacy_date_args(sys.argv[1:])
    if bad:
        print("✗ 日期参数已改名为 --start-date / --end-date"
              "（--end 现在是节点区间专用）：%s" % ", ".join(bad))
        sys.exit(1)

    todo, err = nodeflow.prepare(NODES)
    if err:
        print("✗ " + err)
        sys.exit(1)

    ctx = parse_args()
    sys.exit(nodeflow.execute(todo, ctx, title="[装备点亮日报]"))


# 日志必须在 main() / 节点函数可见前就绪；放到模块顶层，import 时即生效。
log = setup_logging("task_equipment", LOG_PATH)


if __name__ == "__main__":
    main()