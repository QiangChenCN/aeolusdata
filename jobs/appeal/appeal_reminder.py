#!/usr/bin/env python
# -*- coding: utf-8 -*-
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))  # 项目根（公共模块所在）
import venv_guard  # 自动切换至项目 .venv
"""
不满意单申诉提醒 - 端到端流水线（基于项目内 aeolus_sdk.login 登录模块）

流程：
  1) 进程内登录风神 -> 拿到最新 AEOLUS_MOZI_TOKEN（避免 SSO 被浏览器顶掉）
  2) POST download 接口（当天北京时间 00:00:00 ~ 23:59:59.999）-> 拿 CSV 签名链接
  3) 下载 CSV（GBK）-> 筛选：违规分类 != 超时(即非超时) 且 申诉状态 == 待申诉
  4) 渲染表格图片（9 列：违规时间/运单号/骑手信息/所属团队/违规分类/违规类型/违规原因/申诉状态/申诉剩余时间）
  5) 发送：图片文件附件 + 文字消息（下载链接 + 按所属站点 @ 对应站长）

用法：
  python appeal_reminder.py                      # 默认：渲染图片上传MinIO + markdown内联图 + 下载链接 + @站长
  python appeal_reminder.py --no-send            # 只预览（下载/筛选/渲染/上传），不发送
  python appeal_reminder.py --markdown           # 单条 Markdown 消息（不渲染图片）
  python appeal_reminder.py --group <id>         # 覆盖目标群（如发到测试群）
  python appeal_reminder.py --no-at              # 跳过 @ 站长（仅发图片 + 下载链接）
  python appeal_reminder.py --group <id> --no-at # 发到测试群且不 @ 任何人

节点区间（server 步进条）：
  节点顺序 download → filter → render → upload → send
  python appeal_reminder.py --begin download --end filter   # 只拉数看命中多少条
  python appeal_reminder.py --begin render --end send       # 用上次筛好的结果重出图再发
  python appeal_reminder.py --begin send --end send         # 只发（图片已就绪）
"""
import os, sys, io, json, csv, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aeolus_sdk import login as L   # 项目内风神登录模块（纯标准库，每次新建独立会话）

# 钉钉路径/目标群/站长 id/dws 封装/重试 统一从 ding_common 引用（消除三脚本重复定义）
from ding_common import (with_retry, dws_run, GROUP_ID, resolve_openids,
                         FONT_PATH, TEAM_TO_STATION, STATION_MANAGERS, setup_logging)
from minio_common import upload_to_minio
from get_data import violation   # 风控处罚 CSV 取数（单一来源；download_csv 在此）

BASE = os.path.dirname(os.path.abspath(__file__))      # jobs/appeal
ROOT = os.path.dirname(os.path.dirname(BASE))          # 项目根（公共模块所在）
OUT_DIR = os.path.join(BASE, "out")                    # 产物统一进 out/
os.makedirs(OUT_DIR, exist_ok=True)

IMG_PATH = os.path.join(OUT_DIR, "violation_detail.png")
CSV_PATH = os.path.join(OUT_DIR, "violations.csv")
LOG_PATH = os.path.join(OUT_DIR, "appeal_reminder.log")


# ---------- 日志（统一走 ding_common.setup_logging：同时落盘 + 控制台）----------
log = setup_logging("appeal", LOG_PATH)

# 失败重试见 ding_common.with_retry（带退避倍率）
# 团队/站长映射见 ding_common.TEAM_TO_STATION / STATION_MANAGERS（单一来源）
# 站长 openDingTalkId 见 ding_common.MANAGER_OPENID（由 dws aisearch person 解析，会话内稳定）
# 取数单一来源见 get_data.violation（download_csv 在此，API_URL/STATIC_HEADERS 不再在本文件）


# ---------- 1. 动态时间戳（北京时间当天）----------
def dynamic_time_range():
    bj = datetime.timezone(datetime.timedelta(hours=8))
    now = datetime.datetime.now(bj)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = now.replace(hour=23, minute=59, second=59, microsecond=999000)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000), now.date().isoformat()


# ---------- 2. 登录 + 下载 ----------
@with_retry(times=3, delay=5, backoff=2, label="风神登录+下载CSV")
def download_csv():
    start_ms, end_ms, date_str = dynamic_time_range()
    cookie, _ = L.ensure_cookies()   # 优先复用本地有效 cookie，失效才登录（减少顶号）；401 由外层 with_retry 重试自愈
    # 取数单一来源：get_data.violation.download_csv（cookie + 时间窗由此准备后传入）
    text, file_url = violation.download_csv(start_ms, end_ms, cookie=cookie)
    # 落盘统一 UTF-8-sig（Excel 双击也是中文）
    with open(CSV_PATH, "w", encoding="utf-8-sig", newline="") as f:
        f.write(text)
    return text, date_str, file_url


# ---------- 3. 筛选 ----------
def filter_rows(text):
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for r in reader:
        rec = {k: (v or "").strip() for k, v in r.items()}  # CSV 字段带尾随 tab，统一 strip
        if rec.get("违规分类") != "超时" and rec.get("申诉状态") == "待申诉":
            team = rec.get("团队名称", "")
            station = TEAM_TO_STATION.get(team, "未匹配:" + team)
            rows.append({
                "违规时间": rec.get("违规时间", ""),
                "运单号": rec.get("运单号", ""),
                "骑手信息": "%s(%s)" % (rec.get("骑手名称", ""), rec.get("骑手ID", "")),
                "所属团队": team,
                "站点": station,
                "违规分类": rec.get("违规分类", ""),
                "违规类型": rec.get("违规类型", ""),
                "违规原因": rec.get("违规原因", ""),
                "申诉状态": rec.get("申诉状态", ""),
                "申诉剩余时间": rec.get("剩余申诉时间", ""),
            })
    return rows


# ---------- 4. 渲染图片（统一走 report_render，字号自适应见该模块）----------
FONT = FONT_PATH   # 字体路径由 ding_common 解析（环境变量/ .env / 默认）


def render_image(rows, date_str):
    """统一渲染（单一事实来源：report_render）。"""
    import report_render
    return report_render.render_appeal(rows, date_str, out_path=IMG_PATH)

# ---------- MinIO 图床上传统一走 minio_common（见该模块：对象名=业务前缀+内容哈希，幂等）----------


# ---------- 5. 发送 ----------
def collect_at(rows):
    names = set()
    for r in rows:
        for m in STATION_MANAGERS.get(r["站点"], []) if r["站点"] in STATION_MANAGERS else []:
            names.add(m)
    resolved, missing = resolve_openids(names)
    return [oid for _, oid in resolved], sorted(missing)


# dws 封装见 ding_common.dws / dws_run（统一带重试 + 非零退出即抛 RuntimeError）


def send_image_file_fallback(img_path, date_str, file_url, ids, rows, no_at=False,
                              group_id=None):
    """MinIO 不可用时的降级方案：把本地渲染图作为钉钉图片文件附件直接发送（不依赖任何外部图床），
    并补一条文字说明 + 原始 CSV 下载链接（风神 OSS 签名链接，公网可下）。"""
    log.info("图片已生成(本地): %s", img_path)
    # 1) 图片附件（@站长）
    args = ["chat", "message", "send", "--group", group_id or GROUP_ID, "--msg-type", "file",
            "--file-path", img_path, "--yes"]
    if ids and not no_at:
        args += ["--at-open-dingtalk-ids", ",".join(ids)]
    out, err, code = dws_run(args)
    log.info("图片文件附件发送: code=%s %s", code, out[:300])
    # 2) 文字说明 + 原始 CSV 下载链接
    mentions = (" ".join("<@%s>" % i for i in ids)) if (ids and not no_at) else ""
    caption = ("## 不满意单申诉提醒\n**统计日期：** %s　**非超时 · 待申诉 共 %d 条**\n\n"
               "📎 [下载原始数据](%s)\n\n请相关站点站长及时查看上方明细图并处理申诉：%s"
               % (date_str, len(rows), file_url, mentions))
    args2 = ["chat", "message", "send", "--group", group_id or GROUP_ID, "--text", caption, "--yes"]
    if ids and not no_at:
        args2 += ["--at-open-dingtalk-ids", ",".join(ids)]
    out2, err2, code2 = dws_run(args2)
    log.info("说明文字发送: code=%s %s", code2, out2[:300])


def send_image_markdown(rows, date_str, file_url, ids, no_at=False,
                        img_url=None, img_path=None, group_id=None):
    """图片模式发送。

    `ids` 由 send 节点统一收集后传入（原先在函数内重复 collect_at，
    拆成节点后收集动作上移到 send 节点，避免 render/upload 被跳过时收不到 ids）。

    图片来源二选一：
      · img_url  —— MinIO 公网直链，走 markdown 内联图（首选）
      · img_path —— 本地图片，MinIO 不可用时的降级：作为钉钉文件附件发送
    两者都没有 → 直接报错，由 send 节点兜底。
    """
    if img_url:
        mentions = (" ".join("<@%s>" % i for i in ids)) if (ids and not no_at) else ""
        text = (
            "## 不满意单申诉提醒\n"
            "**统计日期：** %s　**非超时 · 待申诉 共 %d 条**\n\n"
            "![违规明细](%s)\n\n"
            "📎 [下载原文件](%s)\n\n"
            "请相关站点站长及时查看并处理申诉：%s"
            % (date_str, len(rows), img_url, file_url, mentions)
        )
        args = ["chat", "message", "send", "--group", group_id or GROUP_ID, "--text", text, "--yes"]
        if ids and not no_at:
            args += ["--at-open-dingtalk-ids", ",".join(ids)]
        out, err, code = dws_run(args)
        log.info("图片内联 Markdown 发送: code=%s %s", code, out[:300])
        return
    if img_path and os.path.exists(img_path):
        log.warning("MinIO 图链不可用，降级为钉钉图片附件")
        send_image_file_fallback(img_path, date_str, file_url, ids, rows, no_at=no_at,
                                 group_id=group_id)
        return
    raise RuntimeError("既无 MinIO 图链也无本地图片，无法发送（先跑 render 节点）")


def send_markdown(rows, date_str, file_url, ids, no_at=False, group_id=None):
    """纯表格 Markdown 模式（不渲染图片）。ids 由 send 节点统一收集后传入。"""
    header = "| " + " | ".join(["违规时间", "运单号", "骑手信息", "所属团队", "违规分类",
                                "违规类型", "违规原因", "申诉状态", "申诉剩余时间"]) + " |\n" + \
             "|" + "|".join(["---"] * 9) + "|"
    body = [header]
    for r in rows:
        body.append("| " + " | ".join([r["违规时间"], r["运单号"], r["骑手信息"], r["所属团队"],
                                        r["违规分类"], r["违规类型"], r["违规原因"],
                                        r["申诉状态"], r["申诉剩余时间"]]) + " |")
    mentions = " ".join("<@%s>" % i for i in ids) if (ids and not no_at) else ""
    text = ("## 不满意单申诉提醒\n**统计日期：** %s　**非超时 · 待申诉 共 %d 条**\n\n"
            % (date_str, len(rows)) + "\n".join(body)
            + "\n\n📎 [下载原文件](%s)\n\n请相关站点站长及时查看并处理申诉：%s"
            % (file_url, mentions))
    args = ["chat", "message", "send", "--group", group_id or GROUP_ID, "--text", text, "--yes"]
    if ids and not no_at:
        args += ["--at-open-dingtalk-ids", ",".join(ids)]
    out, err, code = dws_run(args)
    log.info("Markdown 单条发送: code=%s %s", code, out[:300])


# ==================== 执行节点（server 步进条按顺序跑）====================
# 顺序即流水线顺序；--begin / --end 用这里的 id 圈定区间。
NODES = [
    {"id": "download", "name": "下载违规 CSV", "desc": "登录风神 + POST download 接口 + 下载 CSV(GBK)"},
    {"id": "filter",   "name": "筛选非超时待申诉", "desc": "违规分类 != 超时 且 申诉状态 == 待申诉；0 条则中止"},
    {"id": "render",   "name": "渲染明细图", "desc": "9 列表格渲染成 violation_detail.png"},
    {"id": "upload",   "name": "上传 MinIO", "desc": "PNG 上传 MinIO 拿公网直链（失败则 send 降级为附件）"},
    {"id": "send",     "name": "发送钉钉群", "desc": "组装消息 + @ 对应站长（--no-send 只预览不真发）"},
]


def node_download(ctx):
    ctx["text"], ctx["date_str"], ctx["file_url"] = download_csv()


def node_filter(ctx):
    rows = filter_rows(ctx["text"])
    log.info("日期 %s 筛选命中（非超时 & 待申诉）: %d 条", ctx["date_str"], len(rows))
    for r in rows:
        log.info("  %s", json.dumps(r, ensure_ascii=False))
    log.info("下载链接已获取(长度 %d，已脱敏不外泄签名 URL)", len(ctx["file_url"] or ""))
    if not rows:
        # 业务上不需要继续 —— 抛 Stop 让框架以 0 退出，不算失败
        raise nodeflow.Stop("无符合条件的订单，跳过发送。")
    ctx["rows"] = rows


def node_render(ctx):
    if ctx["markdown"]:
        log.info("（--markdown 模式不需要图片，跳过渲染）")
        return
    ctx["img_path"] = render_image(ctx["rows"], ctx["date_str"])
    log.info("图片已生成: %s", ctx["img_path"])


def node_upload(ctx):
    if ctx["markdown"]:
        log.info("（--markdown 模式不需要图片，跳过上传）")
        return
    if not ctx.get("img_path") or not os.path.exists(ctx["img_path"]):
        # 单独跑 upload 时图片可能还没生成，这里补一次渲染
        ctx["img_path"] = render_image(ctx["rows"], ctx["date_str"])
        log.info("（upload 节点补渲染）图片已生成: %s", ctx["img_path"])
    try:
        ctx["img_url"] = upload_to_minio(ctx["img_path"], prefix="vp")
    except Exception as e:
        log.warning("MinIO 上传失败，send 节点将降级为钉钉图片附件: %s", e)
        ctx["img_url"] = None


def node_send(ctx):
    ids, missing = collect_at(ctx["rows"])
    if missing and not ctx["no_at"]:
        log.warning("以下站长未解析到 openDingTalkId，已跳过 @：%s", missing)
    gid = ctx.get("group_id") or GROUP_ID
    log.info("目标群: %s；将 @ 站长 openid: %s", gid, ids if not ctx["no_at"] else "（--no-at，不 @）")

    if ctx["no_send"]:
        log.info("(--no-send) 未实际发送。图片预览: %s", ctx.get("img_path") or "（未渲染）")
        return
    if ctx["markdown"]:
        send_markdown(ctx["rows"], ctx["date_str"], ctx["file_url"], ids,
                      no_at=ctx["no_at"], group_id=gid)
    else:
        send_image_markdown(ctx["rows"], ctx["date_str"], ctx["file_url"], ids,
                            no_at=ctx["no_at"], img_url=ctx.get("img_url"),
                            img_path=ctx.get("img_path"), group_id=gid)
    log.info("发送完成。")


for _n in NODES:
    _n["fn"] = {"download": node_download, "filter": node_filter,
                "render": node_render, "upload": node_upload,
                "send": node_send}[_n["id"]]


if __name__ == "__main__":
    import nodeflow
    try:
        todo, err = nodeflow.prepare(NODES)
        if err:
            log.error("✗ %s", err)
            sys.exit(1)

        # --begin/--end 已被 prepare 摘掉，这里看到的 argv 只剩业务参数
        ctx = {
            "no_send": "--no-send" in sys.argv,
            "markdown": "--markdown" in sys.argv,
            "no_at": "--no-at" in sys.argv,
            "img_url": None,
            "img_path": None,
        }
        # 可选：覆盖目标群（用于发到测试群验证）
        # 兼容两种传参形式：
        #   --group value        （独立参数）
        #   --group=value        （server server 的 build_cmd 用等号连写，单 argv 元素）
        for _i, _a in enumerate(sys.argv):
            if _a == "--group" and _i + 1 < len(sys.argv):
                GROUP_ID = sys.argv[_i + 1]   # 模块级：send_* 里读的就是它
                log.info("已覆盖目标群: %s", GROUP_ID)
                break
            if _a.startswith("--group="):
                GROUP_ID = _a.split("=", 1)[1]
                log.info("已覆盖目标群: %s", GROUP_ID)
                break

        sys.exit(nodeflow.execute(todo, ctx, title="[申诉]"))
    except Exception as e:
        log.exception("不满意单申诉提醒执行异常: %s", e)
        sys.exit(1)
