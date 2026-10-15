#!/usr/bin/env bash
# 日后更新：在 ECS 上跑一次即可（需已配 GitHub 只读 deploy key）
# 用法：bash /opt/aeolusdata/deploy/update.sh
set -e
cd /opt/aeolusdata

echo "== 拉取最新代码 =="
git pull --ff-only

echo "== 同步 Python 依赖（venv 缺失则创建，支持全新部署）=="
if [ ! -d python/.venv ]; then
  python3 -m venv python/.venv
fi
python/.venv/bin/python -m pip install --upgrade pip
python/.venv/bin/python -m pip install -r python/requirements.txt

echo "== 安装后端依赖并构建（--omit=dev 仅排除 jest/ts-jest 等测试工具；构建工具 @nestjs/cli/typescript 已列入 dependencies，故服务器可独立完成 nest build）=="
cd backend && npm ci --omit=dev && npm run build && cd ..

echo "== 重建前端 =="
cd web && npm install && npm run build && cd ..

echo "== 生成环境文件（.env 被 gitignore，全新部署需从模板生成；含密钥项请运维补全）=="
# 单一配置来源 = 仓库根 /opt/aeolusdata/.env（Nest 显式读它，Python 回读它兜底）；该文件缺失会导致
# systemd 直接拒绝启动（Failed to load environment files）。故缺失时必须从 backend/.env.example 生成。
if [ ! -f /opt/aeolusdata/.env ]; then
  cp backend/.env.example /opt/aeolusdata/.env
  echo "已根据 backend/.env.example 生成 /opt/aeolusdata/.env（单一配置来源），请按需补全 AUTH_TOKEN / NEST_AUTH_TOKEN 后重启服务"
fi

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
