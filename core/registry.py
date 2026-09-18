"""TaskRegistry：任务即插件（治理工作台重构思路 §3.2 / §3.5）。

每个任务声明式注册一条 TaskMeta（id / 名称 / 描述 / 分组 / 是否可定时 / 调度 / 参数 schema / entry）。
前端导航 / 表单 / 步进条可由 registry 自动生成（未来），不再硬编码 `kind`（架构报告 P6）。

本层只提供注册表机制；现有 jobs 暂未强制注册（不迁移业务）。
未来 jobs 改造为 Task 子类后，在此 register 即可被运行时 / 调度器发现。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


@dataclass
class ParamSpec:
    """任务参数 schema（驱动前端表单自动生成）。"""
    name: str
    label: str = ""
    kind: str = "string"            # string | int | date | enum | bool | teams
    default: Any = None
    required: bool = False
    choices: Optional[List[Any]] = None
    help: str = ""


@dataclass
class TaskMeta:
    """任务元数据：注册表里的一条记录。"""
    id: str
    name: str
    description: str = ""
    group: str = "default"                     # 前端分组（如 考勤 / 看板 / 风控）
    category: str = "report"                   # report / dashboard / tool
    schedulable: bool = True                   # 是否允许被定时任务触发
    schedule: Optional[Dict[str, Any]] = None  # {"type":"cron"/"interval","expr":"..."}
    params: List[ParamSpec] = field(default_factory=list)
    # entry：可调用的任务执行体（函数或 Task 实例）。运行时通过 TaskRuntime 驱动。
    entry: Any = None


class TaskRegistry:
    """任务注册表（进程内单例）。"""

    def __init__(self):
        self._tasks: Dict[str, TaskMeta] = {}

    def register(self, meta: TaskMeta) -> TaskMeta:
        if meta.id in self._tasks:
            raise ValueError("任务 id 已存在：%s" % meta.id)
        self._tasks[meta.id] = meta
        return meta

    def get(self, task_id: str) -> TaskMeta:
        if task_id not in self._tasks:
            raise KeyError("未注册的任务：%s" % task_id)
        return self._tasks[task_id]

    def list(self) -> List[TaskMeta]:
        return list(self._tasks.values())

    def by_group(self, group: str) -> List[TaskMeta]:
        return [t for t in self._tasks.values() if t.group == group]

    def schedulable(self) -> List[TaskMeta]:
        return [t for t in self._tasks.values() if t.schedulable]


# 进程内默认注册表（应用组合根 workbench/main.py 未来注入）
registry = TaskRegistry()
