@echo off
chcp 65001 >nul
title 风神数据处理 · 任务运行工作台
cd /d "%~dp0"

set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

echo.
echo   正在启动任务运行工作台...
echo   解释器: %PY%
echo   关闭本窗口即停止服务
echo.

start "" http://127.0.0.1:8917
"%PY%" server.py --port 8917

echo.
echo   服务已停止。
pause
