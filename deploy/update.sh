#!/usr/bin/env bash
# 日后更新：在 ECS 上跑一次即可（需已配 GitHub 只读 deploy key）
# 用法：bash /opt/aeolusdata/deploy/update.sh
set -e
cd /opt/aeolusdata

echo "== 拉取最新代码 =="
git pull --ff-only

echo "== 同步 Python 依赖（uv sync --frozen：按 uv.lock 精确复现）=="
# uv sync 会在 venv 缺失时自动创建，因此全新部署同样适用；--frozen 表示
# 不重新解析、严格按锁文件安装（锁文件与 pyproject.toml 不一致时直接报错）。
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
(cd services/compute && uv sync --frozen --no-dev)

echo "== 安装后端依赖并构建（--prod 仅排除 jest/ts-jest 等测试工具；构建工具 @nestjs/cli/typescript 已列入 dependencies，故服务器可独立完成 nest build）=="
cd apps/api && pnpm install --frozen-lockfile --prod && pnpm --filter aeolus-workbench-backend build && cd ..

echo "== 重建前端 =="
cd apps/web && pnpm install --frozen-lockfile && pnpm --filter aeolus-workbench-web build && cd ..

echo "== 生成环境文件（.env 被 gitignore，全新部署需从模板生成；含密钥项请运维补全）=="
# 单一配置来源 = 仓库根 /opt/aeolusdata/.env（Nest 显式读它，Python 回读它兜底）；该文件缺失会导致
# systemd 直接拒绝启动（Failed to load environment files）。故缺失时必须从 apps/api/.env.example 生成。
if [ ! -f /opt/aeolusdata/.env ]; then
  cp apps/api/.env.example /opt/aeolusdata/.env
  echo "已根据 apps/api/.env.example 生成 /opt/aeolusdata/.env（单一配置来源），请按需补全 AUTH_TOKEN / NEST_AUTH_TOKEN 后重启服务"
fi

echo "== 同步 systemd 单元并重启服务 =="
# 单元文件随代码一起版本化，但 systemd 实际读的是 /etc/systemd/system/ 下的副本，
# 只 git pull 不会生效 —— 必须重新拷贝 + daemon-reload。
# 不这么做正是历史故障的根因：单元改了而 systemd 仍按旧定义管理，
# 旧进程脱管成孤儿占着端口，新实例 bind 失败被 Restart=always 无限重试。
cp deploy/aeolusdata-backend.service deploy/aeolusdata-compute.service deploy/aeolusdata-worker.service /etc/systemd/system/

echo "== 端口/孤儿预检：避免 squatting 导致新实例 EADDRINUSE =="
# 历史故障根因：旧后端进程（手动 nohup 起、或改名前 aeolus-backend 单元起的）
# 脱管成孤儿仍占着 8787，systemd 重启新实例时 bind 失败、被 Restart=always 无限重试。
# 这里在重启前主动清理同项目的游离进程 + 改名遗留的旧单元，并确认端口最终空闲。
BACKEND_PORT=8787
# 1) 清理改名遗留的旧单元 aeolus-backend（已被 aeolusdata-backend 取代）
if systemctl list-unit-files 2>/dev/null | grep -q '^aeolus-backend.service'; then
  echo "发现失效旧单元 aeolus-backend.service（已被 aeolusdata-backend 取代），停用并移除"
  systemctl disable --now aeolus-backend.service 2>/dev/null || true
  rm -f /etc/systemd/system/aeolus-backend.service
fi
# 2) 清理 squatting 8787 的同项目孤儿进程（cmd 含 dist/src/main 但非 systemd 持有）
SYSTEMD_PID=$(systemctl show -p MainPID --value aeolusdata-backend 2>/dev/null || true)
for pid in $(ss -ltnp "sport = :$BACKEND_PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true); do
  if [ -n "$SYSTEMD_PID" ] && [ "$pid" = "$SYSTEMD_PID" ]; then
    continue
  fi
  cmd=$(tr '\0' ' ' < /proc/"$pid"/cmdline 2>/dev/null || true)
  if echo "$cmd" | grep -q 'dist/src/main'; then
    echo "清理 squatting $BACKEND_PORT 的游离后端进程 pid=$pid（cmd: $cmd）"
    kill "$pid" 2>/dev/null || true
    sleep 1
    [ -d /proc/"$pid" ] && kill -9 "$pid" 2>/dev/null || true
  else
    echo "警告：端口 $BACKEND_PORT 被非本项目进程 pid=$pid 占用（cmd: $cmd），未自动处理，请人工排查"
  fi
done
# 3) 确认端口最终空闲（新实例即将 bind）
sleep 1
if ss -ltn "sport = :$BACKEND_PORT" 2>/dev/null | grep -q .; then
  echo "警告：预检后 $BACKEND_PORT 仍被占用，下面 restart 可能仍 EADDRINUSE；请先人工排查端口占用"
else
  echo "端口 $BACKEND_PORT 预检通过：无 squatting，可安全重启"
fi

systemctl daemon-reload
systemctl restart aeolusdata-backend
systemctl restart aeolusdata-compute
systemctl restart aeolusdata-worker
systemctl status aeolusdata-backend --no-pager
systemctl status aeolusdata-compute --no-pager
systemctl status aeolusdata-worker --no-pager

echo "== 更新完成 =="
