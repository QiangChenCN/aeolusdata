# 考勤任务合并说明（2026-09-02）

两个考勤任务（「拉取实时在线」+「发送考勤钉钉」）合并为单一任务「考勤流水线」。

\---

## 1\. 脚本：单一入口 `attendance.py`

取代并删除了 `attendance\_all\_teams.py` 与 `send\_attendance.py`。

内部拆成 4 个有序节点，`NODES` 是唯一事实来源：

|#|节点 id|作用|产物|
|-|-|-|-|
|1|`fetch`|拉取三站实时在线|`attendance\_raw/team\_{tid}\_{时段}.json`、`attendance\_summary.json`|
|2|`render`|渲染考勤明细图|`attendance\_absent.png`|
|3|`upload`|上传 MinIO 取公网直链|图片 URL|
|4|`send`|组装 markdown 发钉钉群|群消息（+ @三站站长）|

### 入参变化

|旧|新|说明|
|-|-|-|
|`attendance\_all\_teams.py --code/--teams`|`attendance.py --code`|`--teams` 删掉，三站是固定常量，不再暴露|
|`send\_attendance.py --group/--group-name/--no-at/--link/--test`|同名保留在 `attendance.py`|语义不变|
|—（无）|**新增 `--begin` / `--end`**|圈定要跑的节点区间，默认 `fetch`→`send` 全跑|

### 执行流程变化

* 旧：**两个进程两次调度**，中间靠磁盘产物（`attendance\_absent.png` / `attendance\_summary.json`）传递；
第二步还要靠 `needs` 字段检查前置产物是否存在。
* 新：**一个进程内顺序执行**，`render` 节点直接从 `attendance\_summary.json` + raw JSON 恢复状态
（不依赖 `fetch` 的内存返回值），所以任意子区间都能单独跑；`send` 节点内部自带 `upload`，
单独跑 `send` 也不会缺图链。前置检查由节点顺序天然保证，`needs` 字段已移除。

### 对外行为变化

* **产物、日志格式、钉钉消息内容、@ 规则、群默认值完全不变**（仍走 `report\_render` / `minio\_common` / `ding\_common`）。
* 日志里每个节点的输出加了 `\[fetch]` / `\[render]` / `\[upload]` / `\[send]` 前缀，便于定位。
* 新增的拒答行为：`--begin`/`--end` 不是合法节点 id，或 `end` 索引早于 `begin` → 打印原因并 `exit 1`，
**不会退化成"全跑"**。

### 常用命令

```bash
python attendance.py                                   # 全跑：拉数→出图→上传→发生产群 @三站站长
python attendance.py --begin fetch  --end render       # 只拉数 + 出图，不发钉钉
python attendance.py --begin render --end send         # 用已有的 summary 重出图并发群
python attendance.py --no-at --test --group-name "钉钉机器人测试群"   # 试跑，发测试群不 @人
```

\---

## 2\. 界面：执行节点区块

任务在 `tasks.json` 里声明 `nodes`，卡片中部出现「执行节点」区块 ——
**一条横线上排着圆点，圆点下方是节点名，点圆点选两端**：

* 列出全部 4 个节点；**点第一个 = 开始，再点一个 = 结束**，两点之间即连续区间
* **只能挑两端**，跳选 / 不连续 / 多段在交互上根本点不出来（不是校验拦住，是点不出来）
* 点在起点之前 → 起点往前挪，继续等选结束；**点同一个圆点两次 = 只跑这一步**
* 默认 `fetch → send`（全选）；底部有「全选 / 清空」
* 还没选完：中性提示（不转红）+ 运行按钮禁用
* 区间非法（两端都空 / 结束早于开始）：整块转红 + 红字说明 + **运行按钮禁用**（点了也被拦下并 toast）
* 只跑区间内节点：选 `render → send` 就**不会重新拉数**

> 这份说明写于合并当天（2026-09-02）。同一天该能力已\*\*推广到全部任务\*\*，
> 且交互由「两个下拉」改成了上面的步进条。§2 的形态描述以 `DESIGN.md` §8.9 为准，
> 通用机制（nodeflow / sync\_nodes）见 §8.10。考勤这里的规则没有例外。

|状态|校验|提示|
|-|-|-|
|默认|合法|4 个节点全高亮，首节点绿标、末节点红标|
|`begin=render, end=send`|合法|只高亮后 3 个|
|`begin=send, end=fetch`|非法|「结束节点「fetch」不得早于开始节点「send」」|
|任一端清空|非法|「请选择开始节点与结束节点」|

### 数据结构变化（`tasks.json`）

* 新增 `nodes: \[{id, name, desc}]` —— 由根目录 `sync\_nodes.py` 从脚本源码的 `NODES` 同步过来
* params 里新增两个 select：`options\_source:"nodes"`、`options` 留空（前端按 `task.nodes` 派生）。
这两个 select 同样由 `sync\_nodes.py` 自动补，不用手写
* 删除原 `attendance\_fetch` / `attendance\_send` 两条任务；两个 preset 由「2 步」改「1 步」
* 任务总数 16 → 15

`server.py` **零改动**：`registry\_view()` 用 `dict(t)` 浅拷贝，`nodes` 自动下发到 `/api/state`；
`build\_cmd()` 对空值不拼命令行，前端"清空选择"与脚本 default 口径一致。

\---

## 3\. 已同步更新的文档

* `atlas/接口清单.md` §1.2 排班未上线骑手考勤、§5 脚本执行约定（节点区间）
* `task\_hub/DESIGN.md` —— §8.9「执行节点区块 `.nodes-block`（步进条 · 区间选择）」、
§8.10「节点能力的后端支撑：`nodeflow.py` + `sync\_nodes.py`」
* `task\_hub/README.md` —— 任务清单表（含每个任务的节点链）、页面结构 ASCII 图、
「执行节点区间选择」小节、`tasks.json` 字段说明
* 代码注释：`ding\_common.py` / `minio\_common.py` / `find\_group.py` 里对旧脚本名的引用已改为 `attendance.py`

