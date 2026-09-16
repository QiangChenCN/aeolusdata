#!/usr/bin/env bash
# 用项目 .venv 的 python 运行任意脚本： ./run.sh appeal_reminder.py [args...]
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/.venv/Scripts/python.exe" "$@"
