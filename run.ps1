# 用项目 .venv 的 python 运行任意脚本： .\run.ps1 appeal_reminder.py [args...]
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$py = Join-Path $root ".venv/Scripts/python.exe"
if (-not (Test-Path $py)) { Write-Error "未找到 $py，请先创建 .venv"; exit 1 }
& $py @args
