#!/usr/bin/env bash
# 日后更新：在 ECS 上跑一次即可（需已配 GitHub 只读 deploy key）
# 用法：bash /opt/aeolusdata/deploy/update.sh
set -e
cd /opt/aeolusdata

echo "== 拉取最新代码 =="
git pull --ff-only

echo "== 同步 Python 依赖 =="
python/.venv/bin/python -m pip install -r python/requirements.txt

echo "== 重建后端（NestJS）=="
cd backend && npm ci && npm run build && cd ..

echo "== 重建前端 =="
cd web && npm install && npm run build && cd ..

echo "== 重启服务 =="
systemctl restart aeolus-backend
systemctl restart aeolus-compute
systemctl status aeolus-backend --no-pager
systemctl status aeolus-compute --no-pager

echo "== 更新完成 =="
