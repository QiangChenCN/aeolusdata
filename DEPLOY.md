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
   aeolus-backend.service（systemd）→ NestJS 后端（:8787，路由/鉴权/编排/静态托管）
   aeolus-compute.service（systemd）→ Python 计算服务（:8900，仅 127.0.0.1 回访）
        │
        ▼
   nginx（certbot 每子域名一张证）
   aeolus.qixinchen.top → 127.0.0.1:8787
```

要点：
- **前端**是 Vite 工程（`web/`），构建产物 `web/dist` 被 `.gitignore` 忽略，**必须重新 `npm run build`** 才会生效；NestJS 托管的正是 `web/dist/index.html`。
- **后端** 分两层：NestJS（`backend/`）负责路由 / 鉴权 / 取数 / 加工 / 编排；Python 计算服务（`python/compute_service/`）只做大数据计算。计算侧 handler 在同包 `python/compute_service/handlers.py` —— 原根目录 `server.py` 的计算子集，已按 AST 依赖闭包精确迁入（路由 handler 源码逐字符一致）。`server.py` **已删除**：其 HTTP 外壳（单体 8917 入口）早已移除，其后仅作为 handler 库被 `import`，现已彻底退场。
- **RBAC + 数据权限** 均由 NestJS 承担（`backend/src/modules/auth/`：用户库 `.users.json`、角色 `.roles.json`、策略 `.pwpolicy.json`、审计 `.audit.jsonl`、数据权限 `.data_perms.json`）。Nest 按 RBAC + 数据权限算好 `x-scope` 随请求下发给 Python 计算服务，**Python 侧不再持有任何权限规则**（原 `core/dataperm.py` 兜底查询已删除）。这些状态文件全部位于 `backend/data/`、gitignore，**不在仓库**，Nest 首次启动自动 bootstrap。

---

## 2. 本地提交规范（重要）

⚠️ **不要 `git add -A` / `git add .`**。以下文件是**运行时缓存**，已跟踪但会反复变化，提交时必须排除：

- `python/dashboard/data/*.json`（**原始层**：运单 / 考勤 / 排班 / 违规明细；由 NestJS 落盘）
- `python/dashboard/standard/cache/pace_state.json`（反爬节奏下限，Nest 与 Python 共用）

> 2026-09-23：原先同目录的**结果层**（`rider_*.json` / `ach_*.json`）已删除 —— 全仓无读取方。

只暂存源码（示例，按实际改动增删）：

```bash
git add .gitignore \
        backend/src/ \
        python/dashboard/standard/attend_period_source.py \
        python/dashboard/standard/rider_dimension.py \
        python/dashboard/standard/rider_dimension.py \
        python/dashboard/standard/site_orders.py \
        python/dashboard/standard/assessment_overview.py \
        index.html run.sh \
        python/compute_service/ \
        web/src/ \

        backend/data/.data_perms.json org_tree.json
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

# 2) 重建前端 —— 关键！NestJS 托管 web/dist，只 pull 不会更新页面
cd web && npm install && npm run build && cd ..

# 3) 重建后端并重启两个服务（新的 NestJS 代码 / RBAC 才生效）
cd backend && npm ci && npx nest build && cd ..
systemctl restart aeolus-backend aeolus-compute

# 4) 确认启动正常 + 看到 bootstrap 提示
journalctl -u aeolus-backend -n 30 --no-pager

# 5) 验证深链接回退（History 路由生效的关键）
#    前端已去掉 URL 里的 #，页面路径（/tasks、/bot/global …）会直接打到服务器。
#    下列请求都应返回 200 且 Content-Type 为 text/html；返回 404 说明 nginx 拦了。
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -H "Accept: text/html" http://127.0.0.1:8787/tasks
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -H "Accept: text/html" http://127.0.0.1:8787/bot/global
#    健康检查必须仍是 JSON（不能被回退规则吞掉）
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://127.0.0.1:8787/health
```

重启后若 `backend/data/` 下无 `.users.json`，NestJS 自动建默认管理员并打印告警（见第 5 节）。

> ⚠️ **重启 = 全体登出**：会话（session）保存在 NestJS **内存**里，不落盘。每次重启 `aeolus-backend`
> 都会清空所有会话，「记住我」的用户也会被要求重新登录。排"上线后要输入密码"的现象时先看这里。

---

## 5. RBAC 初始化与登录

- 首次启动无用户库 → NestJS `auth.service.ts` 的 `ensureBootstrap()` 自动建 `admin`：
  - 密码取环境变量 `WB_ADMIN_PASSWORD`，否则默认 **`admin123`**（启动会打印告警）。
- 角色与策略文件缺失时自动种子（`backend/data/.roles.json` / `backend/data/.pwpolicy.json`）。

> **迁移提醒（从旧版升级时）**：这些文件原本在仓库根（`/.users.json` 等），现挪到 `backend/data/`。
> 升级服务器时务必把旧的 `./.users.json`、`./.roles.json`、`./.pwpolicy.json`、`./.audit.jsonl`、
> `./.data_perms.json` **先拷贝到 `backend/data/`**，否则 bootstrap 会用默认 `admin/admin123` 重建一份，
> 导致既有账号丢失、且触发未改密告警。

**登录**：浏览器开 `https://aeolus.qixinchen.top` → `admin` / `admin123` → 立刻在「系统设置 → 个人」改密码（公网勿留默认口令）。

**想用强口令一步到位**：重启前在 `/etc/systemd/system/aeolus.service` 的 `[Service]` 加

```ini
Environment=WB_ADMIN_PASSWORD=你的强口令
```

然后 `systemctl daemon-reload && systemctl restart aeolus`，bootstrap 即采用该口令，跳过 `admin123`。

**手动管理用户**（`.users.json` 位于 `backend/data/`、不在仓库，服务器上是独立的一份）：

首选 Web 端「系统设置 → 账号」（仅管理员可见）。需要脚本化时用 NestJS 的 admin API：

```bash
# 列表（先登录拿 token）
TOKEN=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"你的口令"}' https://<host>/api/auth/signin | jq -r .token)

curl -H "X-Token: $TOKEN" https://<host>/api/admin/users
curl -H "X-Token: $TOKEN" https://<host>/api/admin/roles

# 新增（角色：admin / operator / viewer）
curl -X POST -H "X-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"username":"某人","password":"口令","role":"operator"}' https://<host>/api/admin/user
# 改角色 / 重置密码 / 删除
curl -X POST -H "X-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"username":"某人","role":"viewer"}'   https://<host>/api/admin/user/update
curl -X POST -H "X-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"username":"某人","password":"新口令"}' https://<host>/api/admin/user/reset-pw
curl -X POST -H "X-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"username":"某人"}'                   https://<host>/api/admin/user/delete
```

> 旧的 `python manage_users.py ...` CLI 已随 Python 侧 RBAC（`core/auth.py`）一并删除：
> 用户库虽是同一份 `backend/data/.users.json`，但**用户管理只应有 NestJS 一个入口**，不要维护第二份实现。

> 旧会话失效（如重启清空了内存会话）会被重定向到**登录页** —— 正常。

---

## 6. 常见坑速查

| 现象 | 原因 | 解决 |
|------|------|------|
| 改了前端但页面没变 | `web/dist` 未重建（gitignored） | 服务器上 `cd web && npm run build` 后重启 |
| 访问 `/tasks` 等深层路由刷新后 404（URL 已无 `#`） | nginx 试图从磁盘找同名静态文件，没反代给 Nest | nginx 的 `location /` 一律 `proxy_pass` 到 8787（见第 8 节），或用第 4 节的 curl 自检 |
| 登录成功后一刷新又要登录 | 会话在 Nest 内存里：后端重启即全部失效；或 Cookie 未种下（`Secure` 在 http 下无效 / 非 HTTPS 域名 | 确认未频繁重启；确认访问的是 HTTPS 域名而不是内网 http |
| 服务器登录不了 | `backend/data/.users.json` 不在仓库，首次需 bootstrap | 用 `admin/admin123`，或设 `WB_ADMIN_PASSWORD` |
| 本地 `git push` 公钥拒绝 | SSH key 没进 agent | 用 HTTPS remote + GCM（见第 3 节） |
| 提交里混入一堆 `*.json` | 缓存文件被跟踪且反复变 | 暂存时排除（见第 2 节），或 `git rm --cached` 后加进 `.gitignore` |
| `send` 钉钉报群名匹配不明确 | 目标群名歧义或群不存在，NestJS 侧 `dingtalk` 模块按群名解析失败（匹配度不足/并列） | 在调用处传更准确的群名，或传 `openConversationId`（cid 开头）；群名解析逻辑全在 `backend/src/modules/dingtalk/dingtalk.service.ts` 的 `resolveGroup` |
| 钉钉发送提示 `dws` 相关路径错误 | dws 由 **NestJS** 调用（Python 不再直调）；`DING_DWS_JS`/`DING_DWS_BIN` 在 `backend/.env` 配置 | `npm i -g dingtalk-workspace-cli` 让 dws 进 PATH，或确认 `backend/.env` 的 `DING_DWS_JS` 指向正确路径 |
| Python job 钉钉调用 401 | job 经 `python/common/nest_client` 回調 NestJS 需要机器令牌 `NEST_AUTH_TOKEN`（由 TaskRunner 自动从 `AUTH_TOKEN` 注入）；未配置则被 AccessGuard 拒绝 | 确认 `backend/.env` 有 `AUTH_TOKEN`，且任务由 Nest 的 TaskRunner 拉起（而非手动裸跑 Python） |

---

## 7. 钉钉机器人配置（多凭据）

运力达成等钉钉机器人由 NestJS 的 `bot` 模块承载，与服务器上 `/opt/dingbot` 的旧 Python 机器人**是两套独立系统**，互不相干，不要混淆。

管理入口是前端「机器人配置」菜单（仅 `admin:bot` 权限可见）。

### 7.1 落盘配置文件（均位于仓库根，已被 `.gitignore` 忽略，服务器上是独立一份）

- **`bot_config.json`**：凭据分组数组 + 全局总开关（查询超时已改为按实例设置，不在此处）。
  ```json
  {
    "credentials": [
      { "id": "dingtalk:default", "label": "默认", "clientId": "…", "secret": "…", "enabled": true, "type": "dingtalk" }
    ],
    "botEnabled": true
  }
  ```
- **`bot_manifest.json`**：实例运行时覆盖（在线启停 + 凭据绑定 + 查询超时），重启保留、无需改源码。
  ```json
  { "overrides": { "std-achievement": { "enabled": true, "credentialsRef": "dingtalk:default", "queryTimeout": 60 } } }
  ```

> **向后兼容**：老格式的单组字段 `dingClientId` / `dingClientSecret` 会被**读取时自动迁移**为 `dingtalk:default` 凭据组，历史部署升级无需手动改文件；首次在前端保存凭据组即会落盘为新结构（老字段被清掉）。建议升级后到「凭据分组」补一份 `dingtalk:default` 组以固化。

### 7.2 前端操作（「机器人配置」菜单）

1. **凭据分组卡片**：列出所有钉钉应用凭据，可新增 / 编辑 / 删除（Secret 脱敏，编辑时留空表示不修改）。被实例引用的凭据**不可删除**（需先在实例中解绑）。
2. **机器人实例与状态卡片**：
   - 每行「启用」开关 = 在线启停（持久化到 `bot_manifest.json`；禁用即退出消息分发，不影响其它连接）。
   - 「凭据分组」下拉 = 把实例绑定到某凭据组。每个被启用的实例引用的凭据组，各自建立一条**独立**的 Stream 长连接（多连接网关）。
   - 「连接明细」表每 15s 自动刷新，展示每个凭据分组的连接状态（已连接 / 未连接）。
3. 改凭据 / 绑定 / 全局开关后，保存即**热重载** Stream 连接，**无需重启** `aeolus-backend` 服务；也可点「重新连接」按钮手动 reload。

### 7.3 部署 / 升级提醒

- 多凭据场景下，卡片推送用的是**对应凭据组**的 token——绑定错了凭据组会导致 `robotCode` 不匹配 / 无权限。改完绑定务必在群里 @机器人 验收（异常应显示「查询超时 / 失败」，而非无限停在「查询中」）。
- 机器人一直停在「查询中」卡片 → 多半是风神 401 / 超时导致卡片终态失败；卡片服务已降级走 webhook，但仍会延迟。检查凭据有效性 / 风神登录态。
- 实例收不到消息 → 凭据分组未绑定 / 该组凭据缺失或失效 / 未触发重连；看「连接明细」定位。
- 权限点 `admin:bot`：GET/POST `/api/bot/*`（config / status / credentials / bots / reload）统一由 `AccessGuard` 按 `permissions.ts` 裁决。

---

## 8. 前端 History 路由（无 `#`）与会话 Cookie

### 8.1 为什么需要 nginx 配合

前端已从 Hash 路由（`/#/tasks`）切到 **History 路由**（`/tasks`）。差别在于：Hash 模式下浏览器永远只
向服务器请求 `/`，服务器从不知道具体路由；切到 History 后，**每一个页面路径都会真实打到服务器**，
服务器必须把未知路径回退到 `index.html`，否则刷新或直接打开链接就是 404。

回退由 **NestJS 负责**（`backend/src/main.ts` 的 SPA 回退中间件）。它注册在 Express 层、早于 Nest 路由，
因此不会落到全局 `AccessGuard`（若改成 Nest 通配路由，冷启动访问深链接会被机器令牌闸门挡成 401 JSON
而不是登录页）。

**nginx 侧要求：** `location /` 必须整体反代给 Nest，不要试图用 `try_files` 在 nginx 层找静态文件或提供
index.html —— 那样 `/tasks` 会 404（或拿到一份没经过机器令牌注入的页面）。推荐写法：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`/api/*` 不需要单独 location —— 走上面这条 `location /` 反代即可（Nest 内部区分 `/api` 与页面路径）。
改完 nginx 记得 `nginx -t && systemctl reload nginx`，再用第 4 节第 5) 步的 curl 自检。

> 另一个前提：回退中间件只在 `web/dist` **存在**时注册，所以服务器上必须已执行
> `cd web && npm run build`（平时 `<distDir>` 也在 ServeController 的候选列表里）。

### 8.2 会话 Cookie 与「记住我」

- 登录后由后端下发 `Set-Cookie: wb_token=…; HttpOnly; SameSite=Lax; Path=/`
  （勾选「记住我」时额外带 `Max-Age=7d`；**不勾选**为会话 Cookie，关浏览器才失效）。
- 令牌不再存 `sessionStorage`/`localStorage`，因此**关闭标签页再打开不会掉登录**（不必关浏览器）。
- 服务端会话采用「滑动空闲窗口 + 绝对上限」双限制：

| | 空闲窗口（滑动续期） | 绝对上限 |
|---|---|---|
| 未勾选记住我 | 12 小时 | 24 小时 |
| 勾选记住我 | 7 天 | 30 天 |

- **`Secure` 标记**：后端按 `req.secure` 决定是否加。本项目**未开启** `app.set('trust proxy')`，而 HTTPS
  由 nginx 终止，因此 Express 认为请求是 http —— 结果是不带 `Secure`。功能不受影响（HTTPS 下浏览器照样
  携带 Cookie，且 `SameSite=Lax` 已挡掉大部分跨站场景）。若想强制 `Secure`，在 `main.ts` 加
  `app.set('trust proxy', 1)`（注意它会同时影响 `req.ip`，让限频改用 `X-Forwarded-For`）。
- **后端重启 = 全体登出**：会话只存在 Nest 进程内存里，不持久化。
