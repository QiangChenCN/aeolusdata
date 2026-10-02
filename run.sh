#!/usr/bin/env bash
# 跨平台便捷脚本：优先用项目 .venv，找不到则退回系统 python。
# Linux: .venv/bin/python   Windows: .venv/Scripts/python.exe
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -x "$ROOT/python/.venv/bin/python" ]; then
  exec "$ROOT/python/.venv/bin/python" "$@"
elif [ -x "$ROOT/python/.venv/Scripts/python.exe" ]; then
  exec "$ROOT/python/.venv/Scripts/python.exe" "$@"
else
  exec python "$@"
fi
