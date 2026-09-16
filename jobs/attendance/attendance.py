#!/usr/bin/env python
# -*- coding: utf-8 -*-
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))  # 项目根（公共模块所在）
import venv_guard  # 自动切换至项目 .venv
"""实时在线播报（统一入口）

合并了原 `attendance_all_teams.py`（拉取实时在线 + 出图）与 `send_attendance.py`
（上传 MinIO + 钉钉发送）两个独立脚本，现在按 4 个**节点**串行执行：

  1. fetch   —— 拉取**全部站点**（运行时调接口动态获取，不写死）当前时段的实时在线
               + 写 raw / summary JSON
  2. render  —— 把 summary JSON 渲染成 PNG 明细图（attendance_absent.png）
  3. upload  —— 把 PNG 上传到 MinIO，拿到公网直链（供 markdown 内联图）
  4. send    —— 组装 markdown + 发钉钉群（默认 @站长）

**只看当前时段**：时段由脚本内部按本地时间自动判断（参见 TIME_SLOTS /
current_time_slot），不再暴露 `--code` 让用户手动选择——实时在线的本质就是当下。

CLI（按节点组织）：
  python attendance.py                                # 跑全部 4 个节点（默认行为）
  python attendance.py --begin fetch --end render      # 只拉 + 出图，不传不发钉钉
  python attendance.py --begin upload --end send        # 在已有 attendance_absent.png 的前提下
                                                       # 传 MinIO + 发钉钉（相当于原 send_attendance.py）
  python attendance.py --no-at                         # 跑全部，但发钉钉时不 @ 站长
  python attendance.py --test                          # 测试模式（自动切「机器人测试」群，且不 @ 真人）
  python attendance.py --group-name <群名>              # 指定目标群（按群名解析，不用记 cid）
  python attendance.py --teams 917521130,917521136       # 只跑指定站点（不给则动态取全部）

节点区间选择：
  · `--begin` / `--end` 接收节点 id（fetch / render / upload / send）
  · 必须同时给出，end 不得早于 begin（否则非零退出）
  · 只跑 [begin, end] 内的节点（按声明顺序，跳过其余）
  · 任一节点失败：终止流水线并以非零退出（后续节点不再跑）
"""
import os, sys, json, datetime, concurrent.futures, urllib.request
# 「实时考勤取数」只由 get_data.attendance.fetch_team 负责（打接口）；
# 统计 / 筛选 / 格式化等加工本就是本任务脚本的职责，定义于下方「本地处理」段。
from get_data.attendance import fetch_team

# ==================== 本地处理（统计 / 筛选 / 格式化）====================
# 这些不是「取数」，是对 fetch_team 返回原始数据的加工，故放在任务脚本内；
# get_data 每个模块只做「打对应接口取数」一件事（见工作区永久记忆 get_data 约定）。
REST_STATES = {2}        # 小休（暂离）
OFFLINE_STATES = {3}     # 下线（未在线装备）
DETAIL_STATES = {2, 3}   # 明细「不在线」范围：小休(2) + 下线(3)
STATE_LABEL = {2: "小休", 3: "下线"}


def fmt_duration(sec):
    if not sec or sec == 0:
        return "0"
    h = sec // 3600
    m = (sec % 3600) // 60
    return f"{h}h{m}m" if h > 0 else f"{m}m"


def fmt_rate(online, sched):
    """在线率：最多2位小数四舍五入；整数则按整数展示。"""
    if not sched:
        return "0"
    r = round(online * 100 / sched, 2)
    if r == int(r):
        return str(int(r))
    return ("%.2f" % r).rstrip("0").rstrip(".")


def team_stats(data, query_code):
    """单站点统计 → (排班, 在线, 下线, 小休, 下线背单, 小休背单)。"""
    riders = data["result"]["data"]
    sched = [r for r in riders if query_code in (r.get("timeCode") or [])]
    online = [r for r in sched
              if r.get("workStatus") not in REST_STATES
              and r.get("workStatus") not in OFFLINE_STATES]
    offline = [r for r in sched if r.get("workStatus") in OFFLINE_STATES]
    rest = [r for r in sched if r.get("workStatus") in REST_STATES]
    off_deliv = [r for r in offline if (r.get("deliveryOrder") or 0) > 0]
    rest_deliv = [r for r in rest if (r.get("deliveryOrder") or 0) > 0]
    return len(sched), len(online), len(offline), len(rest), len(off_deliv), len(rest_deliv)


def filter_detail(data, query_code, site_name, team_id):
    """从不在线骑手里抽出明细行（供渲染图片 / 钉钉 @ 用）。"""
    riders = data["result"]["data"]
    rows = []
    for r in riders:
        if query_code not in (r.get("timeCode") or []):
            continue
        ws = r.get("workStatus")
        if ws not in DETAIL_STATES:
            continue
        is_rest = ws in REST_STATES
        slot_valid = "0" if is_rest else fmt_duration(r.get("timeValidOnlineTime", 0))
        full_valid = "0" if is_rest else fmt_duration(r.get("fullDayValidOnlineTime", 0))
        rows.append({
            "knightName": r["knightName"],
            "site": site_name,
            "state": STATE_LABEL.get(ws, str(ws)),
            "delivering": r.get("deliveryOrder", 0) or 0,
            "slotFinish": r.get("timeFinishOrder", 0) or 0,
            "slotValid": slot_valid,
            "fullFinish": r.get("fullDayFinishOrder", 0) or 0,
            "fullValid": full_valid,
        })
    return rows

BASE = os.path.dirname(os.path.abspath(__file__))      # jobs/attendance
ROOT = os.path.dirname(os.path.dirname(BASE))          # 项目根（公共模块所在）
if ROOT not in sys.path:                                # venv_guard 已加，此处兜底
    sys.path.insert(0, ROOT)
OUT_DIR = os.path.join(BASE, "out")                    # 产物统一进 out/（惰性创建，见 save_last_teams / run_fetch，不在导入期创建以避免 import 副作用）

RAW_DIR = os.path.join(OUT_DIR, "attendance_raw")
IMG_PATH = os.path.join(OUT_DIR, "attendance_absent.png")
SUMMARY_PATH = os.path.join(OUT_DIR, "attendance_summary.json")
# 「上次选择的站点」持久化文件：格式 `id=名称,id=名称,...`
# 2026-09-08：站点列表只在界面展开多选下拉时拉一次，跑任务时不再打站点接口。
# 所以命令行不带 --teams 时，沿用这个文件里记录的上次选择。
LAST_TEAMS_FILE = os.path.join(OUT_DIR, "last_teams.txt")

# 测试模式（--test）按群名动态解析目标群，不写死 cid
TEST_GROUP_QUERY = "机器人测试"

# ==================== 节点定义（单一事实来源）====================
# 顺序即流水线执行顺序；id 在 CLI 的 --begin / --end 中引用。
# fn 在下方「节点包装」段统一绑定（因为要先定义 run_*，这里引用不到）。
NODES = [
    {"id": "fetch",  "name": "拉取实时考勤",     "desc": "HTTP 拉取全部站点实时考勤 + 写 raw / summary JSON（站点动态获取，不写死）"},
    {"id": "render", "name": "渲染图片",         "desc": "把 summary JSON 渲染成 attendance_absent.png"},
    {"id": "upload", "name": "上传图片到MinIO",  "desc": "PNG 上传 MinIO 拿公网直链（供 markdown 内联图）"},
    {"id": "send",   "name": "发送消息到钉钉",   "desc": "组装 markdown 并发送（默认发生产群 + @站长）"},
]

# ==================== 站点（团队）列表 ====================
# 站点**不写死**：运行时调 TEAMS_API 动态取当前账号可见的全部站点（见 fetch_teams）。
# 该接口从 r.ele.me 排班页（schedule.html）的 JS bundle 里逆向得到，
# 返回字段用 `id`（= teamId）+ `team_name` + `teamStatus`。
# 下面这份只是**兜底**：接口挂了/拿不到时才顶上，保证任务不至于直接失败，
# 并在日志里打醒目提示。新增站点无需改代码。
TEAMS_API = "https://httpizza.ele.me/xtop/xtop.lpd.intelligentConfig.getTeamsAll/1.0"
FALLBACK_TEAMS = [
    (917521130, "东莞市黄江镇站-UB"),
    (917521136, "东莞市长安万科站-UB"),
    (917521139, "东莞市大岭山大学城站-UB"),
]
TEAMS = FALLBACK_TEAMS      # 兼容旧引用（等价于兜底清单）

# ==================== 时段映射（含区间）====================
TIME_SLOTS = [
    (datetime.time(0, 0), 100, "凌晨1", "00:00-06:00"),
    (datetime.time(6, 0), 111, "早餐1", "06:00-08:00"),
    (datetime.time(8, 0), 112, "早餐2", "08:00-10:30"),
    (datetime.time(10, 30), 120, "午高峰", "10:30-13:30"),
    (datetime.time(13, 30), 130, "下午茶1", "13:30-15:30"),
    (datetime.time(15, 30), 131, "下午茶2", "15:30-17:30"),
    (datetime.time(17, 30), 140, "晚高峰", "17:30-20:00"),
    (datetime.time(20, 0), 150, "夜宵1", "20:00-22:00"),
    (datetime.time(22, 0), 151, "夜宵2", "22:00-24:00"),
]

# 注意：实时考勤「取数」由 get_data.attendance.fetch_team 负责（只打接口）；
# 本文件顶部的「本地处理」段定义了统计/筛选/格式化（team_stats / filter_detail / fmt_* / STATE 常量），
# 这些是任务脚本对原始数据的加工，不放在 get_data 内（见工作区永久记忆 get_data 约定）。
# 本文件只留任务编排相关：节点定义、CLI、站点兜底清单、last_teams 持久化、钉钉发送。


# ==================== fetch 节点：拉取实时在线 ====================
def current_time_slot(now=None):
    if now is None:
        now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    t = now.time()
    selected = TIME_SLOTS[0]
    for start_time, code, name, rng in TIME_SLOTS:
        if t >= start_time:
            selected = (start_time, code, name, rng)
        else:
            break
    return selected[1], selected[2], selected[3]


# fetch_team 由 get_data.attendance 提供；team_stats / filter_detail / fmt_* 定义于本文件「本地处理」段。

def load_last_teams():
    """读「上次使用的站点」→ [(id, name), ...]；文件不存在 / 为空 / 损坏 → []。"""
    if not os.path.exists(LAST_TEAMS_FILE):
        return []
    try:
        with open(LAST_TEAMS_FILE, encoding="utf-8") as f:
            s = f.read().strip()
    except OSError as e:
        print(f"  ⚠ 读取上次站点记录失败：{e}")
        return []
    if not s:
        return []
    try:
        return parse_teams_arg(s)
    except SystemExit:
        return []


def save_last_teams(items):
    """把本次实际使用的站点写回 `last_teams.txt`，供下次「沿用上次」用。

    写失败只警告不抛——记录文件是便利性功能，不该拖垮出数流程。
    """
    try:
        os.makedirs(OUT_DIR, exist_ok=True)            # 惰性创建产物目录（替代原导入期 makedirs，消除 import 副作用）
        with open(LAST_TEAMS_FILE, "w", encoding="utf-8") as f:
            f.write(",".join(f"{tid}={nm}" for tid, nm in items))
    except OSError as e:
        print(f"  ⚠ 写入上次站点记录失败：{e}")


def _fill_team_names(items):
    """命令行只给了纯 ID 时，用本地记录把 name 从「ID」补回真名（**不联网**）。

    界面多选下拉传的是 `id=名称` 串，这里直接原样返回（零开销）。
    只有在命令行手敲纯 ID 时才会走到补全分支，名字来源是
    `last_teams.txt`（上次用过的站点）+ 内置兜底清单；查不到就保留 ID 并提示。

    2026-09-08：这里原来会调 `fetch_teams()` 打站点接口，已改为不联网——
    站点列表统一由界面在展开下拉时拉一次，跑任务时不再重复请求。
    """
    need = [tid for tid, nm in items if str(nm) == str(tid)]
    if not need:
        return items
    mapping = {}
    for tid, nm in FALLBACK_TEAMS:                 # 先垫兜底清单
        mapping[tid] = nm
    for tid, nm in load_last_teams():              # 上次记录优先覆盖
        mapping[tid] = nm
    out = []
    for tid, nm in items:
        real = mapping.get(tid) or mapping.get(str(tid))
        out.append((tid, real or nm))
    still = [t for t, n in out if str(n) == str(t)]
    if still:
        print(f"  ⚠ 有 {len(still)} 个站点 ID 查不到名字（图片上会显示 ID）：{still}")
        print(f"     在界面上重新勾选一次站点，即可把名称写入 {LAST_TEAMS_FILE}")
    return out


def run_fetch(team_arg=None):
    """拉取节点：返回 (all_rows, query_code, query_name, range_str, team_items, stats)。

    时段固定走 `current_time_slot()`（仅看当下，不接受外部传入 code）。

    站点来源优先级：`team_arg`（界面勾选 / 命令行 --teams）> 上次选择 > 内置兜底清单。

    2026-09-08：**这里不再打站点列表接口**。站点清单由界面在展开多选下拉时拉
    一次（`GET /api/teams`），跑任务阶段只做取数，避免每跑一次多一个网络往返。
    """
    from aeolus_sdk import login as L

    query_code, query_name, range_str = current_time_slot()
    cookie, _ = L.ensure_cookies()

    if team_arg:
        team_items = _fill_team_names(team_arg)
        print(f"[fetch] 站点来源：界面勾选 / 命令行指定，共 {len(team_items)} 个")
    else:
        team_items = load_last_teams()
        if team_items:
            print(f"[fetch] 站点来源：沿用上次选择（{LAST_TEAMS_FILE}），共 {len(team_items)} 个")
        else:
            team_items = FALLBACK_TEAMS
            print("  ⚠ 没有上次选择记录，回落内置兜底清单"
                  f"（{len(team_items)} 个，可能已过期）")

    save_last_teams(team_items)     # 本次用的站点写回，下次「沿用上次」取它

    os.makedirs(RAW_DIR, exist_ok=True)
    print(f"[fetch] 时段：{query_name}（{query_code}，{range_str}），站点 {len(team_items)} 个：")
    for tid, nm in team_items:
        print(f"    - {nm} ({tid})")

    def worker(item):
        team_id, name = item
        try:
            data = fetch_team(team_id, query_code, cookie)
        except Exception:
            try:
                cookie2 = L.get_cookies()
                data = fetch_team(team_id, query_code, cookie2)
            except Exception as e2:
                return (team_id, name, None, str(e2))
        return (team_id, name, data, None)

    all_rows = []
    stats = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(team_items)) as ex:
        for team_id, name, data, err in ex.map(worker, team_items):
            if err:
                print(f"  ✗ [{name}] 查询失败：{err}")
                continue
            st = team_stats(data, query_code)
            stats[team_id] = st
            rows = filter_detail(data, query_code, name, team_id)
            print(f"  [{name}] 排班 {st[0]} | 在线 {st[1]} | 在线率 "
                  f"{fmt_rate(st[1], st[0])}% | 小休 {st[3]} | 下线 {st[2]} | "
                  f"下线背单 {st[4]} | 小休背单 {st[5]} | 明细 {len(rows)} 人")
            for r in rows:
                print(f"    - {r['knightName']} 状态={r['state']} 配送中={r['delivering']} 本时段完成={r['slotFinish']} 本时段有效在线={r['slotValid']}")
            all_rows.extend(rows)
            raw_path = os.path.join(RAW_DIR, f"team_{team_id}_{query_code}.json")
            with open(raw_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"[fetch] 汇总：明细 {len(all_rows)} 人（小休+下线）")

    # 导出结构化汇总，供后续 render / send 节点使用
    t_sched = t_online = t_rest = t_offline = t_off_deliv = t_rest_deliv = 0
    teams_summary = []
    for team_id, name in team_items:
        if team_id not in stats:
            continue
        sched, online, offline, rest, off_deliv, rest_deliv = stats[team_id]
        rate = fmt_rate(online, sched)
        cnt = sum(1 for r in all_rows if r["site"] == name)
        teams_summary.append({
            "team_id": team_id, "name": name,
            "sched": sched, "online": online, "rate": rate,
            "offline": offline, "rest": rest,
            "offline_deliv": off_deliv, "rest_deliv": rest_deliv,
            "detail_count": cnt,
        })
        t_sched += sched; t_online += online; t_rest += rest; t_offline += offline
        t_off_deliv += off_deliv; t_rest_deliv += rest_deliv
    t_rate = fmt_rate(t_online, t_sched)
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    summary = {
        "query_time": now_str,
        "slot_code": query_code, "slot_name": query_name, "slot_range": range_str,
        "teams": teams_summary,
        "total": {
            "sched": t_sched, "online": t_online, "rate": t_rate,
            "offline": t_offline, "rest": t_rest,
            "offline_deliv": t_off_deliv, "rest_deliv": t_rest_deliv,
            "detail_count": len(all_rows),
        },
    }
    with open(SUMMARY_PATH, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"[fetch] summary 已落盘：{SUMMARY_PATH}")
    return all_rows, query_code, query_name, range_str, team_items, stats


# ==================== render 节点：渲染图片 ====================
def run_render():
    """渲染节点：读取 summary JSON，输出 attendance_absent.png。"""
    import report_render
    if not os.path.exists(SUMMARY_PATH):
        print(f"✗ 找不到汇总：{SUMMARY_PATH}；请先跑 fetch 节点（python attendance.py --begin fetch --end render）")
        sys.exit(1)
    with open(SUMMARY_PATH, "r", encoding="utf-8") as f:
        summary = json.load(f)

    # 重建 stats 与 all_rows（render 节点可能单独跑，所以从磁盘恢复而不是依赖 fetch 的返回值）
    query_name = summary["slot_name"]
    range_str = summary["slot_range"]
    teams_summary = summary.get("teams") or []
    team_items = [(t["team_id"], t["name"]) for t in teams_summary]
    stats = {t["team_id"]: (t["sched"], t["online"], t["offline"], t["rest"],
                            t["offline_deliv"], t["rest_deliv"])
             for t in teams_summary}

    # 重建 all_rows：从 attendance_raw/ 重新解析
    import glob
    all_rows = []
    slot_code = summary.get("slot_code")
    for tid, name in team_items:
        raw_path = os.path.join(RAW_DIR, f"team_{tid}_{slot_code}.json")
        if not os.path.isfile(raw_path):
            continue
        with open(raw_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        all_rows.extend(filter_detail(data, slot_code, name, tid))

    print(f"[render] 节点数：{len(all_rows)} | 站点数：{len(team_items)}")
    path = report_render.render_all_teams(
        all_rows, query_name, range_str, team_items, stats, out_path=IMG_PATH)
    print(f"[render] PNG 已生成：{path}")
    return path


# ==================== upload 节点：上传 MinIO ====================
def run_upload():
    """上传节点：把 PNG 传到 MinIO 拿公网直链，返回 URL。"""
    from minio_common import upload_to_minio
    if not os.path.exists(IMG_PATH):
        print(f"✗ 找不到图片：{IMG_PATH}；先跑 render 节点")
        sys.exit(1)
    img_url = upload_to_minio(IMG_PATH, prefix="attendance")
    print(f"[upload] 图片已上传：{img_url}")
    return img_url


# ==================== send 节点：发钉钉 ====================
def build_markdown(summary, img_url, mentions):
    slot = summary["slot_name"]
    rng = summary["slot_range"]
    qtime = summary["query_time"]
    tot = summary["total"]

    lines = []
    lines.append("## 实时在线")
    lines.append("**时段：** %s（%s）　**查询时间：** %s\n" % (slot, rng, qtime))
    lines.append("![实时在线明细](%s)\n" % img_url)
    lines.append("请各站长关注当前时段有排班但未在线的人员（共 %d 人）：%s"
                 % (tot["detail_count"], mentions))
    return "\n".join(lines)


def run_send(group_id, no_at):
    """发送节点：组装 markdown 并发钉钉群（默认发生产群 + @站长）。"""
    from ding_common import GROUP_ID, ALL_MANAGER_IDS, dws
    from find_group import resolve_group_id

    # 未显式指定群 → 回落 ding_common.GROUP_ID（生产群），与 task_board / appeal_reminder 行为一致。
    # 不静默发：打印醒目提示，让人在消息出去之前就知道落到哪个群。
    if group_id is None:
        group_id = GROUP_ID
        print("⚠ 未指定 --group / --group-name，回落到默认群 %s（生产）" % GROUP_ID)
        print("  试跑请加 --test（自动切「%s」群且不 @ 真人）" % TEST_GROUP_QUERY)

    if not os.path.exists(IMG_PATH):
        print(f"✗ 找不到图片：{IMG_PATH}；先跑 render 节点")
        sys.exit(1)
    if not os.path.exists(SUMMARY_PATH):
        print(f"✗ 找不到汇总：{SUMMARY_PATH}；先跑 fetch 节点")
        sys.exit(1)

    summary = json.load(open(SUMMARY_PATH, encoding="utf-8"))

    # send 节点自己负责上传（兼容单独跑 send 时图片已存在但 URL 未生成的情况）
    img_url = run_upload()

    ids = [] if no_at else ALL_MANAGER_IDS
    mentions = " ".join("<@%s>" % i for i in ids) if ids else ""
    text = build_markdown(summary, img_url, mentions)
    args = ["chat", "message", "send", "--group", group_id, "--text", text, "--yes"]
    if ids:
        args += ["--at-open-dingtalk-ids", ",".join(ids)]
    try:
        out, err, code = dws(args)
    except RuntimeError as e:
        print("✗ 钉钉发送失败:", e)
        sys.exit(1)
    print(f"[send] 消息发送：code={code} {(out or err)[:300]}")


# ==================== CLI 解析 ====================
def parse_args():
    """解析 CLI，返回 (group_id, no_at, test_mode, teams)。

    时段不可手动指定——由 `current_time_slot()` 按本地时间自动判断；
    本函数仅承担节点区间外的业务参数。

    `--teams` 可手动圈定站点（`917521130,917521136` 或 `917521130=黄江,917521136=万科`），
    不给则运行时调接口动态取全部站点（见 run_fetch）。

    注意：`--begin` / `--end` **不在这里解析**——它们属于节点区间，统一交给
    `nodeflow.run()` 处理（会在执行前从 sys.argv 里摘掉，避免两处重复解析）。
    """
    group_id = None
    no_at = False
    test_mode = False
    teams = None

    argv = list(sys.argv[1:])
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--group" and i + 1 < len(argv):
            group_id = argv[i + 1]; i += 2; continue
        if a.startswith("--group="):
            group_id = a.split("=", 1)[1]; i += 1; continue
        if a == "--group-name" and i + 1 < len(argv):
            name = argv[i + 1]; i += 2
            gid, gtitle = resolve_group_id_safe(name)
            group_id = gid
            print(f"[send] 按群名「{name}」解析到群：{gtitle} ({gid})")
            continue
        if a.startswith("--group-name="):
            name = a.split("=", 1)[1]; i += 1
            gid, gtitle = resolve_group_id_safe(name)
            group_id = gid
            print(f"[send] 按群名「{name}」解析到群：{gtitle} ({gid})")
            continue
        if a == "--teams" and i + 1 < len(argv):
            teams = parse_teams_arg(argv[i + 1]); i += 2; continue
        if a.startswith("--teams="):
            teams = parse_teams_arg(a.split("=", 1)[1]); i += 1; continue
        if a == "--no-at":
            no_at = True; i += 1; continue
        if a == "--test":
            test_mode = True; no_at = True; i += 1; continue
        print(f"✗ 未知参数：{a}")
        sys.exit(1)
    return group_id, no_at, test_mode, teams


def parse_teams_arg(s):
    """`917521130,917521136` 或 `917521130=黄江,917521136=万科` → [(id, name), ...]。"""
    out = []
    for part in (s or "").split(","):
        part = part.strip()
        if not part:
            continue
        if "=" in part:
            tid, name = part.split("=", 1)
            out.append((int(tid.strip()), name.strip()))
        elif "：" in part:
            tid, name = part.split("：", 1)
            out.append((int(tid.strip()), name.strip()))
        else:
            out.append((int(part), part))   # 只给 ID 时，名字就用 ID 顶着
    if not out:
        print("✗ --teams 没解析到任何站点")
        sys.exit(1)
    return out


def resolve_group_id_safe(name):
    from find_group import resolve_group_id
    try:
        return resolve_group_id(name)
    except SystemExit as e:
        print("✗", e)
        sys.exit(1)


def resolve_test_group():
    """--test 时按群名动态解析测试群 cid（不要写死）。"""
    gid, gtitle = resolve_group_id_safe(TEST_GROUP_QUERY)
    print("[send] 测试模式：按群名「%s」解析到群 %s (%s)，不 @ 真人"
          % (TEST_GROUP_QUERY, gtitle, gid))
    return gid


# ==================== 节点包装 + 主流程 ====================
# 把业务函数包成 nodeflow 约定的 fn(ctx)，节点间通过 ctx 传产物。
def node_fetch(ctx):
    ctx["summary"] = run_fetch(ctx.get("teams"))


def node_render(ctx):
    ctx["img_path"] = run_render()


def node_upload(ctx):
    ctx["img_url"] = run_upload()


def node_send(ctx):
    run_send(ctx["group_id"], ctx["no_at"])


for _n in NODES:
    _n["fn"] = {"fetch": node_fetch, "render": node_render,
                "upload": node_upload, "send": node_send}[_n["id"]]


def main():
    import nodeflow

    # 先摘掉 --begin / --end 并校验区间，再解析业务参数
    # （顺序反了的话 parse_args 会把 --begin 当未知参数报错退出）
    todo, err = nodeflow.prepare(NODES)
    if err:
        print("✗ " + err)
        sys.exit(1)

    code, group_id, no_at, test_mode = None, None, False, False
    group_id, no_at, test_mode, teams = parse_args()

    if test_mode:
        group_id = resolve_test_group()

    ctx = {"group_id": group_id,
           "no_at": no_at, "test": test_mode, "teams": teams}

    code = nodeflow.execute(todo, ctx, title="[实时在线]")
    if code == 0:
        print("\n✓ 实时在线播报完成")
    sys.exit(code)


if __name__ == "__main__":
    main()