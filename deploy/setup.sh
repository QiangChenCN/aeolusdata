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

# 3) 拉代码（ECS 上已配好 GitHub 只读 deploy key，见下方说明）
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

# 6) 后端构建（NestJS：TypeScript → backend/dist，systemd 里直接 node dist/main）
cd backend && npm ci && npm run build && cd ..

echo "== setup 完成 =="
echo "下一步："
echo "  1) 把凭据单独传上来：scp backend/aeolus_sdk/cookie.txt backend/minio_config.json backend/data/jobs/delivery/db_config.json backend/.env .env root@<IP>:/opt/aeolusdata/对应路径"
echo "     —— .env 里要含 NEST_AUTH_TOKEN（= backend/.env 的 AUTH_TOKEN），否则计算服务"
echo "        回访 Nest 取数会被 401 拒绝、静默降级为 Python 本地取数（刷新变慢但不报错）"
echo "  2) sudo cp deploy/aeolus-backend.service deploy/aeolus-compute.service /etc/systemd/system/ \\"
echo "     && sudo systemctl daemon-reload \\"
echo "     && sudo systemctl enable --now aeolus-backend aeolus-compute"
echo "     （旧架构的单体 server.py（8917）已整体删除，其 systemd 单元一并删除；只需启用上面两个服务）"
echo "  3) sudo cp deploy/nginx-aeolus.conf /etc/nginx/sites-available/aeolus && sudo ln -s /etc/nginx/sites-available/aeolus /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx"

# ---- Alibaba Cloud Linux 3 替代步骤（默认 python3 是 3.8，Pillow 12.3 需 >=3.9）----
# dnf install -y python3.11 python3.11-pip nginx git curl fonts-noto-cjk
# 然后用 python3.11 -m venv python/.venv 代替上面的 python3 -m venv python/.venv
# Node 用 dnf 或 nvm 装 18+ 即可
