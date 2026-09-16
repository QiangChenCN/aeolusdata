"""任务总目录。

每个子目录是一个独立任务：
  attendance / appeal / board / equipment / rush /
  delivery / ruledoc / unsat

子目录内约定：
  <脚本>.py  任务代码（产物一律写进同级 out/）
  out/       运行产物（png / csv / json / 日志…）

公共模块（nodeflow / ding_common / minio_common / report_render /
find_group / theme_colors）已归集到 common/ 目录；
venv_guard 与各自 bootstrap 把 common/ 加进 sys.path，裸 import 继续可用。
aeolus_sdk 仍是独立包（项目根），本机脚本仍走 `.venv`。
"""
