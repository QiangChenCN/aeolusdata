"""core —— 工作台重构核心抽象层（见 docs/工作台重构思路.md §3.2 / §4）。

把「运行环境耦合、重复骨架、发送渠道焊死」抽成可替换接口：
- core.notifier     : 通知渠道抽象（钉钉 CLI / 钉钉机器人 / 企微机器人），根治 §2.4
- core.registry     : 任务即插件（TaskRegistry + TaskMeta）
- core.task_runtime : 五段骨架 TaskRuntime（Fetch/Process/Render/Upload/Notify）

本层只定义抽象 + 包现有能力的适配器；**不迁移业务**，现有 jobs / server 调用方式不变。
"""
import os
import sys

# 确保项目根（common/ 所在）在 sys.path，使 core 内 `from common import ...` 可用。
_ROOT = os.path.dirname(os.path.abspath(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from .notifier import Notifier, ReportPayload, get_notifier  # noqa: E402
from .registry import TaskRegistry, TaskMeta, ParamSpec       # noqa: E402
from .task_runtime import (                                   # noqa: E402
    TaskRuntime, NodeflowTask, Stage, TaskResult, Task)

__all__ = [
    "Notifier", "ReportPayload", "get_notifier",
    "TaskRegistry", "TaskMeta", "ParamSpec",
    "TaskRuntime", "NodeflowTask", "Stage", "TaskResult", "Task",
]
