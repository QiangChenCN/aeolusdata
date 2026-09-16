#!/usr/bin/env python
# -*- coding: utf-8 -*-
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))  # 项目根（公共模块所在）
import venv_guard  # 自动切换至项目 .venv
"""站长任务看板（统一入口）

合并了原 `fetch_tasks.py`（拉取 + 筛 + 渲染）与 `send_task_board.py`（读 + 解析 openid + 发钉钉）
两个独立脚本，现在按 5 个**节点**串行执行：

  1. fetch    —— HTTP 拉取「已开始」站长任务（服务端 status=started 过滤）+ 落 task_list_raw.json
  2. filter   —— 筛选「已开始」+ 计算剩余时间；0 条则中止后续（不渲染、不发）
  3. render   —— 把已开始的清单渲染成 task_started.png（淘宝闪购橙主题）
  4. resolve  —— 从原始清单里抽执行人姓名 → 钉钉 openDingTalkId
                  （@ 占位符；未解析的跳过 @，日志里照记）
  5. send     —— 原图(PNG 无损)上传 MinIO 拿公网直链 → 组 markdown → 发钉钉 → @ 执行人

CLI（按节点组织）：
  python task_board.py                              # 跑全部 5 个节点（默认行为）
  python task_board.py --begin fetch --end render    # 只拉 + 筛 + 渲染图，不解析 / 不发
  python task_board.py --begin resolve --end send    # 复用磁盘上已有的图与 raw 重发
                                                        （不重拉、不重渲染）
  python task_board.py --no-at                       # 跑全部，但发钉钉时不 @ 执行人
  python task_board.py --dry-run                     # 同上但 send 节点不真发，只打印将发的 markdown
  python task_board.py --test                        # 测试模式：按群名「机器人测试」解析目标群，不 @ 真人
  python task_board.py --group <cid>                 # 直接指定钉钉群 cid（覆盖默认生产群）

节点区间选择：
  · `--begin` / `--end` 接收节点 id（fetch/filter/render/resolve/send）
  · 必须同时给出，end 不得早于 begin（nodeflow 校验）
  · 只跑 [begin, end] 内的节点（按声明顺序，跳过其余）
  · 任一节点失败：终止流水线并以非零退出（后续节点不再跑）
  · 子节点独立重入：begin=filter / begin=render / begin=resolve 时若 ctx 缺数据，
    会自动从 task_list_raw.json 重新加载；begin=send 时优先用 ctx 里 render 出的图，
    否则用磁盘上现存 task_started.png。

依赖：
  - aeolus_sdk（SSO cookie 复用 / 共享登录态）
  - ding_common（GROUP_ID / resolve_openids / dws_run / setup_logging）
  - minio_common（upload_to_minio，原图上传拿公网直链）
  - report_render.render_tasks（看板 PNG 渲染）
  - find_group（测试模式按群名解析 cid）
"""
import os, sys, json
from get_data import board
from aeolus_sdk import login as _aeolus_login
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))      # jobs/board
ROOT = os.path.dirname(os.path.dirname(BASE))          # 项目根（公共模块所在）
if ROOT not in sys.path:                                # venv_guard 已加，此处兜底
    sys.path.insert(0, ROOT)
OUT_DIR = os.path.join(BASE, "out")                    # 产物统一进 out/
os.makedirs(OUT_DIR, exist_ok=True)

RAW_PATH = os.path.join(OUT_DIR, "task_list_raw.json")
IMG_PATH = os.path.join(OUT_DIR, "task_started.png")
LOG_PATH = os.path.join(OUT_DIR, "task_board_send.log")

# 测试目标群名（运行时按群名动态解析，不写死 cid）
TEST_GROUP_QUERY = "机器人测试"

# ==================== 节点定义（单一事实来源）====================
# 顺序即流水线执行顺序；id 在 CLI 的 --begin / --end 中引用。
# fn 在下方「节点包装」段统一绑定（业务函数需要先定义）。
NODES = [
    {"id": "fetch",   "name": "拉取任务列表",    "desc": "HTTP 拉「已开始」站长任务（status=started 服务端过滤）+ 落 task_list_raw.json"},
    {"id": "filter",  "name": "筛选已开始",      "desc": "只留 status=已开始 + 计算剩余时间；0 条则中止后续"},
    {"id": "render",  "name": "渲染看板图",      "desc": "渲染 task_started.png（淘宝闪购橙主题）"},
    {"id": "resolve", "name": "解析站长 openid", "desc": "执行人姓名 → 钉钉 openDingTalkId（未解析的跳过 @）"},
    {"id": "send",    "name": "发送任务看板",    "desc": "原图传 MinIO + 组 markdown + 发钉钉 + @ 执行人"},
]


# ==================== 业务函数（按职责拆分）====================
# 取数单一来源见 get_data.board（fetch 在此，分页拉全量 + 服务端 status=started 过滤）。
# 本文件只做：站点循环 / 筛选已开始 / 计算剩余时间 / 渲染 / 解析 openid / 发送。

def calc_remaining(expire_str, now=None):
    """计算剩余时间，可读字符串。"""
    if not expire_str:
        return "无截止时间"
    try:
        expire_dt = datetime.strptime(expire_str, "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return "时间格式异常"
    if now is None:
        now = datetime.now()
    delta = expire_dt - now
    if delta.total_seconds() < 0:
        return "已过期"
    days = delta.days
    hours = delta.seconds // 3600
    minutes = (delta.seconds % 3600) // 60
    parts = []
    if days > 0:
        parts.append(f"{days}天")
    if hours > 0:
        parts.append(f"{hours}小时")
    if minutes > 0:
        parts.append(f"{minutes}分钟")
    return "".join(parts) if parts else "不足1分钟"


def filter_started(tasks):
    """筛 status=已开始，按剩余时间排序（已过期排最后）。"""
    now = datetime.now()
    started = []
    for t in tasks:
        if t.get("status") != "已开始":
            continue
        expire_str = t.get("taskExpireTime", "")
        started.append({
            "taskName": t.get("taskName", ""),
            "taskObject": t.get("taskObject", ""),
            "status": t.get("status", ""),
            "taskExpireTime": expire_str,
            "remaining": calc_remaining(expire_str, now),
            "executorName": t.get("executorName", ""),
            "priority": t.get("priority", ""),
        })

    def sort_key(x):
        if x["remaining"] == "已过期":
            return 999999
        try:
            dt = datetime.strptime(x["taskExpireTime"], "%Y-%m-%dT%H:%M:%S")
            return (dt - now).total_seconds()
        except Exception:
            return 999998

    started.sort(key=sort_key)
    return started


def render_image(tasks, output_path):
    """统一渲染（单一事实来源：report_render）。"""
    import report_render
    return report_render.render_tasks(tasks, out_path=output_path)


def load_raw():
    """从磁盘加载原始抓取数据。供子节点独立重入时使用。"""
    if not os.path.exists(RAW_PATH):
        raise FileNotFoundError(
            "未找到 task_list_raw.json，请先跑 fetch 节点（或全量跑）拉取。")
    with open(RAW_PATH, encoding="utf-8") as f:
        return json.load(f)


def extract_executor_names(tasks):
    """从 raw 里抽已开始任务的去重执行人集合（保留顺序）。"""
    names, seen = [], set()
    for t in tasks:
        if t.get("status") != "已开始":
            continue
        for n in (t.get("executorName") or "").split(","):
            n = n.strip()
            if n and n not in seen:
                seen.add(n)
                names.append(n)
    return names


# ==================== send 节点的发送逻辑 ====================
def build_markdown(resolved, missing, total, img_url):
    """构造一条 markdown：文字说明 + 内联图 + @ 占位符（同属一条消息）。

    关键踩坑：钉钉 markdown 内联图能否在查看器直接打开，**与图片大小/比例无关**，
    而与 markdown 里该图片 URL 是否被重复使用强相关 —— 若同一 URL 既作
    `![...](url)` 内联图、又作 `[下载](url)` 文字链接，钉钉会把整条 markdown
    降级为外链（点开跳浏览器）。故发送时**不附带下载地址**。
    """
    mentions = " ".join("<@%s>" % oid for _, oid in resolved)
    text = (
        "## 站长任务看板 · 进行中任务\n"
        "**当前共 %d 条「已开始」任务未完成**，请相关执行人及时跟进处理（明细见下图）：\n\n"
        "![站长任务看板-进行中任务](%s)\n"
        % (total, img_url)
    )
    text += "\n\n" + mentions
    return text


def do_upload(img_path):
    """上传 PNG 原图到 MinIO 拿公网直链（幂等）。"""
    from minio_common import upload_to_minio
    url = upload_to_minio(img_path, prefix="taskboard")
    log.info("图片已上传 MinIO: %s (%.0f KB)", url,
             os.path.getsize(img_path) / 1024)
    return url


def do_send(resolved, missing, total, img_url, group_id,
            dry_run=False, no_at=False):
    """向钉钉发送任务看板。不返回，失败抛异常。"""
    from ding_common import GROUP_ID, dws_run

    ids = [oid for _, oid in resolved]
    gid = group_id or GROUP_ID

    if dry_run:
        caption = build_markdown(resolved, missing, total,
                                 "(内联图片：发送时上传 MinIO 并填入公网直链)")
        log.info("[dry-run] markdown:\n%s", caption)
        return

    at_args = []
    if ids and not no_at:
        at_args = ["--at-open-dingtalk-ids", ",".join(ids)]

    log.info("目标群: %s", gid)
    log.info("将 @ %d 人: %s", len(resolved), "、".join(n for n, _ in resolved))
    if missing:
        log.warning("跳过 @（未解析到 openDingTalkId）: %s",
                    "、".join(sorted(missing)))

    caption = build_markdown(resolved, missing, total, img_url)
    args = ["chat", "message", "send", "--group", gid,
            "--text", caption, "--yes"] + at_args
    out, err, code = dws_run(args, label="发送任务看板(markdown内联图)")
    log.info("任务看板发送: code=%s %s", code, (out or err or "")[:200])
    log.info("任务看板发送完成。")


# ==================== CLI 解析 ====================
def parse_args():
    """解析 CLI，返回 (no_at, dry_run, test_mode, group_id)。

    注意：`--begin` / `--end` **不在这里解析**——它们属于节点区间，统一交给
    `nodeflow.prepare()` 处理（执行前从 sys.argv 里摘掉，避免两处重复解析）。
    """
    no_at = False
    dry_run = False
    test_mode = False
    group_id = None

    argv = list(sys.argv[1:])
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--no-at":
            no_at = True; i += 1; continue
        if a == "--dry-run":
            dry_run = True; i += 1; continue
        if a == "--test":
            # 测试模式：跳过 @；目标群由 resolve_test_group() 按群名解析
            test_mode = True; no_at = True; i += 1; continue
        if a == "--group" and i + 1 < len(argv):
            group_id = argv[i + 1]; i += 2; continue
        if a.startswith("--group="):
            group_id = a.split("=", 1)[1]; i += 1; continue
        # 已经摘掉 --begin/--end；剩下的就是未识别的
        print(f"✗ 未知参数：{a}")
        sys.exit(1)
    return no_at, dry_run, test_mode, group_id


def resolve_test_group():
    """按群名动态解析测试群 cid（不要写死）。"""
    from find_group import resolve_group_id
    try:
        gid, gtitle = resolve_group_id(TEST_GROUP_QUERY)
    except SystemExit as e:
        log.error("✗ %s", e)
        sys.exit(1)
    log.info("测试模式：按群名「%s」解析到群 %s (%s)，不 @ 真人",
             TEST_GROUP_QUERY, gtitle, gid)
    return gid


# ==================== 节点包装 ====================
# 每个节点函数独立运行；缺数据时自动从磁盘加载，便于子节点重入。
def node_fetch(ctx):
    cookie = _aeolus_login.ensure_cookies(_aeolus_login.COOKIE_FILE)[0]
    all_tasks = board.fetch(cookie)
    with open(RAW_PATH, "w", encoding="utf-8") as f:
        json.dump(all_tasks, f, ensure_ascii=False, indent=2)
    print(f"[save] raw data -> {RAW_PATH}", flush=True)
    ctx["all_tasks"] = all_tasks


def node_filter(ctx):
    if "all_tasks" not in ctx:
        ctx["all_tasks"] = load_raw()
    started = filter_started(ctx["all_tasks"])
    print(f"[filter] {len(started)} tasks with status=已开始", flush=True)
    if not started:
        raise nodeflow.Stop("没有进行中的任务，跳过渲染。")
    for t in started:
        print(f"  - {t['taskName']} | {t['taskObject']} | {t['remaining']} | {t['executorName']}",
              flush=True)
    ctx["started"] = started


def node_render(ctx):
    if "started" not in ctx:
        if "all_tasks" not in ctx:
            ctx["all_tasks"] = load_raw()
        ctx["started"] = filter_started(ctx["all_tasks"])
        if not ctx["started"]:
            raise nodeflow.Stop("task_list_raw.json 没有进行中任务，跳过渲染。")
    render_image(ctx["started"], IMG_PATH)
    ctx["img_path"] = IMG_PATH
    print(f"[render] -> {IMG_PATH}", flush=True)


def node_resolve(ctx):
    if "all_tasks" not in ctx:
        ctx["all_tasks"] = load_raw()
    names = extract_executor_names(ctx["all_tasks"])
    ctx["executor_names"] = names
    ctx["total_started"] = sum(
        1 for t in ctx["all_tasks"] if t.get("status") == "已开始")
    log.info("已开始任务 %d 条，涉及执行人 %d 人",
             ctx["total_started"], len(names))
    if ctx.get("test_mode"):
        # 测试群不 @ 真人
        ctx["resolved"], ctx["missing"] = [], set()
        return
    from ding_common import resolve_openids
    resolved, missing = resolve_openids(names)
    ctx["resolved"], ctx["missing"] = resolved, missing


def node_send(ctx):
    img_path = ctx.get("img_path") or IMG_PATH
    if not os.path.exists(img_path):
        raise FileNotFoundError(
            "未找到 %s，请先跑 render 节点（或全量跑）生成图片。" % img_path)
    log.info("已开始任务 %d 条，涉及执行人 %d 人（已解析 %d，缺失 %d）",
             ctx.get("total_started", 0),
             len(ctx.get("executor_names") or []),
             len(ctx.get("resolved") or []),
             len(ctx.get("missing") or set()))
    # 上传 → 发；do_upload/do_send 内部各自打日志
    img_url = do_upload(img_path)
    do_send(resolved=ctx.get("resolved") or [],
            missing=ctx.get("missing") or set(),
            total=ctx.get("total_started", 0),
            img_url=img_url,
            group_id=ctx.get("group_id"),
            dry_run=ctx.get("dry_run", False),
            no_at=ctx.get("no_at", False))


for _n in NODES:
    _n["fn"] = {
        "fetch":   node_fetch,
        "filter":  node_filter,
        "render":  node_render,
        "resolve": node_resolve,
        "send":    node_send,
    }[_n["id"]]


# ==================== 入口 ====================
def main():
    import nodeflow

    # 先摘 --begin / --end 并校验区间，再解析业务参数
    # （顺序反了的话 parse_args 会把 --begin 当未知参数报错退出）
    todo, err = nodeflow.prepare(NODES)
    if err:
        print("✗ " + err)
        sys.exit(1)

    no_at, dry_run, test_mode, group_id = parse_args()

    if test_mode:
        group_id = resolve_test_group()

    ctx = {
        "no_at": no_at,
        "dry_run": dry_run,
        "test_mode": test_mode,
        "group_id": group_id,
    }

    code = nodeflow.execute(todo, ctx, title="[任务看板]")
    if code == 0:
        print("\n✓ 站长任务看板流水线完成")
    sys.exit(code)


# 日志必须在 main() / 节点函数可见前就绪；放到模块顶层，import 时即生效。
from ding_common import setup_logging
log = setup_logging("task_board", LOG_PATH)


if __name__ == "__main__":
    main()
