#!/usr/bin/env bash
# 一次性环境初始化（仅 Ubuntu / Debian 系；Alibaba Cloud Linux 见文件底部注释）
# 用法：把本文件传到 ECS 后 `bash setup.sh`
set -e

# 1) 系统依赖
apt update && apt install -y python3 python3-venv python3-pip curl fonts-noto-cjk nginx git

# 2) Node 22（不再是「仅供前端构建」——后端也要跑在 Node 上）
# ⚠️ 必须 >= 22：后端 tasks 模块用了内置 node:sqlite（Node 22.5+ 才有，20 会直接
#    报 Cannot find module 'node:sqlite' 而启动失败）。前端构建同样需要。
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# 2.1) 启用 corepack → pnpm 可用（Node 22 自带 corepack 但默认未启用，不启用则
#      下面第 5/6 步 pnpm 命令不存在直接失败）。版本由根 package.json 的
#      packageManager 字段锁定，corepack 据此自动取对应版本。
corepack enable

# 2.5) GitHub 只读 deploy key（服务器靠它 git pull；与本地/其他机器 SSH 互不干扰）
#      不配这个，下面 git clone 会 Permission denied (publickey)。
DEPLOY_KEY=~/.ssh/aeolus_deploy
mkdir -p ~/.ssh && chmod 700 ~/.ssh
# 预信任 github.com 主机指纹：新机器 known_hosts 里没有 github.com，首次 SSH 连接会
# 报「Host key verification failed」直接拒绝（与 deploy key 无关，属全新机必踩坑）。
grep -q "github.com" ~/.ssh/known_hosts 2>/dev/null || \
  ssh-keyscan -t ed25519,rsa github.com >> ~/.ssh/known_hosts 2>/dev/null
if [ ! -f "$DEPLOY_KEY" ]; then
  ssh-keygen -t ed25519 -N "" -f "$DEPLOY_KEY" -C "aeolus-deploy@$(hostname)"
  # 让 git@github.com 默认走这个 key（避免占用你本机默认 id 或要求 ssh-agent）
  grep -q "Host github.com" ~/.ssh/config 2>/dev/null || cat >> ~/.ssh/config <<EOF

Host github.com
  IdentityFile $DEPLOY_KEY
  IdentitiesOnly yes
EOF
  chmod 600 ~/.ssh/config
fi
echo "=================================================================="
echo "请把下面这段【公钥】作为「只读 Deploy Key」加到 GitHub 仓库："
echo "  仓库页面 → Settings → Deploy keys → Add deploy key"
echo "  （Allow write access 不要勾，只读即可）"
echo "  地址：https://github.com/QiangChenCN/aeolusdata/settings/keys"
echo "------------------------------------------------------------------"
cat "$DEPLOY_KEY.pub"
echo "=================================================================="
# 等待你粘贴完并保存；担心手滑可 Ctrl-C 中断，重跑本脚本会从这里续上（key 已存在不会重生成）
read -r -p "已在 GitHub 添加该 deploy key？按回车继续 clone，或 Ctrl-C 中断：" _go

# 3) 拉代码（ECS 上已配好 GitHub 只读 deploy key，见上方 2.5）
cd /opt
rm -rf /opt/aeolusdata
git clone git@github.com:QiangChenCN/aeolusdata.git
cd /opt/aeolusdata

# 4) Python 虚拟环境 + 依赖（由 uv 接管）
#    单一来源 = services/compute/pyproject.toml；锁文件 = services/compute/uv.lock（已入库）。
#    venv 落在 services/compute/.venv，与 deploy/aeolusdata-compute.service 的 ExecStart、
#    以及 scripts/manage.sh / watchdog.sh 三处路径保持一致，不再有两套布局。
#    首次部署的机器通常没有 uv，这里自带安装（已装则跳过）。
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
(cd services/compute && uv sync --frozen --no-dev)

# 4.5) 构建 workspace 共享包 @aeolus/shared（dist 不进 git，全新 clone 没有；
#      api / web 的构建都依赖它，不先建则第 5/6 步报找不到 @aeolus/shared）
pnpm --filter @aeolus/shared build

# 5) 前端构建（dist 被 .gitignore 忽略，需每次构建；构建在 ECS 上完成）
cd apps/web && pnpm install && pnpm --filter aeolus-workbench-web build && cd ..

# 6) 后端构建（NestJS：TypeScript → apps/api/dist，systemd 里直接 node dist/src/main）
cd apps/api && pnpm install --frozen-lockfile && pnpm --filter aeolus-workbench-backend build && cd ..

# 7) 生成环境文件骨架（.env 被 gitignore，全新部署需从模板生成；密钥项稍后补全）
#    单一配置来源 = 仓库根 .env（/opt/aeolusdata/.env）：systemd 的 EnvironmentFile 注入同一份，
#    Nest 显式读它，Python 回读它兜底。不再维护 apps/api/.env（避免两份漂移）。
if [ ! -f /opt/aeolusdata/.env ]; then
  cp apps/api/.env.example /opt/aeolusdata/.env
fi

# 7.5) PostgreSQL 17：安装 + 建角色/库 + 把 DATABASE_URL 写进 .env（幂等，可重复跑）
#      所有持久化数据（RBAC 账号/会话/审计、violation/delivery/visit 历史、任务队列）都在 PG，
#      缺了它后端虽能起（部分功能降级）但业务不可用 —— 因此并入本脚本，避免漏装。
#      从旧服务器迁移的，装好后再用 pg_restore 恢复 pg_dump（见输出提示）。
if ! command -v psql >/dev/null 2>&1 || ! psql --version | grep -q " 17"; then
  apt update
  apt install -y curl ca-certificates gnupg lsb-release
  install -d /usr/share/postgresql-common/pgdg
  curl -fsS https://www.postgresql.org/media/keys/ACCC4CF8.asc | \
    tee /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc >/dev/null
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt update
  apt install -y postgresql-17
fi
systemctl enable postgresql
systemctl start postgresql

if [ "$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='aeolus'\"")" != "1" ]; then
  DB_PASSWORD=$(openssl rand -hex 12)
  su - postgres -c "psql -v ON_ERROR_STOP=1 <<EOF
CREATE ROLE aeolus WITH LOGIN PASSWORD '$DB_PASSWORD';
CREATE DATABASE aeolusdata OWNER aeolus;
GRANT ALL PRIVILEGES ON DATABASE aeolusdata TO aeolus;
EOF"
  # 用 printf 纯写追加，杜绝 .env 混入不可见字符导致连库失败的坑（DEPLOY.md §9.3）
  if grep -q '^DATABASE_URL=' /opt/aeolusdata/.env; then
    echo "警告：.env 已有 DATABASE_URL，未覆盖；请确认其密码与新库一致"
  else
    printf 'DATABASE_URL=postgresql://aeolus:%s@localhost:5432/aeolusdata\n' "$DB_PASSWORD" >> /opt/aeolusdata/.env
  fi
  echo "=================================================================="
  echo "PG 角色 aeolus 密码（务必记好/存密码管理器）：$DB_PASSWORD"
  echo "=================================================================="
else
  echo "PG 角色 aeolus 已存在，跳过建库；确认 .env 的 DATABASE_URL 与库密码一致"
fi

echo "== setup 完成 =="
echo "下一步（都是手动、一次性）："
echo "  0) 从旧服务器迁移的：恢复 PG 数据（先 scp 旧服务器的 pg_dump 到 /tmp）"
echo "       su - postgres -c \"pg_restore -d aeolusdata --no-owner --role=aeolus /tmp/aeolusdata.dump\""
echo "  0.5) 旧服务器无 PG 备份/全新空库：跳过，各表由后端启动时自动建（CREATE TABLE IF NOT EXISTS），"
echo "       业务历史数据靠重新取数回填，账号需在 UI 重建"
echo "  1) 编辑 /opt/aeolusdata/.env，把 AUTH_TOKEN 与 NEST_AUTH_TOKEN 改成同一段强随机值"
echo "     （二者必须一致；这是唯一配置来源，Python 计算服务读取该文件兜底）"
echo "       openssl rand -hex 24   # 生成一段随机值粘进去"
echo "  2) 仓库根 /opt/aeolusdata/.env 是【唯一必须带外传输】的文件"
echo "     （AUTH_TOKEN / NEST_AUTH_TOKEN 缺失时 systemd 因 EnvironmentFile 拒绝启动；"
echo "       可直接从旧服务器整份拷贝，或至少补齐这两项为同一段强随机值）："
echo "       openssl rand -hex 24   # 生成一段随机值，AUTH_TOKEN 与 NEST_AUTH_TOKEN 填同一份"
echo "     —— 风神账号密码：部署后到「系统设置 → 风神设置」页面填写保存（落盘 credentials.json）"
echo "     —— MinIO 图床：部署后到「系统设置 → MinIO 设置」页面填写保存（热生效）"
echo "     —— cookie.txt 无需传输：后端用风神凭据自动 SSO 登录后自行生成，缺失会自动重登自愈"
echo "     —— apps/api/runtime/jobs/delivery/db_config.json 按需（只影响对应取数模块，不影响启动）"
echo "  3) 启用并启动三个服务："
echo "       sudo cp deploy/aeolusdata-backend.service deploy/aeolusdata-compute.service deploy/aeolusdata-worker.service /etc/systemd/system/ \\"
echo "       && sudo systemctl daemon-reload \\"
echo "       && sudo systemctl enable --now aeolusdata-backend aeolusdata-compute aeolusdata-worker"
echo "       （旧架构的单体 server.py（8917）已整体删除，只需启用上面两个服务）"
echo "       sudo journalctl -u aeolusdata-backend -n 30 --no-pager   # 确认无报错、看到 bootstrap"
echo "  4) 配置 nginx 反代（只暴露 443，证书放 /etc/nginx/ssl/aeolus/）："
echo "       sudo cp deploy/nginx-aeolus.conf /etc/nginx/sites-available/aeolus \\"
echo "       && sudo ln -s /etc/nginx/sites-available/aeolus /etc/nginx/sites-enabled/ \\"
echo "       && sudo nginx -t && sudo systemctl reload nginx"

# ---- Alibaba Cloud Linux 3 替代步骤（默认 python3 是 3.8，而 numpy==2.5.4 需 >=3.12）----
# dnf install -y python3.12 python3.12-pip nginx git curl fonts-noto-cjk
# 然后显式指定解释器：
#   (cd services/compute && uv sync --frozen --no-dev --python python3.12)
# Node 用 dnf 或 nvm 装 22+ 即可（后端 tasks 模块依赖内置 node:sqlite，需 >=22.5）
