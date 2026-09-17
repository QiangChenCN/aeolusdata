# 部署手册（DEPLOY）

本仓库的「本地改 → 提交 → 服务器部署」标准流程。每次改完代码照此执行即可。

---

## 1. 架构概览

```
开发机（Windows 写代码）
        │ git push（HTTPS + Git Credential Manager）
        ▼
     GitHub（origin/main）
        │ git pull（服务器 remote 为 SSH）
        ▼
   ECS 服务器 /opt/aeolusdata
        │ npm run build（重建前端）
        ▼
   aeolus.service（systemd）→ server.py（纯标准库，:8917）
        │
        ▼
   nginx（certbot 每子域名一张证）
   aeolus.qixinchen.top → 127.0.0.1:8917
```

要点：
- **前端**是 Vite 工程（`web/`），构建产物 `web/dist` 被 `.gitignore` 忽略，**必须重新 `npm run build`** 才会生效；server 托管的正是 `web/dist/index.html`。
- **后端** `server.py` 纯标准库，自托管前端 + 提供 API。
- **RBAC**（`auth.py` / `dataperm.py`）用户库 `.users.json`、角色 `.roles.json`、策略 `.pwpolicy.json`、审计 `.audit.jsonl` 全部 gitignore，**不在仓库**，服务器首次启动自动 bootstrap。

---

## 2. 本地提交规范（重要）

⚠️ **不要 `git add -A` / `git add .`**。以下文件是**运行时缓存**，已跟踪但会反复变化，提交时必须排除：

- `dashboard/data/*.json`（运单 / 考勤 / 排班抓取结果）
- `dashboard/standard/cache/*.json`（标准达成缓存、限速状态、骑手维度）

只暂存源码（示例，按实际改动增删）：

```bash
git add .gitignore \
        common/ding_common.py \
        dashboard/standard/attend_period_source.py \
        dashboard/standard/refresh_all.py \
        dashboard/standard/rider_dimension.py \
        dashboard/standard/site_orders.py \
        dashboard/standard/assessment_overview.py \
        index.html run.sh \
        server.py server/group_picker.py \
        web/src/ \
        auth.py dataperm.py manage_users.py \
        .data_perms.json org_tree.json
git status --short        # 确认缓存 JSON 仍留在工作区（未暂存）
git commit -m "feat: ..."
```

> 提交前务必 `git status --short` 核对：第一列 `A/M` 的应是源码，缓存 JSON 应只出现在第二列（` M`）或 `??`，表示未暂存。

---

## 3. 推送到 GitHub（鉴权）

本地机器的 SSH key（`~/.ssh/id_ed25519`）**未加载进 ssh-agent**，用 SSH 推会 `Permission denied (publickey)`。因此：

- 本地 `origin` 已改为 **HTTPS**：`git remote set-url origin https://github.com/QiangChenCN/aeolusdata.git`
- 推送靠 **Git Credential Manager**（`credential.helper=manager`）鉴权，浏览器/PAT 登录一次后缓存。

```bash
git push origin main
```

> 服务器的 `origin` 仍是 SSH，与本地无关，互不影响。若服务器 `git pull` 也报公钥拒绝，同样在服务器把 `id_ed25519.pub` 加到 GitHub，或把服务器 remote 也改成 HTTPS。

---

## 4. 服务器部署 runbook

在 ECS 上执行：

```bash
cd /opt/aeolusdata

# 1) 拉代码（SSH remote，只要当初能 clone 就能 pull）
git pull

# 2) 重建前端 —— 关键！server 托管 web/dist，只 pull 不会更新页面
cd web && npm install && npm run build && cd ..

# 3) 重启服务（新的 server.py / RBAC 才生效）
systemctl restart aeolus

# 4) 确认启动正常 + 看到 bootstrap 提示
journalctl -u aeolus -n 30 --no-pager
```

重启后若无 `.users.json`，server 自动建默认管理员并打印告警（见第 5 节）。

---

## 5. RBAC 初始化与登录

- 首次启动无用户库 → `auth.ensure_bootstrap()` 自动建 `admin`：
  - 密码取环境变量 `WB_ADMIN_PASSWORD`，否则默认 **`admin123`**（启动会打印告警）。
- 角色与策略文件缺失时自动种子（`.roles.json` / `.pwpolicy.json`）。

**登录**：浏览器开 `https://aeolus.qixinchen.top` → `admin` / `admin123` → 立刻在「系统设置 → 个人」改密码（公网勿留默认口令）。

**想用强口令一步到位**：重启前在 `/etc/systemd/system/aeolus.service` 的 `[Service]` 加

```ini
Environment=WB_ADMIN_PASSWORD=你的强口令
```

然后 `systemctl daemon-reload && systemctl restart aeolus`，bootstrap 即采用该口令，跳过 `admin123`。

**手动管理用户**（`.users.json` 不在仓库，服务器上是独立的一份）：

```bash
python manage_users.py add <用户名> <角色> [--pw 密码]   # 角色：admin / operator / viewer
python manage_users.py list
python manage_users.py reset-pw <用户名> [--pw 密码]
python manage_users.py disable <用户名>
python manage_users.py enable  <用户名>
```

> 旧会话在新 RBAC 下会失效，被重定向到登录框 —— 正常。

---

## 6. 常见坑速查

| 现象 | 原因 | 解决 |
|------|------|------|
| 改了前端但页面没变 | `web/dist` 未重建（gitignored） | 服务器上 `cd web && npm run build` 后重启 |
| 服务器登录不了 | `.users.json` 不在仓库，首次需 bootstrap | 用 `admin/admin123`，或设 `WB_ADMIN_PASSWORD` |
| 本地 `git push` 公钥拒绝 | SSH key 没进 agent | 用 HTTPS remote + GCM（见第 3 节） |
| 提交里混入一堆 `*.json` | 缓存文件被跟踪且反复变 | 暂存时排除（见第 2 节），或 `git rm --cached` 后加进 `.gitignore` |
| `send` 钉钉报 `OPEN_CID_INVALID` | 群 ID 传成了 `conversationId`，dws 要 `openConversationId` | 改正 `find_group.py` / 发送侧 ID 来源 |
| 钉钉发消息 `C:/Users/...` 路径错误 | 服务器未装 dws，回退到写死的 Windows 路径 | `npm i -g dingtalk-workspace-cli`，或设 `DING_DWS_BIN` |
