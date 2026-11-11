# 项目约束文档（CONSTRAINTS）

- 版本：v1.0
- 日期：2026-10-23
- 状态：**强制约束，所有改动必须严格遵循**
- 适用范围：本仓库（aeolusdata monorepo）的全部目录与代码

> 本文档为「目录架构约束」与「本地 / 服务器环境约束」的唯一事实来源。
> 任何新增文件、新增目录、跨环境操作，必须先对照本文档。
> 现有 `docs/dev-spec-architecture.md` 仅规范 `apps/api` 内部的分层，本地/服务器语义不在其范围内；二者冲突时以本文档为准。

---

## 0. 总原则

1. 本仓库是**标准 monorepo**（pnpm workspace + turbo），不是扁平/单体仓库。
2. 新增文件或目录**必须对齐现有架构**，放进对应的顶层/二级目录，禁止在仓库根或随意位置新建业务目录。
3. 本仓库有且仅有两个环境概念：**本地（local）** 与 **服务器（server）**，二者含义固定，不随上下文改变。
4. **AI 编码助手（CodeBuddy 等）每次动手前必须先通读本文档**，未读不得执行任何改动；且 AI 禁止 SSH 登录服务器、禁止在服务器写文件，服务器侧只输出命令由用户执行（详见 §2.5）。

---

## 1. Monorepo 目录架构（强制对齐）

### 1.1 顶层拓扑（现有事实，新增顶层目录需评审）

```
aeolusdata/
├─ apps/          # 应用（每个含独立 package.json，纳入 pnpm workspace）
│  ├─ api/        # NestJS 后端，端口 8787（路由/鉴权/取数/编排/静态托管）
│  └─ web/        # Vite + Vue 前端，构建产物 apps/web/dist 由 .gitignore 忽略
├─ services/      # 独立语言的服务（自管虚拟环境，不进 pnpm workspace）
│  └─ compute/    # Python 计算服务，端口 8900（仅大数据计算）
├─ packages/      # 跨应用共享库（纳入 pnpm workspace）
│  └─ shared/     # @aeolus/shared 共享包
├─ docs/          # 文档（md / html）
├─ deploy/        # 部署相关：systemd 单元、nginx 配置、update.sh / setup.sh
├─ scripts/       # 仓库级脚本（manage.sh / watchdog.sh）
├─ otel/          # 可观测性配置（OpenTelemetry）
├─ pnpm-workspace.yaml
├─ turbo.json
├─ package.json   # 根：packageManager=pnpm，engines.node>=20
└─ tsconfig.base.json
```

### 1.2 新增文件 / 目录落位规则（必须）

| 要新增的内容 | 必须放的位置 | 禁止放的位置 |
|---|---|---|
| 后端业务逻辑（新特性/新接口） | `apps/api/src/modules/<feature>/` | 根目录、`apps/api/src` 下直接散放 |
| 后端共享内核（守卫/拦截器/工具/配置） | `apps/api/src/common/`、`apps/api/src/config/` | 各业务模块内重复实现 |
| 前端页面 / 组件 / 特性 | `apps/web/src/features/`、`components/`、`composables/`、`stores/`、`router/`、`api/` | 根目录或随意新建顶层目录 |
| Python 计算 handler / 分析脚本 | `services/compute/analytics/`、`compute_api/`、`dashboard/`、`common/`、`sources/` | 根目录、apps 内 |
| 跨应用共享 TS 代码 | `packages/shared/src/` | apps 内复制粘贴 |
| 部署 / systemd / nginx | `deploy/` | 随手放进应用目录 |
| 仓库级脚本 | `scripts/` | 散落各处 |
| 文档 | `docs/` | 仓库任意位置新建 md |

### 1.3 命名约定（继承 dev-spec）

- 文件：`kebab-case`；类：`PascalCase`。
- 后端角色后缀：`.controller.ts` / `.service.ts` / `.module.ts` / `.port.ts` / `.adapter.ts` / `.dto.ts` / `.entity.ts` / `.guard.ts` / `.filter.ts` / `.interceptor.ts` / `.decorator.ts` / `.util.ts`。
- 常量 / DI Token：大写下划线；配置键：`UPPER_SNAKE`。

### 1.4 语言边界（强制）

- JS/TS 工程 = `apps/*` + `packages/*`，由 pnpm workspace 管理，`node>=20`。
- `services/compute` 是 Python 工程，自带 `.venv`，**不进 pnpm workspace**，由自身虚拟环境管理；与 JS 工作区共存于同一 monorepo。
- 禁止把 Python 文件塞进 `apps/`，禁止把 JS 业务塞进 `services/`。

---

## 2. 环境约束：本地 vs 服务器（强制）

### 2.1 定义（固定，不可混用）

| 词汇 | 含义 | 实际路径 / 标识 |
|---|---|---|
| **本地（local）** | 本地开发环境，写代码、本地验证 | 本机 `/home/chenqiang/aeolusdata`（仓库工作副本） |
| **服务器（server）** | 远端**云服务器（ECS）**，真实运行环境 | 远端 `/opt/aeolusdata`（systemd 拉起） |

- 用户口中的「服务器」**永远指远端云服务器**，不是本地机器；「本地」**永远指本地开发环境**。
- 二者是**两份独立的代码副本 + 独立的运行态**，通过 `git`（GitHub 中转）同步，不共享进程、不共享文件。

### 2.2 各环境的运行方式（现状）

- **本地**：手动 `nohup` 启动「三件套」——
  1. `apps/api` → `node dist/src/main`（8787）
  2. `services/compute` → `./.venv/bin/python -m uvicorn compute_api.main:app --port 8900`
  3. `apps/api` → `node dist/src/main-worker`（任务 worker，消费 PG 队列）
  - 本地服务**不是 systemd**，重启需手动起全三件，漏起 worker 会导致任务中心「排队中」无解。
- **服务器**：由 systemd 三个 service 自动拉起——`aeolusdata-backend`(8787) / `aeolusdata-compute`(8900) / `aeolusdata-worker`。通过 `bash /opt/aeolusdata/deploy/update.sh` 部署。

### 2.3 本地 / 服务器操作边界（强制）

| 操作 | 本地 | 服务器 |
|---|---|---|
| 写代码、改源码 | ✅ 只在此 | ❌ 不在服务器改源码 |
| 构建（vite build / nest build / python 依赖同步） | ✅ 可在本目录直接执行 | 由 `update.sh` 自动完成 |
| 重启本地「三件套」 | ✅ 可直接执行 | — |
| `git commit` / `git push` | ✅ 本地推送 GitHub | ❌ 不在服务器提交 |
| 跑 `deploy/update.sh`、`git pull`、SSH 登录 | ❌ 不在本地执行 | ✅ 仅服务器 |
| 重启/管理 systemd service | ❌ 不触碰 | ✅ 仅服务器 |

- **禁止**在本地机器执行任何会把改动落到服务器的动作（含 SSH 到服务器、在本地跑 `deploy/update.sh`）。
- 本地副本 `/home/chenqiang/aeolusdata` 与服务器 `/opt/aeolusdata` 是不同机器/目录，**不要假设二者文件互通**。

### 2.4 同步链路（唯一正确路径）

```
本地改代码 → 本地构建/重启验证 → git commit → git push (GitHub)
        → 服务器 git pull + bash deploy/update.sh → systemd 重启服务
```

- 凭据类文件（根 `.env`、`cookie.txt`、`db_config.json` 等 `.gitignore` 项）**不进 git**，由人工带外传输，Actions / `update.sh` 无法部署。例外：MinIO 图床配置（`apps/api/runtime/minio_config.json`）已改为「系统设置 → MinIO 设置」页面维护（热生效），**无需带外传输**，重装后页面重填即可。

---

### 2.5 AI 协作操作边界（强制）

> 编码助手（CodeBuddy 等）容易「失忆」或忽略环境边界，故单列本节为硬约束。
> **任何涉及改代码 / 构建 / 提交 / 服务器相关的动作，动手前必须先 `read_file` 通读本文档（CONSTRAINTS.md）。**

- **禁止 SSH 登录服务器**：含 `ssh root@aeolus.qixinchen.top`、任何到远端 ECS（`/opt/aeolusdata`）的连接。
- **禁止在服务器上创建 / 修改 / 删除任何文件**：含 `minio_config.json` 等凭据、`cookie.txt`、systemd 单元、nginx 配置、运行时 JSON。
- **禁止在本地执行会落到服务器的动作**：`systemctl` / `journalctl` 查服务、跑 `deploy/update.sh`、`git pull` 等，一律**只输出命令**，由用户在服务器执行并把输出贴回。
- AI 只在**本地**（`/home/chenqiang/aeolusdata`）改源码、构建、`git commit` / `git push`；服务器侧诊断、配置文件落地、服务管理、部署全部由用户完成。
- 凭据类文件（`.env`、`minio_config.json`、`cookie.txt`、`db_config.json` 等 `.gitignore` 项）由用户**人工带外传输**，AI 不代写、不代传、不代部署。
- 服务器报错排查：让用户贴 `systemctl status` / `journalctl` / 日志原文，AI 据此给命令，不自行连服务器取证。

## 3. 反模式（禁止）

- ❌ 在仓库根或随意位置新建业务目录 / 散放源码（违反 §1.2）。
- ❌ 把 Python 放进 `apps/`、把 JS 业务塞进 `services/`（违反 §1.4）。
- ❌ 混淆「本地」与「服务器」：不在本地跑部署/SSH，不在服务器改源码（违反 §2）。
- ❌ 假设本地与服务器文件互通、共享进程。
- ❌ 后端 Controller 内写业务逻辑或直连进程外资源（详见 `dev-spec-architecture.md` §4）。
- ❌ `git add -A` / `git add .` 提交运行时缓存 JSON（详见 `deploy/DEPLOY.md` §2）。
- ❌ AI 代理 SSH 登录服务器或在服务器写文件（违反 §2.5）。
- ❌ AI 代理未经 `read_file` 通读本文档就动手执行改动（违反 §2.5 / §0.4）。

---

## 4. 校验

- 仓库已提供架构校验脚本：`pnpm check:arch`（普通）、`pnpm check:arch:strict`（严格）。
- 新增文件 / 目录后，提交前应跑 `pnpm check:arch:strict` 确认未破坏 monorepo 拓扑。
- 涉及环境操作前，先按 §2.3 确认动作归属本地还是服务器。
