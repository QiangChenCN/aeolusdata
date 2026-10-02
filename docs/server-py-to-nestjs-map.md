# server.py → NestJS 逐职责/路由映射

- 日期：2026-09-20（最后更新：2026-09-23）
- 源：`server.py`（~2900 行，手搓 `http.server` 标准库实现）—— **⚠️ 已于 2026-09-23 删除**
- 目标：`backend/`（NestJS，见 `dev-spec-architecture.md`）
- 关联：[ADR-后端选型-NestJS](./adr-backend-nestjs-2026-09-20.md)

> **2026-09-23 收口**：`server.py` 已删除。其 HTTP 外壳（单体 8917）更早已移除，之后它只
> 作为「compute_service 的 handler 库」被 `import`。现已按 AST 依赖闭包把计算子集精确迁入
> `python/compute_service/handlers.py`（命名空间 handler + Cookie 探针 / 站点缓存 / 路径守卫 /
> 表格解析 / 频控），其余约 900 行工作台代码（RunManager / 产物 / 静态托管 / 鉴权令牌 /
> 诊断 / 注册表读写 / data-perms 快照）确认无引用后一并删除。
> 下表对 `server.py` 的行号引用均为**历史行号**，保留以便对照。

> 映射原则（来自 ADR）：
> - **框架无关脊梁**（路由、鉴权闸门、串行任务队列、子进程执行、SSE、静态托管、频控、历史/诊断）直接移植为 NestJS 真实实现。
> - **Python 生态独占逻辑**（`dashboard.standard.*` 计算部分、`group_picker`、`openpyxl`、数据权限组织树拉取）**不进 NestJS 进程**，统一经 `ComputePort` 委托给 Python 服务（FastAPI/子进程），NestJS 侧只做转发 + 鉴权闸门 + 数据权限裁剪。
>
> ⚠️ **2026-09-22 修订（ADR 修订 1）**：**取数（抓取）不属于计算**，已从上面这条中划出、迁回 NestJS；
> 仅「登录重登」与「大数据计算」仍留在 Python。详见 [ADR 修订 1](./adr-backend-nestjs-2026-09-20.md#修订-12026-09-22取数职责迁回-nestjs) 与本文档第 7 节。

状态图例：✅ 已迁移 | 🟡 骨架/部分 | ⬜ 待迁移（委托 Python）

---

## 1. 任务执行（核心脊梁）

| server.py | 新位置 | 方式 | 状态 |
|---|---|---|---|
| `TaskManager` 注册表 `python/workbench/tasks.json`（`task_map`） | `tasks/task-registry.service.ts` | 直接移植（读 JSON） | 🟡 |
| 全局串行队列 + `_worker` 线程（刻意串行，避免 cookie 争抢） | `tasks/task-runner.service.ts` | 直接移植（单 worker 异步循环替代线程） | 🟡 |
| `enqueue` / `queue_state` / `cancel_queued` / `stop_current` / `_kill_tree` | 同上 | 直接移植（含 Windows `taskkill` / POSIX `SIGTERM`） | 🟡 |
| `build_cmd`（解析 `{py}`、params、group→cid via `group_picker`） | 同上 + 委托 `group_picker`（Python） | 命令拼装直移植；群名解析走 ComputePort | 🟡 |
| `subprocess.Popen`（cwd=ROOT、env、`PYTHONUNBUFFERED`、合并 stderr） | `task-runner.service.ts` `execute()` | 直接移植（Node `child_process.spawn`） | 🟡 |
| `_reader` 逐行读 stdout → `_append` → `emit` | 同上（读流 → `StreamingService.emit`） | 直接移植 | 🟡 |
| `diagnose(full, exit_code)`（已知错误模式→可读建议） | `tasks/diagnostics.util.ts` | 直接移植（规则表） | 🟡 |
| 落盘 `.log` + 历史（MAX_HISTORY=60）→ `emit history` | `task-runner.service.ts` | 直接移植（文件系统 + 内存历史） | 🟡 |
| `run_status`（调度器轮询，不订阅 SSE） | `task-runner.service.ts` | 直接移植（读模式，避免背压丢状态） | 🟡 |
| `link_state`（任务 enabled/hidden 判定） | `task-registry.service.ts` | 直接移植 | 🟡 |
| `snapshot`（当前+历史+队列，供刷新/重连补日志） | `task-runner.service.ts` | 直接移植 | 🟡 |

**路由**：`POST /api/run`、`POST /api/stop`、`POST /api/cancel`、`GET /api/state`、`GET /api/history`、`GET /api/log`、`GET /api/download` → `TasksController`。

---

## 2. SSE 实时事件总线

| server.py | 新位置 | 方式 | 状态 |
|---|---|---|---|
| `MGR.emit` / `subscribe` / `unsubscribe`（`queue.Queue` 广播） | `streaming/streaming.service.ts`（全局 `Subject<AppEvent>`） | 直接移植（RxJS 替代 queue） | ✅ |
| `GET /api/events`（`: connected`、`ping` 心跳、事件 `data:` 帧） | `streaming/streaming.controller.ts` `@Sse('api/events')` | 直接移植；事件形态保持 `{type, run_id, ...}`（握手/心跳为可选收尾） | ✅ |

> 旧前端订阅**全局**事件流、自行按 `run_id` 过滤；故 SSE 用全局广播，不再按 taskId 分桶（与旧一致）。

---

## 3. 鉴权 / RBAC / 数据权限

| server.py | 新位置 | 方式 | 状态 |
|---|---|---|---|
| 机器令牌闸门 `API_TOKEN`（`.api_token` 持久化）+ loopback 兜底 | `backend/src/common/guards/token.guard.ts`（已有） | 直接移植（env/`AUTH_TOKEN` 或文件） | ✅ |
| 会话：`auth.get_session` / `login` / `logout` / `change_password`（`core.auth`） | `auth/auth.service.ts`（文件会话 + scrypt 哈希 + 审计，互通 `.users.json`） | 直接移植（端口 `core.auth`） | ✅ |
| `wb_session` Cookie（HttpOnly, SameSite=Lax） | `auth/auth.controller.ts` 登录写 Cookie | 直接移植 | 🟡 |
| `GET /api/auth/me`（无会话也可，返回认证态） | `auth.controller.ts` | 直接移植 | 🟡 |
| `POST /api/auth/login` / `logout` / `account/change-pw` | 同上 | 直接移植 | 🟡 |
| 路由→权限表 `GET_ROUTE_PERMS` / `POST_ROUTE_PERMS` + `has_perm` + `audit` | `auth/permissions.ts`（权限表）+ `backend/src/common/guards/access.guard.ts`（双闸门：机器令牌 + RBAC）+ `auth.service.audit` | 直接移植 | ✅ |
| 数据权限行级隔离 `_enforce_team_scope` / `_scoped_universe`（`core.dataperm`） | `auth/data-perm.service.ts`（端口 `core.dataperm`）+ `proxy/proxy.controller.ts`（委托前下发 `x-scope`） | 直接移植 | ✅ |
| `GET /api/admin/users` / `roles` / `policy` 及账号/角色/策略管理 | `auth/admin.controller.ts` | 直接移植（端口 `core.auth` 管理函数） | ✅ |
| `GET/POST /api/data-perms`（组织树/规则） | `auth/admin.controller.ts` | 直接移植（端口 `core.dataperm`） | ✅ |

---

## 4. 静态资源托管

| server.py | 新位置 | 方式 | 状态 |
|---|---|---|---|
| `/`、`/index.html`（Vite `web/dist`，token 占位替换） | `serve/serve.module.ts`（`@nestjs/serve-static` 排除入口）+ `serve/serve.controller.ts`（`__SERVER_API_TOKEN__` 替换为真实 AUTH_TOKEN） | 直接移植 | ✅ |
| `/assets/*`（Vite 哈希资源，可缓存） | `serve-static` | 直接移植 | 🟡 |
| `/tokens.css`、`/favicon.ico` | `serve` 控制器/中间件 | 直接移植 | 🟡 |
| `/vendor/*`、`/web/*`（本地开源库、前端资源） | `serve` 静态目录映射 | 直接移植（注意敏感路径黑名单 H1） | 🟡 |

---

## 5. 频控（Rate Limit）

| server.py | 新位置 | 方式 | 状态 |
|---|---|---|---|
| 内存频控 `_RATE_STATE`（用户×端点，服务端时间窗口） | `@nestjs/throttler` 或 `backend/src/common/guards/rate-limit.guard.ts` | 直接移植（已加 `throttler` 依赖） | 🟡 |

---

## 6. Python 生态独占：经 ComputePort 委托（不进 NestJS）

| server.py 路由 | Python 实现模块 | 新位置 | 状态 |
|---|---|---|---|
| `GET /api/cookies/status`（登录态探针） | `aeolus_sdk.login` / `quark` | `backend/src/modules/status/`（入口）+ `fetch/cookie-status.service.ts`（风神 validToken）+ `fetch/quark-creds.service.ts::probeDetail`（DA 探针：curl `%{http_code}` + `-L`） | ✅ 已迁移（2026-09-23；原 Python 三个探针函数已删） |
| `GET /api/teams`（站点目录，5min 缓存，源 xtop） | `aeolus_sdk` / xtop | `backend/src/modules/teams/`（入口 + 数据权限过滤）+ `fetch/teams-fetch.service.ts`（取数 / 缓存 / 兜底三站）；Python 侧 `handlers._fetch_all_teams` 改为回调 `GET /api/fetch/teams`，**共用同一份缓存** | ✅ 已迁移（2026-09-23） |
| `GET /api/standard/{achievement,riders,station-report}`（计算） | `dashboard.standard.*` | `python/compute_service/handlers.py` GET 表 | ✅ 归 Python（大数据计算） |
| `GET/POST /api/standard/{teams-config,grade-standards,thresholds}`（**配置**） | `dashboard.standard.{teams_config,grade_standards,threshold_config}` | **Nest 原生** `config.service.ts`（proxy 拦截，不再转发 Python） | ✅ 已迁移（2026-09-23 收尾；见 §6.1） |
| `GET /api/overview/{site-orders,standard,assessment}`（数据大屏） | `dashboard.standard.*` | 同上 | ✅ 归 Python（大数据计算） |
| `GET /api/attend-period/{valid,rider-detail,station-data,dataset,months}`（计算） | `dashboard.standard.attend_period_*` | 同上 | ✅ 归 Python（大数据计算） |
| `GET/POST /api/attend-period/{config,teams}`（**配置**） | `dashboard.standard.{period_config,attend_period_teams}` | **Nest 原生** `config.service.ts`（proxy 拦截） | ✅ 已迁移（2026-09-23 收尾；见 §6.1） |
| `GET /api/realtime/station`（实时播报聚合，计算） | `dashboard.realtime.*` | `python/compute_service/handlers.py` | ✅ 归 Python（大数据计算） |
| `GET/POST /api/realtime/{selection,targets}`（**配置**） | `dashboard.realtime.config` | **Nest 原生** `config.service.ts`（proxy 拦截） | ✅ 已迁移（2026-09-23 收尾；见 §6.1） |
| `GET /api/sheet?path=`（xlsx/xls 解析 `openpyxl`/`xlrd`） | `openpyxl`/`xlrd` | compute_service 自带端点 | ⬜ 归 Python（Excel 边界；需引入 xlsx 库，待迁 Nest） |
| `POST /api/groups/used`、`/groups/forget`（`group_picker`） | — | `backend/src/modules/groups/`（**Nest 原生**，`group_picker` 已删） | ✅ 已迁移 |

> 前缀更正：早期文档写的 `std/*`、`ov/*`、`ap/*` 是**死配置**（前端与 server 均未使用），
> 真实前缀为 `standard/`、`overview/`、`attend-period/`（另有 `realtime/`），
> 见 `backend/src/modules/proxy/proxy.controller.ts` 注释。
| `GET /api/files?task_id=`、`/api/file?path=`（产物列举/下载） | 文件系统 | **直接移植**（产物在本地磁盘） | 🟡 |
| `GET/POST /api/todo`、`/api/todo/runs`、`/api/todo/lists`、`/api/todo/items`、`/api/todo/trigger`、`/api/todo/import` + 定时调度器 | `todo` 模块（`todo-store.service` 端口 `todo_store.py` + `todo.controller` + `scheduler.service` 端口 `todo_sched.py` 的 `TodoScheduler`：每 5s 扫描 / 失败重试 3 次 / 补跑宽限 15min / 重启恢复 / 手动触发） | 直接移植（node:sqlite 内置驱动，复用 python/workbench/data/todo.db） | ✅ |

> 委托机制：`ComputePort` 新增 `proxy(endpoint, method, params)`；`NodeComputeAdapter` 对这类端点返回 `{ok:false, code:'NEED_PYTHON'}`；`PythonComputeAdapter` 转发到 `PYTHON_COMPUTE_URL`（默认 `http://127.0.0.1:8900`）。NestJS 侧由 `ProxyController`（`@Controller('api')`）按前缀（`standard` / `attend-period` / `overview` / `realtime` / `cookies/status` / `teams` / `sheet`）转发，并叠加 RBAC + 数据权限闸门后**再**委托（权限裁剪在 NestJS 侧完成，Python 只算数）。`/api/groups` 已由原生 `GroupsModule` 提供，不再转发。**注意**：`standard / attend-period / realtime` 前缀下的**配置端点**（见 §6.1）已由 `ConfigService` 在 proxy 内拦截、不再转发 Python；只有各自前缀下的**计算**端点（如 `standard/achievement`、`attend-period/valid`、`realtime/station`）才继续转发 compute_service。

---

## 6.1 看板配置端点：迁回 NestJS（2026-09-23 收尾）

> 背景：早于本次收尾，`dashboard.standard.*` 与 `dashboard.realtime.config` 的**配置读写**端点
> 仍由 Python（compute_service）服务，Nest 只做透传代理；虽曾写过 `config-store.service.ts`
> 声称「Nest 是唯一写入方」，但它是**孤儿代码**（无任何 controller 注入 / module 注册），实际写请求
> 仍掉回 proxy → Python。本次收尾把 7 个配置端点**真正迁到 Nest 原生**，与 ADR「Python 只做大计算」对齐。
>
> 原则（与取数迁回同理）：配置端点**不是大数据计算**，逻辑量小、前端强依赖其响应形状，应在 Nest 侧
> 直接实现；落盘文件**位置/格式保持不变**（Python 计算时仍在读），不破坏计算侧输入端口。
> （`refresh-all` / `refresh-all-status` 早前已迁 Nest `refresh-runner`，不在本表内。）

### 6.1.1 端点映射表

| Python 源模块（已不再服务该端点） | 新位置（Nest 原生） | 端点 | 状态 |
|---|---|---|---|
| `dashboard.standard.teams_config` | `backend/src/modules/config/config.service.ts`（`teamsConfigGet/Post`） | `GET/POST /api/standard/teams-config` | ✅ 已迁移 |
| `dashboard.standard.grade_standards` | 同上（`gradeStandardsGet/Post`，含分级 `build_levels`） | `GET/POST /api/standard/grade-standards` | ✅ 已迁移 |
| `dashboard.standard.threshold_config` | 同上（`thresholdsGet/Post`，数值校验 + 按月） | `GET/POST /api/standard/thresholds` | ✅ 已迁移 |
| `dashboard.standard.period_config` | 同上（`periodConfigGet/Post`，按月分文件） | `GET/POST /api/attend-period/config` | ✅ 已迁移 |
| `dashboard.standard.attend_period_teams` | 同上（`apTeamsGet/Post`） | `GET/POST /api/attend-period/teams` | ✅ 已迁移 |
| `dashboard.realtime.config`（selection） | 同上（`realtimeSelectionGet/Post`，按用户名分区 + x-scope 越权站点剔除） | `GET/POST /api/realtime/selection` | ✅ 已迁移 |
| `dashboard.realtime.config`（targets） | 同上（`realtimeTargetsGet/Post`，静态常量 + 行级校验） | `GET/POST /api/realtime/targets` | ✅ 已迁移 |

> 拦截点：`backend/src/modules/proxy/proxy.controller.ts` 在 `standard / attend-period / realtime`
> 通配 handler 内**显式改派** `ConfigService.dispatch(method, path, body, query, user, allowed)`
> （与 `refresh-all` 同款处理，不依赖通配注册顺序，规避 Express 路由序坑）。`GET` 的 `month`/`team`
> 查询参数、响应塑形、校验、默认值、种子均逐条对齐 `handlers.py`，**前端零改动**。
>
> `all` 站点清单（teams-config GET、attend-period/teams GET 的 `all` 字段）由
> `fetch/teams-fetch.service.ts` 取（5min 缓存 + 三站兜底），不再走 Python 的 `_fetch_all_teams` HTTP 回源。

### 6.1.2 落盘路径（Nest 写入 / Python 只读）

| 文件 | 路径（相对仓库根 `PROJECT_ROOT`） | 内容 | 写入方 | 读取方 |
|---|---|---|---|---|
| 参与站点 | `python/dashboard/standard/teams_config.json` | `{teams:[...]}` | Nest `ConfigService` | Python 计算（站点范围） |
| 考核标准 | `python/dashboard/standard/grade_standards.json` | `{schema_version,months}` | Nest | Python（grade / build_levels） |
| 门槛封顶 | `python/dashboard/standard/threshold_config.json` | `{schema_version:2,months}` | Nest | Python |
| 时段配置 | `python/dashboard/standard/period_config_YYYY-MM.json` | `{schema_version:3,periods}` | Nest（按月分文件） | Python |
| 出勤参与站点 | `python/dashboard/standard/attend_period_teams.json` | `{teams:[...]}` | Nest | Python |
| 实时站点选择 | `.realtime_selection.json`（仓库根） | `{<user>: [team,...]}` | Nest（按用户名分区） | Python（realtime 聚合） |
| 实时考核目标 | `.realtime_targets.json`（仓库根） | `{version,rows,updated_*}` | Nest | Python（realtime 聚合） |

> 落盘格式：Nest 端 `JSON.stringify(obj, null, 2)` + **原子写**（先写 `.tmp` 再 `rename`），与 Python
> 原 `json.dump(ensure_ascii=False, indent=2)` 解析兼容（文件内容均为 ASCII 友好的数字/枚举，中文转义
> 不影响 Python `json.load`）。两个 `.realtime_*.json` 已补进 `.gitignore`（运行期本地状态，不提交）。

### 6.1.3 配置变更 → 计算缓存失效（接缝）

仅 `grade-standards` / `thresholds` 两个端点的 POST 触发 Python 进程内结果缓存**全量失效**
（`raw-cache.service.invalidateAll()` → `POST /api/cache/invalidate {all:true}`），对应 Python 原
`_CACHE.clear_results()`。其余配置端点（teams-config / period-config / ap-teams / realtime-*）POST
**不**失效缓存——与 Python 原 handler 调用 `clear_results` 的范围一致，避免无谓重算。

> 遗留：`/api/sheet`（xlsx 解析）**仍归 Python**（后端无 xlsx 库，且属文件解析而非配置逻辑），不在本次
> 「配置端点」收尾范围；`/api/cache/invalidate` 作为 Nest→Python 缓存失效接缝保留。

---

## 7. 取数：迁回 NestJS（ADR 修订 1，2026-09-22）

> 取数（抓取）**不是计算**，已从「Python 生态独占」划出、由 NestJS 承担。
> 依据：[ADR 修订 1](./adr-backend-nestjs-2026-09-20.md#修订-12026-09-22取数职责迁回-nestjs)

| 原 Python 实现 | 新位置 | 方式 | 状态 |
|---|---|---|---|
| `python/get_data/delivery.py` `query`（单次分页请求） | `fetch/delivery-query.service.ts` | 直接移植 | ✅ |
| `python/dashboard/standard/orders_fetch.py` 节奏 / AIMD / 退避 / 统计 | `fetch/fetch-pace.service.ts` | 直接移植（常量需两边同步） | ✅ |
| `orders_fetch.Session`（重登/退避）+ `fetch_orders`（切片去重） | `fetch/orders-fetch.service.ts` | 直接移植 | ✅ |
| `refresh_all` 阶段 0（一次拉全量 + 分组 + 落盘） | `fetch/refresh-all.service.ts` | 直接移植 | ✅ |
| `aeolus_sdk.login` 登录重登 | `fetch/aeolus-login.service.ts` + `fetch/aeolus-cookie.service.ts`（RSA 无填充分块加密 + SSO 四步 + validToken 探针 + 进程内复用 + 重登串行/合并 + 原子写盘） | 直接移植到 Nest（**登录已不再依赖 Python 运行时**）；Python 侧 `python/get_data/auth.refresh_cookie()` 仅转发 `POST /api/fetch/aeolus-relogin` | ✅ 已迁移（2026-09-23） |
| `refresh_all` 阶段 1+ 的**取数**（`sched` / `att` / `violation`） | — | Nest `fetch/schedule-fetch.service.ts` / `attendance-fetch.service.ts` / `violation-fetch.service.ts`，经 `fetch.controller.ts` 的 `attendance-raw` / `sched-raw` / `violation-csv` 暴露；Python `python/get_data/{schedule_statistics,attendance,violation}.py` 已改为**转发层** | ✅ 已迁移（2026-09-23） |
| `refresh_all` 的**编排**（阶段 0/0.5/每站调度、状态机、日志、单飞、频控、数据权限收敛、历史护栏） | `python/dashboard/standard/refresh_all.py`（**已删除**） | Nest `fetch/refresh-runner.service.ts` + `refresh.controller.ts` | ✅ 已迁移（2026-09-23） |
| `refresh_all` 的**结果计算**（rider / achievement 聚合） | `rider_dimension.py` + `achievement.py` | Python（`ComputePort` 委托）：`POST /api/compute/{rider-dimension,achievement}` | ✅ 归 Python（大数据计算） |
| **原始层落盘**（orders/sched/att/violation 写 `python/dashboard/data/{kind}_{team}_{date}.json`） | `python/dashboard/standard/cache.save_raw` / `save_violation` | 委托 Nest：`cache.save_*` → `POST /api/cache/raw` → `fetch/raw-cache.service.ts`（**唯一写入方**，格式与 Python 旧实现逐字兼容）；Python 只保留**读**（`load_raw` 是计算的输入端口） | ✅ 已迁移（2026-09-23；结果层 `{rider,ach}_*.json` 核实无任何读取方，随之一并删除） |

跨语言契约（不遵守会读到陈旧数据）：

1. 共享 `backend/aeolus_sdk/cookie.txt` —— **Nest 是唯一写入方**（登录/重登后原子写盘 + chmod 600）；Python 只读复用，失效由 Nest 的 validToken 探针发现并重登
2. 共享原始层 `python/dashboard/data/{kind}_{team}_{date}.json` —— **Nest 是唯一写入方**（`raw-cache.service.ts`），Python 只读取（计算的输入端口）；落盘格式以 `raw-cache.service.ts` 为准，Python 的 `cache.save_raw` 仅转发，不再自己写文件
3. 共享 `python/dashboard/standard/cache/pace_state.json` —— 两边学到的节奏下限互通
4. **Nest 写完原始层后必须调 `POST /api/cache/invalidate`** —— 否则 Python 进程内结果缓存不失效，看板返回旧聚合结果（已实测复现：移走数据文件后报表数字仍不变）
5. 共享看板配置文件（`python/dashboard/standard/{teams_config,grade_standards,threshold_config,period_config_YYYY-MM,attend_period_teams}.json` 与仓库根 `.realtime_selection.json` / `.realtime_targets.json`）—— **Nest 是唯一写入方**（`config.service.ts`），Python 只读取（计算输入端口）；落盘格式以 `config.service.ts` 为准（原子写 + `indent=2`），Python 不再写这些文件。grade-standards / thresholds 写入后由 Nest 调 `invalidateAll()` 全量失效结果缓存（见 §6.1.3）

## 8. 映射后模块归属总览

```
backend/src/modules/
├─ tasks/      注册表 + 串行执行器 + 历史/诊断 + 产物 + 9 个原生任务流水线
├─ streaming/  全局事件总线 + /api/events
├─ auth/       令牌闸门 + 会话 + RBAC + 数据权限 + 审计
├─ serve/      静态托管（dist/vendor/web/tokens）
├─ compute/    ComputePort + Node/Python Adapter
├─ proxy/      Python 委托转发控制器（standard / overview / attend-period / realtime / …）+ 配置端点拦截
├─ config/     看板配置端点原生实现（teams/grade/thresholds/period/ap-teams/realtime；见 §6.1）
├─ fetch/      取数（反爬节奏 + 分页 + 落盘 + 各任务取数 + Quark 凭证）
├─ dingtalk/   钉钉发送（dws CLI 封装）
├─ groups/     群选择器（原生，取代 Python group_picker）
├─ render/     PNG 渲染（@napi-rs/canvas，取代 python/common/report_render.py）
├─ media/      MinIO 图床（取代 python/common/minio_common.py）
├─ notify/     通知配置（站长 openid / 站点映射 / 群常量）
├─ scheduler/  定时调度
└─ todo/       提醒事项（sqlite + 调度）

python/compute_service/
├─ main.py     FastAPI 应用（只算、不鉴权；8900，仅环回）
└─ handlers.py 计算 handler 库：原 server.py 的计算子集（standard/attend-period/overview/realtime）
```

> `server.py` **已删除**（2026-09-23）：其工作台职责全部在 NestJS，计算职责在 `python/compute_service/handlers.py`。

**关键不变量（迁移必须保持）**：
1. 任务**全局串行**（避免 aeolus cookie 并发争抢）。
2. 调度器**轮询** `run_status`，**不订阅 SSE**（防背压丢状态）。
3. 数据权限（team 维度行级隔离）在 NestJS 侧执行，再委托 Python 计算。
4. SSE 事件形态 `{type, run_id, ...}` 不变，前端零改动。
5. NestJS 写入原始层后**必须**通知 Python 失效结果缓存（见第 7 节契约 4）。
6. 看板配置文件（`python/dashboard/standard/*` 配置类 + 仓库根 `.realtime_*.json`）由 Nest `ConfigService` **唯一写入**、Python 只读（见 §6.1 / §7 契约 5）——改动写入方后须保证格式/路径兼容，否则计算侧读到陈旧或坏数据。
