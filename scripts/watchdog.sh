#!/usr/bin/env bash
# watchdog.sh —— Aeolus 三服务看门狗（开发机用，非 systemd 环境）
#
# 作用：后端(8787) / Python 计算(8900) / 前端(5173) 任一「端口死亡」或「HTTP 探测超时(卡死)」，
#       连续失败 MAX_FAIL 次后，按与原启动一致的方式自动重启，避免人工干预。
#
# 本脚本由 scripts/manage.sh 在 --watchdog 时拉起 / stop 时一并停掉，不单独手动调用。
#
# 前端(5173)默认只告警不自动重启（RESTART_WEB=0），以免误杀你手动起的 vite 开发服务器；
# 如需前端也自愈，把下面 RESTART_WEB 改成 1。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/apps/api/runtime/logs/watchdog.log"
BPORT=8787; CPORT=8900; WPORT=5173
PROBE_INTERVAL=30
TIMEOUT_B=20; TIMEOUT_C=10; TIMEOUT_W=10
MAX_FAIL=2
RESTART_WEB=0

mkdir -p "$(dirname "$LOG")"
log(){ echo "$(date '+%F %T') $*" | tee -a "$LOG"; }

# 端口是否在监听
port_listen(){
  ss -ltn 2>/dev/null | grep -q ":$1 "
}

# HTTP 探测：能连上并拿到任意响应视为健康（返回 0）
probe(){
  local port=$1 timeout=$2
  curl -s -o /dev/null -m "$timeout" "http://127.0.0.1:$port/" >/dev/null 2>&1
}

restart_backend(){
  log "[restart] backend (8787) — 按原命令 node dist/src/main 拉起"
  pkill -KILL -f "dist/src/main$" 2>/dev/null; sleep 1
  setsid bash -c "cd $ROOT/apps/api && exec node dist/src/main" >> "$ROOT/apps/api/runtime/logs/backend.log" 2>&1 < /dev/null &
}
restart_compute(){
  log "[restart] compute (8900) — 按原命令 gunicorn + UvicornWorker 拉起"
  pkill -KILL -f "compute_api[.]main:app" 2>/dev/null; sleep 1
  setsid bash -c "cd $ROOT/services/compute && exec .venv/bin/python -m gunicorn -k uvicorn.workers.UvicornWorker -w 4 --bind 127.0.0.1:8900 compute_api.main:app" >> "$ROOT/apps/api/runtime/logs/python-compute.log" 2>&1 < /dev/null &
}
restart_web(){
  log "[restart] web (5173) — 按原命令 vite 拉起"
  pkill -KILL -f "vite --port 5173 --strictPort" 2>/dev/null; sleep 1
  setsid bash -c "cd $ROOT/apps/web && exec node node_modules/.bin/vite --port 5173 --strictPort" >> "$ROOT/apps/api/runtime/logs/web.log" 2>&1 < /dev/null &
}

fb=0; fc=0; fw=0
log "[watchdog] started; monitoring $BPORT / $CPORT / $WPORT (RESTART_WEB=$RESTART_WEB)"
while true; do
  if port_listen $BPORT && probe $BPORT $TIMEOUT_B; then fb=0
  else
    fb=$((fb+1)); log "[warn] backend unhealthy (fail $fb/$MAX_FAIL)"
    if [ $fb -ge $MAX_FAIL ]; then restart_backend; fb=0; fi
  fi

  if port_listen $CPORT && probe $CPORT $TIMEOUT_C; then fc=0
  else
    fc=$((fc+1)); log "[warn] compute unhealthy (fail $fc/$MAX_FAIL)"
    if [ $fc -ge $MAX_FAIL ]; then restart_compute; fc=0; fi
  fi

  if port_listen $WPORT && probe $WPORT $TIMEOUT_W; then fw=0
  else
    fw=$((fw+1)); log "[warn] web unhealthy (fail $fw/$MAX_FAIL)"
    if [ $fw -ge $MAX_FAIL ]; then
      if [ "$RESTART_WEB" = "1" ]; then restart_web; else log "[warn] web down 但 RESTART_WEB=0，仅告警不重启"; fi
      fw=0
    fi
  fi

  sleep $PROBE_INTERVAL
done
