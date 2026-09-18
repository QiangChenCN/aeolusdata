# 风神数据处理 · 任务运行工作台

一个本地网页控制台，把散落在项目里的 17 个脚本收进统一入口：勾选参数 → 点运行 → 实时看日志 → 失败直接给原因。

---

## 一、启动方法

### 方式 A：双击启动（推荐）

双击项目根目录的 **`start_workbench.bat`**

会自动用项目 `.venv` 的 Python 启动服务并打开浏览器。

### 方式 B：命令行

```bat
cd E:\WorkBuddy\风神数据处理
.venv\Scripts\python.exe server.py --port 8909
```

然后浏览器访问 <http://127.0.0.1:8909>

> 换端口：把 `--port 8909` 改成别的（如 8910）。改了 `.bat` 里的端口也要同步改。
> **关闭命令行窗口 / 关掉 .bat 窗口即停止服务。**

---

## 二、页面结构（左右分栏）

```
┌──────────────────────── 顶部标题栏（logo / 主标题 / 服务状态 / Cookie 状态 / 重载任务清单 / 终止）──────────┐
│ 左侧固定导航        │  右侧内容区                                                             │
│                    │  ┌ 视图标题（分组名 + 任务数）───────────────────────────────────┐  │
│ 全部任务       15  │  │ 任务卡片（单列横长形：左标题 / 中描述参数+节点区 / 右运行按钮）│  │
│ 排班考勤        1  │  └────────────────────────────────────────────────────────────┘  │
│ 商站任务       2  │  ┌ ▸ 输出日志（可折叠抽屉，有任务运行自动展开）───────────────┐  │
│ 装备点亮       2  │  └────────────────────────────────────────────────────────────┘  │
│ 运单处理       6  │                                                                      │
│ 不满意单       2  │                                                                      │
│ 其他工具       1  │                                                                      │
│ 数据看板       —  │    ← 一级导航项（与任务中心同级，非分组，故无任务数）             │
│                    │                                                                      │
│ 运行记录       16  │                                                                      │
│ 运行               │                                                                      │
│  输出日志          │                                                                      │
│  运行记录          │                                                                      │
└───────────────────────────────（批量执行栏已移除：每次仅运行单个任务）────────────────────────────┘
```

| 区域 | 作用 |
|---|---|
| **左侧导航** | 分两级：**一级项**（首页 / 任务中心 / 数据看板 / 工作内容 / 运行记录）与**二级项**（任务中心展开后的「全部任务」+ 各业务分组：排班考勤/商站任务/装备点亮/运单处理/不满意单/其他工具）。一级项是否展开由 `navSections()` 返回的 `children` 决定——**有 children 才是可展开的一级容器**（目前只有任务中心），无 children 的（如数据看板）点击直接切视图。当前分组有任务在跑时显示蓝点。窄屏（<1000px）折叠成抽屉，用顶栏 ☰ 打开。「数据看板」为独立一级项，非任务分组，故不显示任务数 |
| **任务卡片区** | 按左侧选中的分组过滤。每张卡片独占一行（横长形布局）：左栏复选框+标题+风险徽章，中栏描述+产物+前置提示+**执行节点区**+**配置摘要**（点开弹窗看完整参数表单，参数不再直接展开在卡片上），右栏**配置 + 运行** 等宽按钮组+上次运行记录。卡片宽度=100%容器宽，高度由内容撑开；≤820px 时三栏回退为垂直堆叠防止挤压 |
| **输出日志** | 内容区底部的可折叠抽屉；有任务开跑时自动展开。点运行记录里的「看日志」可进全屏版 |
| **运行记录** | 最近 60 次执行的时间/状态/耗时/诊断，点「看日志」可回看该次的完整输出 |
| **批量执行栏** | 底部浮出，仅在任务视图可用 |

### 2. 运行单个任务

在卡片上调好参数 → 点 **运行**。

风控分级（卡片上的彩色徽章）：

| 徽章 | 含义 | 点运行时 |
|---|---|---|
| <span>只读</span> | 纯拉取/出图，不外发 | 直接执行 |
| **会发钉钉** | 真实发群消息、@ 真人 | **弹确认框** |
| **需前置** | 依赖 MySQL 等外部服务 | 直接执行，卡片上黄条提示前置条件 |
| **高危** | DROP 建表等破坏性操作 | **弹红色确认框** |

### 前置产物检查（`tasks.json` 的 `needs` 字段）

有些任务必须靠前一个任务的产物才能跑，比如「发送装备未点亮明细」需要 `rider_equipment.csv`。
这种依赖写在 `needs` 里，工作台会在**每次请求时按磁盘现状检查**：

- 卡片上出现黄色提示条：**缺少前置产物：xxx（先跑「某个任务」）**
- 直接点运行时会弹确认框，说明缺什么、建议先跑哪个 —— **只是提示，不阻断**，确认后照样能跑

只在**单任务直跑**时检查。批量执行和流水线不检查，因为前一步往往正好就是产出方，
那时候报缺失属于误报。

`needs` 的写法（相对项目根目录）：

```jsonc
"needs": ["rider_equipment.csv"]   // 文件：必须存在
"needs": ["delivery_raw/"]         // 以 / 结尾按目录算：必须存在且非空
```

### 执行节点区间选择（`tasks.json` 的 `nodes` 字段）

**每个任务内部都是一串有序步骤**。比如「实时在线播报」= `fetch` 拉数 → `render` 出图 →
`upload` 上传 → `send` 发钉钉；「不满意单申诉提醒」= `download` → `filter` → `render` →
`upload` → `send`。**全部 15 个可见任务都声明了 `nodes`**，卡片中部都会出现「执行节点」区块 ——
**一条横线上排着圆点，圆点下方是节点名，点圆点选两端**：

- **默认全选**（首节点 → 末节点）
- **点第一个圆点 = 开始**，再点一个 = 结束，两点之间就是连续区间
- 点在起点之前 → 起点往前挪，继续等选结束
- **点同一个圆点两次 = 只跑这一个节点**
- 因为只能挑两端，"跳选 / 不连续 / 多段"在交互上根本点不出来
- **结束早于开始时**，整块转红一行错误提示；运行按钮同步禁用
- **每次运行结束后，节点选择自动回到默认**（begin/end 清空，下次跑全跑）

对应到命令行就是统一口径的 `--begin <节点> --end <节点>`：

```bat
.venv\Scripts\python.exe attendance.py --begin render --end upload   :: 只出图+上传，不发钉钉
.venv\Scripts\python.exe appeal_reminder.py --begin download --end filter  :: 只拉数+筛选，不渲染不发
.venv\Scripts\python.exe -m aeolus_sdk.login --begin verify --end verify   :: 只校验登录态，不触发登录
```

脚本侧同样校验（`nodeflow.py` 统一实现）：`end` 早于 `begin`、或 id 不在节点表里，
都打印 `✗ …` 并 `exit 1`，不会出现"界面拦住了但脚本偷偷全跑"的口径不一致。

几个值得知道的点：

- **区间内 0 命中会正常中止**（不是报错）。比如申诉单筛出 0 条，脚本提示
  「无符合条件的订单，跳过发送。」并 exit 0 —— 0 命中就不打扰任何人。
- **单点区间**可以单独重跑某一步（改了图再发一次、只想校验一次登录态），不用全链路重来。
- **默认区间未必是全程**：`拉取装备点亮数据` 默认到 `save` 为止，
  末节点 `report`（打印响应摘要）是排查用的，只有显式点到或带 `--print` 才跑。
- 节点定义在**脚本源码**里，`tasks.json` 由 `sync_nodes.py` 自动同步，不是手抄的（见第四节）。

### 配置弹窗（统一入口 · 所有任务复用）

任务参数（`tasks.json` 的 `params` 字段，如时段、目标群、不@站长...）**不再直接展开在卡片上**——
卡片中部的「执行节点」区块下方只显示一行**配置摘要**（参数名 → 当前值，单行截断，整行可点）。

点「摘要行」或卡片右侧的「配置」按钮 → 弹出独立配置界面：

```
┌─ 配置 · 实时在线播报 ─── 共 4 项参数 ─── ✕           ┐
│                                                      │
│  开始节点        [ fetch（默认） ▾ ]                 │
│  结束节点        [ send（默认）  ▾ ]                 │
│  目标群          [ 站点日常管理通知群 ]              │
│  不 @ 站长       [      ☐      ]                     │
│                                                      │
│  [ ↻ 恢复默认值 ]    取消    [ 保存 ]                │
└──────────────────────────────────────────────────────┘
```

交互契约：

- **保存** = `commitParamsForm()` 一次性收集表单内 `[data-flag]` 控件回写 `state.args` → `savePrefs()` 落盘 → `refreshAll()` 刷新卡片摘要里的「修改角标」。
- **恢复默认值** = `fillDefaultToForm()` 仅把控件显示值改回 `params[].default`，**不写 state**（确认保存才会落盘）。
- **取消 / ✕ / 点遮罩 / Esc** = 关闭窗口，丢弃改动。
- **必填校验**：保存时若某 `required` 项为空，运行入口会先 toast 提示，并保留窗口不关。

复用要点（保证后续新增任务**不必再为参数写第二份** UI）：

- 表单渲染走 `renderParamRow(task, param, live)`：一个函数，分支 switch / select / text 三种控件，
  均挂 `data-flag`；`live=true` 时立即 `setArg`（备用于将来卡片内嵌场景），`live=false` 时只渲染，
  由 `commitParamsForm` 统一收集。
- 新增 param 类型（譬如 `"multi"` 多选 / `"date"` 日期选择）只需在 `renderParamRow` 里加一个分支，
  卡片摘要与配置弹窗同步支持。
- `tasks.json` 里的 `--begin` / `--end` 在卡片上由「执行节点」区块提供选择器，**不会**再在摘要
  与弹窗里出现第二次（`visibleParams()` 自动过滤）。

### 3. 批量执行

在**任务视图**勾选多个任务（卡片左上角复选框）→ 底部浮出执行栏 → **按顺序执行**。

- 任务**串行**跑，一个跑完才跑下一个
- 串行是刻意的：避免多个脚本同时写 `aeolus_sdk/cookie.txt` 触发 Windows 文件占用
- 批量执行前如果勾中了「会发钉钉」或「高危」任务，同样会弹确认
- 切到流水线 / 输出日志 / 运行记录视图时执行栏自动收起（勾选状态保留）

### 4. 常用流水线（一键跑完整流程）

预设流水线数据仍保留在 `tasks.json` 的 `presets` 字段（5 条一键流程），后端接口完整，**但工作台 UI 当前不展示入口**。如需使用，请直接调 `POST /api/run` 传入 `preset_id`；后续若恢复导航入口，详见 `DESIGN.md` §4.2 流水线视图。

- **考勤全流程（生产群）** = 实时在线播报全 4 节点 → 发生产群 @站长
- **考勤试跑（测试群·不@）** = 实时在线播报全 4 节点 → 发测试群且不 @ 任何人
- **商站任务全流程** = 拉取任务看板 → 发生产群 @执行人
- **装备点亮日报** = 拉取 T-1 数据 → 发台账沟通群 @站长
- **运单日流水（CSV）** = 下载今天运单 CSV

### 5. 失败时看什么

任务失败后，日志面板下方会出现红色诊断卡，给出**失败原因 + 具体建议**。已内置这些已知故障的识别：

| 诊断 | 触发特征 | 建议 |
|---|---|---|
| 登录态失效 | 401 / 顶号 / result is null | 闲置浏览器后重试，或命令行跑 `python -m aeolus_sdk.login` |
| aeolus_sdk/cookie.txt 并发争抢 | Errno 13 | 已串行执行，直接重试 |
| MySQL 不可用 | Can't connect / pymysql | MySQL 容器已删除，需先重建 |
| 依赖缺失 | ModuleNotFoundError | 用 .venv 的 pip 装 |
| 网络抖动 | SSLEOFError / timeout | 直接重跑 |
| 前置产物缺失 | 找不到图片/汇总 | 先跑对应的拉取任务 |
| 接口限流 | REQUEST_TOO_FREQUENT | 稍后重试 |
| 接口分页/跨度超限 | PAGE_SIZE_OVER_RANGE / 超过7天 | 缩小日期范围 |
| Quark 鉴权失败 | DA_TOKEN / 403 | 确认 curl 可用，脚本会自动重试 3 次 |

### 6. 其他操作

- **终止**：顶栏「终止」按钮，强制结束当前进程及子进程，**同时取消队列里尚未开始的任务**（弹窗会显示待取消的个数）。注意：已经开始执行的任务无法回滚，已发出的钉钉消息也撤不回
- **超时**：单个任务超过 `timeout` 秒（默认 300）自动终止，诊断显示为「执行超时」，与手动终止区分开
- **日志不丢**：页面刷新或网络断连重连后，会自动从服务端把当前任务缺失的日志补齐
- **重载任务清单**：改了 `tasks.json` 后点顶栏「重载任务清单」按钮，不用重启服务
- **下载日志**：日志面板的下载图标
- **回看历史日志**：左侧「运行记录」→ 任意一行点「看日志」
- 导航位置、参数选择、勾选状态、日志抽屉展开状态都存在浏览器本地，刷新不丢

---

## 三、任务清单

**全部 15 个任务都声明了执行节点**，卡片上可点选区间。节点化是**强制约束** ——
新增任务若不声明节点，`sync_nodes.py` 会点名报警并以退出码 1 结束。

参数与卡片布局：参数由**配置弹窗**统一管理（见第二节）—— 卡片中部只显示
一行配置摘要、卡片右侧是「**配置 + 运行**」等宽按钮组；不再像早期版本那样把表单直接展开。

| 分组 | 任务 | 风控 | 执行节点（可圈定区间） | 产物 |
|---|---|---|---|---|
| 排班考勤 | **实时在线播报** | 会发钉钉 | `fetch`>`render`>`upload`>`send` | attendance_absent.png / attendance_summary.json / attendance_raw/ |
| 不满意单 | 不满意单申诉提醒 | 会发钉钉 | `download`>`filter`>`render`>`upload`>`send` | violations.csv / violation_detail.png |
| 商站任务 | 站长任务看板 | 会发钉钉 | `fetch`>`filter`>`render`>`resolve`>`send` | task_started.png / task_list_raw.json |
| 装备点亮 | 拉取装备点亮数据(T-1) | 只读 | `fetch`>`save`>`report`（默认到 `save`） | rider_equipment.csv / rider_equipment_raw.json |
| 装备点亮 | 发送装备未点亮明细 | 会发钉钉 | `filter`>`render`>`upload`>`send` | rider_equipment_warning.png / rider_equipment_unlit.csv |
| 运单处理 | 抓取三站在途急单 | 只读 | `fetch`>`merge`>`write` | dispatcher_jidan_3stations.json / .csv |
| 运单处理 | 下载运单 CSV | 只读 | `login`>`query`>`write` | aeolus_delivery_*.csv |
| 运单处理 | 抓取运单原始层(JSONL) | 只读 | `plan`>`fetch` | delivery_raw/*.jsonl |
| 运单处理 | 运单入库 MySQL | 需前置 | `connect`>`upsert` | — |
| 运单处理 | 核对入库行数 | 需前置 | `connect`>`count` | — |
| 运单处理 | 建库建表（DROP 重建） | **高危** | `connect`>`ddl` | — |
| 其他工具 | 生成骑士规则文档 | 只读 | `login`>`query`>`build`>`write` | rule_doc_&lt;id&gt;.html / .md |
| 不满意单 | 不满意复盘反馈 | 会发钉钉 | `fetch`>`store`>`sheet`>`send` | — |

> 一个脚本有多种模式时，每种模式一套节点：
> `load_delivery_db.py`（入库 / 核对 / 建表）、`jobs/unsat/main.py`（run）。
> 节点 id 只在**同一套节点内**唯一，跨模式重名（`connect`）是正常的。

---

## 四、文件结构

```
workbench/
├── tasks.json       ← 任务注册表（唯一配置源，改这里就能增删任务）
├── server.py        ← 后端服务（纯标准库，零第三方依赖）
├── index.html       ← 工作台页面（单文件，全内联）
├── tokens.css       ← 设计令牌：配色/字号/间距/圆角/阴影/布局尺寸的唯一来源
├── DESIGN.md        ← UI 设计规范说明（各项取值含义、适用场景、命名规范）
├── check_tokens.py  ← 令牌自检脚本（改令牌后跑一遍，确认取值没漂）
├── vendor/          ← 本地化的第三方前端库（离线可用，不依赖 CDN）
│   └── echarts.min.js  ← Apache ECharts 5.5.1（约 1MB），供「数据看板」图表使用
├── runs/            ← 每次运行的完整日志 + 历史记录
└── README.md        ← 本文件
start_workbench.bat        ← 双击启动

项目根目录/
├── common/          ← 公共模块包（ding_common / nodeflow / minio_common / report_render / theme_colors / find_group）
│   └── nodeflow.py  ← 执行节点通用框架：解析/校验 --begin --end，只跑区间内节点
└── tools/           ← 跨领域开发/维护工具
    └── sync_nodes.py    ← 把脚本源码里的 NODES 同步进 tasks.json（AST，幂等）
```

### 设计令牌

所有颜色、字号、间距、圆角、阴影、层级、布局尺寸都定义在 `tokens.css`，
页面通过 `<link rel="stylesheet" href="tokens.css">` 引入，业务样式一律用 `var()` 引用，不写裸值。

- 改主题/改配色 → 只动 `tokens.css`
- 新增样式怎么写 → 看 `DESIGN.md` 第 11 节
- 改完怎么验证 → `python check_tokens.py`（详见 `DESIGN.md` 第 14 节）

### 顶部展示哪些信息

顶栏只有：**logo + 单行主标题 + 服务状态 + Cookie 状态 + 重载任务清单 / 终止**，没有副标题。

**服务状态胶囊**（SSE 事件流），点名连接对象 = 本地工作台服务，三态：

| 状态 | 圆点 | 文案（≤1000px 用短版） |
|---|---|---|
| 事件流已通 | 绿 | `工作台服务已连接`（短：`服务已连接`） |
| 首帧 / 重连中 | 灰 | `正在连接服务`（短：`连接中`） |
| 断流 | 红 | `工作台服务已断开`（短：`服务已断开`） |

**Cookie 状态胶囊**（独立轮询的只读探针，不调 login / 不写 aeolus_sdk/cookie.txt），三态：

| 状态 | 圆点 | 文案（≤1000px 用短版） | 含义 |
|---|---|---|---|
| 探针 200 | 绿 | `Cookie 有效`（短：`有效`） | 风神会话仍可用 |
| 探针 401 | 红 | `Cookie 已失效`（短：`已失效`） | 会话已掉（多因浏览器活跃顶号），需重新登录 |
| 其他（超时 / aeolus_sdk/cookie.txt 不存在 / 接口异常） | 灰 | `Cookie 状态未知`（短：`未知`） | 临时不可用 ≠ 失败，**不要误报红** |

轮询策略（详见 `DESIGN.md` 8.6 节）：基础 **60s** + 抖动 **±15s**（下限 5s），页面可见时挂链、隐藏时摘链、可见性恢复立即探一次再挂链、`beforeunload` 摘链。鼠标悬停胶囊给完整解释（含探针路径、checked_at、unknown 原因等）。

**窄屏降级**：≤1000px 切短版（`服务已连接` / `Cookie 有效`）；≤620px 隐藏服务状态胶囊（次要，Cookie 胶囊永远保留）。详见 `DESIGN.md` 8.6.5 节。

文案必须带主语（`服务已连接` / `Cookie 有效` 而不是 `已连接` / `有效`），详见 `DESIGN.md` 8.5 节「状态文案通则」。
任务总数放在**右侧各视图的标题**里（如「全部任务 · 共 15 个任务」），随筛选结果变化。
**不展示部署细节**（项目根路径 / 解释器路径 / 端口）—— 详见 `DESIGN.md` 8.5 节「信息架构原则」。
后端 `/api/state` 不下发路径字段；前端 `state` 里没有 `meta: { python, root }`，`renderHeader()` 也只更新服务/Cookie 状态与终止按钮。

### 增删任务

编辑 `workbench/tasks.json`，然后点页面上的「重载任务清单」按钮即可，不用重启服务。

```jsonc
{
  "id": "my_task",                          // 唯一 ID
  "name": "我的任务",
  "group": "tool",                          // 对应 groups 里的 id
  "desc": "一句话说明做什么",
  "cmd": ["{py}", "some_script.py"],        // {py} 会自动替换成 .venv 的 python
  "params": [
    { "flag": "--date", "label": "日期", "type": "text", "default": "",
      "placeholder": "YYYY-MM-DD", "required": true },
    { "flag": "--force", "label": "强制", "type": "switch", "default": false },
    { "flag": "--code", "label": "时段", "type": "select", "default": "",
      "options": [{"value": "120", "label": "午高峰"}] }
  ],
  "risk": "safe",          // safe | external | caution | danger
  "timeout": 300,          // 秒，超时自动终止
  "hidden": true,          // 可选：true = 隐藏任务（不出现在任务列表 / 不可手动跑 / 不参与批量）；
                           // 用于已转为顶部胶囊自动检测的工具类脚本。当前无任务使用。
  "needs": ["out.csv"],    // 可选：前置产物，缺了会在卡片提示并弹确认（以 / 结尾按目录算）
  "outputs": ["out.csv"],  // 展示用，不校验
  "confirm": "确认文案",    // risk=external/danger 时的弹窗正文

  // 执行节点（有序）—— 对任务来说是**必填**，不是可选：没有 nodes 的任务
  // sync_nodes.py 会判为「未节点化」并报错。卡片会渲染「执行节点」区块，
  // 用户只能挑开始/结束两端圈定一段连续区间，映射到脚本的 --begin / --end。
  // ★ 别手抄：在脚本里定义 NODES，用 tools/sync_nodes.py --write 自动同步过来。
  "nodes": [
    { "id": "fetch", "name": "拉数", "desc": "调接口拉原始数据" },
    { "id": "send",  "name": "发群", "desc": "组装消息并发钉钉" }
  ]

  // 与 nodes 配套的 --begin / --end 两个 select 同样由 sync_nodes.py 自动补，
  // 不用手写。补出来长这样：
  //   { "flag":"--begin", "label":"开始节点", "type":"select",
  //     "default":"fetch", "options_source":"nodes", "options":[] }
  //   { "flag":"--end",   "label":"结束节点", "type":"select",
  //     "default":"send",  "options_source":"nodes", "options":[] }
}
```

> `options_source:"nodes"` 时前端从 `task.nodes` 生成选项，JSON 里 `options` 留空即可；
> 服务端 `build_cmd()` 只认 `default`，空值不拼进命令行（脚本自己兜底）。
> `nodes` 经 `/api/state` 原样下发，后端无需改动。

**给任务加节点，完整两步**：

1. 脚本里声明节点并接上框架（`nodeflow.py`）：

   ```python
   NODES = [
       {"id": "fetch", "name": "拉数", "desc": "…", "fn": node_fetch},
       {"id": "send",  "name": "发群", "desc": "…", "fn": node_send},
   ]

   def main():
       import nodeflow
       todo, err = nodeflow.prepare(NODES)      # 必须先摘参数，再解析业务参数
       if err: print("✗ " + err); sys.exit(1)
       args = parse_args()
       sys.exit(nodeflow.execute(todo, ctx))
   ```

2. 在 `sync_nodes.py` 的 `SRC` 里加一行，跑一次同步：

   ```bat
   .venv\Scripts\python.exe tools\sync_nodes.py --write
   ```

   然后点页面「重载任务清单」（或刷新页面），卡片上就出现步进条了。详见 `DESIGN.md` §8.10。

   漏了第 1 步或第 2 步都跑不掉：`sync_nodes.py` 会把没有 `nodes` 的任务列进
   「未节点化」并**以退出码 1 结束**，新增任务不会悄悄变成无节点的普通任务。

> **不属于任务的东西不要节点化。** 例：`python -m aeolus_sdk.login`（登录诊断）是
> SDK 自带的诊断入口，跑在命令行，不在 `tasks.json` 里，也就不接 `nodeflow` ——
> SDK 是被人 import 的库，保持零外部依赖。

`presets` 数组定义常用流水线（有序步骤，可带 `args` 覆盖单个步骤的参数）。

---

## 五、注意事项

- **只监听 127.0.0.1**，不对外暴露，外部机器访问不到
- 页面只是调度器，**脚本本身的行为没有任何改变** —— 会发钉钉的任务照样会发
- 发钉钉的任务默认发**生产群**。试跑请务必：勾选「不 @ 站长」/「只预览不发送」，或目标群选「钉钉机器人测试群」
- 所有任务共用 `aeolus_sdk/cookie.txt`，串行执行是为了避开并发写冲突
- 运单接口只有 **60 天**窗口，过期数据不可回溯

---

## 六、前端实现细节

> 这一节是 `index.html` / `tokens.css` 的维护笔记。改前端前先扫一遍，比读代码快。

### 6.1 设计令牌与层级宪法
- `tokens.css` 是设计令牌唯一来源。**§21「层级」是 z-index 唯一来源**。
- `--z-confirm=120` = **全局最高可交互层**（danger / 二次确认弹窗必须走这层）。
  唯一允许更高的是 `--z-toast=200`，且 toast 必须 `pointer-events:none`（不吃点击）。
- **danger 弹窗双保险**：`.mask` 用 `--z-confirm`；`askConfirm()` 打开时 `hoistConfirm()`
  把 `#mask` appendChild 到 body 末尾 —— 兜底祖先 `transform`/`filter`/`opacity`
  创建新 stacking context 的情况（CSS z-index 只在同一 stacking context 内有效），
  关闭时按 anchor comment 归位。**所有 askConfirm 调用点共用一个 `#mask`，抬一次全生效。**
- 日期 picker `.dpk` 复用 `--z-modal:100`。
- 块内局部令牌（如步进条的 `--ndot`/`--nline`）不入 tokens.css；`check_tokens.py`
  的 `parse_local()` 会单独列出这类「组件内就地定义」的令牌。
- 冒烟 `check_tokens.py` 三查：未定义令牌 / 裸色值 / 层级违规。第 3 节自动校验
  全屏浮层（`position:fixed`）的 z-index 只能写 `var(--z-*)`，禁裸数字与
  `calc(var(--z-x) + n)` 魔法偏移。

### 6.2 执行节点步进条（横向）
- 形态（2026-09-02 用户指定）：一条横线上等距圆点 + 圆点下方节点名，**点圆点**选两端，不用下拉。
- 连线技巧：每个 `li` 自带 `::before`/`::after` 左右半段（首砍左、末砍右），
  `seg-l`/`seg-r` 控制高亮 → 节点数变化不用改 CSS。
- 点击规则：未选/已选满 → 点谁谁是开始（进 pending）；已选开始 → 点其后=结束、
  点其前=起点前移；点同一个两次=单节点区间。
- 三态 `ok` / `pending`（中性提示）/ `invalid`（转 err + 禁按钮）。
  **只有 pending 不转红** —— 还没选完不算出错。
- 前端三函数：`effectiveOptions()` / `nodesBlock()` / `refreshNodesBlock()`。
  **铁律：`refreshNodesBlock` 是叶子渲染器，绝不回调 `refreshAll()`**；
  `ns` 对象必须在绑定事件**之前**建好（闭包捕获顺序）。
- `sanitizeNodeRange(task, ns)`（2026-09-03）：在 `nodesBlock()` 建完 ns 后、首次
  `refreshNodesBlock` 前，把 localStorage 里残留的失效节点 id（如已删除的 `csv`）
  回落为默认值。否则老用户的旧偏好会让界面一进来就出红字。
- 「清空选择」要写**显式空串**而非 delete key —— delete 会回落 `params[].default`，
  等于又全选，空选择提示永远不出现。
- params 循环里要跳过已在节点区渲染的 `--begin/--end`，否则同卡出现两组同名下拉。

### 6.3 卡片 + 配置弹窗（统一复用模式）
- 入口：卡片右上「配置（⚙）+ 运行（▶）」等宽按钮组。`.card-actions` 用
  `grid-template-columns:minmax(0,1fr) minmax(0,1.15fr)`，比 `flex:1` 像素级等宽。
- 三层 helper（写一次，所有任务复用，再不为参数写第二份 UI）：
  - `renderParamRow(task, param, live)` —— 单行渲染，控件一律挂 `data-flag`；新增 param 类型只改这里。
  - `commitParamsForm(task, container)` —— 「保存」遍历 `[data-flag]` 写 state + savePrefs + refreshAll。
  - `fillDefaultToForm(task, container)` —— 「恢复默认值」**仅改控件显示，不写 state**
    （点「保存」才落盘，避免"恢复立即生效"的歧义）。
- 配置摘要：卡片中部单行 pill（参数名 · 当前值，整行可点进弹窗）。任意 param 改过 default
  → pill 加 `.mod`，卡片「配置」按钮加 `.has-mod` 角标。
- 弹窗 DOM 单实例 `#cfMask` + `cfCurrent`，避免每张任务一份重复弹窗。
  关闭（Esc / 取消 / 关闭 / 点遮罩）统一 `closeConfigDialog()`，**不写 state**。
- 卡片「运行」按钮始终在弹窗外、一键可点 —— 配置只是修改入口，不强制每次走弹窗。
- **⚠️ 改 `renderParamRow` 的 select 分支务必 `row.appendChild(la); row.appendChild(el)`**：
  select 分支曾漏了这行（append 只在 date/text 分支做），导致**所有普通 select 参数（各任务的「目标群 / --group」下拉）
  整行不渲染、配置弹窗里完全看不到** —— 极其隐蔽：节点选择 --begin/--end 走步进条不在这里渲染，且默认群没人改所以一直没暴露。
  最稳写法：把 append 提到 select/date/text 三个分支之后**统一执行**（2026-09-04 修复，jsdom 无头验证通过）。

### 6.4 日期参数（定论：常驻原生 date，2026-09-03 回退拍板）
- params 类型：`select` / `switch` / `text` / `date`。日期类（共 10 处）一律 `type:"date"`，
  value 天然 `YYYY-MM-DD`，与脚本期望一致。
- 交互：**单击聚焦手打（分段输入，直接敲数字）+ 点右侧图标弹日历**。
  - 曾尝试「常态 text、双击临时切 date + `showPicker()`」的 `bindDatePicker()`，
    已按老板要求**彻底删除**（JS 函数 + `.bad` 校验 CSS + `title` 提示全清）。**别再折腾"临时变形"。**
  - **原生做不到「单击即弹日历又同时能输入」**：HTML 规范规定 picker 必须由用户显式激活
    （点 indicator / 键盘 / 用户手势内调 `showPicker()`），focus 即自动弹是被禁止的。
    硬绑 `click→showPicker()` 虽能弹（click 是用户手势），但每次手打都得先关日历，等于堵死输入。
    **两者互斥，没有原生两全解。**
  - 民间 hack（`onfocus` 时 text→date + showPicker，blur 切回）Chrome 可用，但
    Safari/Firefox 表现不一致（macOS Safari 的 date 无 picker indicator，showPicker 要 16.4+），
    内部工具不值得为它背兼容性债。
- 后端 `build_cmd()` 对非 switch 类型统一处理，**不区分 text/date，服务端零改动**。
- 前端三处要认 `date`：
  1. CSS：`.cf-row input[type=text]` / `.pr input[type=text]` 并列加 `input[type=date]`
  2. `renderParamRow()`：`el.type = (p.type==="date") ? "date" : "text"`
  3. `commitParamsForm()` / `fillDefaultToForm()`：`querySelector("input[type=text]")`
     要补 `|| querySelector("input[type=date]")`
- 坑：原生 date 用日历选值时**只触发 `change` 不触发 `input`**，`live` 模式下必须
  `el.onchange = el.oninput` 两个都挂，否则卡片上的值不回写。
- Chrome 默认日历图标 opacity 偏低像禁用态，用 `::-webkit-calendar-picker-indicator` 提到 .55 / hover 1。

### 6.5 左侧菜单图标（2026-09-03）
- **Lucide Icons**（ISC 协议，可商用闭源）。24×24 viewBox、`stroke-width=2`、
  `fill=none`、`stroke=currentColor` —— 与既有 `svg()` 渲染函数对齐，**风格不变**。全部内联，零外链。
- `ICON` 字典存 path；`navSections()` 按 `g.id` 查 `GROUP_ICONS` 映射，
  **未匹配降级 `grid`**（以后加新分组忘填图标也不会破相）。
- 映射表：排班考勤 `user-check` / 商站任务 `store` /
  装备点亮 `lightbulb` / 运单处理 `truck` / 不满意单 `message-square-warning` /
  其他工具 `wrench` / 数据看板 `chart`；全部任务 `grid`、运行记录 `clock`。

### 6.6 数据看板与图表库（2026-09-08）
- **「数据看板」是一级导航项，与「任务中心」平级，不是 `tasks.json` 的分组。**
  这点容易搞错：`groups[]` 里的条目是任务中心下的**二级项**；要加真正的一级项，
  得在 `navSections()` 里 `items.push({kind:"dash", ...})` 且**不带 `children`**——
  `renderNav()` 靠有没有 children 判断它是"可展开容器"还是"直接切视图的叶子"。
  同时必须在 `renderMain()` 加对应分发，否则会落到兜底分支渲染成任务列表。
- 颜色 `TK.cyan` = `#0891B2`（tokens.css 的 `--cyan`），与其余 6 个业务分组色均不撞。
- **当前是占位视图** `renderDashView()`：标题 + 「还没有看板」空态，不会报错。
- **图表库已本地化**：`vendor/echarts.min.js`（Apache ECharts 5.5.1，约 1MB）。
  选本地化而非 CDN 的原因：工作台是内网/本机服务，CDN 断网即白屏。
- **页面当前并未加载它**（避免在没图表可画时白拉 1MB）。真要做看板页时在 `index.html`
  加一行即可，静态路由已通（实测 `/vendor/echarts.min.js` 返回 200）：
  ```html
  <script src="vendor/echarts.min.js"></script>
  ```
- 看板数据来源已备好：PostgreSQL `127.0.0.1:5432 / postgres`，表 `ods_delivery_tracking`
  （连接参数见 `jobs/delivery/db_config.json`）。

### 6.7 冒烟测试写法
- `check_tokens.py`：0 未定义令牌 / 0 裸色值 / 0 层级违规。
- jsdom 跑 init（踩过坑）：
  - 卡片选择器是 `.tasks > .card`（**没有 `data-tid`**，旧笔记过时了），任务名取 `card.querySelector('.c-t b')`
  - `DOMContentLoaded` 监听必须挂在 `beforeParse(window)` 里
  - 让 jsdom 直连真实服务最省事：`window.fetch = (u,o)=>globalThis.fetch(u[0]==='/'?BASE+u:u,o)`
  - 需手动灌 `state.tasks/groups/presets/last` 再 `refreshAll()`，否则 `state.tasks.length===0` 渲染 0 张卡片
  - 末尾 `process.exit(0)`，防 `openConfigDialog` 里 `setTimeout(80)` 卡住不退出
- 真实浏览器验证用 Playwright 的 `page.click()`（能查出元素被遮挡），静态快照查不出。
