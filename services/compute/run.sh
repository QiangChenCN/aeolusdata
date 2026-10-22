#!/usr/bin/env bash
# 跨平台便捷脚本：优先用项目 .venv，找不到则退回系统 python。
#
# 位置：python/run.sh（与 .venv 同目录，2026-10-21 从仓库根移入 —— 它只服务于 Python 侧）。
# 用法：bash python/run.sh <脚本>.py [参数...]
#   Linux:   .venv/bin/python
#   Windows: .venv/Scripts/python.exe
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -x "$ROOT/.venv/bin/python" ]; then
  exec "$ROOT/.venv/bin/python" "$@"
elif [ -x "$ROOT/.venv/Scripts/python.exe" ]; then
  exec "$ROOT/.venv/Scripts/python.exe" "$@"
else
  exec python "$@"
fi
