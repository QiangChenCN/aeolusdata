from analytics.core.paths import ROOT, PY_HOME, _ROOT  # noqa: E402,F401 <<<


"""公共模块包：跨流水线复用的共享库（钉钉 HTTP 客户端 / 配色 / 业务配置）。

这些模块原本散落在项目根目录，2026-09-07 统一归集到 common/，由 venv_guard
（及各自 bootstrap）把 common/ 加入 sys.path，从而保持 `import nest_client` 这类
裸导入继续可用。

包含：
  nest_client      Python 侧经 HTTP 调用 NestJS 的钉钉模块（发消息 / 读写表 / 群解析）
  theme_colors     配色唯一来源
  groups.json      群相关纯数据

2026-09-23 任务中心迁移后，以下模块已随之删除（能力全部进了 NestJS）：
  · ding_common   → 业务配置迁到 apps/api/src/modules/notify/notify-config.ts；
                    发送/群解析走 nest_client → NestJS dingtalk 模块
  · minio_common  → apps/api/src/modules/media/minio.service.ts
  · report_render → apps/api/src/modules/render/report-render.service.ts（@napi-rs/canvas）
  · nodeflow      → apps/api/src/modules/tasks/pipeline.ts + tasks/pipelines/
内部交叉 import（如 report_render 依赖 theme_colors）随之一并消失。
"""
