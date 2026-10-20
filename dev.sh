#!/usr/bin/env bash
# 一键开发启动：按序拉起 Python 计算服务(8900) → 后端(8787) → 前端(5173)
# 用法（项目根目录）： npm run dev   或   bash dev.sh
#
# 行为：
#   · 顺序启动，每启动一个先用对应端口探测就绪，再启动下一个（避免后端在 8900 未就绪时抢跑）。
#   · 幂等：若某端口已在监听，视为已运行，跳过启动（不会与手动/ watchdog 起的实例冲突）。
#   · 由本脚本启动的进程由脚本托管；Ctrl-C 时优雅停止这些进程（不会误杀跳过的已有实例）。
#
# 说明：前端改动后仍需 `cd web && npm run build` 才生效（8787 经 express.static serve dist）；
#       本脚本只负责「起服务」，不做构建。后端若未构建会启动失败，请先 `cd backend && npm run build`。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$ROOT/logs"
mkdir -p "$LOG"
PIDS=()

port_listen(){ ss -ltn 2>/dev/null | grep -q ":$1 "; }
# 等待端口就绪，超时返回非 0
wait_port(){ local port=$1 to=$2 i=0
  while ! port_listen "$port"; do
    sleep 1; i=$((i+1))
    if [ "$i" -ge "$to" ]; then echo "  [warn] $port 未在 ${to}s 内就绪，请查看日志"; return 1; fi
  done
  echo "  [ok] $port 已就绪"; return 0
}

start_compute(){
  echo "[1/3] Python 计算服务 (8900)"
  if port_listen 8900; then echo "  [skip] 8900 已在运行"; return; fi
  echo "  starting gunicorn -w 4 ..."
  ( cd "$ROOT/python" && exec .venv/bin/python -m gunicorn -k uvicorn.workers.UvicornWorker -w 4 --bind 127.0.0.1:8900 compute_api.main:app ) \
    >> "$LOG/python-compute.log" 2>&1 &
  PIDS+=($!)
  wait_port 8900 30
}

start_backend(){
  echo "[2/3] 后端 NestJS (8787)"
  if port_listen 8787; then echo "  [skip] 8787 已在运行"; return; fi
  echo "  starting node dist/src/main ..."
  ( cd "$ROOT/backend" && exec node dist/src/main ) >> "$LOG/backend.log" 2>&1 &
  PIDS+=($!)
  wait_port 8787 30
}

start_web(){
  echo "[3/3] 前端 Vite (5173)"
  if port_listen 5173; then echo "  [skip] 5173 已在运行"; return; fi
  echo "  starting vite --port 5173 --strictPort ..."
  ( cd "$ROOT/web" && exec node node_modules/.bin/vite --port 5173 --strictPort ) >> "$LOG/web.log" 2>&1 &
  PIDS+=($!)
  wait_port 5173 30
}

cleanup(){
  echo
  if [ "${#PIDS[@]}" -gt 0 ]; then
    echo "[dev] 停止本脚本启动的服务 ..."
    for p in "${PIDS[@]}"; do
      # 发给进程组，连带子进程（gunicorn worker / node）一起退
      kill -TERM -"$p" 2>/dev/null || kill "$p" 2>/dev/null
    done
  else
    echo "[dev] 未启动任何新服务（均为已运行实例），不执行停止"
  fi
}
trap cleanup INT TERM EXIT

start_compute
start_backend
start_web

echo
echo "[dev] 全部就绪：由本脚本托管的服务可用 Ctrl-C 停止（已运行的实例不受影响）。"
echo "[dev] 日志目录：$LOG"
wait
