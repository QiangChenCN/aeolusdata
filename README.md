# AeolusData

风神（骑手考核 / 运营）数据平台 —— 模块化单体后端 + Vue 前端 + Python 计算服务的 **pnpm monorepo**。

## 仓库结构

```
aeolusdata/
├── apps/
│   ├── api/          # NestJS 后端（取数编排、RBAC、考核看板、SSE 推送）  [package: aeolus-workbench-backend]
│   └── web/          # Vue 3 + Vite 前端（看板 / 任务中心 / 历史）        [package: aeolus-workbench-web]
├── packages/
│   └── shared/       # 跨应用共享代码包（@aeolus/shared，api/web 以 workspace:* 接入）[package: @aeolus/shared]
├── services/
│   └── compute/      # Python(FastAPI) 计算服务：落盘 + 大数据聚合        （独立 .venv，非 pnpm 工作区）
├── docs/             # 文档
├── deploy/           # 部署：systemd 单元、nginx、setup/update 脚本、DEPLOY.md
├── scripts/           # 本地运维脚本：manage.sh（start/stop/restart 统一入口）、watchdog.sh（守护）
├── pnpm-workspace.yaml
├── turbo.json        # Turborepo 任务编排（build / lint / test）
├── tsconfig.base.json
├── .npmrc            # pnpm 行为（node-linker=hoisted 等）
└── package.json      # 根：packageManager=pnpm、workspace 脚本
```

> `services/compute` 是 Python 工程，自带虚拟环境，不参与 pnpm 工作区；它与 JS 工作区共存于同一仓库，属于 monorepo 的一部分。

## 快速开始

要求 Node ≥ 20（建议用 `.nvmrc` 指定的版本）、pnpm（由 `packageManager` 字段锁定，可用 `corepack enable` 启用）。

```bash
corepack enable            # 启用与 package.json 锁定的 pnpm 版本
pnpm install               # 依赖提升到根 node_modules（hoisted）

pnpm build                 # turbo：构建 api + web
pnpm build:api             # 仅构建后端（nest build）
pnpm build:web             # 仅构建前端（vite build）

pnpm lint                  # turbo：api + web 的 eslint
pnpm test                  # turbo：运行单测（web 无 test 脚本会自动跳过）

bash scripts/manage.sh start                  # 本地一键起：Python(8900) → 后端(8787) → 前端(5173)
bash scripts/manage.sh stop                   # 停止全部（含看门狗）
bash scripts/manage.sh restart [svc...]        # 重启（compute|backend|web）
bash scripts/manage.sh start --watchdog        # 起服务并拉起自愈看门狗
```

## 约定

- **唯一依赖真相**：`pnpm-lock.yaml` 提交入库，保证可复现安装；不要手写 `npm install`。
- **跨应用公共代码**：抽到 `packages/shared`，以 `"@aeolus/shared": "workspace:*"` 引用（api / web 均已接入并验证）。
  - `packages/shared` 以 CommonJS 产物（`dist/index.js` + `.d.ts`）对外：NestJS（CJS）可直接 `require`，Vite 通过 `build.commonjsOptions.include` 纳入转换后亦可按需打包；turbo 的 `^build` 会保证它先于 api / web 构建。
- **构建/校验编排**：统一走 `turbo run <task>`，新增脚本请优先挂到 turbo 任务而非各写一遍。
- **本地状态 / 凭据 / 运行产物**：见 `.gitignore`（`.env`、RBAC 库、看板缓存、Python `.venv` 等均不入库）。
