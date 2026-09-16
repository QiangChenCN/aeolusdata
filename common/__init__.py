"""公共模块包：跨流水线复用的共享库（钉钉 / 图床 / 报表渲染 / 配色 / 节点框架 / 群解析）。

这些模块原本散落在项目根目录，2026-09-07 统一归集到 common/，由 venv_guard
（及各自 bootstrap）把 common/ 加入 sys.path，从而保持 `import ding_common` 这类
裸导入在所有任务脚本里继续可用。

包含：
  ding_common      钉钉路径 / dws CLI 封装 / 重试 / 群与站长配置（单一来源）
  minio_common     MinIO 图床上传
  report_render    报表图渲染 + fit_font 字号自适应
  theme_colors     配色唯一来源
  nodeflow         通用节点框架
  find_group       群名 → 群 ID 解析

内部交叉 import（如 find_group 依赖 ding_common、report_render 依赖 theme_colors）
在 common/ 入 sys.path 后照常解析，无需改动。
"""
