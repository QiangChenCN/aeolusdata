#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把各脚本里的 NODES 定义同步进 server/tasks.json。

为什么要有这个脚本
------------------
「执行节点」的单一事实来源是**脚本源码里的 NODES**（见 nodeflow.py）。
如果 tasks.json 里的 nodes 靠手抄，改了脚本忘了改 JSON，界面上点的范围
就和实际跑的不一致了。这个脚本用 AST 从源码只读地提取节点定义，再写回
tasks.json，从机制上杜绝两边漂移。

用法
----
    python tools/sync_nodes.py          # 打印将要发生的变更
    python tools/sync_nodes.py --write  # 真正写入 tasks.json

新增脚本时：在下面的 SRC 里加一行即可（var = 源码里的节点变量名）。

强制约束
--------
**tasks.json 里的每个任务都必须节点化** —— 没有 nodes 的任务会被列进
「未节点化」并以退出码 1 结束，提醒你补。这条是硬约束，不靠人记：
新增任务 = 脚本里声明 NODES + 在 SRC 里登记一行。
（SDK 自带的诊断入口如 `python -m aeolus_sdk.login` 不是任务，不在此列。）
"""
import ast
import io
import json
import os
import sys

# 本文件位于 tools/ 下；项目根 = tools 的父目录。
BASE = os.path.dirname(os.path.abspath(__file__))          # tools/
PROJ_ROOT = os.path.dirname(BASE)                          # 项目根
TASKS_JSON = os.path.join(PROJ_ROOT, "server", "tasks.json")

# task_id -> (脚本相对路径, 源码里的节点变量名, 默认结束节点 id)
# 默认结束节点一般是末节点（None = 用末节点）；个别脚本末节点是排查用的，
# 默认不该跑，这里显式指定。
SRC = {
    "attendance":      ("jobs/attendance/attendance.py",               "NODES",       None),
    "appeal_reminder": ("jobs/appeal/appeal_reminder.py",          "NODES",       None),
    "task_board":     ("jobs/board/task_board.py",               "NODES",       None),
    "task_equipment": ("jobs/equipment/task_equipment.py",           "NODES",       None),
    "jidan_fetch":     ("jobs/rush/fetch_jidan.py",              "NODES",       None),
    "delivery_csv":    ("jobs/delivery/download_delivery.py",        "NODES",       None),
    "delivery_raw":    ("jobs/delivery/fetch_delivery_raw.py",       "NODES",       None),
    # 一个脚本三种模式，各自一套节点
    "delivery_init":   ("jobs/delivery/load_delivery_db.py",         "NODES_INIT",  None),
    "delivery_load":   ("jobs/delivery/load_delivery_db.py",         "NODES_LOAD",  None),
    "delivery_verify": ("jobs/delivery/load_delivery_db.py",         "NODES_VERIFY", None),
    "rule_doc":        ("jobs/ruledoc/gen_rule_doc.py",             "NODES",       None),
    "orange_storm":    ("jobs/orange_storm/fetch_orange_storm.py",  "NODES",       None),
    # 包内两个子命令，各自一套节点
    "unsat_run":       ("jobs/unsat/main.py",    "NODES_RUN",   None),
    "unsat_remind":    ("jobs/unsat/main.py",    "NODES_REMIND", None),
}
# 注意：aeolus_sdk/login.py 是 SDK 自带的诊断入口，**不是任务**，不参与节点化。
# 登录诊断请直接跑 python -m aeolus_sdk.login。


class NodeExtractError(Exception):
    """AST 提取节点失败（如源文件语法错误）。"""


def extract_nodes(path, varname):
    """用 AST 从源码里只读地取出 NODES 字面量 -> [{"id","name","desc"}]。

    用 AST 而不是 import，是因为有些脚本 import 时就有副作用
    （建日志目录、连库、切 venv），同步配置不该触发这些。
    """
    with io.open(path, encoding="utf-8") as f:
        src = f.read()
    try:
        tree = ast.parse(src, filename=path)
    except SyntaxError as e:
        raise NodeExtractError("语法错误：%s（line %d）" % (e.msg, e.lineno))

    # 收集所有同名赋值（按源码行号），取最后一次（支持 reassign / 条件构造）
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id == varname:
                    found.append((getattr(node, "lineno", 0), node.value))
                    break
    if not found:
        return None
    found.sort(key=lambda x: x[0])
    target = found[-1][1]

    if not isinstance(target, ast.List):
        return None

    out = []
    for el in target.elts:
        if not isinstance(el, ast.Dict):
            continue
        d = {}
        for k, v in zip(el.keys, el.values):
            if isinstance(k, ast.Constant) and isinstance(v, ast.Constant):
                d[k.value] = v.value
        if "id" in d:
            out.append({
                "id": d["id"],
                "name": d.get("name") or d["id"],
                "desc": d.get("desc") or "",
            })
    return out or None


# 日期参数的规范形态。历史上有 3 个脚本的日期参数就叫 --start/--end，
# 和节点区间的 --end 撞名，统一改名成 --start-date/--end-date（脚本侧
# 已同步，并有 reject_legacy_date_args() 友好拦截旧写法）。
DATE_SPEC = {
    "--start-date": {"label": "开始日期", "placeholder": "与 --end-date 搭配"},
    "--end-date":   {"label": "结束日期", "placeholder": "与 --start-date 搭配"},
}
DATE_ALIAS = {"--start": "--start-date", "--end": "--end-date"}


def normalize_date_params(task):
    """把日期参数规整成 --start-date/--end-date，和节点参数区分开。

    识别依据：节点参数一定带 options_source == "nodes"；不带的就是日期参数。
    少了这一步，将来重建任务时 --end 会被当成节点参数，日期输入就丢了。
    """
    fixed = []
    for p in task.get("params", []):
        flag = p.get("flag")
        if p.get("options_source") == "nodes":
            # 节点参数：清掉历史遗留的 placeholder（那是日期参数的说法）
            if p.get("placeholder"):
                p["placeholder"] = ""
                fixed.append("%s 清理 placeholder" % flag)
            continue
        new_flag = DATE_ALIAS.get(flag)
        if not new_flag:
            continue
        p["flag"] = new_flag
        p["type"] = "text"
        p["label"] = DATE_SPEC[new_flag]["label"]
        p["placeholder"] = DATE_SPEC[new_flag]["placeholder"]
        p.setdefault("default", "")
        fixed.append("%s -> %s" % (flag, new_flag))
    return fixed


def ensure_range_params(task, nodes, default_end):
    """保证任务带 --begin / --end 两个 select（选项由 nodes 派生）。"""
    begin_id = nodes[0]["id"]
    end_id = default_end or nodes[-1]["id"]

    params = task.setdefault("params", [])
    spec = {
        "--begin": {"flag": "--begin", "label": "开始节点", "type": "select",
                    "default": begin_id, "options_source": "nodes", "options": []},
        "--end":   {"flag": "--end",   "label": "结束节点", "type": "select",
                    "default": end_id, "options_source": "nodes", "options": []},
    }
    for flag, tmpl in spec.items():
        found = False
        for p in params:
            if p.get("flag") == flag:
                found = True
                p["type"] = "select"
                p["label"] = tmpl["label"]
                p["default"] = tmpl["default"]
                p["options_source"] = "nodes"
                p.setdefault("options", [])
                break
        if not found:
            params.append(dict(tmpl))


def main():
    write = "--write" in sys.argv
    with io.open(TASKS_JSON, encoding="utf-8") as f:
        reg = json.load(f)

    by_id = {t["id"]: t for t in reg["tasks"]}
    changed, missing = [], []

    for task_id, (rel, varname, default_end) in SRC.items():
        task = by_id.get(task_id)
        if task is None:
            missing.append("tasks.json 里没有任务 %s" % task_id)
            continue
        path = os.path.join(PROJ_ROOT, rel)
        if not os.path.exists(path):
            missing.append("脚本不存在：%s" % rel)
            continue
        try:
            nodes = extract_nodes(path, varname)
        except NodeExtractError as e:
            missing.append("%s: %s" % (rel, e))
            continue
        if not nodes:
            missing.append("%s 里没找到 %s" % (rel, varname))
            continue

        old = task.get("nodes") or []
        old_sig = ">".join(n["id"] for n in old)
        new_sig = ">".join(n["id"] for n in nodes)
        if old_sig != new_sig or old_sig == "":
            changed.append("  %-16s %s  ->  %s" % (task_id, old_sig or "（无）", new_sig))
        task["nodes"] = nodes
        # 先规整日期参数，再补节点参数：否则日期的 --end 会被误认成节点 --end
        for msg in normalize_date_params(task):
            changed.append("  %-16s %s" % (task_id, msg))
        ensure_range_params(task, nodes, default_end)

    # 强制约束：每个任务都必须节点化。新增任务忘了在脚本里声明 NODES / 忘了在
    # SRC 里登记，这里就会被点名 —— 「后续新增的任务也要有节点」靠机制保证，不靠人记。
    unnoded = []
    for t in reg["tasks"]:
        if t.get("nodes") or t["id"] in SRC:
            continue  # 登记了但没取到的，已经在 missing 里报过，不重复
        unnoded.append("  %-16s %s" % (t["id"], t.get("name", "")))

    print("== 节点变更 ==")
    print("\n".join(changed) if changed else "  （无变化，脚本与 tasks.json 已一致）")
    if missing:
        print("\n== 跳过 ==")
        print("\n".join("  " + m for m in missing))
    if unnoded:
        print("\n== 未节点化（新增任务请补 NODES，并在 SRC 里登记一行）==")
        print("\n".join(unnoded))

    if write:
        with io.open(TASKS_JSON, "w", encoding="utf-8") as f:
            json.dump(reg, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print("\n已写入 %s" % TASKS_JSON)
    else:
        print("\n（预览模式，加 --write 才真正写入）")
    return 1 if (missing or unnoded) else 0


if __name__ == "__main__":
    sys.exit(main())
