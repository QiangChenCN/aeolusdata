"""TaskRuntime：五段骨架（Fetch → Process → Render → Upload → Notify）。

治理 §2.3（每个任务重复 fetch→render→upload→send 骨架）：
把「每段怎么写」统一成可组合节点，tasks/* 只填「本任务特有的加工与取数」。

本文件只定义抽象 + 一个把现有 nodeflow NODES 包成 Task 的适配层（NodeflowTask），
不重写现有 jobs 逻辑。现有 jobs 仍可自己 nodeflow.run()；未来改造为 Task 子类后即可被
TaskRuntime 统一驱动（前端 / 调度器均可复用同一运行时，见 §3.3 / §4.1）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class Stage(str, Enum):
    """五段骨架的标准阶段。"""
    FETCH = "fetch"
    PROCESS = "process"
    RENDER = "render"
    UPLOAD = "upload"
    NOTIFY = "notify"


@dataclass
class TaskResult:
    """一次任务运行的结果（供 history / 定时任务记录）。"""
    task_id: str
    ok: bool
    steps: List[str] = field(default_factory=list)
    error: Optional[str] = None
    artifacts: Dict[str, Any] = field(default_factory=dict)


class Task:
    """任务抽象：子类实现 run(params) -> TaskResult。"""

    id = "base"

    def run(self, params: Dict[str, Any]) -> TaskResult:
        raise NotImplementedError


class NodeflowTask(Task):
    """把现有 nodeflow 风格的 NODES（含 fn(ctx)）包成 Task。

    仅做能力收敛，不要求 jobs 改造；未来 jobs 可直接继承此类并声明 NODES。
    现有 jobs 仍可用 nodeflow.run(NODES) 自行驱动——本类提供「同样的事，但能被注册表 / 调度器发现」的入口。
    """

    # 子类覆盖：NODES = [...]
    NODES: List[Dict[str, Any]] = []

    def run(self, params: Dict[str, Any]) -> TaskResult:
        from common import nodeflow   # 自包含：core 不依赖外部 PYTHONPATH 把 common/ 放进 path
        ctx = dict(params)
        code = nodeflow.run(self.NODES, ctx, title="[%s]" % self.id)
        return TaskResult(task_id=self.id, ok=(code == 0),
                          steps=[n["id"] for n in self.NODES])


class TaskRuntime:
    """统一运行时入口：触发任务、串联五段、收集日志与产物。

    当前实现：直接调 task.run(params)。未来可在此插入：
      - 每步日志 → 队列 → SSE（沿用现有日志配色令牌）
      - 执行记录写 runs 表（history / 定时任务共用）
      - 并发上限 / 失败重试（Scheduler 层）
    """

    def __init__(self, notifier=None):
        self.notifier = notifier

    def run(self, task: Task, params: Optional[Dict[str, Any]] = None) -> TaskResult:
        params = params or {}
        try:
            result = task.run(params)
        except Exception as e:  # 运行时兜底：任何未捕获异常都记为失败，不崩进程
            return TaskResult(task_id=getattr(task, "id", "?"), ok=False, error=str(e))
        return result
