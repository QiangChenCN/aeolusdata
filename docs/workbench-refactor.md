# 工作台逻辑重构思路

> 目标：在「不推倒重写业务逻辑」的前提下，消除现有工作台的拼接感 / 结构混乱 / 职责不清，
> 并为「定时任务」「钉钉 / 企微机器人推送报表」预留扩展位。
> 适用范围：逻辑分层、模块划分、数据流、调用关系、可扩展性。不含具体代码。

---

## 0. 现状结论（一句话）

**业务逻辑正确、分层混乱、运行环境强绑桌面壳。**
重构应保留 `data/`（取数）+ `tasks/`（加工）业务内核，抽出 `core/`（运行时 +
通知 / 渲染 / 存储抽象）与环境配置，用「任务即插件 + 能力可替换 + 配置驱动」三招消除拼接感；
并现在就立起 `Notifier` 抽象，让钉钉 / 企微机器人推送和定时任务成为「加适配器 / 加字段」而非「改架构」。

---

## 1. 当前工作台整体逻辑与模块关系

### 1.1 现有分层

```
表现层    WorkBuddy 桌面壳 + index.html(单文件 SPA) + tokens.css(设计令牌)
接入层    server.py(原生 http，~1700 行：静态+手动路由+SSE+子进程跑任务+todo CRUD)
编排层    python/jobs/* (12 个任务脚本，nodeflow.run(NODES) 驱动 fetch→render→upload→send)
能力层    python/common/ : ding_common(钉钉发送) / minio_common(图床) / report_render(Pillow)
                    find_group(搜群) / theme_colors(配色) / nodeflow(编排)
取数层    根 python/get_data/ (底层 HTTP) · python/dashboard/get_data/ (看板友好签名)
           python/dashboard/standard/get_data.py (re-export shim)
鉴权层    aeolus_sdk.login (风神 SSO，全项目唯一登录实现) · quark_sdk (Quark DA 兑换)
存储层    PostgreSQL(ods_*) · SQLite(todo.db) · MinIO(图床) · 本地 out/*.json
```

### 1.2 关键调用关系

- 任务脚本（`python/jobs/attendance/attendance.py`、`python/jobs/board/task_board.py` 等）是业务入口：
  每个脚本 `import nodeflow` + `from get_data import xxx` + `from common import ...`，自己实现 `NODES` 与节点函数。
- 取数：`python/get_data/*` 只做「打接口取原始数」，统计 / 筛选 / 渲染归各 job（约定见 `python/get_data/__init__.py`）。
- 发送闭环：`job.send` → `build_markdown()` → `ding_common.dws()` → **本机 `dws.js`（WorkBuddy 的 node CLI）** → 钉钉。
- 鉴权：`aeolus_sdk.login.ensure_cookies()` 是全项目唯一登录实现，进程内共享锁防顶号。

整体是清晰的「**取数 → 加工 → 渲染成图 → 上传图床 → 推钉钉**」五段式，节点编排（`nodeflow`）做得不错。
问题不在「做什么」，而在「怎么组织」与「绑在什么环境上」。

---

## 2. 拼接感 / 结构混乱 / 职责不清（带证据）

### 2.1 运行环境强绑桌面壳（拼接感根源，也是 Web 化最大障碍）

- `python/common/ding_common.py`：`_resolve_node()` 硬编码 `C:/Users/ChenQiang/.workbuddy/binaries/node/.../node.exe` 与 `dws.js` 路径；`FONT_PATH` 硬编码 `C:/Windows/Fonts/simhei.ttf`。
  发送钉钉走 `dws` CLI——`dws` 本身是钉钉官方开源工具（详见 4.2），路径写死在 WorkBuddy 包目录只是巧合；
  真正的环境耦合是「Windows 路径硬编码 + 依赖一台机器上已建立的 dws 登录会话」，换机/换服务器需重新配置路径与登录态。
- 每个 job 顶部都重复 `sys.path.insert(0, ROOT)` + `import venv_guard` —— 环境引导散落各处。
- `aeolus_sdk/login.py`：账号密码明文写进代码。

> 这几点直接导致：当前架构不是网页应用能直接跑的——服务器上没有 WorkBuddy、没有那个 node、
> 没有那个字体、dws 发不出消息。这是重构必须先解决的环境耦合。

### 2.2 取数层三层 + 双轨不一致（职责不清）

- 根 `python/get_data/`：底层 HTTP，约定为「单一来源」。
- `python/dashboard/get_data/`：看板友好签名封装（独立于根层）。
- `python/dashboard/standard/get_data.py`：**又是一层 re-export shim**，文档自述「仅做转发，保证旧调用方不变」。

同时 **jobs 走根层、看板走 dashboard 层**，两条取数路径并存；`python/dashboard/standard/` 还有大量 `.log`，
而「数据看板」UI 视图长期是占位悬空脚手架。取数逻辑分散 + 看板半悬空 = 重复与漂移高风险。

### 2.3 每个任务重复 `fetch→render→upload→send` 骨架（拼接感）

`nodeflow` 只统一了「选哪一段区间跑」（`--begin/--end`），没有统一「每段怎么写」。于是：
- `attendance.py` 的 `run_render/run_upload/run_send` 与 `task_board.py` 的 `render_image/do_upload/do_send`
  是高度雷同又略有差异的副本；`appeal`、`equipment`、`orange_storm` 同理。
- `send` 节点各自 `build_markdown()` + 拼 `dws` 参数，群选择有的用 `find_group`、有的只写死 `GROUP_ID`。
- 共享做得好的只有 `minio_common`、`report_render`、`ding_common` 三个点——但「节点骨架」本身没抽象，新任务仍走复制粘贴。

### 2.4 钉钉发送是唯一的、且绑桌面的出口（职责不清 + 扩展障碍）

`find_group.py` + `ding_common.dws()` 是全局唯一的消息出口，但要求本机 dws CLI。
这与「网页化 + 未来钉钉 / 企微机器人推送」目标正面冲突：机器人推送是纯 HTTP webhook，不需要桌面 dws。
当前架构没有「通知渠道」概念，发送渠道与任务逻辑焊死在一起。

### 2.5 业务配置埋进代码

- `ding_common.py`：站长 `MANAGER_OPENID`、站点→站长 `STATION_MANAGERS`、默认群 `GROUP_ID` 都是代码里的字典。
- `attendance.py`：时段码 `TIME_SLOTS` 写在任务脚本里。
- （反例是好的：`python/common/groups.json` 已把隐藏群号外置为纯数据。）

### 2.6 前端 / 后端单文件问题（架构报告已详述，从略）

`index.html` ~5700 行单文件、导航与渲染分发硬编码（`kind` 字符串）、`server.py` ~1700 行混合多职责、
todo 双数据源——见 `docs/架构评估报告_2026-09-09.md`。

---

## 3. 重构思路

### 3.1 总原则

**复用业务内核，重构外壳与分层**：`aeolus_sdk`、`quark_sdk`、`python/get_data/*`、各 job 的「加工逻辑」全部保留；
只把「运行环境耦合、重复骨架、散落配置、桌面发送」抽出来重组成清晰分层。不推倒重写。

### 3.2 目标分层与模块划分

```
app/                         # 新增：Web 接入层（FastAPI）
  main.py                    # 组合根
  routers/                   # tasks / teams / todo / runs / schedules / notify
  schemas.py                 # Pydantic 入参/出参
core/                        # 新增：运行时与能力抽象（取代散落 common）
  task_runtime.py            # TaskRuntime：统一五段骨架
  nodes.py                   # 通用节点：Fetch/Render/Upload/Notify + 业务可插拔
  registry.py                # TaskRegistry：任务即插件（参数 schema + 节点 + 元数据）
  notifier/                  # Notifier 抽象（见第 4 节）
    base.py  dingtalk_robot.py  wecom_robot.py  workbuddy_legacy.py
  renderer/                  # Renderer 抽象（Pillow 实现保留）
  storage/                   # Storage 抽象（MinIO 实现保留）
  auth.py                    # 登录服务封装（复用 aeolus_sdk，密钥移 env）
tasks/                       # 原 python/jobs/* 改造：每个任务 = 一个 Task 类（注册进 registry）
  attendance.py  board.py  delivery.py  equipment.py ...
data/                        # 取数层收敛为单一来源（合并根 get_data + python/dashboard/get_data，删 shim）
config/                      # 业务配置外置：sites.json / managers.json / groups.json / notify.json
python/common/                      # 保留：nodeflow / theme_colors / 工具
```

**关键改变**
1. **取数层收敛为单一 `data/`**：删 `python/dashboard/standard/get_data.py` 这层 shim，看板与 jobs 共用 `data/`；
   `python/dashboard/standard/*` 的加工逻辑迁为 `tasks/` 下的「看板类任务」或独立聚合服务。
2. **任务即插件（根治架构报告 P6）**：每个任务声明式注册——`NODES`、参数 schema、所属分组、是否可定时。
   前端导航 / 表单 / 步进条全部由 registry 自动生成，不再硬编码 `kind`。
3. **五段骨架进 `TaskRuntime`**：`Fetch→Process→Render→Upload→Notify` 做成可组合的通用节点，
   `tasks/*` 只填「本任务特有的加工与取数」，消除复制粘贴。
4. **业务配置外置 `config/`**：站长 / 站点 / 群 / Webhook 从代码迁出；`login.py` 账密进 env / secret。

### 3.3 数据流（一次「运行任务」）

```
前端(触发/填参)
   │  POST /api/tasks/{id}/run
   ▼
TaskRuntime.run(task, params)
   ├─[Fetch]   data.xxx.fetch(...)          # 复用现有取数
   ├─[Process] task.process(raw)            # 复用现有加工逻辑
   ├─[Render]  renderer.render(...)         # 复用 report_render(Pillow)
   ├─[Upload]  storage.upload(img)  ──────▶ MinIO 拿公网直链
   └─[Notify]  notifier.notify(payload) ──▶ 钉钉/企微/桌面(legacy)
   │ 每一步 print → 队列 → SSE → 前端日志终端（沿用现有日志配色令牌）
   ▼
执行记录写入 runs 表（供 history 视图 + 定时任务共用）
```

### 3.4 调用关系（重构后）

```
前端 ──HTTP/SSE──▶ app/routers ──▶ core/task_runtime ──┬─▶ data/* (取数)
                                                      ├─▶ tasks/* (加工, 插件)
                                                      ├─▶ core/renderer (出图)
                                                      ├─▶ core/storage (MinIO)
                                                      └─▶ core/notifier (推送, 多渠)
        app/routers/schedules ──(触发)──▶ core/task_runtime   # 定时任务复用同一运行时
        core/auth ──▶ aeolus_sdk / quark_sdk                # 登录态唯一来源
```

### 3.5 可扩展性建议

- **加任务 = 加一个文件 + 注册一条**：无需改前端、无需改路由（registry 驱动）。
- **加渠道 / 存储 / 渲染 = 加一个适配器**：实现 `Notifier` / `Storage` / `Renderer` 接口，配置切换。
- **加定时 = 加 schedule 字段**：Scheduler 只决定「何时触发」，触发即调 `TaskRuntime.run()`，与任务逻辑完全解耦。
- **配置驱动**：环境（env）+ 业务（config/*.json）分离，换机器 / 换群 / 换站点零改码。

---

## 4. 预留扩展方向

### 4.1 定时任务（Scheduler）

- **与运行时解耦**：引入调度器（持久化 job store 到 DB），它只负责「何时触发」，
  触发动作就是调用 `TaskRuntime.run(task, params)`——复用整套链路，不另写执行逻辑。
- **任务注册表加 `schedule` 字段**：`cron` / `interval` / 一次性。前端「任务中心」每个任务卡加「定时设置」面板。
- **执行记录打通**：每次定时触发都走 `runs` 表，与现有「运行记录」视图天然合一；失败重试、并发上限在 Scheduler 层统一管控。
- **登录态复用**：定时任务仍要 aeolus cookie（单点登录），直接复用 `aeolus_sdk.login` 的进程内共享锁，
  调度器进程持有一份即可。

### 4.2 钉钉 / 企微机器人推送报表（Notifier 抽象落地）

这是重构里最值得现在就埋接口的方向，因为它同时解决 2.1（环境路径硬编码）/ 2.4（发送渠道与任务焊死）的问题。

> **关于 `dws` 的事实澄清（重要）**：`dws` 是钉钉官方开源的 Workspace CLI
> （`DingTalk-Real-AI/dingtalk-workspace-cli`，Apache-2.0），**并非 WorkBuddy 私有依赖**。
> 当前代码把它写在 `C:/Users/ChenQiang/.workbuddy/binaries/node/.../dingtalk-workspace-cli/bin/dws.js`
> 只是 WorkBuddy 顺手装进了自己的 node_modules。**`dws` 可独立安装（`npm i -g dingtalk-workspace-cli`
> 或官方 `install.sh`），并在服务器无桌面环境运行**：`dws auth login --device`（设备流）或
> `dws auth login --client-id/--client-secret`（自建应用，非交互、凭证自动刷新）。
> 因此「网页后端能否用 dws」的答案是**能**，只需把现有硬编码路径改为可配置（环境变量 / `shutil.which`）。

- **现在定义 `Notifier` 接口**：`send_text / send_markdown_image / notify(report_payload)`。
- **钉钉渠道两种实现（均可在服务器运行，并列可选，非二选一淘汰）**：
  - `DingTalkCLINotifier`：复用现有 `ding_common.dws()`，路径改为可配置（`DING_DWS_BIN` / `PATH` 探测）。
    **改动最小**，且能顺带用 dws 的通讯录搜索、日程等能力；发群用 `dws chat message send-by-bot`。
  - `DingTalkRobotNotifier`：钉钉自定义机器人 webhook + 加签（secret），**不依赖 dws**，更轻，
    但消息格式化需自写。
  - 企微无官方 CLI，统一走 `WeComRobotNotifier`（企微群机器人 webhook + key）。
- **推送内容标准化**：任务产出统一成 `ReportPayload`（标题 / 图片 URL / 文案 / @名单），
  `Notifier` 只负责「按渠道格式化发送」。同一份报表可同时推钉钉（CLI 或 webhook）和企微，新增渠道零改任务代码。
- **接收人 / 群配置外置**：钉钉 webhook URL、企微 key、`@` 名单从 `ding_common.py` 的硬编码字典
  迁出到 `config/notify.json` + `config/managers.json`；`dws` 登录态 / client-secret 走环境变量，不入代码。
- **与定时任务组合**：`Scheduler 触发 → TaskRuntime 跑完 → Notifier 自动推送`，
  形成「定时出数 + 自动推送报表」闭环——正好覆盖未来核心诉求。

---

## 5. 推荐落地顺序（低风险、可随时停）

1. **后端先动**：`server.py` → FastAPI，按 router 拆分，SSE 平移（不动业务逻辑）。
2. **立 `Notifier` 抽象**：先把桌面 dws 包成 legacy 适配器，预留 robot 实现（为推送打底）。
3. **收口取数层**：合并 `data/`，删 `python/dashboard/standard/get_data.py` shim，看板复用。
4. **任务插件化**：建 `TaskRegistry` + `TaskRuntime` 五段骨架，挑 `attendance` 做第一个改造样本。
5. **配置外置**：`config/*.json` + env 接管站长 / 站点 / 群 / 账密。
6. **前端骨架**：Vite + App Shell 搭壳，按模块逐一切换（tasks → history → todo → dash）。
7. **接扩展**：Scheduler + 钉钉 / 企微 robot Notifier，形成定时推送闭环。

---

## 6. 已落地骨架（core/，可随时停）

> 按 §5 顺序，第一步先立「核心抽象骨架」：**不迁业务、不改 server / jobs 调用方式**，
> 只把现有能力收口到可替换接口后，预留扩展位。已实现于仓库根 `core/` 包。
> 治理痛点：§2.1（dws 路径硬编码，已由 ding_common 用 env 解析，legacy 适配器复用）、
> §2.4（发送渠道与任务焊死 → Notifier 抽象解耦）。

### 6.1 目录

```
core/
  __init__.py            # 导出入口 + 确保项目根在 sys.path
  notifier/
    base.py              # Notifier 抽象 + ReportPayload（统一产出结构）
    workbuddy_legacy.py  # DingTalkCLINotifier：复用 common.ding_common.dws（默认渠道，零配置可用）
    dingtalk_robot.py    # DingTalkRobotNotifier：钉钉自定义机器人 webhook + 加签（不依赖 dws）
    wecom_robot.py       # WeComRobotNotifier：企微群机器人 webhook
    __init__.py          # get_notifier(channel, **cfg) 工厂
  registry.py            # TaskRegistry + TaskMeta + ParamSpec（任务即插件机制）
  task_runtime.py        # TaskRuntime + Stage(Fetch/Process/Render/Upload/Notify) + NodeflowTask
  _selftest.py           # 装配自检：python -m core._selftest（dry_run，不真实发送）
```

### 6.2 接口契约

- **`Notifier.notify(ReportPayload)`**：任务只产 `ReportPayload`（title / text / image_url / at / group），
  由具体渠道负责「按渠道格式化发送」。同一份报表可同时推多渠，新增渠道零改任务代码。
- **`get_notifier(channel, **cfg)`**：`dingtalk_cli`（默认，零配置，复用现有 dws 发送）
  / `dingtalk_robot`（需 webhook_url + secret） / `wecom_robot`（需 webhook_url）。
  配置驱动：webhook / secret 走构造参数，下一步接 `config/notify.json` + env（见 §3.5）。
- **`TaskRegistry.register(TaskMeta)`**：任务即插件。前端导航 / 表单 / 步进条未来由 registry 自动生成，
  消除硬编码 `kind`（架构报告 P6）。当前 jobs 暂未强制注册（不迁移业务）。
- **`TaskRuntime.run(task, params)`**：统一运行时入口，异常兜底为 `TaskResult(ok=False)` 不崩进程。
  `NodeflowTask` 把现有 `nodeflow.NODES` 包成 `Task`；未来 jobs 改造为 `Task` 子类即被运行时 / 调度器发现（§3.3 / §4.1）。

### 6.3 验证

```
python -m core._selftest
```

全部用例通过：三种 Notifier 可构造、legacy `dry_run` 正确拼出 dws 命令、robot 加签 URL 生成正确、
TaskRegistry 注册 / 列举、NodeflowTask 跑通内置 NODES。**全程未真实发送任何消息。**

### 6.4 下一步（未做，保持可停）

- Notifier 的 robot 实现接 `config/notify.json` + env（secret / webhook 外置，治理 §2.5）。
- 挑 `attendance` 做第一个「任务插件化」样本：继承 `NodeflowTask` 并在 `registry` 注册（§5 第 4 步）。
- 其余 jobs 按同法逐批注册，前端导航改由 registry 驱动（§5 第 6 步）。

