# >>> python-home bootstrap (added by layout migration) >>>
import os as _os
import sys as _sys

def _find_python_home():
    d = _os.path.dirname(_os.path.abspath(__file__))
    # 计算服务代码根：同时含 analytics/ 与 compute_api/ 子目录
    while d and not (
        _os.path.isdir(_os.path.join(d, "analytics"))
        and _os.path.isdir(_os.path.join(d, "compute_api"))
    ):
        d = _os.path.dirname(d)
    return d

def _find_repo_root():
    d = _os.path.dirname(_os.path.abspath(__file__))
    # 仓库根：含 .git 或根 package.json
    while d and d != _os.path.dirname(d) and not (
        _os.path.exists(_os.path.join(d, ".git"))
        or _os.path.exists(_os.path.join(d, "package.json"))
    ):
        d = _os.path.dirname(d)
    return d

PY_HOME = _find_python_home()
ROOT = _find_repo_root()
_ROOT = ROOT
if PY_HOME and PY_HOME not in _sys.path:
    _sys.path.insert(0, PY_HOME)
# <<< python-home bootstrap <<<


"""公共模块包：跨流水线复用的共享库（钉钉 HTTP 客户端 / 配色 / 业务配置）。

这些模块原本散落在项目根目录，2026-09-07 统一归集到 common/，由 venv_guard
（及各自 bootstrap）把 common/ 加入 sys.path，从而保持 `import nest_client` 这类
裸导入继续可用。

包含：
  nest_client      Python 侧经 HTTP 调用 NestJS 的钉钉模块（发消息 / 读写表 / 群解析）
  theme_colors     配色唯一来源
  groups.json      群相关纯数据

2026-09-23 任务中心迁移后，以下模块已随之删除（能力全部进了 NestJS）：
  · ding_common   → 业务配置迁到 backend/src/modules/notify/notify-config.ts；
                    发送/群解析走 nest_client → NestJS dingtalk 模块
  · minio_common  → backend/src/modules/media/minio.service.ts
  · report_render → backend/src/modules/render/report-render.service.ts（@napi-rs/canvas）
  · nodeflow      → backend/src/modules/tasks/pipeline.ts + tasks/pipelines/
内部交叉 import（如 report_render 依赖 theme_colors）随之一并消失。
"""
