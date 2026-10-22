# ADR: 后端选型 NestJS（计算隔离 + Python 接管规则）

- 日期：2026-09-20
- 状态：已采纳（Accepted）
- 关联：`workbench-refactor.md`、`architecture-review-2026-09-09.md`

## 决策（Decision）
后端初始选型 **NestJS（Node + TypeScript）**。所有"计算类"逻辑从一开始就关进**独立的 service**（如 `ComputeService` / 领域级 `ReportService`、`AnalysisService`），对外只返回干净的 DTO。

当某块计算在 **Python 生态明显优于 Node** 时，将该计算**单独抽出，由独立的 FastAPI 服务接管**；NestJS 继续作为编排 / I-O 层（HTTP、SSE、REST、调度、鉴权、托管前端），通过 HTTP 或子进程调用 Python 计算服务。

## 背景（Context）
- 当前功能以轻计算为主（取数 → 渲染 → 上传 → 通知，看板由前端 ECharts 渲染，后端只出数据 + SSE 推流）。
- 目标：用 NestJS 的模块 / DI / 守卫结构根治"拼凑感"，并享受全栈 TypeScript 一致性。
- 风险点：未来若出现重数据 / Excel / 图像生成类计算，Node 生态相对 Python（pandas / openpyxl / PIL）偏弱。本决策预先给出"局部引入 Python"的出口，避免将来被 NestJS 锁死。

## 约束与迁移规则（Constraints & Migration Rule）
1. **计算隔离（现在就做）**：计算逻辑只能存在于独立的 compute/service 层，控制器、SSE、前端不得直接调用计算库。该层返回 DTO，与上层解耦。
2. **触发条件（何时切 Python）**：当某计算任务满足——Python 生态明显占优（pandas 数据整理、openpyxl 生成 Excel、PIL / 图像、科学计算库）且 Node 侧实现不划算——即启动拆分。
3. **拆分方式（二选一）**：
   - **FastAPI 微服务**：把该计算包成 FastAPI 端点，NestJS 用 `fetch` / `axios` 调用。适合需常驻、可独立扩缩的计算。
   - **子进程 spawn**：NestJS `child_process.spawn('python', [...])`，输入走 stdin / 临时文件，输出走 stdout / JSON。适合批处理，零新增常驻服务（沿用现有 `server.py` 的 spawn 模式）。
4. **不动的部分**：HTTP / SSE / REST / 调度 / 鉴权 / 前端托管全部留在 NestJS，不随计算迁移而改动。

## 后果（Consequences）
- **好处**：轻计算阶段单运行时（Node），结构清晰；将来重计算局部引入 Python，不碰 NestJS 主干，迁移成本仅限"重写一个 service 内部 + 接一个 I-O 边界"（典型数小时至一两天，非重写）。
- **代价 / 要求**：计算隔离依赖早期纪律——若计算逻辑散落到控制器 / 各 service，将来抽 Python 会变为成比例重构。须从第一天起守住"计算只在独立 service"。
- **不锁死**：本决策即"Node 管 I-O / 编排 + Python 管计算"的多语言后端范式，未来可平滑演进。

## 备注
- 本决策覆盖"初始选型"，不要求现在就引入 Python。仅当触发条件成立时才启动 FastAPI 接管。
- 若届时整体计算占比过高、Python 成为主体，再评估"NestJS 降级为纯网关 / 或整体转 FastAPI"也不迟。

---

## 修订 1（2026-09-22）：取数职责迁回 NestJS

> 本节是对上方「决策」的**修订**，不推翻原文；原文仍适用于「计算类」逻辑。

### 变更

原映射原则把 `aeolus_sdk` 与 `dashboard.standard.*` 整体视为「Python 生态独占、不进 NestJS 进程」。经实测与权衡，**取数（数据抓取）不属于计算**，故重新划分：

| 职责 | 归属 | 说明 |
|---|---|---|
| 分页请求、反爬节奏（AIMD）、限流退避、会话失效检测、时段切片、去重、refresh-all 编排 | **NestJS** | I/O 密集 + 编排逻辑；Node 的 async I/O 更适合，且能复用 Nest 的鉴权/数据权限 |
| **登录重登**（RSA 加密 + SSO 票据交接） | **Python** | 低频但高复杂度、且 cookie.txt 是跨进程共享状态（Python 侧有 `xlock` 互斥），Node 重写会绕过该锁、两边互相顶号 |
| 大数据计算（标准达成 / 时段出勤 / 实时播报聚合、openpyxl 等） | **Python** | 仍是 Python 生态占优，继续经 `ComputePort` 委托 |

即：**取数在 Nest，登录与计算在 Python**。

### 落地位置

- `backend/src/modules/fetch/`：`FetchPaceService`（节奏/退避/统计）、`DeliveryQueryService`（单次请求）、`AeolusCookieService`（cookie + 重登）、`OrdersFetchService`（编排）、`RefreshAllService`（阶段 0 + 落盘）。
- 常量与算法原先严格对齐 `python/dashboard/standard/orders_fetch.py`；该文件已于 2026-09-23 删除
  （本地运单拉取路径移除，运单只由阶段 0 取）。Nest 侧现为**唯一实现**，见
  `backend/src/modules/fetch/fetch-pace.service.ts`。

### 协作契约（跨语言，务必遵守）

1. **共享 `aeolus_sdk/cookie.txt`**：Node 只读复用；失效时 spawn `python -m aeolus_sdk.login` 重登，不自建第二套登录。

   > 📌 **2026-09-24 补注（原文保留，仅记录后续演进）**：本条的两项前提均已改变 ——
   > ① 登录/重登已于 2026-09-23 迁入 Nest（`backend/src/modules/fetch/aeolus-login.service.ts`），
   >    不再 spawn Python；手动复位走 `POST /api/fetch/aeolus-relogin`（机器令牌）；
   > ② cookie 文件于 2026-09-24 移入 `backend/aeolus_sdk/cookie.txt`（写入方仍是 Nest）。
   > 本条仍有效的是分工原则：**登录态只有一个写入方**。
2. **共享原始层 `apps/api/runtime/raw/{kind}_{team}_{date}.json`**：Nest 写、Python 算。Nest 落盘格式必须与 `cache.save_raw` 完全一致（orders = 裸 JSON 数组，非空才写）。
3. **共享 `apps/api/runtime/pace_state.json`（apps/api/runtime/ 目录）**：两边学到的节奏下限互通。
4. **⚠️ 写完必须通知失效**：Python 的进程内结果缓存只在它自己调 `save_raw` 时失效。Nest 直接写文件后**必须**调 `POST {PYTHON_COMPUTE_URL}/api/cache/invalidate`，否则看板会返回旧聚合结果（表现为「刷新了但数字没变」，已实测复现）。

### 数据流

```
Nest 取数（反爬节奏）→ 写 apps/api/runtime/raw → 通知 /api/cache/invalidate → Python 重算 → 前端
```

### 当前状态

- ✅ 阶段 0（运单取数 + 分组 + 落盘）已在 Nest 落地，并用真实数据验证；Python 从 Nest 写的文件成功算出结果（`need_refresh=false`）。
- ✅ 阶段 1+ **已迁完**（2026-09-23）：**取数**（`sched` / `att` / `violation`）经
  `POST /api/fetch/{sched-raw,attendance-raw,violation-csv}` 全部由 Nest 承担（Python 的
  `python/get_data/*` 改为转发层，调用方零改动）；**编排**（阶段调度 / 状态机 / 日志 / 单飞 / 频控 /
  数据权限收敛 / 历史护栏）迁到 `backend/src/modules/fetch/refresh-runner.service.ts`
  + `refresh.controller.ts`，`/api/standard/refresh-all` 不再代理给 Python
  （`python/dashboard/standard/refresh_all.py` 已删除）。
  **结果计算**（rider / achievement 聚合 + 结果层落盘）按分工留在 Python，
  经 `POST /api/compute/{rider-dimension,achievement}` 调用。
