#!/usr/bin/env bash
# 跨平台便捷脚本：优先用项目 .venv，找不到则退回系统 python。
# Linux: .venv/bin/python   Windows: .venv/Scripts/python.exe
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -x "$ROOT/.venv/bin/python" ]; then
  exec "$ROOT/.venv/bin/python" "$@"
elif [ -x "$ROOT/.venv/Scripts/python.exe" ]; then
  exec "$ROOT/.venv/Scripts/python.exe" "$@"
else
  exec python "$@"
fi
