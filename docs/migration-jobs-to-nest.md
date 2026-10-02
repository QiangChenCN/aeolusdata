# 任务中心迁移：jobs/*.py → NestJS 任务流水线

- 日期：2026-09-23
- 状态：进行中
- 关联：[ADR 修订 1](./adr-backend-nestjs-2026-09-20.md#修订-12026-09-22取数职责迁回-nestjs)、[server-py-to-nestjs-map](./server-py-to-nestjs-map.md)、[workbench-refactor](./workbench-refactor.md)

## 0. 决策（Principle）

**Python = 大数据计算，仅此一项。其余一切（取数 / 加工 / 编排 / 出图 / 上传 / 发送 / 调度 / 托管）全部 NestJS。**

- 已确认边界（2026-09-23）：**仅 Excel（openpyxl）保留 Python**；**PNG 渲染迁 Nest**（前端已有 ECharts 生态，Node 侧用 `@napi-rs/canvas` 复刻）。
- 9 个 `python/jobs/*.py` 脚本**整体退场**，重写为 Nest 任务流水线；任务中心不再 `spawn(python, python/jobs/xxx.py)` 跑业务。
- Python 保留下来的调用口只剩两类：**大数据计算**（看板聚合 `rider_dimension` / `achievement`）与 **Excel**（`openpyxl`，看板导出）。
  （原「登录重登」`aeolus_sdk.login` 已于 2026-09-23 迁 Nest——RSA/SSO/探针/重登全在 `backend/src/modules/fetch/aeolus-login.service.ts`，Python 侧 `python/get_data/auth.refresh_cookie()` 仅转发 `POST /api/fetch/aeolus-relogin`；「缓存落盘」同批迁 Nest，Python 只保留读。）

### 关键事实（清点结论）

- 9 个任务**完全不用 Excel**（`openpyxl` 只出现在 `python/get_data/delivery_export.py`，供看板用）→ 迁移后这 9 个任务对 Python 的依赖为**零**。
- 4 个任务出 PNG（attendance / appeal_reminder / task_board / task_equipment / unsat_run 共 5 个，其中 unsat 自绘不走 `report_render`），4 个任务上传 MinIO（prefix：`attendance` / `vp` / `taskboard` / `equip`）。
- 覆盖的 `get_data` 模块：`attendance` / `violation` / `board` / `rush` / `delivery` / `ruledoc` / `orange_storm` / `rider_equipment`（Quark 凭证链）。
- 现有 Nest `fetch/` 已落地 delivery 取数（`DeliveryQueryService` / `FetchPaceService` / `AeolusCookieService` / `OrdersFetchService` / `RefreshAllService`），其 `POST /api/fetch/orders-raw`（“供 Python 编排层回调”）即是本次复用的范式。

## 1. 目标架构

```
backend/src/modules/
├─ tasks/        注册表 + 串行执行器 + 历史/诊断 + 产物      ← 脊梁
│   ├─ task-handler.ts        TaskHandler / TaskContext 接口
│   ├─ task-handlers.service.ts  handler 注册表（按 taskId 查）
│   └─ pipelines/*.ts         9 个任务的流水线（原 python/jobs/*.py）
├─ fetch/        取数（新增 attendance/board/violation/rush/ruledoc/orange-storm/equipment 服务）
├─ media/        MinioService（移植 python/common/minio_common）
├─ render/       ReportRenderService + theme-colors（移植 python/common/report_render）
├─ notify/       通知配置（MANAGER_OPENID / STATION_MANAGERS / TEAM_TO_STATION / 群常量）
├─ dingtalk/     已有：发消息 / 发文件 / 群解析 / 在线表读写
└─ compute/      委托边界（Python 仅此出入：重计算 / Excel）
```

### 任务执行模型（增量、可回退）

`TaskRunnerService` 保留两种执行路径，**按任务逐批切换**：

1. **原生 handler**（新）：任务在 Nest 内注册 `TaskHandler`，`execute()` 直接 `await handler.run(ctx)`；
   日志仍走 `append()` → `StreamingService.emit`，前端零改动。
2. **spawn(python)**（旧，过渡期保留）：未注册 handler 的任务继续按 `cmd` 起子进程，直至全部迁完再删除该分支。

`python/workbench/tasks.json` 语义微调：`cmd` 变为可选；新增 `native: true` 标记（由 handler 注册表反向校验）。
`groups` / `params` / `outputs` / `needs` / `nodes` 等前端依赖字段**保持不变**。

## 2. 契约与不变量

1. **全局串行**：任务不并发（避免 aeolus cookie 争抢）——沿用现有单 worker 循环。
2. **SSE 事件形态不变**：`{type, run_id, ...}`，前端零改动。
3. **产物路径不变**：仍是 `python/jobs/<task>/out/**`（`tasks.json.outputs` 已声明，前端产物浏览器依赖它）。
4. **群定位语义不变**：传群名（如 `站点日常管理通知群`）或 cid，由 `dingtalk` 模块 `resolveGroup` 解析。
5. **@人语义不变**：`STATION_MANAGERS` → `MANAGER_OPENID` → 剔除 `DO_NOT_AT`。
6. **日志文案尽量保持**：`diagnose` 的已知错误模式依赖日志文本。
7. **节点区间**：`--begin/--end` 语义保留（`nodeflow.pick` 等价物）。

## 3. 迁移顺序（先易后难，每步可停）

| # | 任务 | 取数 | 加工 | 出图 | MinIO | 发送 | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | `jidan_fetch` | rush（三连调） | 扁平化 | — | — | — | 最简，验证框架 |
| 2 | `orange_storm` | orange_storm | flatten | — | — | — | 仅落盘 CSV/JSON |
| 3 | `rule_doc` | ruledoc | HTML/MD 组装 | —（HTML） | — | — | 产出 HTML/MD |
| 4 | `delivery_pipeline` | delivery | JSONL + PG 入库 | — | — | — | 需 `pg` 驱动 |
| 5 | `task_board` | board | 筛已开始 | ✓ | ✓ | ✓ | 首个子图+发送 |
| 6 | `appeal_reminder` | violation | 筛待申诉 | ✓ | ✓ | ✓ | CSV + 出图 |
| 7 | `attendance` | attendance | 站点统计 | ✓ | ✓ | ✓ | 多站并发 |
| 8 | `task_equipment` | rider_equipment | 筛未点亮 | ✓ | ✓ | ✓ | Quark 凭证链 |
| 9 | `unsat_run` | violation | SQLite + 在线表 | ✓（自绘） | — | ✓ | 最复杂 |

**收尾**：迁移供看板使用的剩余 `get_data`（`teams` / `schedule_statistics` / `delivery_export`）；
删除 `python/jobs/*.py`、`python/common/{nodeflow,report_render,minio_common,ding_common}.py`；更新本文档与 `server-py-to-nestjs-map.md`。

## 4. 新增依赖

- `@napi-rs/canvas`：Node 侧 PNG 渲染（预编译二进制，无需本地编译工具链）。
- `minio`：对象存储上传（复刻内容寻址对象名 `prefix/{sha256[:16]}.png`）。
- `pg`：`delivery_pipeline` 入库（PostgreSQL）。

中文字体：沿用 `ding_common.resolve_font_path()` 的解析顺序（env `DING_FONT_PATH` → Windows simhei/msyh → Linux wqy/Noto → macOS PingFang → `fc-match`），在 Nest 侧落为 `render/font.ts`。

## 5. 风险

- **渲染复刻保真**：5 个渲染函数布局细节多（列宽自适应、斑马纹方向、药丸、`fit_font` 逐号递减）。策略：逐函数对照 `python/common/report_render.py` 复刻，并保留旧 Python 渲染到全部验收通过后再删。
- **Quark 凭证链**（`rider_equipment`）：DA_TOKEN 兑换是 SSO 多跳 + `curl` 中性 TLS 指纹。
  最初按「复用 Python `quark_sdk` 子进程」过渡；**2026-09-23 按用户要求整体重写为 Nest 原生**
  （`fetch/quark-creds.service.ts`），Python 侧实现已全部删除。
- **过度迁移**：`python/dashboard/standard/*` 的聚合计算不在本次范围（属「大数据计算」，留 Python）。

## 6. 迁移状态（2026-09-23）

9 个任务已全部迁到 Nest 原生流水线（`backend/src/modules/tasks/pipelines/`），实测情况：

| # | 任务 | 取数服务 | 实测 |
|---|---|---|---|
| 1 | `jidan_fetch` | `fetch/rush-fetch.service` | ✅ 实跑（21 条急单，CSV/JSON 正确） |
| 2 | `orange_storm` | `fetch/orange-storm-fetch.service` | ✅ 实跑（3920 条，91 列 + 精简 CSV） |
| 3 | `rule_doc` | `fetch/ruledoc-fetch.service` | ✅ 实跑（HTML 101KB + MD 9KB） |
| 4 | `delivery_pipeline` | `fetch/delivery-{raw,db,csv}.service` | 🟡 raw/断点续传已验证；**DB 未验证（本机无 PG）**；真实抓取被上游限流 |
| 5 | `task_board` | `fetch/board-fetch.service` | ✅ 实跑（18 条，MinIO 上传，出图保真） |
| 6 | `appeal_reminder` | `fetch/violation-fetch.service` | ✅ 实跑（GBK CSV 解码，出图保真） |
| 7 | `attendance` | `fetch/attendance-fetch.service` | ✅ 实跑（3 站并发，出图保真） |
| 8 | `task_equipment` | `fetch/equipment-fetch.service` + `quark-creds.service` | ✅ 实跑（162 行，出图保真） |
| 9 | `unsat_run` | `fetch/unsat-store.service`（node:sqlite） | 🟡 fetch/store/自绘渲染已验证；**sheet 写生产在线表 / 发群未实写** |

共享基建：`media/minio.service`（MinIO）、`render/*`（`@napi-rs/canvas` 复刻 5 个渲染函数 + theme-colors + 字体）、`notify/notify-config`（@人/站点/群常量）、`python/common/csv`（RFC4180）。

**Quark 凭证链已重写为 Nest 原生**（`fetch/quark-creds.service.ts`，2026-09-23）：
getReport（fetch）→ report.htm / daLogin（**spawn `curl` 取中性 TLS 指纹**）→ 解析 curl cookie 罐拿 `DA_TOKEN`
→ 报表页提取 `reportIdToken/secureParams/metaTime`。缓存落 `backend/data/quark/da_cache.json`
（`{cookie, jar, saved_at}`，原子写）。**实测完整兑换 3.2 秒**（原 Python 约 13s），
`DA_TOKEN` 与三件套齐备，缓存探针 valid，`task_equipment` 全链路正常。
`python/tools/quark_creds_dump.py`、`quark_sdk/` 已删除；`server.py::_check_quark_cookie` 改为
「只读 Nest 缓存 + stdlib 探针」。Nest 新增只读端点 `GET /api/quark/status`。

Python 侧现仅剩**看板聚合计算 / Excel**（`compute_service`）一项业务职责。
（原「Aeolus SSO 登录重登」已于 2026-09-23 迁 Nest——`aeolus_sdk/{login,xlock,__init}.py` 已删，
Python 侧 `python/get_data/auth.refresh_cookie()` 仅转发 `POST /api/fetch/aeolus-relogin`；
「缓存落盘」同批迁 Nest，Python 不再写盘，只保留 `load_raw` 读端口。）

**顺带修复的真实缺陷**（随 `quark_sdk` 一并不复存在）：原 `creds.py::_curl_get` 未指定编码
→ Windows 默认 GBK 解码报表页崩溃，导致「报表页无权限」误判；Nest 侧一律显式 UTF-8 宽松解码。

### 收尾（2026-09-23 已执行）

**已删除**（删除前逐个确认无存活消费者）：

- `python/jobs/**` 下全部 `.py` / `.pyc`（26 个作业脚本与辅助模块）+ `__pycache__`
  —— **保留** `python/jobs/**` 下的数据/配置/产物：`delivery/column_profile.json`、`delivery/db_config.json`、
  `ruledoc/rule_native_reference*.html`、各 `out/`（Nest 侧仍在读这些路径，切勿连带删除）。
- `python/common/{nodeflow,report_render,minio_common,ding_common}.py`（能力已全部进 Nest）
- `python/tools/quark_creds_dump.py` 与 `quark_sdk/` 下全部文件（Quark 凭证链已重写为 Nest 原生；
  旧缓存 `quark_da_cache.json` / `quark_da_cookies.txt` 一并删除，首次运行自动重兑）
- 上述模块的孤儿消费者：`core/`、`python/tools/{preview_renders,sync_nodes}.py`、
  `python/tests/{test_nodeflow,test_ding_common,test_core_notifier}.py`
- 仅被已删作业使用的 `python/get_data/`：`board` / `rush` / `orange_storm` / `ruledoc` / `rider_equipment`
  —— **保留** `attendance` / `violation`（看板聚合仍用）、`delivery` / `delivery_export` / `schedule_statistics`（看板用）、
  `teams`（`python/tools/probe_teams` + `server.py` 用）、`auth`（共享）。

**回归校验**：`import server` / `import compute_service.main` 均 OK（Python 计算后端未受影响）；
`task_board` 原生流水线在删除后仍跑通。

**收尾已完成（2026-09-23）**：

1. ✅ `core/` 与 `quark_sdk/`（空目录）已删除 —— 守卫测试
   `python/tests/test_compute_handlers.py::test_no_python_side_data_permission_module` 恢复通过，
   **pytest 全绿（当时 35 项：30 passed / 5 skipped / 0 failed）**。
2. ✅ `python/workbench/tasks.json` 的 9 个 `cmd` 已移除；`TaskDef.cmd` 改为可选，`TaskRunner` 在
   「无原生 handler 且无 cmd」时**明确报错**（不再静默去起一个已删除的脚本）；`web/src/run.js`
   的高危确认弹窗已容忍缺失 `cmd`（改显示「Nest 原生流水线 · 任务名」）。
   实测 9 个任务均为 `hasCmd=false / hasNativeHandler=true`，`jidan_fetch` 实跑通过。
3. ✅ 注释/文档残留清理：`server.py`（2 处）、`python/get_data/__init__.py`、`python/venv_guard.py`、
   `aeolus_sdk/__init__.py`、`DEPLOY.md`、`docs/SERVER_DEPLOY_GUIDE.md`（含 scp 清单与验证命令已改为 Nest 侧）。
4. ✅ `python/requirements.txt` 移除已无引用的 `Pillow` / `minio`（仅保留 `openpyxl` —— `server.py`
   与 `python/get_data/delivery_export.py` 仍在用）。`deploy/setup.sh` 复核无失效引用。

### server.py 解体（2026-09-23，后端收敛步骤 1）

`server.py` 已**删除**，`compute_service` 不再 `import server`：

- **切分方式**：AST 传递闭包。入口 = `check_cookie_status` / `_fetch_all_teams` / `_safe_resolve` /
  `sheet_to_json` + `GET_ROUTES` / `POST_ROUTES`，产出 `python/compute_service/handlers.py`
  （新增 `python/compute_service/__init__.py` 使其可被测试导入）。
- **保留 58 个模块级定义**：命名空间 handler（standard / attend-period / overview / realtime，
  20 GET + 8 POST）+ 频控、站点缓存、Cookie 探针、路径守卫、表格解析。
- **剔除 38 个定义、约 900 行**：`RunManager`（≈500 行）/ 产物列举 / 静态托管 / `API_TOKEN` /
  `DIAG_RULES`+`diagnose` / `load_registry`+`missing_prereqs` / `load_history`+`save_history` /
  data-perms 站点快照（`_dp_*`）/ `_is_loopback_origin` / `CONTENT_TYPES`+`INLINE_EXTS` / 各类路径常量。
- **校验**：① 28 条路由 handler 源码与迁移前**逐字符一致**，4 个入口函数与 7 个依赖常量同样一致；
  ② 自建「未定义名」静态扫描 → **0**；③ 8900 实测 `/api/health` 200、
  `/api/cookies/status` 返回 `status:"valid"`（真实探针）、`/api/standard/refresh-all-status` 正常、
  `sheet_to_json` 直测可解析 xlsx；④ pytest **31 passed / 5 skipped / 0 failed**（共 36 项；5 个 skip 均来自已休眠的 `test_monolith_parity.py`）。
- **两处切分遗漏（已由校验抓出并修掉）**：`urllib.request`/`urllib.error` 子模块形式、
  `sheet_to_json` 依赖的 `openpyxl`/`xlrd` 守卫式导入（包在 `try/except` 里，不在顶层语句中，
  初版闭包未覆盖）。前者表现为 `/api/cookies/status` 报 `module 'urllib' has no attribute 'request'`，
  后者会让 `/api/sheet` 直接崩。
- **副作用清理**：计算进程不再读写 `.api_token`（原为频控指纹来源），改为常量兜底 ——
  鉴权归 NestJS，计算进程不该有「创建鉴权文件」的副作用。
- **测试改造**：`python/tests/test_server_routes.py` → `python/tests/test_compute_handlers.py`
  （新增 `test_no_workbench_side_effects`，防止工作台职责从后门回流）；
  `test_data_scope.py`、`test_monolith_parity.py` 的引用一并改到 `compute_service.handlers`。
- **文档同步**：`DEPLOY.md`（分层说明 / 暂存示例 / runbook 的 systemd 单元名）、
  `deploy/nginx-aeolus.conf`、`deploy/setup.sh`、`index.html` 注释、本文件与
  `docs/server-py-to-nestjs-map.md`。

**顺带发现（未改，留待决策）**：`handlers._is_sensitive_path` 里
`os.path.normpath(rel).replace("\\","/").strip("./")` 的 `strip` 会吃掉**前导 `.`**，
于是 `.env` 被归一化成 `env`，与 `_SENSITIVE_GLOBS` 中的 `".env"` / `"*.env"` **永远匹配不上**
—— 即「阻止读 .env」这条规则实际失效（迁移前已如此，非本次引入）。当前唯一消费者 `/api/sheet`
只解析 xlsx/xls，读不到凭证，暂不构成可利用漏洞；建议顺手改成
`strip("/")` + 显式去 `./` 前缀。

### 站点目录与登录态迁 Nest（2026-09-23，后端收敛步骤 2）

两个端点从「Nest 代理 → Python」改为 Nest 原生：

| 端点 | 新位置 | 说明 |
|---|---|---|
| `GET /api/teams` | `modules/teams/` + `fetch/teams-fetch.service.ts` | 取数（xtop `getTeamsAll/1.0`）+ 5 分钟缓存 + 兜底三站；控制器只叠加数据权限过滤 |
| `GET /api/cookies/status` | `modules/status/` + `fetch/cookie-status.service.ts` | 风神 validToken 三态 + Quark DA 四态；前端 60s 轮询 |

配套改动：

- **新增内部端点 `GET /api/fetch/teams`**：供 Python 侧回调。`handlers._fetch_all_teams`
  不再自己打 xtop，改为转发它 —— 这样前端 `/api/teams`、`/api/attend-period/teams`、
  `/api/standard/teams-config` 三处消费**共用同一份 5 分钟缓存**（此前 Nest / Python 各一份，
  等于每 5 分钟多打一次风神）。
- `handlers.py` 删除三个登录态探针函数（`check_cookie_status` / `_check_aeolus_cookie` /
  `_check_quark_cookie`，共 139 行）；`python/compute_service/main.py` 删除对应两个端点。
- `QuarkCredsService` 新增 `probeDetail`：curl 增加 `-w '%{http_code}'` **与 `-L`**，
  把「401/403 硬拒」「HTML 登录页」「非 JSON 怪响应」「网络异常」分开；`cacheStatus`
  改用同一探针，并区分「da_cache.json 不存在」与「文件在但缺 cookie 字段（缓存损坏）」
  —— 后者原先也被折叠成「不存在」，前端无法分辨「没兑换过」和「缓存坏了」。
- `ProxyController` 移除 `/api/teams`、`/api/cookies/status` 两条转发路由 ——
  **同路径重复注册时 Express 只保留先注册的那个**，另一条静默失效（该文件注释里记录过这个坑）。
- 兜底清单口径收敛：`FALLBACK_TEAMS`（Nest）成为唯一来源；Python
  `python/dashboard/standard/teams_config.py::TEAM_NAMES` 仅在 Nest 整体不可达时作末位兜底，
  前端 `web/src/teams.js` 同理 —— **新增 / 改名站点需同步 Nest 与前端两处**。
- 数据权限：`/api/teams` 无会话（系统 / iframe 持机器令牌）时**不受限**，有会话才按
  `resolveAllowed(user, role, 'team')` 过滤 —— 与 `ProxyController.scopeHeaders` 的
  `x-scope` 口径一致；过滤一律 `filter` 出新数组，**绝不就地改共享缓存**（防缓存投毒）。

**实测**：`/api/fetch/teams` 与 `/api/teams` 均返回真实 xtop 站点（9 个，`source=xtop`）；
`/api/cookies/status` 返回 `status:"valid"`（风神）+ `quark:"invalid" / 探针被网关硬拒（HTTP 403）`
—— **与迁移前 Python 输出逐字一致**；Python 侧 `_fetch_all_teams()` 转发成功
（`source=xtop, teams=9`）。pytest **33 passed / 5 skipped / 0 failed**（38 项）。

**过程中修掉的一个真缺陷**：探针沿用旧 Nest `probeHealthy` 的 curl 调用时**没有跟随重定向**，
而 DA cookie 失效时该端点先回 `302` 再落到 403 / 登录页 —— 不跟随只能看到「302 + 空正文」，
于是「凭证已废」被误报成「状态未知」（迁移前的 Python 用 `urllib.urlopen` 默认跟随，
两边口径本就不一致）。加 `-L` 后与 Python 完全对齐。

### 阶段 1+ 三路取数迁 Nest（2026-09-23，后端收敛步骤 3）

`refresh_all` 阶段 1+ 的三路取数（`sched` 排班 / `att` 考勤 / `violation` 违规）从 Python 迁到 Nest：
打接口（分页节奏 / 限流退避 / 会话失效判定）全部由 Nest 承担，Python 的 `python/get_data/*` 变成**转发层**。

| 路 | Nest 实现 | 暴露端点 | Python 转发点 |
|---|---|---|---|
| 考勤 att | `fetch/attendance-fetch.service.ts`（**已存在，1:1 复用**） | `POST /api/fetch/attendance-raw` | `python/get_data/attendance.py::fetch_team` |
| 排班 sched | `fetch/schedule-fetch.service.ts`（**新写** —— Nest 此前无任何排班实现） | `POST /api/fetch/sched-raw` | `python/get_data/schedule_statistics.py::query` |
| 违规 violation | `fetch/violation-fetch.service.ts`（已有的只覆盖底层下载）+ 新端点 | `POST /api/fetch/violation-csv` | `python/get_data/violation.py::download_csv` |

**关键设计：在 `python/get_data/*` 这一层改转发，上层零改动。**
`python/dashboard/standard/{rider_dimension,achievement}.py` 与 `python/dashboard/realtime/violations.py`
仍照旧 `from get_data.attendance import fetch_team` —— 换取数引擎对它们完全透明。
这与阶段 0（运单）当年经 `NEST_FETCH_URL` 回调 Nest 是同一范式，只是把「回调」下沉到了
`get_data` 边界（该环境变量后来随阶段 0 原生化一并废弃）。

配套改动：

- `python/get_data/_nest.py`（新）：转发薄封装 + `{ok, code, error}` 拆包。命中
  `get_data.auth.SESSION_CODES` 时抛 `AuthError`，让 `call_with_relogin` 照旧**强制重登后重试** ——
  重登本身已迁 Nest（`POST /api/fetch/aeolus-relogin`，Nest 的 `ensure()` 先做 validToken 探针）；
  Python 保留的是「捕获会话失效 → 强登 → 重试一次」的编排，不再持有任何登录实现。
- `python/common/nest_client.py`：从「仅钉钉客户端」扩为**共享客户端**，新增 `nest_base()` /
  `post_json()` / `get_json()`。两套错误口径并存且写明理由：钉钉那几条是「成功即用、失败直接抛」；
  取数回调**不抛 HTTP 错误**，把响应体交回调用方判定（需要区分「会话失效 → 重登」与「服务错误 → 上报」）。
- 排班取数保留 Python 原有退避节奏（网络 `2+2n` 秒 / 限流 `3+3n` 秒），数值未改。
- 顺带收口步骤 2 的遗留：`python/get_data/teams.py` 已无生产消费者 → **删除**；
  `python/tools/probe_teams.py` 的生产段改调 Nest `GET /api/fetch/teams`（其「候选接口探活」段仍直连 xtop ——
  那是逆向探测，不是生产取数）。`python/get_data/__init__.py` 重写为「转发层」口径。
- 三个 `get_data` 模块不再含任何 `urllib.request` 代码（已核对为空）；`API_URL` / `STATIC_HEADERS`
  作为**对照参考**保留，便于核对 Nest 侧与上游口径是否一致。

**实测（真实接口）**：`schedule_statistics.query` → 1 天 / 11 个时段；
`attendance.fetch_team` → 116 名骑手（字段集完整）；`violation.download_csv` → 14.5KB CSV
（中文表头 + 真实数据）。pytest 全绿。

**仍未迁：`refresh_all` 的原生编排。** `/api/standard/refresh-all` 依旧代理到 Python，
per-team 循环（`RD.compute` → `AC.compute` → 落结果层缓存）与结果计算仍在
`python/dashboard/standard/refresh_all.py`。这一步与「取数」正交：结果计算属大数据计算、按原则留 Python；
但**编排**（阶段 0 / 0.5 / 每站的调度、状态机、日志、频控）应迁 Nest —— 这是 ADR 里最后一个 ⬜。

### refresh-all 原生编排（2026-09-23，后端收敛步骤 3 收尾）

**ADR 里最后一个 ⬜ 关闭**：`/api/standard/refresh-all` 不再代理给 Python。

| 层 | 归属 | 内容 |
|---|---|---|
| 编排 | **Nest** `fetch/refresh-runner.service.ts` + `refresh.controller.ts` | 阶段 0/0.5/每站调度、状态机、日志文件、单飞、频控、数据权限收敛、历史日期护栏 |
| 阶段 0 取数 | Nest（已有） | `RefreshAllService.refreshOrders`（一次拉全量 → 分组落盘 → 通知 Python 失效缓存） |
| 计算步 | **Python** `compute_service` | `POST /api/compute/{violations,rider-dimension,achievement}`：算 + 按既有格式落盘 |

**边界判定（值得记下来）**：三个计算步**连落盘一起留在 Python**，而不是「Python 算完把结果丢回 Nest 让 Nest 落盘」。
理由：结果层缓存（`python/dashboard/standard/cache/{rider,ach}_*.json`）与违规明细的 `fetch_ok` 包装格式，
其**唯一读取方是 Python 的看板聚合**；把格式判定的责任搬到 Nest 只会制造两份格式知识。
所以分工定为「Nest 编排，Python 算 + 按自己的契约落盘」，返回值只带摘要（`rows` / `order_counts` / `msg`）。

关键实现点：
- **`refresh_all.py` 已删除**；`handlers.py` 移除两个 handler、两条路由条目、`REFRESH_ALL_GLOBAL_GAP_SEC`
  与只服务 refresh-all 的 `_rate_check_multi`。
- `states` 字段名与 Python `_STATE` **逐字一致**（前端只读 `running` 与 `error[]`，其余是诊断信息）。
  实测 `status` 里的 `stats` 直接就是 Nest 的抓取节奏统计（少了一层跨进程搬运）。
- 日志文件仍在 `python/dashboard/standard/logs/refresh_YYYYmmdd_HHmmss.log`，行格式不变。
  差别：Python 计算步自己 print 的进度行现在只进 compute 服务的 stdout，不进这个文件
  （编排自己写的行照旧）—— 排查计算细节需看 compute 日志。
- `ProxyController` 的 `standard/{*path}` 通配会命中这两个路径，故在通配里**显式改派**到同一个
  `RefreshRunnerService`（path-to-regexp 不支持负向断言，靠模块注册顺序又易碎）；
  HTTP 语义（频控/权限/单飞）因此下沉进 service，避免两处各写一遍。
- **测试跟随逻辑迁移**：原 Python 的 5 个作用域收敛用例（打桩 `RA.start` 捕获入参）迁为
  `backend/src/modules/fetch/refresh-runner.spec.ts` 的 **9 个 Jest 用例**（作用域 4 条 + 交集为空
  越权边界 + 单飞 + 频控 + 历史护栏 + status 形状）。顺带**补上了此前缺失的 Jest 配置**
  （`backend/jest.config.js`）—— 在此之前 `npm test` 实际因无法解析 TS 而跑不起来。

**实测（真实链路）**：单站全量刷新 84 秒跑完 —— 阶段 0 共享运单（全量 2344 条 / 命中 1015）、
阶段 0.5 违规（84 条 / 命中 47）、每站骑手维度（77 人）全部 `ok`，`error: null`；
日志落在 `refresh_20260923_142302.log`；`stats` 显示请求 48 次 / 被限流 1 次 / 重试 1 次。
pytest 与 Jest 均全绿。

### 移除「Nest 挂了也能拉数」的本地回退（2026-09-23）

原先 Python 侧保留了一整套本地运单拉取（分页 / 反爬节奏 / 限流退避 / 重登 / 异步导出兜底），
供阶段 0 失败时降级使用（`reuse_orders=False` → 逐站本地拉）。这一步把它整体移除。

**改动**：

- **Nest**：阶段 0 失败改为**整体失败**（不再「降级为逐站拉取」—— 那等于恢复一套刚删掉的实现），
  逐站标记失败后结束；新增 Jest 用例覆盖该语义。
- **Python 计算步**：`rider_dimension` / `achievement` 的运单来源改为**只读阶段 0 落盘**。
  `reuse_orders` 语义变为「阶段 0 已完成」：为真时缺文件视为当日 0 单（不是错误），
  为假则直接明确报错。
- **删除**：`python/dashboard/standard/orders_fetch.py`（约 600 行：Session / 分页 / 时段切片 /
  指数退避 / 统计 / 导出兜底）、`python/dashboard/standard/download_delivery.py`、
  `python/tools/probe_export_path.py`、`python/get_data/delivery.py`、`python/get_data/delivery_export.py`。
  ⚠️ 说明：`delivery_export`（运单 → Excel/CSV 导出）的唯一消费者就是这套本地拉取，
  删除后已无任何调用方，故一并移除。看板需要的 xlsx **解析**能力不受影响，
  仍在 `python/compute_service/handlers.py::sheet_to_json`（那条 Excel 边界不变）。
  若日后还要「导出运单明细」，应基于 Nest 的 `POST /api/fetch/orders-raw` 重做，而不是恢复本地拉取。
- **配置**：`NEST_FETCH_URL` 废弃（`deploy/.env.example`、`deploy/aeolus-compute.service` 已更新）；
  回调基址改为 `NEST_BASE` / `DING_NEST_BASE` → loopback（两服务同机时无需任何配置）。
- **注释债清扫**：7 个 Python 文件中指向 `refresh_all._*` / `orders_fetch` / `get_data.delivery`
  的失效指针全部改指现址（Nest 的 `refresh-all.service.ts` / `refresh-runner.service.ts` /
  `fetch-pace.service.ts`）。
- **测试**：删除 3 个 `orders_fetch.Session` 用例（被测对象已不存在）；`AuthError` 一致性断言
  收窄到仍在用的模块。

**取舍记录**：这等于**放弃**「Nest 整体不可用时仍能拉数」的应急能力。理由是该能力要求长期维护
两套取数实现（各自的限流与重登策略都要同步），而 Nest 本身就是唯一入口 —— 它挂了前端也用不了。
若将来确实需要，应由 Nest 提供一条最小可用路径，而不是在 Python 保留第二套。

**验证**：删改后重跑单站全量刷新 —— 84 秒完成，`error: null`，站点 `ok`（骑手 77 人 / 运单命中
1034 条）、违规命中 48 条、日志与抓取统计正常；pytest **25 passed / 5 skipped / 0 failed**（30 项）；
Jest **10 passed**。

### 风神 SSO 登录迁 Nest（2026-09-23，后端收敛步骤 4）

目标收敛为「Python 只做大计算」后，登录不能再留在 Python（否则 Nest 取数要依赖 Python 运行时）。
原 `aeolus_sdk/login.py` 整体移植到 **`backend/src/modules/fetch/aeolus-login.service.ts`**：

- **RSA**：复刻 Dave Koelle 版 JS 库（**无填充分块**、小端整数、`pow(m,0x10001,n)`、hex 左补零），
  用 BigInt 模幂实现 —— 不是标准 PKCS#1，任何一位偏差都只会得到「账号密码错误」。
- **SSO 流程**：登录页取 `rsaPublicKey`/`_sso_csrftoken_`/`umidTokenId` → POST `doLogin.json`
  → 跟随 redirectURL 完成票据交接 → 访问 aeolus 取 `AEOLUS_MOZI_TOKEN`。
- **手工 cookie jar + 手工跟随跳转**：票据交接全靠每一跳的 `Set-Cookie`，而 `fetch` 的
  `redirect:'follow'` 拿不到中间响应头。
- `AeolusCookieService` 变为异步状态层：进程内复用（等价 `_shared_cookie`）+ 重登串行
  （promise 链，等价 `_shared_lock`）+ **并发重登合并** + 原子写盘（临时文件 + rename，0600）。

**三处有意偏离 Python（都更严格）**：
1. `ensure()` 会做 validToken 探针（Python 的 `ensure_cookies` 也做；而迁移前 Nest 只「文件存在就用」，
   于是拿过期 cookie 反复赚 401，还得靠 Python 侧 `call_with_relogin` 兜）。
2. `relogin()` **强制**新登录，不复用内存 token —— Python 的 `refresh_shared_cookies` 在内存有 token
   时直接返回它，而调用方正是「刚被 401 顶掉」的场景，返回旧 token 会让重试再失败（潜在死循环）。
3. 凭据**惰性读取**（Python 在 import 期就读，缺文件会让「只是 import 一下」抛错）。

`AEOLUS_INSECURE_TLS` 未保留（Node 全局 `fetch` 无法按请求关证书校验）；跨进程锁 `xlock.py`
不再需要（迁移后只有 Nest 写 cookie）；新增 `POST /api/fetch/aeolus-relogin` 供 Python 触发强登。

**验证**：RSA + URL 编码与 Python 原实现**逐字节等价**（7 个向量，覆盖跨块 / 中文 / 1024 位生产密钥尺寸；
`aeolus-login.spec.ts`）；登录页解析实测命中；**端到端真登录实测成功** —— 探针发现旧 cookie 失效后
由新实现走完完整 SSO，日志 `SSO 登录成功，cookie 长度 442`，且新 cookie 被接口接受
（`GET /api/fetch/teams` 正常返回 9 个站点）。

**Python 侧退场**：删除 `aeolus_sdk/{login,xlock,__init__}.py` 与 `python/tests/test_xlock.py`；
`backend/aeolus_sdk/`（2026-09-24 由根目录移入）现在**只剩数据文件**（`cookie.txt` + `credentials.json`）。`python/get_data/auth.refresh_cookie()`
改为转发 `/api/fetch/aeolus-relogin`；`python/dashboard/standard/schedule_statistics.py` 的
`Session`/`fetch`（无调用者）删除，该文件精简为纯计算的 `flatten`。

### 原始层落盘迁 Nest + 结果层删除（2026-09-23，后端收敛步骤 5）

**落盘全部归 Nest**（`backend/src/modules/fetch/raw-cache.service.ts` 是**唯一写入方**）：

- 原 `RefreshAllService.saveRaw`（运单）提取为共享服务，新增 `saveViolation` 组装违规明细的
  `fetch_ok` 包装；新增 `POST /api/cache/raw` 供 Python 计算侧把 payload 交回落盘。
- Python 的 `cache.py` **保留读写 API 的名字、去掉写入实现**：`save_raw` / `save_violation`
  转发到 Nest（`save_violation` 由 Nest 组装包装格式，使格式全仓只有一处定义），
  **读**（`load_raw` / `raw_exists` / `latest_cache_time`）仍直接读文件 —— 那是计算的输入端口。
- 进程内结果缓存（`get_result`/`put_result`/`clear_results`）**有意不迁**：它是计算进程内的
  memoization，迁到 Nest 等于让 Nest 缓存 Python 的内存对象。写入后由**同进程**调用
  `invalidate_results` 失效（Nest 不知道自己写的文件脏了哪个进程的缓存，跨进程通知走
  `/api/cache/invalidate`）。

**结果层删除**：`python/dashboard/standard/cache/{rider,ach}_*.json` 与 `cache.save()` / `cache.load()` 一并移除
—— 迁移时核实全仓**无任何读取方**（Python 无 `CACHE.load(` 调用，前端与 Nest 也不读），
是 write-only 死物（已清掉盘上 90 个文件 / 2.28MB；`pace_state.json` 保留，它与 Nest 共用）。

**验证**：真实计算步端到端 —— `POST /api/compute/rider-dimension`（`reuse_orders=true`）
`{ok:true, source:"live", rows:77}`，`att_<team>_<date>.json` 由 Nest 重写；`achievement` 在删除当日
`sched` 后同样由 Nest 重写（11 行展平结构）；违规的 `save_team` / `mark_failed`（保留旧 rows、
置 `fetch_ok=false`）经 `/api/cache/raw` 往返验证。pytest 用例改造为**种子文件测读侧 + 打桩
`nest_client.post_json` 测转发**，不再依赖在跑的 Nest。

### 顺带修掉的缺陷：body 上限 100kb 会把 413 变成误导性 404（2026-09-23）

迁落盘时踩到：实时考勤快照 ≈340KB，而 Express `json()` 默认上限 **100kb**。超限时
body-parser 的 413 在 Nest 里最终表现为默认「未匹配路由」，客户端收到的是

```
404 {"code":404,"message":"Cannot POST /api/cache/raw","path":"/api/cache/raw"}
```

即**看起来像路由没注册，实际是 body 超限**（实测阈值 102400 通过 / 105000 失败；与路由无关，
`/api/auth/signin` 同样中招）。修法：`main.ts` 改 `bodyParser: false` + 自注册
`json/urlencoded({ limit: '16mb' })`（必须自注册：框架默认解析器先注册，顺序上会先拦）。

**仍待验证（需特定环境）**：
- `delivery_pipeline` 的 PG 入库（需 PostgreSQL 实例）
- `unsat_run` 的在线表写入与发群（写生产在线表有副作用，不宜盲跑）
- 遗留改进：`delivery` 的 FREQUENT 限流目前照搬 Python 的「立即重试 8 次」，建议两侧都加指数退避

**历史文档说明**：`docs/workbench-refactor.md`、`docs/code_review_2026-09-07.md`、
`docs/api-list.md` 中涉及 `python/jobs/*` / `quark_sdk` / `python/common/*` 的章节是**迁移前的记录，保持原样不追改**；
当前状态以本文档为准。
