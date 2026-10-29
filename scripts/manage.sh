#!/usr/bin/env bash
# manage.sh —— Aeolus 本地三服务运维统一入口（开发机用，非 systemd 环境）
#
# 合并了原 start.sh / stop.sh / restart.sh：用子命令区分动作，避免根目录散落多份脚本。
# 守护进程 watchdog.sh 仍独立（长驻循环），由本脚本在 --watchdog 时拉起 / 停止时一并停掉。
#
# 子命令：
#   start   [svc...] [--force] [--no-watchdog] 启动（顺序 compute→backend→web；已在运行自动跳过）
#   stop    [svc...]                          停止（顺序 web→backend→compute；一并停 watchdog）
#   restart [svc...] [--watchdog]             逐服务「停→起」，自动恢复 watchdog 原状态
#
# watchdog 默认行为（2026-10-22 调整）：
#   · start 默认一并拉起 watchdog，无需再手动加 --watchdog；
#   · 只想起服务、不要自愈监管时，显式加 --no-watchdog；
#   · stop 仍会一并停掉 watchdog（否则它会在约 60s 内把服务重新拉起来）；
#   · restart 仍按「原状态」恢复（原本没跑就不自作主张拉起），需强制开则加 --watchdog。
#
# svc 可选：compute | backend | web（缺省全部）
#   例：
#     bash scripts/manage.sh start                  # 三个都起 + 一并拉起 watchdog
#     bash scripts/manage.sh start --no-watchdog    # 只起三个服务，不自愈监管
#     bash scripts/manage.sh start backend          # 只起后端（仍会拉起 watchdog）
#     bash scripts/manage.sh stop web                # 只停前端
#     bash scripts/manage.sh restart backend         # 只重启后端（前端/计算不受影响）
#
# 说明：
#   · 启动顺序 compute→backend→web 是依赖顺序（后端要转发给计算，前端只依赖后端）；
#   · restart 逐个「停→起」而非整体 stop 再 start，避免后端启动瞬间 8900 未就绪导致的短暂无数据；
#   · watchdog 在 stop 时会被一并停掉（否则 ~60s 内又把服务拉起），restart 会按原状态恢复。

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="$ROOT/apps/api/runtime/logs"
mkdir -p "$LOGDIR"

CPORT=8900   # Python 计算服务（gunicorn + uvicorn worker）
BPORT=8787   # NestJS 后端
WPORT=5173   # 前端 Vite
FORCE=0      # 全局：start 时是否强制重启已运行的服务

# ---------------- 启动相关 ----------------
port_listen() { ss -ltn 2>/dev/null | grep -q ":$1 "; }

# 等待「端口监听 + HTTP 有响应」；返回 0 表示就绪
wait_ready() {
  local port=$1 path=$2 name=$3 to=${4:-40} i=0
  while [ "$i" -lt "$to" ]; do
    if port_listen "$port" && curl -s -o /dev/null -m 5 "http://127.0.0.1:$port$path" >/dev/null 2>&1; then
      echo "  [ok] $name 就绪 (:$port)"; return 0
    fi
    sleep 1; i=$((i + 1))
  done
  echo "  [fail] $name ${to}s 内未就绪，请查 $LOGDIR"; return 1
}

# 已在运行且非强制 → 跳过（不造重复实例，也不打断 watchdog 托管的实例）
skip_if_running() {
  local port=$1 name=$2
  [ "$FORCE" = "1" ] && return 1
  if port_listen "$port"; then echo "  [skip] $name 已在运行 (:$port)"; return 0; fi
  return 1
}

start_compute() {
  echo "[1/3] Python 计算服务 ($CPORT)"
  skip_if_running "$CPORT" compute && return 0
  if [ ! -x "$ROOT/services/compute/.venv/bin/python" ]; then
    echo "  [fail] 缺少 $ROOT/services/compute/.venv/bin/python（请先建虚拟环境）"; return 1
  fi
  setsid bash -c "cd $ROOT/services/compute && exec .venv/bin/python -m gunicorn -k uvicorn.workers.UvicornWorker -w 4 --bind 127.0.0.1:$CPORT compute_api.main:app" \
    >> "$LOGDIR/python-compute.log" 2>&1 < /dev/null &
  wait_ready "$CPORT" /docs compute 40
}

start_backend() {
  echo "[2/3] 后端 NestJS ($BPORT)"
  skip_if_running "$BPORT" backend && return 0
  if [ ! -f "$ROOT/apps/api/dist/src/main.js" ]; then
    echo "  [fail] 缺少 apps/api/dist/src/main.js —— 请先 pnpm build:api"; return 1
  fi
  setsid bash -c "cd $ROOT/apps/api && exec node dist/src/main" \
    >> "$LOGDIR/backend.log" 2>&1 < /dev/null &
  wait_ready "$BPORT" / backend 40
}

start_web() {
  echo "[3/3] 前端 Vite ($WPORT)"
  skip_if_running "$WPORT" web && return 0
  # pnpm 工作区：用 workspace 命令启动，避免 hoisted 依赖后各 app/node_modules/.bin 缺失
  setsid bash -c "cd $ROOT && exec pnpm --filter aeolus-workbench-web run dev" \
    >> "$LOGDIR/web.log" 2>&1 < /dev/null &
  wait_ready "$WPORT" / web 40
}

start_watchdog() {
  if pgrep -f "[w]atchdog.sh" >/dev/null 2>&1; then echo "  [skip] watchdog 已在运行"; return 0; fi
  setsid bash "$ROOT/scripts/watchdog.sh" >> "$LOGDIR/watchdog.out" 2>&1 < /dev/null &
  echo "  [ok] watchdog 已拉起（端口死亡/卡死自愈）"
}

# ---------------- 停止相关 ----------------
PAT_WEB='vite --port 5173 --strictPort'
PAT_BACKEND='dist/src/main$'
PAT_COMPUTE='compute_api[.]main:app'
PAT_WATCHDOG='[w]atchdog.sh'

stop_one() {
  local name=$1 pat=$2
  if ! pgrep -f "$pat" >/dev/null 2>&1; then echo "  [skip] $name 未运行"; return 0; fi
  pkill -TERM -f "$pat" 2>/dev/null
  local i=0
  while [ "$i" -lt 15 ]; do
    pgrep -f "$pat" >/dev/null 2>&1 || { echo "  [ok] $name 已停止"; return 0; }
    sleep 1; i=$((i + 1))
  done
  pkill -KILL -f "$pat" 2>/dev/null; sleep 1
  echo "  [ok] $name 强制停止（TERM 15s 未退出）"
}

# ---------------- 子命令 ----------------
cmd_start() {
  # 默认随服务一并拉起 watchdog（--watchdog 保留兼容，--no-watchdog 显式关闭）
  local WITH_WATCHDOG=1 SERVICES=()
  for a in "$@"; do
    case "$a" in
      --force) FORCE=1 ;;
      --watchdog) WITH_WATCHDOG=1 ;;
      --no-watchdog) WITH_WATCHDOG=0 ;;
      compute|backend|web) SERVICES+=("$a") ;;
      *) echo "用法: bash scripts/manage.sh start [compute|backend|web] [--force] [--no-watchdog]"; exit 1 ;;
    esac
  done
  [ ${#SERVICES[@]} -eq 0 ] && SERVICES=(compute backend web)
  local rc=0
  for s in "${SERVICES[@]}"; do
    case "$s" in
      compute) start_compute || rc=1 ;;
      backend) start_backend || rc=1 ;;
      web) start_web || rc=1 ;;
    esac
  done
  [ "$WITH_WATCHDOG" = "1" ] && { echo "[watchdog]"; start_watchdog; }
  echo; echo "日志目录：$LOGDIR"
  exit $rc
}

cmd_stop() {
  local SERVICES=("$@")
  [ ${#SERVICES[@]} -eq 0 ] && SERVICES=(web backend compute)
  echo "[watchdog]"; stop_one watchdog "$PAT_WATCHDOG"
  local n=0
  for s in "${SERVICES[@]}"; do
    n=$((n + 1)); echo "[$n/${#SERVICES[@]}]"
    case "$s" in
      web) stop_one "前端 Vite (5173)" "$PAT_WEB" ;;
      backend) stop_one "后端 NestJS (8787)" "$PAT_BACKEND" ;;
      compute) stop_one "Python 计算 (8900)" "$PAT_COMPUTE" ;;
      *) echo "  未知服务：$s（可选 web|backend|compute）" ;;
    esac
  done
  echo; echo "已停止：${SERVICES[*]}   启动：bash scripts/manage.sh start"
  echo "提示：watchdog 已一并停止（否则它会在约 60s 内把服务重新拉起来）。"
  echo "      下一次 start 会默认重新拉起 watchdog；不想自愈监管则用 start --no-watchdog。"
  echo "      只重启某个服务而不丢 watchdog：用 bash scripts/manage.sh restart <服务>（会自动恢复）"
}

cmd_restart() {
  local FORCE_WATCHDOG=0 SERVICES=()
  for a in "$@"; do
    case "$a" in
      --watchdog) FORCE_WATCHDOG=1 ;;
      compute|backend|web) SERVICES+=("$a") ;;
      *) echo "用法: bash scripts/manage.sh restart [compute|backend|web] [--watchdog]"; exit 1 ;;
    esac
  done
  [ ${#SERVICES[@]} -eq 0 ] && SERVICES=(compute backend web)

  # 先记录并停掉 watchdog，避免重启窗口内它抢先拉起服务
  local WD_WAS_RUNNING=0
  pgrep -f "[w]atchdog.sh" >/dev/null 2>&1 && WD_WAS_RUNNING=1
  echo "[watchdog]"; stop_one watchdog "$PAT_WATCHDOG"

  local rc=0
  for s in "${SERVICES[@]}"; do
    echo "=== 重启 $s ==="
    case "$s" in
      web) stop_one "前端 Vite (5173)" "$PAT_WEB" || rc=1 ;;
      backend) stop_one "后端 NestJS (8787)" "$PAT_BACKEND" || rc=1 ;;
      compute) stop_one "Python 计算 (8900)" "$PAT_COMPUTE" || rc=1 ;;
    esac
    # 端口释放窗口：stop 后立刻 start 容易撞上 TIME_WAIT / 旧进程未完全退出
    sleep 1
    case "$s" in
      compute) start_compute || rc=1 ;;
      backend) start_backend || rc=1 ;;
      web) start_web || rc=1 ;;
    esac
  done

  # 按原状态恢复 watchdog（原本没跑就不自作主张拉起）
  local need_wd=$WD_WAS_RUNNING
  [ "$FORCE_WATCHDOG" = "1" ] && need_wd=1
  if [ "$need_wd" = "1" ]; then echo "=== 恢复 watchdog ==="; start_watchdog; fi

  echo; echo "已重启：${SERVICES[*]}"
  exit $rc
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  restart) shift; cmd_restart "$@" ;;
  *) echo "用法: bash scripts/manage.sh {start|stop|restart} [compute|backend|web] [...]"; exit 1 ;;
esac
