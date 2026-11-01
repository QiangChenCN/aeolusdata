#!/usr/bin/env bash
# manage.sh —— Aeolus 本地四服务（含任务 Worker）运维统一入口（开发机用，非 systemd 环境）
#
# 合并了原 start.sh / stop.sh / restart.sh 以及独立看门狗 watchdog.sh：单一入口统管启停与自愈。
# 看门狗以 `watch` 子命令实现（长驻监控循环），由本脚本在 start 时拉起、stop 时一并停掉。
#
# 子命令：
#   start   [svc...] [--force] [--no-watchdog] 启动（顺序 compute→backend→worker→web；已在运行自动跳过）
#   stop    [svc...]                          停止（顺序 web→worker→backend→compute；一并停看门狗）
#   restart [svc...] [--watchdog]             逐服务「停→起」，自动恢复看门狗原状态
#   status                                   仅做健康检查并打印四服务状态（不改服务）
#   watch                                    看门狗监控循环（由 start 自动拉起，勿手动单独跑）
#
# 看门狗默认行为：
#   · start 默认一并拉起看门狗（watch 子命令），无需再手动加 --watchdog；
#   · 只想起服务、不要自愈监管时，显式加 --no-watchdog；
#   · stop 仍会一并停掉看门狗（否则它会在约 60s 内把服务重新拉起来）；
#   · restart 仍按「原状态」恢复（原本没跑就不自作主张拉起），需强制开则加 --watchdog。
#
# svc 可选：compute | backend | worker | web（缺省全部）
#   例：
#     bash scripts/manage.sh start                  # 四个都起 + 一并拉起看门狗
#     bash scripts/manage.sh start --no-watchdog    # 只起四个服务，不自愈监管
#     bash scripts/manage.sh start backend          # 只起后端（仍会拉起看门狗）
#     bash scripts/manage.sh stop web                # 只停前端
#     bash scripts/manage.sh restart backend         # 只重启后端（前端/计算不受影响）
#
# 说明：
#   · 启动顺序 compute→backend→worker→web 是依赖顺序（后端要转发给计算，前端只依赖后端）；
#   · restart 逐个「停→起」而非整体 stop 再 start，避免后端启动瞬间 8900 未就绪导致的短暂无数据；
#   · 看门狗在 stop 时会被一并停掉（否则 ~60s 内又把服务拉起），restart 会按原状态恢复。

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="$ROOT/apps/api/runtime/logs"
mkdir -p "$LOGDIR"

CPORT=8900   # Python 计算服务（gunicorn + uvicorn worker）
BPORT=8787   # NestJS 后端
WPORT=5173   # 前端 Vite
WPAT='dist/src/main-worker$'   # 任务 Worker（无 HTTP 端口，仅按进程判定存活）
FORCE=0      # 全局：start 时是否强制重启已运行的服务

# ---------------- 看门狗（watch 子命令）相关 ----------------
PROBE_INTERVAL=30   # 探测间隔（秒）
MAX_FAIL=2          # 连续失败多少次后自愈重启
RESTART_WEB=0       # 前端默认只告警不自动重启（怕误杀你手动起的 vite）
# HTTP 探测：能连上并拿到任意响应视为健康
probe() { curl -s -o /dev/null -m "$2" "http://127.0.0.1:$1/" >/dev/null 2>&1; }

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

# 健康检查：打印四服务（compute/backend/web 看端口 + HTTP，worker 看进程）状态；
# 全部健康返回 0，否则返回 1（供 start/restart 据此置 rc）。
health_check() {
  local all_ok=0
  echo "=== 服务状态 ==="
  local items=("compute:$CPORT:port" "backend:$BPORT:port" "web:$WPORT:port" "worker:0:proc")
  for item in "${items[@]}"; do
    IFS=':' read -r name port kind <<< "$item"
    local ok=0
    if [ "$kind" = "port" ]; then
      if port_listen "$port" && curl -s -o /dev/null -m 5 "http://127.0.0.1:$port/" >/dev/null 2>&1; then ok=1; fi
    else
      pgrep -f "$WPAT" >/dev/null 2>&1 && ok=1
    fi
    if [ "$ok" = "1" ]; then echo "  [✓] $name 健康"; else echo "  [✗] $name 异常"; all_ok=0; fi
  done
  return $all_ok
}

# 判断单个服务是否已健康（compute/backend/web 看端口+HTTP，worker 看进程存活）
svc_up() {
  case "$1" in
    compute) port_listen $CPORT && curl -s -o /dev/null -m 5 "http://127.0.0.1:$CPORT/" >/dev/null 2>&1 ;;
    backend) port_listen $BPORT && curl -s -o /dev/null -m 5 "http://127.0.0.1:$BPORT/" >/dev/null 2>&1 ;;
    web)     port_listen $WPORT && curl -s -o /dev/null -m 5 "http://127.0.0.1:$WPORT/" >/dev/null 2>&1 ;;
    worker)  pgrep -f "$WPAT" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# 按服务名分发到对应的 start_* 函数
start_svc() {
  case "$1" in
    compute) start_compute ;;
    backend) start_backend ;;
    worker)  start_worker ;;
    web)     start_web ;;
  esac
}

# 启动单个服务：启动后检测，未成功则重试（默认 3 次）
start_svc_retry() {
  local s=$1 max=${2:-3} i=0
  while [ "$i" -lt "$max" ]; do
    i=$((i + 1))
    echo "--- 启动 $s（第 $i/$max 次）---"
    start_svc "$s"
    if svc_up "$s"; then echo "  [ok] $s 启动成功"; return 0; fi
    echo "  [warn] $s 启动后检测未通过，准备重试"
    sleep 2
  done
  echo "  [fail] $s 经 $max 次尝试仍未能成功启动"; return 1
}

# 停止单个服务：停止后检测，未成功则重试（默认 3 次）
stop_svc_retry() {
  local name=$1 pat=$2 max=${3:-3} i=0
  while [ "$i" -lt "$max" ]; do
    i=$((i + 1))
    echo "--- 停止 $name（第 $i/$max 次）---"
    stop_one "$name" "$pat"
    if ! pgrep -f "$pat" >/dev/null 2>&1; then echo "  [ok] $name 已停止"; return 0; fi
    echo "  [warn] $name 停止后检测仍在运行，准备重试"
    sleep 2
  done
  echo "  [fail] $name 经 $max 次尝试仍未能停止"; return 1
}

# 已在运行且非强制 → 跳过（不造重复实例，也不打断 watchdog 托管的实例）
skip_if_running() {
  local port=$1 name=$2
  [ "$FORCE" = "1" ] && return 1
  if port_listen "$port"; then echo "  [skip] $name 已在运行 (:$port)"; return 0; fi
  return 1
}

# 按进程特征串判定是否已在运行（用于无 HTTP 端口的服务，如 worker）
skip_if_running_pat() {
  local pat=$1 name=$2
  [ "$FORCE" = "1" ] && return 1
  if pgrep -f "$pat" >/dev/null 2>&1; then echo "  [skip] $name 已在运行"; return 0; fi
  return 1
}

start_compute() {
  echo "[1/4] Python 计算服务 ($CPORT)"
  skip_if_running "$CPORT" compute && return 0
  if [ ! -x "$ROOT/services/compute/.venv/bin/python" ]; then
    echo "  [fail] 缺少 $ROOT/services/compute/.venv/bin/python（请先建虚拟环境）"; return 1
  fi
  setsid bash -c "cd $ROOT/services/compute && exec .venv/bin/python -m gunicorn -k uvicorn.workers.UvicornWorker -w 4 --bind 127.0.0.1:$CPORT compute_api.main:app" \
    >> "$LOGDIR/python-compute.log" 2>&1 < /dev/null &
  wait_ready "$CPORT" /docs compute 40
}

start_backend() {
  echo "[2/4] 后端 NestJS ($BPORT)"
  skip_if_running "$BPORT" backend && return 0
  if [ ! -f "$ROOT/apps/api/dist/src/main.js" ]; then
    echo "  [fail] 缺少 apps/api/dist/src/main.js —— 请先 pnpm build:api"; return 1
  fi
  setsid bash -c "cd $ROOT/apps/api && exec node dist/src/main" \
    >> "$LOGDIR/backend.log" 2>&1 < /dev/null &
  wait_ready "$BPORT" / backend 40
}

start_worker() {
  echo "[3/4] 任务 Worker (main-worker)"
  skip_if_running_pat "$WPAT" worker && return 0
  if [ ! -f "$ROOT/apps/api/dist/src/main-worker.js" ]; then
    echo "  [fail] 缺少 apps/api/dist/src/main-worker.js —— 请先 pnpm build:api"; return 1
  fi
  setsid bash -c "cd $ROOT/apps/api && exec node dist/src/main-worker" \
    >> "$LOGDIR/worker.log" 2>&1 < /dev/null &
  # worker 无 HTTP 端口，仅等待进程存在
  local i=0
  while [ "$i" -lt 20 ]; do
    pgrep -f "$WPAT" >/dev/null 2>&1 && { echo "  [ok] worker 已启动"; return 0; }
    sleep 1; i=$((i + 1))
  done
  echo "  [fail] worker 启动失败，请查 $LOGDIR/worker.log"; return 1
}

start_web() {
  echo "[4/4] 前端 Vite ($WPORT)"
  skip_if_running "$WPORT" web && return 0
  # pnpm 工作区：用 workspace 命令启动，避免 hoisted 依赖后各 app/node_modules/.bin 缺失
  setsid bash -c "cd $ROOT && exec pnpm --filter aeolus-workbench-web run dev" \
    >> "$LOGDIR/web.log" 2>&1 < /dev/null &
  wait_ready "$WPORT" / web 40
}

start_watchdog() {
  if pgrep -f "$PAT_WATCHDOG" >/dev/null 2>&1; then echo "  [skip] 看门狗已在运行"; return 0; fi
  setsid bash "$ROOT/scripts/manage.sh" watch >> "$LOGDIR/watchdog.out" 2>&1 < /dev/null &
  echo "  [ok] 看门狗已拉起（端口死亡/卡死自愈）"
}

# ---------------- 停止相关 ----------------
PAT_WEB='vite --port 5173 --strictPort'
PAT_BACKEND='dist/src/main$'
PAT_WORKER='dist/src/main-worker$'
PAT_COMPUTE='compute_api[.]main:app'
PAT_WATCHDOG='manage[.]sh .*watch'   # 匹配 `bash .../manage.sh watch` 守护进程

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
      *) echo "用法: bash scripts/manage.sh start [compute|backend|worker|web] [--force] [--no-watchdog]"; exit 1 ;;
    esac
  done
  [ ${#SERVICES[@]} -eq 0 ] && SERVICES=(compute backend worker web)
  local rc=0
  for s in "${SERVICES[@]}"; do
    start_svc_retry "$s" 3 || rc=1
  done
  [ "$WITH_WATCHDOG" = "1" ] && { echo "[watchdog]"; start_watchdog; }
  echo; health_check || rc=1
  echo; echo "日志目录：$LOGDIR"
  exit $rc
}

cmd_stop() {
  local SERVICES=("$@")
  [ ${#SERVICES[@]} -eq 0 ] && SERVICES=(web worker backend compute)
  echo "[watchdog]"; stop_one watchdog "$PAT_WATCHDOG"
  local n=0
  for s in "${SERVICES[@]}"; do
    n=$((n + 1)); echo "[$n/${#SERVICES[@]}]"
    case "$s" in
      web) stop_svc_retry "前端 Vite (5173)" "$PAT_WEB" ;;
      worker) stop_svc_retry "任务 Worker" "$PAT_WORKER" ;;
      backend) stop_svc_retry "后端 NestJS (8787)" "$PAT_BACKEND" ;;
      compute) stop_svc_retry "Python 计算 (8900)" "$PAT_COMPUTE" ;;
      *) echo "  未知服务：$s（可选 web|worker|backend|compute）" ;;
    esac
  done
  echo; echo "已停止：${SERVICES[*]}   启动：bash scripts/manage.sh start"
  echo "提示：看门狗已一并停止（否则它会在约 60s 内把服务重新拉起来）。"
  echo "      下一次 start 会默认重新拉起看门狗；不想自愈监管则用 start --no-watchdog。"
  echo "      只重启某个服务而不丢看门狗：用 bash scripts/manage.sh restart <服务>（会自动恢复）"
}

cmd_restart() {
  local FORCE_WATCHDOG=0 SERVICES=()
  for a in "$@"; do
    case "$a" in
      --watchdog) FORCE_WATCHDOG=1 ;;
      compute|backend|web) SERVICES+=("$a") ;;
      *) echo "用法: bash scripts/manage.sh restart [compute|backend|worker|web] [--watchdog]"; exit 1 ;;
    esac
  done
  [ ${#SERVICES[@]} -eq 0 ] && SERVICES=(compute backend worker web)

  # 先记录并停掉 watchdog，避免重启窗口内它抢先拉起服务
  local WD_WAS_RUNNING=0
  pgrep -f "$PAT_WATCHDOG" >/dev/null 2>&1 && WD_WAS_RUNNING=1
  echo "[watchdog]"; stop_one watchdog "$PAT_WATCHDOG"

  local rc=0
  for s in "${SERVICES[@]}"; do
    echo "=== 重启 $s ==="
    case "$s" in
      web) stop_svc_retry "前端 Vite (5173)" "$PAT_WEB" || rc=1 ;;
      worker) stop_svc_retry "任务 Worker" "$PAT_WORKER" || rc=1 ;;
      backend) stop_svc_retry "后端 NestJS (8787)" "$PAT_BACKEND" || rc=1 ;;
      compute) stop_svc_retry "Python 计算 (8900)" "$PAT_COMPUTE" || rc=1 ;;
    esac
    # 端口释放窗口：stop 后立刻 start 容易撞上 TIME_WAIT / 旧进程未完全退出
    sleep 1
    start_svc_retry "$s" 3 || rc=1
  done

  # 按原状态恢复 watchdog（原本没跑就不自作主张拉起）
  local need_wd=$WD_WAS_RUNNING
  [ "$FORCE_WATCHDOG" = "1" ] && need_wd=1
  if [ "$need_wd" = "1" ]; then echo "=== 恢复 watchdog ==="; start_watchdog; fi

  echo; health_check || rc=1
  echo; echo "已重启：${SERVICES[*]}"
  exit $rc
}

# 看门狗监控循环：复用上面的 start_* 函数做自愈，避免与 manage.sh 里的启动逻辑重复。
# 由 cmd_start 通过 `setsid ... manage.sh watch` 拉起为独立后台进程；cmd_stop 会一并停掉它。
cmd_watch() {
  log(){ echo "$(date '+%F %T') $*" | tee -a "$LOGDIR/watchdog.log"; }
  local fb=0 fc=0 fw=0 fwk=0
  log "[watch] started; monitoring $BPORT / $CPORT / $WPORT (RESTART_WEB=$RESTART_WEB)"
  while true; do
    if port_listen $BPORT && probe $BPORT 20; then fb=0
    else
      fb=$((fb+1)); log "[warn] backend unhealthy (fail $fb/$MAX_FAIL)"
      if [ $fb -ge $MAX_FAIL ]; then pkill -KILL -f "$PAT_BACKEND" 2>/dev/null; sleep 1; start_backend; fb=0; fi
    fi
    if port_listen $CPORT && probe $CPORT 10; then fc=0
    else
      fc=$((fc+1)); log "[warn] compute unhealthy (fail $fc/$MAX_FAIL)"
      if [ $fc -ge $MAX_FAIL ]; then pkill -KILL -f "$PAT_COMPUTE" 2>/dev/null; sleep 1; start_compute; fc=0; fi
    fi
    if port_listen $WPORT && probe $WPORT 10; then fw=0
    else
      fw=$((fw+1)); log "[warn] web unhealthy (fail $fw/$MAX_FAIL)"
      if [ $fw -ge $MAX_FAIL ]; then
        if [ "$RESTART_WEB" = "1" ]; then pkill -KILL -f "$PAT_WEB" 2>/dev/null; sleep 1; start_web; else log "[warn] web down 但 RESTART_WEB=0，仅告警不重启"; fi
        fw=0
      fi
    fi
    # worker 无 HTTP 端口，仅按进程存活判定
    if pgrep -f "$PAT_WORKER" >/dev/null 2>&1; then fwk=0
    else
      fwk=$((fwk+1)); log "[warn] worker not running (fail $fwk/$MAX_FAIL)"
      if [ $fwk -ge $MAX_FAIL ]; then pkill -KILL -f "$PAT_WORKER" 2>/dev/null; sleep 1; start_worker; fwk=0; fi
    fi
    sleep $PROBE_INTERVAL
  done
}

# 仅做健康检查并打印状态，不改任何服务
cmd_status() {
  health_check
  exit $?
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  restart) shift; cmd_restart "$@" ;;
  status) shift; cmd_status "$@" ;;
  watch) shift; cmd_watch "$@" ;;
  *) echo "用法: bash scripts/manage.sh {start|stop|restart|status|watch} [compute|backend|worker|web] [...]"; exit 1 ;;
esac
