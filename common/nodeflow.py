"""通用「执行节点」框架 —— 让任意脚本都支持节点区间选择。

背景
----
server 工作台会把任务的 `nodes` 字段渲染成一条横向步进条，用户点圆点选
「开始节点 / 结束节点」圈定一段连续区间，前端拼成 `--begin <id> --end <id>`
传给脚本。脚本侧必须能：

1. 认识 `--begin` / `--end`（同时兼容 `--begin=xxx` 写法）
2. 校验：id 必须存在；结束不得早于开始；不合法就**报错退出**，绝不退化成全跑
3. 只跑区间内的节点

这个模块把上面三件事做成公共能力，各脚本只需声明 NODES 并在 main 里调一次
`nodeflow.run(NODES, ctx)`，不必各自重复解析逻辑。

用法
----
    import nodeflow

    NODES = [
        {"id": "fetch",  "name": "拉取数据", "desc": "...", "fn": do_fetch},
        {"id": "render", "name": "渲染图片", "desc": "...", "fn": do_render},
        {"id": "send",   "name": "发送钉钉", "desc": "...", "fn": do_send},
    ]

    def main():
        ctx = {}
        sys.exit(nodeflow.run(NODES, ctx))

节点函数约定
------------
* 签名 `fn(ctx)`，无返回值；`ctx` 是一个普通 dict，节点之间靠它传递产物
  （比如 fetch 放 `ctx["rows"]`，render 取 `ctx["rows"]`）。
* 节点函数内部若判定「没必要继续」（如命中 0 条），抛 `nodeflow.Stop` 即可，
  框架会打印原因并以 0 退出（**不算失败**，与「跑到一半崩了」区分开）。
* 需要非零退出直接 `sys.exit(n)` 或抛异常，框架不吞。

sys.argv 处理
-------------
`run()` 会**原地**把 `--begin` / `--end` 及其取值从 `sys.argv` 里摘掉，
这样各脚本原有的 `"--no-send" in sys.argv` 之类判断完全不受影响。

注意：`--start` / `--end` 中的 `--end` 在个别脚本（如 task_equipment）
是**日期参数**，与节点无关。本模块只认 `--begin`（节点）和 `--end` 之后紧跟的
取值；如果脚本自己要用日期 `--end`，请改用 `--end-date`，或在调用 nodeflow 之前
自行解析日期参数。当前接入的脚本均不存在该冲突。
"""

import re
import sys

__all__ = ["Stop", "parse_range", "resolve", "prepare", "execute", "run",
           "reject_legacy_date_args"]

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def reject_legacy_date_args(argv, legacy=("--start", "--end"), new=("--start-date", "--end-date")):
    """拦截把日期写成 `--start/--end` 的老用法（`--end` 已归节点区间专用）。

    只在**取值长得像日期**（YYYY-MM-DD）时才报错 —— 否则会把
    `--end fetch` 这种正常的节点用法误判成日期参数。

    返回命中的老写法列表（如 `["--end 2026-08-23"]`），空列表表示没问题。
    """
    bad = []
    for i, arg in enumerate(argv):
        name, sep, val = arg.partition("=")
        if name not in legacy:
            continue
        v = val if sep else (argv[i + 1] if i + 1 < len(argv) else "")
        if _DATE_RE.match(v or ""):
            bad.append("%s %s" % (name, v))
    return bad


class Stop(Exception):
    """节点主动终止流水线（业务上不需要继续），以 0 退出。

    例：筛选命中 0 条 → 抛 Stop("无符合条件的订单，跳过发送")。
    与真正的异常区分开：Stop 不打印 traceback，也不算失败。
    """


def _node_ids(nodes):
    return [n["id"] for n in nodes]


def _node_index(nodes):
    return {n["id"]: i for i, n in enumerate(nodes)}


def _take(argv):
    """从 argv 摘出 --begin / --end 的**原始取值**并原地移除，不做任何校验。

    返回 `(begin, end, err)`；未指定时 begin/end 为 None，由 `pick()` 补默认值。
    单独暴露出来是为了支持「先摘参数 → 再决定用哪套 NODES → 最后校验」的场景
    （典型如一个脚本多种子命令，每种子命令有各自的节点列表）。
    """
    begin = end = None
    out = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--begin" or a == "--end":
            if i + 1 >= len(argv):
                return None, None, "%s 缺少取值" % a
            if a == "--begin":
                begin = argv[i + 1]
            else:
                end = argv[i + 1]
            i += 2
            continue
        if a.startswith("--begin="):
            begin = a.split("=", 1)[1]
        elif a.startswith("--end="):
            end = a.split("=", 1)[1]
        else:
            out.append(a)
        i += 1
    del argv[:]
    argv.extend(out)
    return begin, end, None


def pick(nodes, begin=None, end=None):
    """校验 begin/end 并返回区间节点列表，返回 `(todo, err)`。

    `begin` / `end` 为 None 时取首/末节点（即默认全跑）。
    """
    ids = _node_ids(nodes)
    idx = _node_index(nodes)
    if begin is None:
        begin = ids[0]
    if end is None:
        end = ids[-1]
    if begin not in idx:
        return None, "--begin 必须是节点 id 之一：%s（收到 %r）" % (ids, begin)
    if end not in idx:
        return None, "--end 必须是节点 id 之一：%s（收到 %r）" % (ids, end)
    if idx[end] < idx[begin]:
        return None, "结束节点 %r 不得早于开始节点 %r" % (end, begin)
    return resolve(nodes, begin, end), None


def take_range(argv):
    """`_take()` 的公开版：只摘参数不校验，返回 `(begin, end, err)`。"""
    return _take(argv)


def parse_range(argv, nodes):
    """摘出 --begin / --end 并**一次做完**校验（原地删除）。

    返回 `(begin_id, end_id, err)`；需要「先摘后校验」的场景请用
    `take_range()` + `pick()`。
    """
    begin, end, err = _take(argv)
    if err:
        return None, None, err
    todo, err = pick(nodes, begin, end)
    if err:
        return None, None, err
    return todo[0]["id"], todo[-1]["id"], None


def resolve(nodes, begin_id, end_id):
    """返回落在 [begin, end] 闭区间内的节点列表（保持定义顺序）。"""
    idx = _node_index(nodes)
    lo, hi = idx[begin_id], idx[end_id]
    return [n for n in nodes if lo <= idx[n["id"]] <= hi]


def prepare(nodes, argv=None):
    """只做「解析 + 校验 + 摘 argv」，不执行。返回 `(todo, err)`。

    拆成两步是因为多数脚本有自己的业务参数解析（如 `--group` / `--no-at`），
    而那些解析器遇到不认识的 `--begin` 会直接报错退出。正确顺序是：

        todo, err = nodeflow.prepare(NODES)   # 先把 --begin/--end 从 sys.argv 摘掉
        if err: print("✗ " + err); sys.exit(1)
        args = parse_args()                   # 再解析业务参数，此时 argv 已干净
        sys.exit(nodeflow.execute(todo, ctx))

    `argv` 缺省为 `sys.argv`（原地摘除 [1:] 部分）；也可传入自定义 list。
    """
    if argv is None:
        argv = sys.argv
        head, rest = argv[0], argv[1:]
        begin, end, err = _take(rest)
        if err is None:
            del argv[1:]
            argv.extend(rest)
    else:
        begin, end, err = _take(argv)
    if err:
        return None, err
    return pick(nodes, begin, end)


def execute(todo, ctx=None, title=None):
    """按顺序执行 `prepare()` 返回的节点列表，返回进程退出码。"""
    if ctx is None:
        ctx = {}
    prefix = (title + " ") if title else ""
    print("%s节点区间：%s → %s（共 %d 步）"
          % (prefix, todo[0]["id"], todo[-1]["id"], len(todo)), flush=True)

    for i, n in enumerate(todo, 1):
        print("\n[%d/%d] %s —— %s" % (i, len(todo), n["id"], n.get("name", "")),
              flush=True)
        try:
            n["fn"](ctx)
        except Stop as e:
            print("  ⏹ %s" % e, flush=True)
            return 0
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
            if code != 0:
                print("  ✗ 节点 %s 以 %s 退出" % (n["id"], code), flush=True)
            return code
    return 0


def run(nodes, ctx=None, argv=None, title=None):
    """`prepare()` + `execute()` 的便捷组合，适用于无业务参数要解析的脚本。

    需要自己解析业务参数（如 `--group`）的脚本请改用两步写法，否则业务解析器
    会先撞上尚未摘除的 `--begin` / `--end`。
    """
    todo, err = prepare(nodes, argv)
    if err:
        print("✗ " + err)
        return 1
    return execute(todo, ctx, title=title)
