#!/usr/bin/env bash
# 一次性环境初始化（仅 Ubuntu / Debian 系；Alibaba Cloud Linux 见文件底部注释）
# 用法：把本文件传到 ECS 后 `bash setup.sh`
set -e

# 1) 系统依赖
apt update && apt install -y python3 python3-venv python3-pip curl fonts-noto-cjk nginx git

# 2) Node 20（仅供前端 build；若改为本地构建前端可跳过这段）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 3) 拉代码（ECS 上已配好 GitHub 只读 deploy key，见下方说明）
cd /opt
rm -rf /opt/aeolusdata
git clone git@github.com:QiangChenCN/aeolusdata.git
cd /opt/aeolusdata

# 4) Python 虚拟环境 + 依赖
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
# 可选（按你实际跑的模块）：delivery 入库 / 表格解析
# .venv/bin/python -m pip install psycopg2-binary openpyxl xlrd

# 5) 前端构建（dist 被 .gitignore 忽略，需每次构建；构建在 ECS 上完成）
cd web && npm install && npm run build && cd ..

echo "== setup 完成 =="
echo "下一步："
echo "  1) 把凭据单独传上来：scp aeolus_sdk/cookie.txt common/minio_config.json jobs/delivery/db_config.json .env root@<IP>:/opt/aeolusdata/对应路径"
echo "  2) sudo cp deploy/aeolus.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now aeolus"
echo "  3) sudo cp deploy/nginx-aeolus.conf /etc/nginx/sites-available/aeolus && sudo ln -s /etc/nginx/sites-available/aeolus /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx"

# ---- Alibaba Cloud Linux 3 替代步骤（默认 python3 是 3.8，Pillow 12.3 需 >=3.9）----
# dnf install -y python3.11 python3.11-pip nginx git curl fonts-noto-cjk
# 然后用 python3.11 -m venv .venv 代替上面的 python3 -m venv .venv
# Node 用 dnf 或 nvm 装 18+ 即可
