# 服务器部署可行性评估与检查清单

> 适用场景：把本仓库上传到 Linux 服务器（如 2V4G 公网机）运行。
> 结论先行：**代码本身是跨平台友好的，真正的环境依赖已收敛到很少几项**。
> 钉钉发送**已确认可解**：`dws` 是钉钉官方开源的 `dingtalk-workspace-cli`，服务器独立安装 +
> 无头授权即可，代码通过 `DING_*` 环境变量即可指向，无需改代码。
> 网络层面**已确认非内网**：所有抓数接口都是公网 `*.ele.me` / `*.alibaba.com` 域名（本仓库沙箱实测均可解析并返回 200），
> 只靠登录态（cookie / token）鉴权，不需要 VPN / 白名单 / 企业内网。公网服务器直接用即可。
> 仅「传源码 + 装依赖」不够，下面按阻塞程度列出必做项。

---

## 一、直接结论

| 流水线 | 上传 Linux 默认能否跑 | 卡在哪 |
|---|---|---|
| 风神 SSO 登录 `login.py` | ✅ 能（账密常量在代码内，公网可达） | 无（cookie 自动刷新） |
| Quark 报表取数（Nest `fetch/quark-creds`） | ✅ 能（需系统 curl，公网可达） | 系统 curl |
| 考勤 / 申诉 / 看板 / 装备（Nest 任务流水线） | ✅ 能（需装 dws CLI + 无头授权 + 设字体路径） | 钉钉 dws（公开可装，非硬阻塞） |
| 运单 delivery（raw 抓取） | ✅ 能（需 curl，公网可达） | 系统 curl |
| 运单 delivery（load/verify 入库） | ❌ 不能（除非部署 PG） | Nest 侧 `pg` 驱动 + PostgreSQL 未部署 |
| server 工作台（本机运行任务） | ✅ 能 | 绑定 127.0.0.1，仅本机可用 |
| server 工作台（公网访问） | ⚠️ 能但不安全 | 零鉴权 + /api/file 可读任意文件 |

---

## 二、硬阻塞（不处理必崩）

### 1. 运单库 PostgreSQL（仅 delivery load/verify 节点）—— 仅剩的这一道真硬阻塞
- 入库已迁到 NestJS（`backend/src/modules/fetch/delivery-db.service.ts`，Node `pg` 驱动）→ **不再需要 `psycopg2-binary`**。
- `python/jobs/delivery/db_config.json` 指向 `127.0.0.1:5432 / postgres / admin`（密码明文，已被 gitignore）；该文件仍被 Nest 读取（数据/配置保留在 `python/jobs/` 下）。
- 服务器需：① 运行 PostgreSQL；② 已建库；③ init 节点会 `DROP TABLE ... CASCADE` 重建表。
- 未部署 PG 时：load/verify 节点连接失败；raw 节点（抓 JSONL）仍可独立跑完。

### 2. 系统 curl 缺失
- `backend/src/modules/fetch/quark-creds.service.ts` 用 `child_process` 调系统 `curl`（中性 TLS 指纹，urllib / Node fetch 替代不了）。
- 部署镜像需 `curl` 在 PATH：`which curl` 验证；容器/minimal 可能缺。

### 3. run.sh 是 Windows 脚本（非致命，但别用）
- `run.sh` 内容写死 `.venv/Scripts/python.exe` —— 这是 Windows 的 venv 结构，Linux 上不存在。
- **不影响功能**：`python/venv_guard.py` 已做跨平台（`os.name=="nt"` 区分 `Scripts`/`bin`），直接 `python script.py` 即可，它会自动切到正确解释器。`run.sh` 是个坏掉的便捷脚本，弃用即可。

### 4. 凭据文件 git 不带，需手动传
- `.gitignore` 忽略：`backend/aeolus_sdk/cookie.txt` / `backend/data/quark/`（DA cookie 缓存 + curl 罐） / `backend/minio_config.json` / `python/jobs/delivery/db_config.json` / `.env` 及 Nest 状态文件。
- `git clone` 只拿源码 → 这些全丢。首次跑会：重新登录（风神账密常量在 `login.py` 内，可自动）/ 重兑 DA（需 curl，Nest 自动完成）/ 重配 MinIO（需 minio_config）/ 重连 PG（需 db_config）。
- **必须手动 `scp/rsync` 这些文件**，否则每次重登且依赖账密硬编码可用（或重新走登录流程）。
- 注意：`quark_sdk/` 已删除，Quark 凭证缓存改到 `backend/data/quark/`，**无需手工传**（首次运行自动兑换）。

---

## 三、钉钉发送（可解，非阻塞）—— 已修正结论（2026-09-07）

**澄清：之前版本误判 dws 为「WorkBuddy 私有连接器、服务器必崩」，这是错的。** 实测结论如下：

- `dws` = 钉钉官方 **Apache-2.0 开源**的 `dingtalk-workspace-cli`
  （GitHub: `open-dingtalk/dingtalk-workspace-cli`；npm: `dingtalk-workspace-cli`）。
  WorkBuddy 只是把它打包进自己的 node 目录，服务器可**独立安装，无需 WorkBuddy**。
- **本机实测全部子命令/flag 在公开版均存在**（用本机打包的 1.0.61 跑 `--help` 确认）：
  `chat message send --group/--conversation-id`、`--at-open-dingtalk-ids`、`--format json`、
  `aisearch person`、`sheet csv-get`、`sheet range update`；`auth login --device` 专为
  「SSH / 容器 / 无头环境」设计。
- **凭据持久化**：首次 `dws auth login --device` 后，凭证落盘于 `~/.config/dws/`
  （`profiles.json` / `token.json` / `identity.json`），后续运行自动刷新 token，无需 Keychain。
- **代码侧已 env 可配**（无需改代码）：Nest 钉钉服务（`backend/src/modules/dingtalk/`）用 `DING_DWS_JS` / `DING_NODE_BIN` /
  `DING_FONT_PATH` 三个环境变量覆盖 Windows 硬编码路径。

**服务器落地步骤（详见第六节）：**
```bash
npm install -g dingtalk-workspace-cli@1.0.61   # 锁版本，避免 flag 漂移
dws auth login --device                        # 无头授权，一次性，凭证存 ~/.config/dws/
export DING_DWS_JS="$(npm root -g)/dingtalk-workspace-cli/bin/dws.js"
export DING_NODE_BIN="$(which node)"
export DING_FONT_PATH=/usr/share/fonts/.../NotoSansCJK-Regular.ttc
```

---

## 四、需配置才能跑（非致命）

| 项 | 做法 |
|---|---|
| 中文字体出图乱码 | 设 `DING_FONT_PATH` 指向服务器中文字体（Noto Sans CJK / 文泉驿），Pillow 能加载 |
| Python 依赖 | `pip install -r python/requirements.txt` 后**额外** `pip install psycopg2-binary` |
| venv 重建 | 服务器上 `python -m venv .venv` + 装依赖（Windows 的 `.venv` 二进制不兼容，不能打包上传） |
| server 公网访问 | 绑定 `0.0.0.0` + 反向代理 + **加鉴权**（当前零鉴权，且 `/api/file` 可读任意文件含 cookie，公网暴露高危） |

---

## 五、网络可达性（已确认不是内网，非阻塞）

- 所有抓数接口均为**公网域名**，本仓库沙箱实测连通（2026-09-07）：
  - `aeolus.ele.me`（风神 SSO 票据/MOZI_TOKEN）→ 200
  - `httpizza.ele.me`（xtop 报表 / validToken 探针）→ 200
  - `dispatcher.ele.me`（急单调度台）→ 200
  - `quark.alibaba.com` / `app2-edu.ele.me`（Quark 报表 / FBI 取数）→ 可解析
  - `mozi-login.alibaba-inc.com`（SSO 登录 RPC）也需公网可达
- **鉴权方式**：纯 HTTP + `ensure_cookies()`（风神账密常量在 `login.py` 内，可自动登录刷新）+ Quark DA_TOKEN 兑换（需系统 curl）。**不需要 VPN / 白名单 / 企业内网**。
- 判定依据：用户本机（非企业内网环境）可正常抓取，印证这些接口对公网开放。

---

## 六、最小可行部署步骤

```bash
# 1. 传源码（不含 .venv / 凭据 / 运行产物，git 已忽略）
rsync -av --exclude='.venv' --exclude='__pycache__' --exclude='preview' ./ user@server:/opt/fengshen/

# 2. 手动传凭据（git 不带！）
#    Quark DA cookie 由 Nest 自动兑换并缓存到 backend/data/quark/，无需手工传
scp backend/aeolus_sdk/cookie.txt backend/minio_config.json python/jobs/delivery/db_config.json .env \
    user@server:/opt/fengshen/对应路径

# 3. 建 venv + 装依赖
cd /opt/fengshen
python3 -m venv .venv
.venv/bin/python -m pip install -r python/requirements.txt psycopg2-binary
# 确认系统有 curl
which curl

# 3.5 安装钉钉 dws CLI（钉钉官方开源 dingtalk-workspace-cli，与 WorkBuddy 打包同款）
#     锁定与本地打包同版本，避免子命令/flag 漂移
npm install -g dingtalk-workspace-cli@1.0.61
# 无头授权（容器/SSH 环境）：按提示用手机钉钉扫码或输入 device code，一次性
dws auth login --device
# 凭证持久化于 ~/.config/dws/，后续自动刷新
# 让代码定位到服务器上的 dws（无需改代码，走 DING_* 环境变量）
export DING_DWS_JS="$(npm root -g)/dingtalk-workspace-cli/bin/dws.js"
export DING_NODE_BIN="$(which node)"

# 4. 中文字体（出图用）
# 先装中文字体包（Debian/Ubuntu: apt install fonts-noto-cjk 或 fonts-wqy-zenhei）
export DING_FONT_PATH=/usr/share/fonts/.../NotoSansCJK-Regular.ttc

# 5. 起 PostgreSQL 并建表（若未就绪，仅 delivery load/verify 需要）
# load/verify 节点前先跑 init 节点 DROP 重建

# 6. 起 Nest 后端（取数 / 加工 / 出图 / 上传 / 发送 / 编排 全在 Nest）
cd backend && npm ci && npx nest build && node dist/main &    # 监听 8787
#    验证 Quark 凭证链（只读探针：valid / invalid / nocache / unknown）
curl -s -H "Authorization: Bearer $NEST_AUTH_TOKEN" http://127.0.0.1:8787/api/fetch/quark/status
#    跑任务：任务中心页面点「运行」，或 POST /api/run
curl -s -X POST http://127.0.0.1:8787/api/run -H "Authorization: Bearer $NEST_AUTH_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"items":[{"task_id":"delivery_pipeline","args":{}}]}'
```

> 注：`run.sh` 是 Windows 脚本，服务器上请直接用 `.venv/bin/python <脚本>`（venv_guard 会自动接管），
> 或 `python <脚本>`（venv_guard 检测非 venv 会重投到 .venv/bin/python）。

---

## 七、一句话总结

代码架构跨平台友好、依赖面窄；**上服务器唯一剩下的真硬阻塞只有「运单库依赖 PostgreSQL」（仅 delivery 入库节点）**。
钉钉发送已确认可解——`dws` 是钉钉官方开源 CLI，服务器独立装 + 无头授权即可，代码通过 `DING_*` 环境变量即可指向，无需改代码。
网络层面也已确认**非内网**：所有接口均为公网 `*.ele.me` / `*.alibaba.com` 域名，只靠登录态鉴权，公网服务器直接可用。
纯传源码 + 装依赖 + 装 dws +（可选）起 PG 即可跑起来。
