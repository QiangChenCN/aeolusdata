"""P0 安全网：common.nodeflow 特性测试。

nodeflow 是现成的「节点区间执行框架」（NODES + fn(ctx) 约定）。
本测试锁住核心行为：串行执行、--begin/--end 区间裁剪、ctx 透传、节点异常冒泡，
全部在内存中跑，不触发任何外部调用。
"""
import sys
import pytest
from common import nodeflow


def _nodes():
    return [
        {"id": "fetch", "name": "拉取", "desc": "x", "fn": lambda c: c.update(fetch=1)},
        # proc 不依赖前序，便于单独区间测试
        {"id": "proc", "name": "加工", "desc": "x", "fn": lambda c: c.update(proc=c.get("fetch", 0) + 1)},
        {"id": "send", "name": "发送", "desc": "x", "fn": lambda c: None},
    ]


def _run(nodes, argv):
    backup = sys.argv
    sys.argv = argv
    try:
        return nodeflow.run(nodes, {}, title="[demo]")
    finally:
        sys.argv = backup


def test_run_executes_all_nodes_in_order():
    assert _run(_nodes(), ["nodeflow"]) == 0


def test_run_respects_begin_end_range():
    # 仅跑中间节点，验证 --begin/--end 区间裁剪语法正确
    assert _run(_nodes(), ["nodeflow", "--begin", "proc", "--end", "proc"]) == 0


def test_run_propagates_node_exception():
    # 节点异常直接冒泡（nodeflow 不吞异常）：a 执行、b 抛、c 不执行
    nodes = [
        {"id": "a", "name": "a", "desc": "x", "fn": lambda c: c.update(a=1)},
        {"id": "b", "name": "b", "desc": "x",
         "fn": lambda c: (_ for _ in ()).throw(RuntimeError("boom"))},
        {"id": "c", "name": "c", "desc": "x", "fn": lambda c: c.update(c=1)},
    ]
    ctx = {}
    with pytest.raises(RuntimeError):
        nodeflow.run(nodes, ctx, title="[demo]")
    assert "a" in ctx and "c" not in ctx
