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

# 2.5) GitHub 只读 deploy key（服务器靠它 git pull；与本地/其他机器 SSH 互不干扰）
#      不配这个，下面 git clone 会 Permission denied (publickey)。
DEPLOY_KEY=~/.ssh/aeolus_deploy
mkdir -p ~/.ssh && chmod 700 ~/.ssh
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

# 4) Python 虚拟环境 + 依赖
# venv 必须建在 python/ 下：venv_guard / run.sh / compute_api 都按此路径查找
python3 -m venv python/.venv
python/.venv/bin/python -m pip install -r python/requirements.txt
# 可选（按你实际跑的模块）：delivery 入库 / 表格解析
# python/.venv/bin/python -m pip install psycopg2-binary openpyxl xlrd

# 5) 前端构建（dist 被 .gitignore 忽略，需每次构建；构建在 ECS 上完成）
cd web && npm install && npm run build && cd ..

# 6) 后端构建（NestJS：TypeScript → backend/dist，systemd 里直接 node dist/src/main）
cd backend && npm ci && npm run build && cd ..

# 7) 生成环境文件骨架（.env 被 gitignore，全新部署需从模板生成；密钥项稍后补全）
#    单一配置来源 = 仓库根 .env（/opt/aeolusdata/.env）：systemd 的 EnvironmentFile 注入同一份，
#    Nest 显式读它，Python 回读它兜底。不再维护 backend/.env（避免两份漂移）。
if [ ! -f /opt/aeolusdata/.env ]; then
  cp backend/.env.example /opt/aeolusdata/.env
fi

echo "== setup 完成 =="
echo "下一步（都是手动、一次性）："
echo "  1) 编辑 /opt/aeolusdata/.env，把 AUTH_TOKEN 与 NEST_AUTH_TOKEN 改成同一段强随机值"
echo "     （二者必须一致；这是唯一配置来源，Python 计算服务读取该文件兜底）"
echo "       openssl rand -hex 24   # 生成一段随机值粘进去"
echo "  2) 把本地凭据单独传上来（这些不在仓库里，必须手动带外传输）："
echo "       scp -r backend/aeolus_sdk/cookie.txt \\"
echo "             backend/minio_config.json \\"
echo "             backend/data/jobs/delivery/db_config.json \\"
echo "             root@<IP>:/opt/aeolusdata/backend/对应路径"
echo "     —— 缺 cookie.txt / minio / db_config 只影响对应取数模块，不影响启动；按需补"
echo "  3) 启用并启动两个服务："
echo "       sudo cp deploy/aeolus-backend.service deploy/aeolus-compute.service /etc/systemd/system/ \\"
echo "       && sudo systemctl daemon-reload \\"
echo "       && sudo systemctl enable --now aeolus-backend aeolus-compute"
echo "       （旧架构的单体 server.py（8917）已整体删除，只需启用上面两个服务）"
echo "       sudo journalctl -u aeolus-backend -n 30 --no-pager   # 确认无报错、看到 bootstrap"
echo "  4) 配置 nginx 反代（只暴露 443，证书放 /etc/nginx/ssl/aeolus/）："
echo "       sudo cp deploy/nginx-aeolus.conf /etc/nginx/sites-available/aeolus \\"
echo "       && sudo ln -s /etc/nginx/sites-available/aeolus /etc/nginx/sites-enabled/ \\"
echo "       && sudo nginx -t && sudo systemctl reload nginx"

# ---- Alibaba Cloud Linux 3 替代步骤（默认 python3 是 3.8，Pillow 12.3 需 >=3.9）----
# dnf install -y python3.11 python3.11-pip nginx git curl fonts-noto-cjk
# 然后用 python3.11 -m venv python/.venv 代替上面的 python3 -m venv python/.venv
# Node 用 dnf 或 nvm 装 18+ 即可
