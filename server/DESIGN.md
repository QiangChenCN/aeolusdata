# 任务运行工作台 · UI 设计规范

> 本文件说明 **工作台前端** 的视觉规范与令牌用法。
> 所有取值均从 `index.html` 中**忠实提取**，未新增臆造值。
>
> - 令牌真值：`web/tokens.css`（单一事实来源）
> - 页面消费：`index.html`（根目录；`<link rel="stylesheet" href="/web/tokens.css">` 与 `/web/apple.css`）
> - 配套脚本：`server.py`（根目录）的 `do_GET` 负责托管 `/web/*`（含 `/web/tokens.css`；另保留 `/tokens.css` 旧路由兼容）

---

## 1. 为什么要分两层

改造前页面把 26 个变量都写在一个 `:root` 里，值和语义混在一起（比如 `--err:#E02020` 既是最红，也是"失败"这个角色）。
改造后拆成两层：

```
第一层  原始色板  --c-err: #E02020        ← 只有这里允许出现具体色值
                     ↑ var()
第二层  语义令牌  --err: var(--c-err)    ← 业务样式只引用这一层
                     ↑ var()
业务样式          .b-err{ color:var(--err) }
```

好处：换主题只动第一层，改"失败"这个角色的含义只动第二层映射，业务样式一行不用碰。

**规则**：业务样式里禁止出现裸色值；禁止跨层引用（业务样式不要写 `var(--c-err)`）。

---

## 2. 命名规范

统一格式 `--{类别}-{角色}[-{变体}]`。

| 前缀 | 类别 | 示例 |
|---|---|---|
| `--c-` | 原始色板（第一层，存字面量） | `--c-brand` `--c-text-muted` `--c-term-bg` |
| 无前缀 | 语义令牌（第二层） | `--brand` `--muted` `--border` |
| `--fs-` | 字号 | `--fs-body` `--fs-badge` |
| `--fw-` | 字重 | `--fw-medium` |
| `--lh-` | 行高 | `--lh-base` |
| `--sp-` | 间距 | `--sp-13` |
| `--r-` | 圆角 | `--r-card` `--r-pill` |
| `--shadow-` | 阴影 | `--shadow-1` |
| `--ring-` | 聚焦环 | `--ring-brand` |
| `--dur-` | 动效时长 | `--dur-base` |
| `--z-` | 层级 | `--z-modal` |
| `--layout-` | 布局尺寸 | `--layout-side` |
| `--ctrl-` | 控件高度 | `--ctrl-h-md` |
| `--grid-` | 栅格列宽 | `--grid-col-status` |

两条硬性约定：

1. **间距后缀即 px 值** —— `--sp-9` 就是 9px，不做任何隐式换算。想调间距改数字后缀，不要改定义。
2. **命名即用途** —— `--fs-badge` 用在徽标上，`--fs-title` 用在标题上。找不到对口的再考虑新增，不要拿"看着差不多"的顶替。

---

## 3. 配色

### 3.1 品牌色

品牌主色沿用项目全局的**淘宝闪购橙**，与 `theme_colors.py`、健康证以外的全部报表一致。

| 令牌 | 值 | 适用场景 |
|---|---|---|
| `--brand` | `#FF5000` | 主按钮底、选中态文字、运行中状态点、进度条 |
| `--brand-dark` | `#D94400` | 主按钮 hover / active |
| `--brand-soft` | `#FFF1EA` | 选中项底色、幽灵按钮 hover 底、聚焦环 |

用法：

```css
.btn-run{ background:var(--brand); color:var(--white); }
.btn-run:hover{ background:var(--brand-dark); }
.nv.on{ background:var(--brand-soft); color:var(--brand); }
```

### 3.2 中性面与文字

| 令牌 | 值 | 适用场景 |
|---|---|---|
| `--bg` | `#F5F6F8` | 页面画布 |
| `--card` | `#FFFFFF` | 卡片 / 面板 / 抽屉底 |
| `--surface-sunken` | `#FAFBFC` | 下沉块：表头、参数区、面板头 |
| `--surface-cancel` | `#F1F3F5` | 次要（取消）按钮底 |
| `--surface-cancel-hover` | `#E6E9EC` | 次要按钮 hover 底 |
| `--surface-disabled` | `#D8DBE0` | 禁用按钮底 |
| `--glass` / `--glass-strong` | `rgba(255,255,255,.92 / .96)` | 顶栏 / 底部执行栏毛玻璃 |
| `--scrim` | `rgba(16,24,40,.45)` | 侧栏抽屉遮罩 |
| `--overlay` | `rgba(16,24,40,.5)` | 弹窗遮罩 |
| `--text` | `#1F2328` | 主文字 / 标题 |
| `--text-body` | `#404854` | 弹窗正文 |
| `--muted` | `#6B7280` | 次级文字 |
| `--muted-2` | `#9AA1AC` | 辅助文字 / 时间戳 / 占位 |
| `--accent-neutral` | `#5F6368` | 中性图标、「其他工具」分组强调色 |
| `--border` | `#E4E7EB` | 常规描边 |
| `--border-soft` | `#EEF0F3` | 极浅描边 / 组内分割 |
| `--bw` | `1px` | 描边宽度（与上面的颜色搭配使用） |

### 3.3 语义色

每种语义都有「主色 / 浅底 / 描边 / 深正文」四件套，浅底上的文字必须用 `-deep` 版本才够对比度。

| 语义 | 主色 | 浅底 | 描边 | 深正文 |
|---|---|---|---|---|
| 成功 `--ok` | `#0F9D58` | `#E9F7EF` | — | — |
| 失败 `--err` | `#E02020` | `#FDECEC` | `#F5C2C2` | `#7A2020` |
| 警告 `--warn` | `#F5A623` | `#FEF6E7` | `#F3D9A4` | `#96650B` |
| 信息 `--info` | `#1A73E8` | `#EAF1FD` | `#B9D2FB` | — |
| 商站任务 `--purple` | `#7A5AF8` | `#F0ECFE` | — | — |
| 数据看板 `--cyan` | `#0891B2` | `#E6F4F8` | — | — |

失败/警告另有 hover 加深态：`--err-dark:#B81818`、brand 的 `--brand-dark` 同理。

### 3.4 死令牌的"故意保留"

死令牌分析当前报告 3 个从未被 CSS `var()` 引用的令牌（脚本见 `check_tokens.py`）。它们不是臆造，而是有意保留：

| 令牌 | 取值来源 | 保留理由 |
|---|---|---|
| `--purple` / `--purple-soft` | `#7A5AF8` / `#F0ECFE`，与 `tasks.json` 中「商站任务」分组 `color: "#7A5AF8"` 同色 | **双路径**：CSS 这条路径暂未启用，实际消费在 `tasks.json → JS → gchip 内联 style`。两条路径必须同色，改色要同时改两边（tokens.css §11 节 + `tasks.json` 第 6 行）。 |
| `--tap-min` | 44px（对齐 iOS / WCAG 触控目标） | **未来值**：当前桌面端组件无 44px 控件，移动端组件尚未开发。§9.2 已写明"新增组件请遵守"，作为规范值保留。 |

> 何时可以删 `--purple`：把 `tasks.json` 的 `color` 字段去掉、改由 JS `getComputedStyle(root).getPropertyValue("--c-purple")` 取色，让 tokens.css 成为唯一来源。这一改涉及 4 处 JS 渲染点，未在本次任务范围内。
> 何时可以删 `--tap-min`：永远不删——它是规范，不是死代码。

### 3.5 终端（页面内唯一的深色面）

日志终端是自成一体的深色面，不要拿中性色往里套。

| 令牌 | 值 | 用途 |
|---|---|---|
| `--term-bg` | `#0F1115` | 终端底 |
| `--term-fg` | `#C9D1D9` | 普通输出 |
| `--term-sys` | `#7D8590` | 系统行 |
| `--term-cmd` | `#79C0FF` | 命令行、成功态状态点 |
| `--term-ok` | `#3FB950` | `[开始]`、运行中状态点 |
| `--term-bad` | `#FF7B72` | 错误行、失败态状态点 |
| `--term-warn` | `#D29922` | `[系统]` 行 |
| `--term-dim` | `#6E7681` | 异常堆栈（弱化） |

### 3.6 深浅模式

**本页未实现深色模式**，也没有 `prefers-color-scheme` 分支 —— 现有需求里没有。
如果以后要加，正确做法是新增一个 `@media (prefers-color-scheme: dark){ :root{ ... } }`，**只覆写第一层 `--c-*`**，第二层语义令牌和全部业务样式都不用动。这也是分两层最大的收益。

---

## 4. 字体与字号层级

```css
--font-sans: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,...,"PingFang SC","Microsoft YaHei",sans-serif;
--font-mono: "SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;
```

字号共 12 级，**命名即用途**：

| 令牌 | 值 | 用在哪 |
|---|---|---|
| `--fs-badge` | 11px | 徽标 / 角标 / 分组标签 |
| `--fs-caption` | 11.5px | 计数 / 时间戳 / 次要点提示 |
| `--fs-small` | 12px | 表头 / 次级说明 |
| `--fs-note` | 12.5px | 描述正文 / 副标题 |
| `--fs-control` | 13px | 按钮 / 输入 / 表格正文 |
| `--fs-control-lg` | 13.5px | 主按钮 / 面板标题 |
| `--fs-body` | 14px | 页面正文基准 |
| `--fs-title-sm` | 14.5px | 卡片标题 / 区块标题 |
| `--fs-title` | 15.5px | 顶栏主标题 |
| `--fs-input` | 16px | **表单控件**（iOS 上小于 16px 会触发页面自动放大，别改小） |
| `--fs-title-lg` | 16.5px | 弹窗标题 |
| `--fs-title-xl` | 17px | 视图主标题 |

字重只有三档，不要引入第四档：

| 令牌 | 值 | 用在哪 |
|---|---|---|
| `--fw-regular` | 400 | 正文 |
| `--fw-medium` | 500 | 按钮 / 选中项 |
| `--fw-semibold` | 600 | 徽标 / 导航分区标题 / 表头 |

行高五档：

| 令牌 | 值 | 用在哪 |
|---|---|---|
| `--lh-tight` | 1.35 | 卡片标题（多行时收紧） |
| `--lh-normal` | 1.5 | 描述 / 产物列表 |
| `--lh-base` | 1.55 | 页面正文基准 / 诊断卡 |
| `--lh-relaxed` | 1.6 | 徽标 / 弹窗正文 |
| `--lh-term` | 1.65 | 终端日志（等宽字体需要更松） |

---

## 5. 间距

`--sp-{n}` 的值就是 `{n}px`，没有换算。现有档位：
1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 34, 88, 96。

**只在 `padding` / `margin` / `gap` 上使用**，不要拿它当 width/height 用（那是 `--layout-*` / `--ctrl-*` 的活）。

```css
.card{ padding:var(--sp-14); }
.hrow{ display:flex; gap:var(--sp-8); }
.nv{ padding:var(--sp-8) var(--sp-10); }
```

需要新档位时直接加定义（比如 `--sp-28:28px;`），不要复用邻近值凑数。

---

## 6. 圆角

| 令牌 | 值 | 用在哪 |
|---|---|---|
| `--r-xs` | 3px | 滚动条滑块 |
| `--r-sm` | 5px | 徽标 / 分组标签 |
| `--r-md` | 7px | 小按钮 / 输入框 / 标签页 |
| `--r-lg` | 8px | 列表首尾 / 内嵌块 |
| `--r-xl` | 9px | **最常用**：按钮 / 导航项 / 卡片内块 |
| `--r-card` | 12px | 卡片 / 面板 |
| `--r-modal` | 14px | 弹窗 |
| `--r-pill` | 999px | 胶囊 |
| `--r-circle` | 50% | 圆形（图标底 / 状态点 / 序号） |

列表首尾那种半圆角写法照样能用：`border-radius:var(--r-lg) var(--r-lg) 0 0`。

---

## 7. 阴影、边框与聚焦环

```css
--shadow-1: 0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.06);  /* 卡片 */
--shadow-2: 0 12px 32px rgba(16,24,40,.16);                              /* 浮层 / 抽屉 / 弹窗 */
--ring-brand: 0 0 0 3px var(--brand-soft);   /* 聚焦 / 选中 */
--ring-ok:    0 0 0 3px var(--ok-soft);      /* 在线状态点 */
--ring-err:   0 0 0 3px var(--err-soft);     /* 离线状态点 */
```

边框统一写法，**宽度走 `--bw`，颜色走语义令牌**：

```css
.card{ border:var(--bw) solid var(--border); }
.b-err{ border:var(--bw) solid var(--err-line); background:var(--err-soft); color:var(--err-deep); }
```

---

## 8. 组件样式与交互状态

主要组件的默认态（值为展开后的实际效果）：

| 组件 | 高度 | 圆角 | 底色 | 文字 | 字号/字重 |
|---|---|---|---|---|---|
| `.btn-run`（卡片主按钮） | 38px | 9px | `--brand` | `--white` | 13.5px / 500 |
| `.btn-primary`（弹窗主按钮） | 40px | 9px | `--brand` | `--white` | — / 500 |
| `.btn-ghost`（幽灵按钮） | 38px | 9px | `--white` + `--border` | `--muted` | 13px |
| `.btn-cancel`（取消） | — | — | `--surface-cancel` | `--text` | — |
| `.btn-danger`（危险） | — | — | `--err` | `--white` | — |
| `.hd-btn`（顶栏按钮） | padding 7/12 | 9px | `--white` + `--border` | `--text` | 13px |
| `.nv`（导航项） | min 38px | 9px | 透明 | `--text` | 13.5px |
| `.tab`（标签页） | min 30px | 7px | `--white` + `--border` | `--muted` | 12px |
| `.mini`（小按钮） | min 38px | 9px | `--white` + `--border` | — | 13px |
| `.card` | — | 12px | `--card` + `--border` + `--shadow-1` | — | padding 14px |
| `.modal` | — | 14px | `--card` + `--shadow-2` | — | padding 22px |
| `.toast` | — | 9px | `--text` | `--white` | 13.5px |

交互状态（16 条，全部沿用令牌）：

| 选择器 | 效果 |
|---|---|
| `.btn-run:hover` / `.btn-primary:hover` | 底色 → `--brand-dark` |
| `.btn-danger:hover` / `.btn-run.danger:hover` | 底色 → `--err-dark` |
| `.btn-cancel:hover` | 底色 → `--surface-cancel-hover` |
| `.btn-ghost:hover` / `.hd-btn:hover` / `.mini:hover` / `.hrow .act button:hover` | 底 → `--brand-soft`，描边+文字 → `--brand` |
| `.nv:hover` | 底 → `--border-soft` |
| `.tab:hover` | 文字 → `--text` |
| `.mini.warn:hover` / `.mini.err:hover` | 描边 → `--warn` / `--err` |
| `.pr select:focus, .pr input:focus` | 描边 → `--brand`，`box-shadow:var(--ring-brand)`，`outline:none` |
| `.btn-run:disabled` | 底 → `--surface-disabled`，`cursor:not-allowed` |
| `.hd-btn:disabled` | 底 → `--white`，描边 → `--border`，文字 → `--muted`，`opacity:.45`，`cursor:not-allowed` |

---

## 8.5 信息架构原则：工作台只展示工作台信息

UI 上一处典型的设计陷阱：**把服务器/部署细节混进产品界面**。典型例子：

- 顶部副标题渲染项目根目录路径（`E:\...`）+ 解释器路径（`...\.venv\Scripts\python.exe`）+ 任务数 —— 三者用 `·` 拼成一长串。
- 整改一：去掉路径，只留"共 17 个任务"。
- 整改二（最终形态）：**副标题整行删除**——任务数在每个视图的标题里已经写了（如"按分组归类，共 17 个任务"），顶栏再挂一行是重复信息。

问题：路径是**部署细节**，对使用者（站长/同事）无意义，反而挤占了真正的工作台信息；同一台机器换人登录，路径还得改；URL 截图外发还会泄机器结构。副标题同理——它占掉了顶栏高度，换来的却是一句在别处已经存在的话。

**顶栏结构（当前唯一形态）**：

```
[☰] [logo] 风神数据处理 · 任务运行工作台   …………  [● 工作台服务已连接] [↻ 重载任务清单] [终止]
```

即：左侧导航入口 + 品牌标识 + **单行主标题**；右侧服务状态胶囊（"工作台服务已连接 / 正在连接服务 / 工作台服务已断开"，鼠标悬停有完整解释）+ 操作按钮。标题区 `.hd-t` 内**只有一个 `<b>` 主标题元素**，不再有 `<span>` 副标题；`.hd-t` 因此从纵向 flex 收敛为 `display:flex;align-items:center`，超长时由 `text-overflow:ellipsis` 兜底。

**服务状态胶囊三态**（视觉见 §4.2）：

| `state.connected` | 圆点 | 完整文案（>1000px） | 短文案（≤1000px） | 含义 |
|---|---|---|---|---|
| `true` | 绿 `--ok` | `工作台服务已连接` | `服务已连接` | 事件流已通，运行中任务的 `log` / `run_start` / `run_end` 推送即时到达 |
| `null` | 灰 `--muted-2` | `正在连接服务` | `连接中` | 首帧或重连中。**`null` 不是 `false`**——首帧不该红着说"已断开" |
| `false` | 红 `--err` | `工作台服务已断开` | `服务已断开` | SSE 断流；运行中的任务不中断，但**日志不再实时更新**，刷新页面可恢复 |

胶囊 `title`（三态共用，解释"连的是啥 + 断了会怎样"）：

> 连接对象：本地工作台服务的 SSE 事件流 —— 决定任务日志是否实时刷新。断开时任务照常运行，只是日志不再实时更新，刷新页面可恢复

**为什么必须点名连接对象**（这条是踩过两轮返工定下来的）：

1. 第一版 `已连接 / 已断开` —— 不知道连的是啥（服务器？风神？钉钉？）。
2. 第二版 `实时同步 / 同步中断` —— 换了产品语义，但**同步的是什么**依然没说，等于把问题从"连给谁"平移成"同步啥"，仍然不合格。
3. 定稿 `工作台服务已连接 / 已断开` —— **主语写全**：连接对象就是"工作台服务"（本 `server.py` 起的本地服务），一眼看明白。

**状态文案通则**（适用于本项目所有状态指示器，不只是顶栏胶囊）：

| 规则 | 说明 |
|---|---|
| ① 主语必须写全 | "已连接" ❌ → "工作台服务已连接" ✅。状态词前面一定要有"谁/什么东西" |
| ② 后果写进 title | 主文案说清"是什么"，hover 说清"连的是啥 + 断了会怎样"，不塞进主视觉 |
| ③ 初始态 ≠ 失败态 | 还没连上用 `null` + 灰点 + "正在连接…"，**绝不能**首帧就红着报"已断开" |
| ④ 窄屏降级保主语 | 短文案可以砍修饰（`工作台服务已连接`→`服务已连接`），但对象词不能砍到只剩"已连接" |
| ⑤ 技术名词不进主文案 | SSE / WebSocket / EventSource 这类只出现在 title 和代码注释里 |

**约定**：

| 该展示 | 不该展示 |
|---|---|
| 工作台名称 / 服务连接状态 / 当前运行中的任务 | 项目根路径、解释器路径、`tasks.json` 物理位置 |
| 任务数（在**视图标题**里，随筛选结果变化） | 服务器主机名 / IP / 端口 |
| 用户名（登录后） | 任务数（在**顶栏**里）/ 当前时段（已并入考勤任务卡片的 `--code` 参数） |

**实现**：

- 后端 `/api/state` **不下发**任何路径或部署字段。
- 前端 `state` 不留 `meta: { python, root }` 这种"待展示用"的容器。
- `renderHeader()` 只做四件事：连接圆点、连接文案、cookie 圆点、cookie 文案、终止按钮禁用态。
- 任务总数只出现在 `renderViewHead()` 的视图标题中（`共 N 个任务` / `按分组归类，共 N 个任务`）。

**按钮文案通则**（与状态文案同根问题）：

按钮文案同样要写清**动作对象**，否则用户看不出点下去会发生什么。

| ✅ 直白 | ❌ 模糊 |
|---|---|
| `重载任务清单` | `重载配置`（配置是啥？配置在哪？点了会怎样？） |
| `终止` + title "终止运行中的任务" | `取消`（取消啥？当前操作？排队？运行中？） |
| `清空示例` | `重置`（重置到默认？还是清掉我所有数据？） |

判定原则与 §8.5 一致：**主语必须写全**——动词前面有"对象"或"动作结果"，不能光秃秃一个动词。
`title` 字段保留作为详细说明（如"编辑 tasks.json 后点此重新加载任务清单（无需重启服务）"），鼠标悬停可见。

---

## 8.6 周期性轮询与可见性

顶栏 cookie 有效性胶囊需要一个"定时校验 + 切到后台暂停 + 切回前台立即刷"的轮询机制。这套模式适用于任何"页面级后台轮询"（未来加新的轮询源照抄即可）。

### 8.6.1 周期与抖动取值

**结论**：基础 **60 秒** + 抖动 **±15 秒**，下限兜底 **5 秒**。

| 取值 | 理由 |
|---|---|
| 基础 60s | cookie 失效是**分钟级**事件（风神会话最长保留 30 分钟量级，但失效主要因浏览器活跃顶号，发生时机离散）。秒级轮询既无收益，又徒增 validToken 接口压力。1 分钟这个量级人眼能感知状态变化，又不至于太迟钝 |
| 抖动 ±15s | 4 邻拍（15s 步长）足以让多客户端/多标签错峰。±15s 比 ±5s 错得更彻底，比 ±30s 仍保持「在 1 分钟左右」的预期感 |
| 下限 5s | 兜底防抖：极端情况下 `base + jitter` 算成接近 0 时仍至少等 5s，避免抖到「立即又探」的死循环 |

**为什么不固定间隔**：
1. 多标签同开时会出现**整点同步探针**（所有标签同时拉），validToken 不限流但日志看着像 DDoS；
2. 固定节拍更易被风神反爬系统识别为机器行为；
3. 抖动让"上次探的间隔"成为不可预测值，反而像人。

### 8.6.2 状态机

```
            ┌────────── startCookiePolling (init) ──────────┐
            │                                                ▼
   ┌─hidden─┐                              ┌─ scheduleCookieCheck ─┐
   │        │   visibility=visible         │  setTimeout(base±jit)  │
   ▼        │   (立即探一次)               ▼                        │
  暂停      │              ┌── checkCookieStatus ──┐               │
  (无定时器)│              │                       │               │
            │              ▼                       ▼               │
            │   state.cookie = res     .finally: 若 active 则挂链   │
            │              │                                           │
            │              └─ renderHeader()                         │
            │                                                          │
   ▲        │                                                          │
   │ hidden │  clearTimeout + 停止挂链                                 │
   └────────┘                                                          │
                                                                      │
            ┌─ 卸载 (beforeunload) ─────────────────────────────────────┘
            ▼
   stopCookiePolling (清 active + 清 timer, 不发请求)
```

### 8.6.3 实现要点

| 要点 | 说明 |
|---|---|
| 链式 setTimeout，不用 setInterval | 每次只排下一次，抖动才能生效；setInterval 的间隔是固定的 |
| `state.cookiePollActive` 标志 | 与 timer 句柄分离。`stopCookiePolling` 同时关 active + clearTimeout，**双保险**，避免回调闭包里还误以为"该继续" |
| 解耦于 SSE | cookie 探针失败 / SSE 断流 互不影响。SSE 是日志推送通道，cookie 是另一种数据源，混在一起会让单点故障放大 |
| `beforeunload` 摘链 | 标签关闭瞬间，回调里再撞 `document.getElementById("cookieCap")` 可能撞上已脱离 DOM 的元素抛错 |
| `pageshow(e.persisted)` 兜底 | 从 bfcache 恢复时 visibilitychange 不会触发，需要额外补一刀 |
| 后端 `/api/cookies/status` 是只读 | 不调 `aeolus_sdk.login`、不写 aeolus_sdk/cookie.txt；探针路径是 `validToken`（200=有效，401=失效）|

### 8.6.4 错误态（unknown）的归因

- aeolus_sdk/cookie.txt 不存在 → unknown（"aeolus_sdk/cookie.txt 不存在"）—— 还没登录过，别误报"已失效"
- aeolus_sdk/cookie.txt 为空 → unknown（"aeolus_sdk/cookie.txt 为空"）—— 同上
- 探针超时 / 网络错 → unknown + reason（"请求失败：……"）—— 临时问题，**不要**在网络抖动时把胶囊从 valid 变红，看着吓人
- 探针返回 401 → invalid（明确是会话失效）—— 此时红点是必要的，因为后端用 cookie 跑任务会全部失败

文案设计：unknown 永远是**灰点 + "Cookie 状态未知"**（不红）。invalid 才是红。理由——见 §8.5 状态文案通则 ③：临时不可用≠失败。

### 8.6.5 窄屏降级

≤620px 隐藏服务状态胶囊（`#connCap`）。理由：

- **重要性分层**：SSE 断流 → 任务照跑，仅日志不再实时刷新；Cookie 失效 → 所有需要 cookie 的任务必然失败。Cookie 关键性高于 SSE，窄屏空间紧张时让位。
- **退路**：标题元素里不需要，胶囊 HTML 节点保留（display:none 不卸载），宽屏切回时立即可用；`state.cookie` 仍正常更新，不影响逻辑。

`#cookieCap` 永远保留：所有断点（≤560 / 620 / 820 / 1000 / 全宽）都可见。窄屏短版（`Cookie 有效` 等 2-3 字）已足够辨识，且探针 URL 在 title 里随时可查。

**为什么不进一步收窄（如 ≤560px 隐藏重载任务清单按钮）**：实测顶栏在 375px 下即使做完上述降级仍溢出（主标题单行 ellipsis 后仍需 ~200px、菜单+logo+cookie+终止合计 162px、padding 40px、3 个 gap 42px = 总 444px > 375px 69px）。这是**顶栏塞太多元素的结构问题**，不只这次改动导致。优化路径是后续把 logo 与主标题合并、或把顶栏改成两行——但属另起一桩，本节只做最小降级。

---

## 8.7 左侧导航：扁平条目（无分组小标题）

**最终形态**（2026-09-02）：

```
全部任务       17
排班考勤       2
商站任务       2
装备点亮       2
运单处理       6
不满意单       2
其他工具       1
数据看板       —     ← 一级导航项（2026-09-08 新增），与任务中心同级，非分组故无计数
运行记录       16
```

—— 一列扁平条目，**无分组小标题**。条目间用 `.nv + .nv { margin-top: var(--sp-5) }` 留 5px 间距替代原来的分组间距。

> **2026-09-08 补充（层级）**：上图虽称"扁平"（指没有写明的分组小标题），但**实际是两级**——
> 「任务中心」是可展开的一级容器，排班考勤/商站任务/… 是它挂的二级项（`.nv-subs`）；
> 「数据看板」则是**与任务中心平级的一级叶子项**（无 `children`，点击直接切视图）。
> 判定依据只看 `navSections()` 里该项**有没有 `children`**：有 = 可展开容器，无 = 叶子。
> 新增一级项必须同步在 `renderMain()` 加 `state.nav.kind` 分发，否则会落到兜底分支渲染成任务列表。

**两轮整改过程**：

| 阶段 | 形态 | 问题 |
|---|---|---|
| 整改一 | 三分组（任务 / 流水线 / 运行） | 分组小标题"任务""流水线""运行"占用纵向高度；任务列表 + 流水线列表 + 运行列表 10+5+2 ≈ 17 项铺开太长；用户进工作台第一眼是找具体的任务卡片，分组小标题属于装饰 |
| 整改二（当前） | 扁平条目（无分组） | 删 `.nv-sec` / `.nv-t` 容器，改为 `.nv + .nv { margin-top }` 直接铺按钮，**视觉上分组感保留**（同等功能/同色图标自然成簇）但**不再有写明的小标题** |

**为什么删「流水线」整组**：

工作台当前阶段定位是"日常任务执行"，流水线（考勤全流程/商站任务全流程/装备点亮日报/运单日流水等）多数时候是"周/月例行"而非"每天点几次"。当流水线用得少时左侧导航里 5 条占空间却少点击，效率反低。**预设流水线数据完整保留**——`tasks.json → server.py → state.presets` 全链路不动，渲染 `renderPresetView` 函数也保留，只是导航无入口。如需用回，调 `POST /api/run` 传 `preset_id`；恢复 UI 入口只需新增导航项，无须改业务代码。

**为什么删「输出日志」导航项**：

输出日志的真实使用场景是"任务跑起来时看实时输出"——这由**底部抽屉**承担（任务开跑自动展开，点 `dwBar` 切换收起/展开）。左侧的"输出日志"项实际是"全屏版日志视图"，入口用得极少（用户更习惯底部抽屉）。**全屏视图代码保留**——从「运行记录」点某条历史的「看日志」按钮可跳过去（`viewRunLog()` 设 `nav.kind="logs"`），渲染分支也保留。

**CSS 规则替代**：

```css
/* 旧 */
.nv-sec { margin-bottom: var(--sp-18) }
.nv-t   { font-size: var(--fs-badge); font-weight: var(--fw-semibold); letter-spacing: .6px;
          color: var(--muted-2); padding: 0 var(--sp-10); margin-bottom: var(--sp-6); text-transform: uppercase }

/* 新 */
.nv          { margin-top: var(--sp-5) }
.nv:first-child { margin-top: 0 }
```

**预留原则**：

- 业务逻辑（数据 / 后端接口 / 渲染函数）一律不删，只去 UI 入口。
- 视图代码保留（renderPresetView / 渲染 logs 全屏分支）——后续加回导航项时不用补逻辑。
- 导航扁平化是**结构决策**，与单条文案/样式调整不同：改完应同时更新 DESIGN.md 与 README.md 的页面结构示意（如 ASCII 框图），否则文档与代码不一致。

---

**约定**：禁用态统一是"降饱和 + `cursor:not-allowed`"，不用 `opacity` 全局降透明度（顶栏按钮除外，那里历史上就是 `.45`）。

---

## 8.8 任务卡片：横长形布局（每张独占 100% 宽）

**最终形态**（2026-09-02）：

```
┌─────────────────────────────────────────────────────────────────────┐
│ ☑ 拉取实时在线                    │ 拉取三站点实时在线…  │ ▶  运行    │
│   考勤  只读  成功                │ [时段: 自动判断当前]   │ 17:30 2.4s │
│                                   │                       │   成功    │
└─────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────┐
│ ☐ 拉取装备点亮…                   │ 拉取 T-1 数据…        │ ▶  运行    │
│   装备点亮  只读                   │ 开始日期 / 结束日期…  │            │
└─────────────────────────────────────────────────────────────────────┘
```

每张卡片独占容器一整行；高度由内容撑开，远小于宽度——典型的横长形。三栏 grid：

```
.card { display:grid; grid-template-columns: minmax(0,1fr) minmax(0,2.4fr) auto;
        grid-template-areas:"left mid right"; align-items:center;
        column-gap:var(--sp-16); row-gap:var(--sp-8); }
```

| 栏 | 内容 | 宽度策略 |
|---|---|---|
| **左 `.card-left`** | 复选框 + 标题 + 分组 chip + 风控徽章 + 状态徽章 | `1fr`（占 1 份） |
| **中 `.card-mid`** | 描述 + 前置提示 + 产物说明 + missing 提示 + 参数区（`auto-fit` 多列） | `2.4fr`（占 2.4 份，自然撑开） |
| **右 `.card-right`** | 运行按钮 + 上次运行记录 | `auto`（按钮 100% 宽，固定 160px 起步） |

**为什么这么做**：

- 截图反馈原 3 列网格在 1366×768 笔记本屏下每张高度约 320px、单行 3 张 → 4 行 ~1300px，**首屏看不到完整一张卡片的底部运行按钮**。横长形每张独占一行后高度自然落到 80~140px（由参数区行数决定），**首屏通常可看到 6~8 张完整卡片**。
- 三栏 grid 而不是 6 个子元素横向排：把"标题/参数/操作"三块**视觉分组**，避免"按钮和描述挤一坨"。
- 参数区独立 grid：`grid-template-columns:repeat(auto-fit,minmax(180px,1fr))` —— 中栏越宽自动放越多参数列，不需要靠 nth-child 或预定义列数。

**降级策略**：

| 断点 | 行为 |
|---|---|
| 默认（> 820px） | 三栏 grid（left + mid + right） |
| ≤ 820px | 三栏挤成水平一行会塌，改为三行垂直堆叠（grid-template-areas:"left" "mid" "right"），右栏按钮左对齐 |

**预设流水线卡片 `.card.preset` 不走横长形**：

```css
.card.preset{ display:flex; flex-direction:column; gap:var(--sp-10);
              padding:var(--sp-14); grid-template-columns:none; }
```

理由：流水线卡片里有"步骤列表 `.psteps`"——它是垂直列表（步骤 1 → 步骤 2 → …），塞进横长形三栏会破坏阅读节奏。

**改动后产物**：

- `index.html` CSS（`.tasks` / `.card` / `.params` / `.btn-run`）与 JS（`taskCard()` 用 left/mid/right 三个 wrapper）同步修改
- `presetCard()` 加 `.preset` class 保留垂直布局
- 静态页面读盘即生效，**无需重启服务**
- 验证：CSS + JS 源码 15/15；jsdom 真实跑 init 拉 `/api/state` 渲染 7/7（16 张卡片结构 = `[card-left, card-mid, card-right]`），`check_tokens.py` 全部通过

---

## 8.9 执行节点区块 `.nodes-block`（步进条 · 区间选择）

**适用条件**：任务在 `tasks.json` 里声明了 `nodes: [{id,name,desc}...]`。
**当前 15 个任务全部有节点** —— 节点化对任务是强制约束（`sync_nodes.py` 会拦未节点化的任务），
是工作台的通用能力，不是实时在线播报专属。SDK 自带的诊断入口（如 `python -m aeolus_sdk.login`）
不是任务，不在此列。

渲染只认 `nodes` 一个条件；`--begin` / `--end` 两个 select 由 `sync_nodes.py` 自动补，
万一某个任务只声明了 `nodes` 没配这两个 param，前端用**虚拟 param 兜底**
（只读写 `state.args`，不进 params 循环，所以不会渲染两遍选择器）。

**形态：一条横线 + 线上的圆点 + 圆点下方的节点名，点圆点选两端。**

```
┌─ card-mid ───────────────────────────────────────────────────────────┐
│  考勤端到端 4 节点流水线：…                                          │
│  ┌ .nodes-block ─────────────────────────────────────────────────┐   │
│  │ ⚡ 执行节点                                                   │   │
│  │                                                               │   │
│  │  ●━━━━━━━●━━━━━━━●━━━━━━━●                                   │   │
│  │ 拉取实时   渲染明细   上传MinIO   发送钉钉                     │   │
│  │  开始                              结束                       │   │
│  └───────────────────────────────────────────────────────────────┘   │
│  [ ⚙ 配置 ]    [ ▶ 运行 ]                  2026-09-02 · 6.2s · 成功 │
└──────────────────────────────────────────────────────────────────────┘
```

**卡片只摘要，参数全部进配置弹窗**（§8.10）。卡片上的配置摘要 + 「配置」按钮只是个入口；
「运行」按钮在弹窗外，等于「不改任何东西直接跑」，避免每次都走一遍弹窗。

### 交互契约（三条硬规则）

1. **只能选两端**：界面只有圆点，没有下拉。点第一个 = 开始，再点一个 = 结束；
   点在起点之前 = 起点往前挪。中间永远是连续区间，
   **跳选 / 不连续 / 多段在交互层面就不可能发生**（不是"校验拦住"，是"点不出来"）。
2. **点同一个圆点两次 = 只跑这一个节点**（区间退化为单点，端点标注「仅此一步」）。
3. **区间必须合法**才允许运行，二种状态：

| 状态 | 触发 | 表现 |
|---|---|---|
| `ok` | begin/end 都有值且 `end >= begin` | 常态；区间内的圆点填品牌色，两端加 ring，区间线段品牌色。**默认 (default) = 首末全选，所有节点一起跑**。 |
| `invalid` | 两端都空，或 `end < begin`（后者只会来自历史 prefs） | 整块转 `err` 系 + 红字一行说明 + **运行按钮禁用**。 |

节点面板不挂底部摘要、不放全选 / 清空按钮，**保持一行节点线 + 节点名**的极简形态。
**每次跑完任务（`run_end` SSE 事件到达）会把 `state.args[tid]` 清空成 `{}`**，下次开起来节点
选择与配置参数全部回到 default，has-mod 角标、节点边缘色、配置按钮高亮同步收起 —— 复用
`argValue()` 的「找不到 key 就回落到 `params[].default`」语义，前端不维护单独的清空按钮。


### 为什么用"每节点自带左右半段线"拼连线

```css
.nodes-step::before{left:0;right:50%;margin-right:calc(var(--ndot)/2 + var(--sp-4))}  /* 左半段 */
.nodes-step::after {left:50%;right:0;margin-left:calc(var(--ndot)/2 + var(--sp-4))}   /* 右半段 */
.nodes-step:first-child::before,.nodes-step:last-child::after{display:none}
```

- 不用百分比算线段端点，节点数从 4 变 6 也**不用改一行 CSS**
- 只有「本节点与相邻节点都在区间内」时那半段才点品牌色（`seg-l` / `seg-r`），
  所以区间外天然保持灰色，视觉上就是一段连续高亮路径
- 圆点与线之间留 `--sp-4` 间隙，避免圆点压在线上

`--ndot` / `--nline` 是**块内局部令牌**（组件级尺寸，窄屏覆盖成 14px），
不入 `tokens.css` 以免污染全局命名空间；`check_tokens.py` 会单独列出「组件内局部令牌」供人工过目。

### 与后端的口径对齐

- 前端只做校验，**真正决定跑哪些节点的是 Python 脚本**：所有脚本统一走 `nodeflow.py`
  （项目根目录），命令行口径一致 —— `<script> --begin <id> --end <id>`，
  `end` 早于 `begin` 或 id 不在节点表里，都打印 `✗ …` 并 `exit 1`。详见 `DESIGN.md` §8.10。
- 点击写回 `state.args[tid]` 时**写显式空串而不是删 key** —— 删 key 会让 `argValue()` 回落到
  `params[].default`（等于又全选了），空选择的提示就永远不出现。
- `server.py` 的 `build_cmd()` 对空值（`""/None/False`）**不拼进命令行**，
  所以"未选"在服务端等价于"不传该 flag"，脚本走自己的 default —— 与前端 default 一致。
- `nodes` 字段由 `registry_view()` 的 `dict(t)` 浅拷贝自动下发到 `/api/state`，**后端零改动**。

### 实现要点（避免踩坑）

| 要点 | 说明 |
|---|---|
| **渲染函数不互调** | `refreshNodesBlock()` 是叶子渲染器，只被 `nodesBlock()` 与圆点的 `onclick` 调用，内部绝不回调 `refreshAll()` |
| **闭包顺序** | `ns` 对象必须在绑定 `onclick` **之前**建好，否则闭包捕获到 undefined |
| **参数区不重复渲染** | params 循环里 `if(nodesState && (flag==="--begin"||flag==="--end")) return;` —— 否则同一张卡片出现两套选择器 |
| **圆点用 `<button>`** | 保证键盘可达 + `:focus-visible` 聚焦环；整块（圆点+名字）可点，点击区域远大于 44px |
| **联动按钮靠 `closest`** | `ns.block.closest && ns.block.closest(".card")` 拿到卡片再找 `.btn-run`（不用可选链，保持与全文件 ES5 风格一致）|
| **窄屏** | ≤560px 时圆点缩到 14px |

### 涉及的类

`.nodes-block`（+ `.invalid`）· `.nodes-head` · `.nodes-track` · `.nodes-step`
（+ `.in` / `.edge` / `.seg-l` / `.seg-r`）· `.nodes-hit` · `.nodes-dot` · `.nodes-name` ·
`.nodes-role` · `.nodes-warn`。
全部只用 `var()`，`check_tokens.py` 校验 0 未定义令牌、0 裸色值。

---

## 8.11 配置弹窗 `.cf-dialog`（统一入口 · 所有任务复用）

**适用条件**：任务在 `tasks.json` 里声明了 `params`，且可见参数数 ≥ 1。
**当前 11 个任务**有可见参数（考勤 / 申诉 / 4 个带开关的 / 3 个带日期的）；
**4 个只有节点区间选择**的任务（站长任务看板 / 抓急单 / 入库 / 核对行数）不显示摘要与「配置」按钮—— 节点步进条本身已是 UI。

**动机**：之前所有参数都直接展开在卡片上（.params 自适应多列），13 张卡挤在一起参数密密麻麻，
不同任务宽窄不一，且容易误触。改造后：

- 卡片中部只显示**一行配置摘要**（参数名 · 当前值，单行 ellipsis，整行可点）。
- 卡片右侧「配置 + 运行」等宽按钮组；点「配置」或摘要行 → 弹窗。
- 弹窗里有**完整表单** + 「保存 / 取消 / 恢复默认值」三件套。
- 后续新增任务**不再需要为参数写第二份** UI —— `renderParamRow()` 统一渲染。

### 交互契约（四条硬规则）

| 行为 | 触发 | 结果 |
|---|---|---|
| **保存** | 点 `cfSave` 或回车 | `commitParamsForm()` 收集 `[data-flag]` 控件 → `setArg()` 写 `state.args` → `savePrefs()` 落盘 → `refreshAll()` 刷摘要里 mod 角标 → 关弹窗 + toast |
| **恢复默认值** | 点 `cfDefault` | `fillDefaultToForm()` 把所有控件显示重置为 `params[].default`，**不写 state**（确认保存才落盘）；这就避免了"恢复"被理解成"立即生效"的歧义 |
| **取消** | 点 `cfCancel` / `cfClose` / 遮罩 / Esc | 关闭窗口，丢弃所有未保存改动 |
| **必填校验** | 某 `required` 项为空就关弹窗或运行 | runTasks 入口处 toast 提示「需要填写：xxx」并保留窗口 |

### 单实例复用设计

```js
// 单套 DOM 服务所有任务（避免每张卡一份重复弹窗）
<div class="cf-mask" id="cfMask">
  <div class="cf-dialog">
    <header class="cf-head">任务名 + 关闭</header>
    <div class="cf-body" id="cfBody"></div>   ← 打开任务时按任务 params 重建
    <footer class="cf-foot">[恢复默认] 取消 [保存]</footer>
  </div>
</div>

var cfCurrent = null;                          // 记录当前正在编辑的任务
function openConfigDialog(taskId){ /* 重建 cfBody + 显示 cfMask */ }
function closeConfigDialog(){ /* 隐藏 + 清空 cfCurrent */ }
function commitParamsForm(task, container){ /* 遍历 [data-flag] 回写 state.args */ }
function fillDefaultToForm(task, container){ /* 把控件显示重置为 default，不写 state */ }
```

### 复用点：参数行渲染函数 `renderParamRow(task, p, live)`

```js
function renderParamRow(task, p, live){
  // live=true：每个 onchange/oninput 立即 setArg（卡片内嵌用，目前未启用，留作扩展）
  // live=false：不绑事件，控件值统一由 commitParamsForm 在「保存」时一次性收集
  var row = document.createElement("div");
  row.dataset.flag = p.flag;       // ← 把 param 与控件关联的"唯一钩子"，commit 全靠它
  if(p.type==="switch"){
    /* checkbox + 文本标签，开/关 .on 切换样式 */
  } else {
    /* label(可带 * + 默认值提示) + select/input[type=text] */
  }
  return row;
}
```

**新增 param 类型**（如未来要支持 `"multi"` 多选 / `"date"` 日期选择），只在
`renderParamRow` 里加一个分支 —— 卡片摘要（`paramValueDisplay`）与配置弹窗同步
支持，无须在两处各改一遍。

### 配置摘要（`renderConfigSummary`）

摘要行用 `<span class="pill mod"><b>时段</b>·<span>午高峰</span></span>` 之类切片展示：

- pill 显示成 `标签 · 值`；值由 `paramValueDisplay()` 映射成短串（switch → ✓/—，select → 取 option.label）。
- 任一 pill 改过 default → 该 pill 加 `.mod` 类（值用品牌色）；卡片右侧「配置」按钮同时加 `.has-mod` 角标。
- 整行 `overflow:hidden; text-overflow:ellipsis; white-space:nowrap` —— 单行截断不换行；想看完整值去弹窗。

### 按钮等宽（`card-actions`）

> 用户原话："不同任务的运行按钮因文案长度不同而宽度不一致，统一为相同尺寸。
> 处理长文案的省略或换行，保证按钮在列表中视觉对齐、在窄屏下也能正常显示。"

`card-actions` 用 `display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.15fr)` —
两个按钮在主轴**严格等宽**，运行按钮因视觉权重略宽（1.15:1）做成主操作。
`minmax(0,1fr)` 让窄屏按内容收缩而不是溢出；`.btn-conf` / `.btn-run` 内部都
`white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding:0 var(--sp-9)`。

`flex:1` / `width:100%` 的弹性布局在小数像素上会算出不一致的"等宽"——
grid 列宽在主轴上**像素级相等**，没有四舍五入抖动。

### 涉及的类

`.cf-mask`（+ `.show`）· `.cf-dialog` · `.cf-head` · `.cf-tit`（+ `.ic`）·
`.cf-close` · `.cf-body` · `.cf-foot` · `.cf-row` · `.cf-row-sw`（+ `.on`）
· `.btn-default` · `.btn-save` · `.btn-cancel` · `.card-actions` · `.btn-conf`（+ `.has-mod`）
· `.config-summary` · `.vals`（+ `.pill`、`.mod`）· `.cf-empty`。
全部只用 `var()`，`check_tokens.py` 校验 0 未定义令牌、0 裸色值。

---

## 8.11 节点能力的后端支撑：`nodeflow.py` + `sync_nodes.py`

界面上的圆点是表象，底下有两条约束保证"点的"和"跑的"永远一致：

1. **脚本源码里的 `NODES` 是单一事实来源** —— 不在 `tasks.json` 里手抄节点。
2. **`nodeflow.py` 统一解析 `--begin/--end`** —— 15 处调用点共用同一份校验，口径不会漂。

### `nodeflow.py`（common/ 目录）

| API | 作用 |
|---|---|
| `Stop` | 业务中止异常。**不算失败**（exit 0），用于"筛出 0 条，跳过发送"这类正常短路 |
| `prepare(nodes)` | 解析 + 校验 + **把 `--begin/--end` 从 `sys.argv` 原地摘掉**，返回 `(todo, err)` |
| `execute(todo, ctx)` | 按序执行区间内节点，返回退出码 |
| `run(nodes, ctx)` | `prepare` + `execute` 的便捷组合 |
| `take_range(argv)` | 只摘取值、不校验（多套节点的脚本用） |
| `pick(nodes, begin, end)` | 只校验不碰 argv，与 `take_range` 配套 |
| `reject_legacy_date_args(argv)` | 拦截旧的 `--start/--end` 日期写法（见下） |

**调用顺序是硬要求**：先 `prepare()` 摘参数，再解析业务参数。反了会报"未知参数 --begin"——
因为多数脚本有自己的 `argparse`，它不认识节点参数。

```python
todo, err = nodeflow.prepare(NODES)   # 1. 先摘 --begin/--end
if err: print("✗ " + err); sys.exit(1)
args = parse_args()                   # 2. 再解析业务参数（此时 argv 已干净）
sys.exit(nodeflow.execute(todo, ctx)) # 3. 只跑区间内的节点
```

`load_delivery_db.py` / `jobs/unsat/main.py` 一个入口有多套节点（按模式、按子命令），
用 `take_range()` → 定模式 → `pick()` 的两步式。
注意 `take_range(sys.argv[1:])` 传的是**切片副本**，摘完要自己写回 `sys.argv`。

### `--end` 撞名这件事

3 个脚本的**日期**参数原本就叫 `--start` / `--end`，和节点区间的 `--end` 撞车。
处理办法：日期参数改名 `--start-date` / `--end-date`，并在脚本里加
`nodeflow.reject_legacy_date_args()` 友好拦截 ——
**只在取值匹配 `^\d{4}-\d{2}-\d{2}$` 时才报错**，否则 `--end fetch` 这种正常节点用法会被误伤。

`tasks.json` 侧同理：节点参数一定带 `options_source:"nodes"`，
**同步脚本据此区分"节点的 `--end`"和"日期的 `--end-date`"**。

### `sync_nodes.py`（tools/ 目录）

用 `ast.parse` **只读**地从脚本源码提取 `NODES` 字面量，再写回 `tasks.json`。
用 AST 而不是 `import`，是因为很多脚本 import 时就有副作用（建日志目录、连库、切 venv）。

```bat
.venv\Scripts\python.exe tools\sync_nodes.py           :: 预览将要发生的变更
.venv\Scripts\python.exe tools\sync_nodes.py --write   :: 真正写入 tasks.json
```

它顺带做两件事：补 / 刷新 `--begin`/`--end` 两个 select；把日期参数规整成
`--start-date`/`--end-date`。**幂等**，连续跑第二次输出"无变化"。

新增一个带节点的脚本，只需两步：

1. 脚本里定义 `NODES = [{"id","name","desc","fn"}, ...]` 并在 `main()` 里 `nodeflow.prepare()`
2. 在 `sync_nodes.py` 的 `SRC` 里加一行 `"task_id": ("script.py", "NODES", None)`
   （第三个值是**默认结束节点**，`None` = 末节点；个别脚本末节点是排查用的、
   默认不该跑，就显式指定该节点 id）

改完跑一次 `--write`，再点页面的「重载任务清单」，卡片上就出现节点步进条了。

---

## 9. 布局栅格与响应式断点

### 9.1 布局尺寸

| 令牌 | 值 | 说明 |
|---|---|---|
| `--layout-max` | 1560px | 顶栏 / 主体 / 执行栏 统一最大宽度 |
| `--layout-hd` | 59px | 顶栏高度。JS 的 `syncHeaderHeight()` 会按实测值覆写，这里的 59px 是首屏兜底 |
| `--layout-side` | 236px | 侧栏宽度 |
| `--layout-side-mobile` | 262px | 窄屏抽屉宽度 |
| `--layout-card-min` | 330px | 任务卡栅格最小列宽 |
| `--layout-preset-min` | 400px | 流水线卡栅格最小列宽 |
| `--layout-log-h` | 320px | 日志抽屉内日志区高度 |
| `--layout-log-offset` | 290px | 全屏日志 `100vh` 扣除量 |
| `--layout-log-min` | 340px | 全屏日志最小高度 |
| `--layout-modal` | 440px | 弹窗最大宽度 |

### 9.2 控件高度

| 令牌 | 值 | 用在哪 |
|---|---|---|
| `--ctrl-h-xs` | 30px | 小按钮（日志工具栏、"看日志"） |
| `--ctrl-h-sm` | 32px | 输入 / 下拉 |
| `--ctrl-h` | 34px | 顶栏按钮 |
| `--ctrl-h-md` | 38px | 卡片主按钮 / 快捷按钮 / 导航项 |
| `--ctrl-h-lg` | 40px | 底部执行栏按钮 |
| `--ctrl-h-xl` | 42px | 弹窗按钮 |
| `--tap-min` | 44px | **移动端最小点击区**（对齐 WCAG，新增组件请遵守） |

### 9.3 栅格列宽

运行记录表格是固定列宽 + 弹性列的组合：

```css
.hrow{
  display:grid;
  grid-template-columns:
    var(--grid-col-time)                    /* 150px 时间 */
    minmax(0,1fr)                           /* 任务名，自适应 */
    var(--grid-col-status)                  /* 82px  状态 */
    var(--grid-col-dur)                     /* 72px  耗时 */
    minmax(0,1.2fr)                         /* 输出摘要，自适应 */
    var(--grid-col-act);                    /* 92px  操作 */
}
```

参数行标签宽度：`--grid-form-label:100px`。

### 9.4 响应式断点

> ⚠️ **CSS 的 `@media()` 条件里不能用 `var()`**，所以断点只能在 `index.html` 里写死字面量。
> 断点集中登记在 `tokens.css` 第 25 节，改断点时**两处一起改**。

| 断点 | 变化 |
|---|---|
| `≤1000px` | 侧栏转抽屉，顶栏出现 ☰，隐藏 `.hide-sm` |
| `≤900px` | 首页两栏转单列、工作内容四宫格转两列、提醒明细转单列 |
| `≤820px` | 运行记录由表格行转为卡片式网格 |
| `≤620px` | 流水线卡栅格转单列、日志模态接近全屏 |
| `≤560px` | 任务卡栅格转单列、顶栏两行、时段/提醒区收窄 |
| `≤520px` | `@container` 容器查询：看板/快捷卡栅格在容器内收窄列宽 |

---

## 10. 在 JS 里用令牌

JS 里画状态点、拼内联样式时拿不到 CSS 的 `var()`，项目里统一走 `TK` 这个缓存对象（定义在 `index.html` 的脚本开头）：

```javascript
var TK = { brand:"#FF5000", neutral:"#5F6368",
           termOk:"#3FB950", termBad:"#FF7B72", termCmd:"#79C0FF", termWarn:"#D29922" };
var TK_MAP = { brand:"--brand", neutral:"--accent-neutral",
               termOk:"--term-ok", termBad:"--term-bad",
               termCmd:"--term-cmd", termWarn:"--term-warn" };

function readTokens(){ /* 启动时从 tokens.css 读一次并缓存 */ }
```

- `init()` 里的第一步就是 `readTokens()`，之后用 `TK.brand` 即可。
- 兜底值与 `tokens.css` 保持一致，样式表没加载出来也不会塌色。
- `readTokens()` 内部会解一层 `var()`，因此拿到的**一定是可用色值**（`#...`），不会是 `var(--c-brand)` 字符串。

新增颜色给 JS 用时，两步：在 `tokens.css` 加令牌 → 在 `TK` 和 `TK_MAP` 里各加一项。

---

## 11. 新增页面 / 组件时怎么用

**新页面**：在 `<head>` 里加一行即可，其余照常写。

```html
<link rel="stylesheet" href="/web/tokens.css">
<!-- 可选：Apple 式动效增强（滚动揭示 / 首屏淡入），见 §15 -->
<link rel="stylesheet" href="/web/apple.css">
```

**新组件**：只引用第二层语义令牌，不要写裸色值。

```css
/* ✅ 正确 */
.stat-card{
  background:var(--card);
  border:var(--bw) solid var(--border);
  border-radius:var(--r-card);
  padding:var(--sp-14) var(--sp-16);
  box-shadow:var(--shadow-1);
}
.stat-card .num{ font-size:var(--fs-title-sm); font-weight:var(--fw-semibold); color:var(--text); }
.stat-card .sub{ font-size:var(--fs-note); line-height:var(--lh-normal); color:var(--muted); }
.stat-card:hover{ border-color:var(--brand); transition:border-color var(--dur-base); }
.stat-card.is-bad{ background:var(--err-soft); border-color:var(--err-line); color:var(--err-deep); }

/* ❌ 错误：裸值、跨层引用 */
.stat-card{ border:1px solid #E4E7EB; color:var(--c-text-strong); }
```

**新令牌**：先确认现有令牌里没有能顶上的，再加。加在 `tokens.css` 对应小节末尾，补一句注释说明用途。

---

## 12. 有意保留字面量的地方

不是所有硬编码都该变成令牌。以下三类**故意保留字面量**，新增代码时也按此处理：

1. **响应式断点** —— `@media()` 不支持 `var()`，只能写字面量（已在 §9.4 说明）。
2. **一次性装饰尺寸** —— 图标方块的 `width/height`（14/15/16/17/19px 等）每个尺寸只服务一个组件，造令牌等于多加一层间接，反而更难读。
3. **非设计维度的技术值** —— `letter-spacing:.2px`、`backdrop-filter:blur(14px)`、`transform:translateY(8px)`，这些是排版微调与动效参数，不参与设计一致性约束。

---

## 13. 与 Python 侧配色（`theme_colors.py`）的关系

`common/` 目录的 `theme_colors.py` 是 **Pillow 出图 / HTML 报表**的配色来源，与本项目工作台是**两套独立表面**，取值并不一致：

| 角色 | 工作台 `tokens.css` | `theme_colors.py` |
|---|---|---|
| 成功绿 | `#0F9D58` | `#00B42A` |
| 失败红 | `#E02020` | `#F53F3F` |
| 主色加深 | `#D94400` | `#E64600` |

两边**不要互相套用**。如果要统一，是一次独立的改色决策，需要同时验证图片报表和工作台两边的效果。

---

## 14. 改动后怎么验证

改令牌属于"改一处动全身"，提交前跑：

```bat
.venv\Scripts\python.exe server\check_tokens.py --baseline <改动前的 index.html 副本>
```

脚本做三件事：

1. **未定义令牌扫描** —— 全文扫 `var(--x)`，确认每个名字在 `tokens.css` 里都有定义。
2. **等价性比对** —— 把 `var()` 递归解析回字面量，与基线逐条规则对比（选择器集合、声明集合、展开值三者都应一致）。
3. **裸值残留统计** —— 还剩多少硬编码色值 / 裸 px，以及它们在哪。

不带 `--baseline` 时只跑 1 和 3，日常够用；动了令牌再拿基线跑完整的。

**基线怎么来**：改动前把 `index.html` 复制一份存好。本项目目前没有 git，无法用 `git show` 取历史版本。

**已知的良性差异**：基线里 `#fff` 与 `#FFFFFF` 两种写法并存，`tokens.css` 统一取大写，
所以脚本会稳定报告 **16 处 `#fff` → `#FFFFFF`**。同色，仅写法归一，看到这批差异不必紧张。
除此之外出现任何差异，都要逐条确认是有意改动。

本次改造的验证结果：规则 205 组 / 声明 761 条前后一一对应，0 个未定义令牌，0 个选择器增删，
运行时冒烟 36 项全通过；唯一差异就是上面那 16 处写法归一。

---

## 15. Apple 风格表现层增强（2026-09-15）

> 本节记录 2026-09-15 在 §1–§14 既有规范之上追加的 Apple 式表现层改造。
> 全部沿用 §2–§13 的令牌与"禁止裸值"约定；新增的 `color-mix()` / `clamp()` / `backdrop-filter`
> 均为 §12 允许的「非设计维度技术值」或已批准特例（§4 已写明字号个别特例可用 `clamp()`）。
> 改动文件：`index.html`（内联 `<style>` + `<head>` 脚本 + 主体脚本后观察脚本）、`web/apple.css`。

### 15.1 滚动逐条浮现（IntersectionObserver）

- **门控防闪烁**：`index.html` `<head>` 内联 `<script>document.documentElement.classList.add('reveal-ready')</script>`，置于 `<link apple.css>` 前。无 JS / JS 失败 → 不置标记 → 卡片保持可见，**绝不白屏**。
- **触发**：主体脚本之后追加的观察脚本用 `IntersectionObserver` 监听 `.card, .home-box`，阈值 `0.08`、`rootMargin:'0px 0px -8% 0px'`，进入视口加 `.in` 并 `unobserve`（只播一次）。
- **SPA 覆盖**：`MutationObserver` 监听 `.main` 子树，视图切换后新插入的卡片自动 `arm()`；`load` 事件 + `700ms` 兜底各扫一次。
- **降级**：`prefers-reduced-motion: reduce` 或无 `IntersectionObserver` → `showAll()` 直接全部可见。
- **样式**（`web/apple.css`）：`html.reveal-ready .card/.home-box{ opacity:0; transform:translateY(18px); transition:opacity/transform .6s var(--ease-apple) }`，`.in` 触发到可见；首屏 `.view-h` / `.home-sec` 仍用 `apple-rise` 淡入（不依赖滚动）；reduced-motion 下 reveal 隐藏态强制全部可见。

### 15.2 首页 Hero（大标题 + 动态日期）

- `renderHomeView()` 改用 `homeHero()` 生成，替换原 `viewHead()`。
- **结构**：eyebrow（`AEOLUS WORKBENCH`：`--fs-caption` + 字距 `.18em` + 大写 + `--brand`）/ 主标题 `.hero-title`（`clamp(40px,6vw,64px)`、字重 700、字距 `-.025em`、`background-clip:text` 品牌渐变，无 JS 回退纯色）/ 副标题（`heroDate()` 实时算 `年-月-日 · 周X` + 概览，≤62ch 限宽）。
- **顶部柔光**：`.hero::before` 径向渐变 `color-mix(in srgb, var(--brand) 16%, transparent)` + `blur(18px)`，不挡交互。
- **响应式**：≤560px 收紧边距、标题 `clamp(34px,9vw,44px)`。
- **入场**：`.hero` 加入 `apple-rise` 首屏淡入（见 §15.1）。
- 样式：`index.html` 内联 `<style>` 的 `.hero` 块（`.home-sec` 之后）。

### 15.3 表格 Apple 化（tabulator 第三方样式提权覆盖）

- **作用域**：仅产物表，容器 `.arttab-body .tabulator`（覆盖原硬编码 `#f1f3f5` / `#1f2329` 写法，统一改用令牌）。
- **提权要点**：tabulator 自带样式选择器优先级深（如 `.tabulator .tabulator-header` = 0,2,0），本覆盖统一以 `.arttab-body .tabulator …`（0,3,0）打头稳压，**无需大量 `!important`**。仅「强制水平排」一条保留 `!important`（Simple 主题 17 列竖排兜底）。
- **容器**：圆角 `--r-card` + `var(--bw) solid var(--border)` + `overflow:hidden` + `box-shadow:var(--shadow-1)`，背景 `--card`。
- **表头**：浅灰 `color-mix(in srgb, var(--text) 4%, var(--white))` + 底部 `var(--bw) solid var(--border)`；列标题 `--muted` + `--fs-caption` + 字距 `.02em`。
- **单元格**：发丝线 `var(--border-soft)`，内边距 `--sp-8/--sp-10`，文字 `--text` / `--fs-control`。
- **行**：hover 与选中 `var(--brand-soft)`；zebra `color-mix(in srgb, var(--text) 2%, var(--white))`；`transition:background var(--dur-fast)`。
- **页脚**：同表头浅灰底。

### 15.4 任务中心精细打磨（在 §8.8 横长形卡片之上追加）

- **卡片悬浮**：`.card:hover{ box-shadow:var(--shadow-2); transform:translateY(-2px) }`；**不碰边框色**，保留 `.card.running` / `.card.failed` 彩色边框；`transition` 复用 `.card` 既有 `--dur-slow`。
- **标题/元信息左对齐**：`.c-t{ text-align:left }`、`.c-meta{ justify-content:flex-start }`（原居中），更贴近 Apple 卡片常规排版；状态 pill 仍借 `.card.* .c-meta::before` 行首注入（§8.8 机制不变）。
- **工具条吸顶磨砂**：`.tf-bar{ position:sticky; top:0; backdrop-filter:blur(10px); background:color-mix(in srgb, var(--white) 86%, transparent) }`，加 `padding` 与负 `margin-top` 抵消；滚动时搜索/筛选/视图切换常驻。
- **分组头悬浮**：`.task-group .section-head` 加圆角热区（`padding` + 负左右 `margin` 撑满栅格宽），`:hover` 时 `var(--brand-soft)` 浅橙底；箭头 `tg` 随 `collapsed` 旋转（既有）。

### 15.5 兼容性约束（实现时必须遵守）

- `color-mix()`：2023+ 浏览器；旧浏览器表头/zebra/浅底回退默认灰，功能不受影响。
- `backdrop-filter`：现代浏览器；旧浏览器吸顶条回退半透白无模糊。
- `background-clip:text`：现代浏览器；旧浏览器 hero 标题回退纯色。
- `IntersectionObserver` / `MutationObserver`：缺失时卡片回退直接可见。
- 以上降级路径均已内置；**新增 UI 不得引入「无 JS / 旧浏览器即不可见」依赖**。
- 全部新增样式走 `check_tokens.py` 校验：0 未定义令牌、0 裸色值（`color-mix` 内仅引用 `--brand` / `--text`，无字面量色值）。
- 另：本次在 `web/tokens.css` §20 新增 `--ease-apple: cubic-bezier(0.32,0.72,0,1)`（Apple ease-out 曲线），供滚动揭示 / 首屏淡入 / 卡片位移统一复用；此前 `apple.css` 已引用该名但未定义，现补全后动画缓动方才生效。

### 15.6 改动清单（本次 Apple 化落地）

- 滚动逐条浮现（IntersectionObserver + `reveal-ready` 门控）。
- 首页 Apple hero（动态日期 eyebrow + 品牌渐变大标题 + 顶部柔光）。
- tabulator 表格 Apple 化（圆角容器 + 柔和表头 + 品牌 hover + 细 zebra，统一 token，提权覆盖第三方样式）。
- 任务中心精细打磨（卡片悬浮浮起 / 标题左对齐 / 工具条吸顶磨砂 / 分组头悬浮高亮）。
