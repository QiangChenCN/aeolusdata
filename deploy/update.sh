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

echo "== 同步 systemd 单元并重启服务 =="
# 单元文件随代码一起版本化，但 systemd 实际读的是 /etc/systemd/system/ 下的副本，
# 只 git pull 不会生效 —— 必须重新拷贝 + daemon-reload。
# 不这么做正是历史故障的根因：单元改了而 systemd 仍按旧定义管理，
# 旧进程脱管成孤儿占着端口，新实例 bind 失败被 Restart=always 无限重试。
cp deploy/aeolus-backend.service deploy/aeolus-compute.service /etc/systemd/system/
systemctl daemon-reload
systemctl restart aeolus-backend
systemctl restart aeolus-compute
systemctl status aeolus-backend --no-pager
systemctl status aeolus-compute --no-pager

echo "== 更新完成 =="
