# 工作内容（提醒事项）模块 · 设计说明

数据从 localStorage 迁到 SQLite，新增重复规则、任务关联与定时自动执行。
库文件：`server/data/todo.db`（已在 .gitignore 中排除，含 WAL sidecar）。

---

## 1. 数据持久化

### 1.1 表结构

#### `todo_list` —— 列表（分组）
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `l_xxxx` |
| `name` | TEXT NOT NULL | |
| `icon` / `color` | TEXT | 图标名与主题色 |
| `sort_order` | INTEGER | 左栏排序 |
| `created_at` / `updated_at` | TEXT NOT NULL | 本地时间 `YYYY-MM-DDTHH:MM` |

#### `todo_item` —— 事项
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `i_xxxx` |
| `list_id` | TEXT NOT NULL | 所属列表 |
| `title` | TEXT NOT NULL | |
| `note` | TEXT | 备注 |
| **`status`** | TEXT NOT NULL | `open` / `done` |
| `done_at` | TEXT | 完成时间 |
| `done_count` | INTEGER | 重复事项累计完成次数 |
| `flag` | INTEGER | 标记重要 |
| `remind_at` | TEXT | **当前实例**的到期时间（重复项会滚动更新） |
| `repeat_type` | TEXT | `none`/`daily`/`weekly`/`monthly`/`custom` |
| `repeat_interval` | INTEGER | 每 N 天/周/月/小时 |
| `repeat_by` | TEXT | weekly: `1,3,5`（ISO 周一=1）；monthly: `15` 或 `L` |
| `repeat_end` | TEXT | 重复截止日，空 = 不限 |
| `task_id` | TEXT | 关联的任务中心任务 id（可空） |
| `task_args` | TEXT | 执行参数 JSON，默认 `{}` |
| `auto_run` | INTEGER | 到点自动执行开关 |
| `last_run_at` / `last_run_status` | TEXT | 最近一次执行情况 |
| `created_at` / `updated_at` | TEXT NOT NULL | |

#### `todo_run` —— 执行记录
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增 |
| `item_id` | TEXT NOT NULL | |
| **`fire_key`** | TEXT NOT NULL **UNIQUE** | `<item_id>#<到期时间>` —— 幂等的最后一道防线 |
| `due_at` | TEXT NOT NULL | 计划触发时间（手动触发为 `manual:<分钟>`） |
| `started_at` / `finished_at` | TEXT | |
| `status` | TEXT NOT NULL | `running`/`retrying`/`success`/`failed`/`skipped`/`missed` |
| `attempt` | INTEGER | 第几次尝试，1 起 |
| `retry_at` | TEXT | `retrying` 状态下的下次重试时刻 |
| `run_id` | TEXT | RunManager 的运行 id |
| `message` | TEXT | 结果说明 |

### 1.2 索引设计

| 索引 | 语句 | 为什么 |
|---|---|---|
| `idx_item_list_status` | `(list_id, status)` | 左栏点列表时的主查询路径：`WHERE list_id=? AND status='open'` |
| `idx_item_due` | `(remind_at)` **部分索引** `WHERE auto_run=1 AND status='open'` | 调度器每 5 秒扫一次。部分索引让这个索引只装「真正会调度」的那几行，事项再多扫描也几乎不增长 |
| `idx_item_remind` | `(remind_at)` | 「计划」视图按提醒时间排序 |
| `idx_run_item` | `(item_id, due_at DESC)` | 详情页的执行记录面板 |
| `idx_run_open` | `(status)` 部分索引 `WHERE status IN ('running','retrying')` | 调度器每 tick 轮询未结束的执行，同理只装极少数行 |
| `todo_run.fire_key` | UNIQUE | 去重，见 §5 |

> 刻意**没有**建的：`title` 的模糊索引（数据量小，扫表更快）、`task_id` 的索引（反查极少，且注册表在内存）。

### 1.3 迁移方式

版本号存在 SQLite 自带的 `PRAGMA user_version` 头里，不额外建元数据表。
`todo_store.MIGRATIONS` 是有序的 `(目标版本, [SQL 语句])` 列表：

```python
MIGRATIONS = [
    (1, [ "CREATE TABLE IF NOT EXISTS todo_list (...)", ... ]),
    # 发新版时只往这里追加，不要改已发布的步骤：
    # (2, ["ALTER TABLE todo_item ADD COLUMN foo TEXT"]),
]
```

启动流程（`init_db()`）：读出当前版本 → 把大于它的步骤按序执行，每步一个事务，
执行完立刻写回版本号，失败整体回滚。

- **全新库** `user_version=0` → 从 v1 跑到底，天然等价于建表，不用维护两份 DDL；
- **老库**只跑增量步骤，且每步都写成幂等的 `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN`；
- 排查用：`python -m server.todo_store` 打印版本、表、索引与条数。

### 1.4 连接与并发

`ThreadingHTTPServer` 是多线程的，所以连接按**线程本地化**（`threading.local`），
每个线程一把自己的 `sqlite3` 连接；进程内写操作再用一把 `RLock` 串行；
跨进程由 WAL + `busy_timeout=15s` 兜底。三重保险，任一层都不会把库写坏。

时间统一本地字符串 `YYYY-MM-DDTHH:MM` —— 定长格式可直接用字符串比较排序，
索引能生效，也方便人肉查库。

---

## 2. 重复规则

### 2.1 存储格式

不存 RRULE 字符串，拆成四个离散字段（可读、可索引、可在 SQL 里直接看）：

| type | interval | by | 语义 |
|---|---|---|---|
| `none` | 1 | — | 不重复 |
| `daily` | N | — | 每 N 天 |
| `weekly` | N | `1,3,5` | 每 N 周的周三、周五（ISO 周一=1） |
| `monthly` | N | `15` 或 `L` | 每 N 个月的 15 日 / 最后一天 |
| `custom` | N | — | 每 N 小时（从提醒时间起算） |

`repeat_end` 是可选的截止日。所有写入都过 `normalize_rule()`：越界值收敛到合法范围
（interval<1→1、月份日期>31→31、星期去重升序），**不让脏数据进库**——否则算下一次时间时会出怪值。

### 2.2 实例如何生成：**不预生成**

事项在库里永远只有**一条**记录（模板 + 当前 `remind_at`），触发或完成后用
`compute_next_due()` 滚出下一次并写回。

对比「预生成未来 N 条实例」的方案：不会随时间爆炸、改规则不用批量改实例、
也不会留下与当前规则不符的脏数据。代价是查不到「未来第 5 次是哪天」——当前业务不需要。

滚动时机：

- **勾选完成**：重复项不进「已完成」，而是 `done_count +1`、`remind_at` 前移到下一次、
  `status` 保持 `open`（跟 iPad 提醒事项一致：勾掉后又出现一条新的）；一次性项才置 `done`。
- **自动执行结束**：成功/用尽重试次数后，重复项滚到下一次；一次性项成功即置 `done`，失败保持 `open`。

计算要点：`compute_next_due(rule, anchor, now)` 以首次提醒时间为**相位锚点**
（决定每周几、每月几号、每天的时分），返回严格晚于 `now` 的时刻。
每月 31 日在 2 月自动回退到 28/29 日；每周按「周起点对齐」判断周间隔，
避免用日期差算周数时被跨年/跨月带偏。

---

## 3. 任务关联

- 关联关系存在 `todo_item.task_id`，**不建外键** —— 任务在 `tasks.json` 里，不是数据库的表，
  加外键约束只会让删任务时误伤待办。有效性在运行时判定。
- **取消关联**：`POST /api/todo/items {op:"unlink"}`，或在编辑弹窗把任务选回「不关联」。
  只解绑，顺带关掉 `auto_run`、清空执行参数，**事项本身保留**。
- **任务被删除 / 被禁用时**：
  - 判定由 `RunManager.link_state(task_id)` 给出 `ok` / `missing`（注册表里没了）/
    `disabled`（标了 hidden 或 disabled）；
  - 到期时若非 `ok` → 写一条 `skipped` 执行记录（占位，防止每 tick 重试）并广播提示，
    **不自动解绑、不删事项**；
  - 前端在编辑弹窗与列表行显示告警徽标（「任务已不存在」），由用户决定改关联还是删掉。

> 取舍：待办是用户自己的数据，不因为外部注册表变化而被动销毁。自动解绑看似聪明，
> 实际上会在「误删任务→重启→关联全没了」这种场景下造成不可逆丢失。

---

## 4. 定时自动执行

调度器 `todo_sched.TodoScheduler` 是一个后台线程，每 5 秒扫一次
（提醒精度是分钟，5 秒足够且不空转），到期项丢进 RunManager 的串行队列执行。

**为什么不用 apscheduler**：需要的是「同一事项同一时刻只触发一次」这种与业务数据强耦合的
幂等语义，内存态的 job store 做不到——进程一重启 job 就没了，而我们的去重落在数据库的
UNIQUE 约束上。

### 4.1 边界情况

| 场景 | 处理 |
|---|---|
| **应用重启，有待执行项** | 启动时先把上次遗留的 `running` 记录收尾：还在补跑宽限期内 → 转成重试让它自然补上；超过宽限期 → 判失败并推进。压根没触发过的到期项按同样的宽限期规则处理 |
| **补跑宽限期** | `CATCHUP_GRACE_SEC = 15 分钟`。到期距现在 15 分钟内 → 正常补跑（重启、机器睡醒等短暂无服务）；超过 → 记 `missed` 跳过。**宁可漏一次，也不要在周一早上重启时把上周五到现在的活儿全倒出来** |
| **执行失败** | 最多 3 次（1 次正式 + 2 次重试），退避 60s / 300s。重试复用同一条记录、`attempt` 递增，**不新开 fire_key**，否则「同一时刻只触发一次」会被重试本身破坏。3 次都不成 → 判失败并推进到下一周期，不让一个坏任务堵死后续 |
| **手动终止** | 判失败但**不再重试**（尊重用户意图） |
| **关联任务失效** | 见 §3，写 `skipped` 占位 |
| **任务执行超时/卡死** | RunManager 侧有 timeout 兜底，结束后按失败流程处理 |

### 4.2 状态流转

```
到期 → [宽限内] claim → running ──成功──→ success → 推进（重复项滚到下一次 / 一次性项置 done）
                          │
                          ├─失败 & attempt<3─→ retrying ──到点──→ running(attempt+1)
                          └─失败 & attempt=3─→ failed → 推进
      [超宽限] → missed → 推进
      [任务失效] → skipped → 推进
```

---

## 5. 并发与幂等

**同一工作内容在同一时间点不会被重复触发**，靠三层：

1. **数据库（唯一保证）**：`todo_run.fire_key = <item_id>#<到期时间>` 带 UNIQUE 约束。
   并发插入只有一个能成功，另一个拿 `IntegrityError` 安静放弃。
   代码层的检查只是降低冲突概率，真正的互斥由这个约束保证。
2. **逻辑层**：`fire_key` 已存在 ⇒ 本轮处理过了，直接跳过。
3. **内存层**：`open_run_of(item_id)` —— 同一事项还有 `running`/`retrying` 的执行时直接跳过。
   这一层同时保证了**手动操作与调度互不冲突**：手动点「立即执行」时若已有执行在飞，
   返回「上一次执行还没结束，稍等再试」。

**手动触发不吃掉定时触发**：手动用的 `fire_key` 到期值是 `manual:<YYYY-MM-DDTHH:MM>`，
与定时触发的键天然不同；同时它又能挡住同一分钟内的连点。

**为什么调度器不用 SSE 监听执行结果**：SSE 的订阅队列满了会丢事件，一丢执行记录就永远卡在
`running`。所以改成**拉模式**——每 tick 用 `RunManager.run_status(run_id)` 轮询，
笨但不会因为背压把状态弄丢。

---

## 6. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/todo` | 全量数据（列表 + 事项 + 调度器状态），事项带 `linkState` / `repeatLabel` / `hasOpenRun` |
| GET | `/api/todo/runs?item_id=&limit=` | 某个事项的执行记录 |
| POST | `/api/todo/lists` | `op: create / update / delete` |
| POST | `/api/todo/items` | `op: create / update / toggle / delete / unlink` |
| POST | `/api/todo/trigger` | 手动立即执行 |
| POST | `/api/todo/import` | 迁移 localStorage 旧数据（前端仅在库为空时调用） |

字段命名：**库里蛇形、前端驼峰**，只在 `api_item()` 这个边界上转一次。

---

## 7. 测试

```
python server/test_todo.py     # 40 项：迁移 / 重复 / 调度 / 重启恢复 / 重试 / 去重 / 关联
```

覆盖的关键断言：同一到期时刻只能 claim 一次（IntegrityError）、超宽限记 missed 不补跑、
重试 3 次后放弃、手动终止不再重试、重启恢复补跑 vs 判失败、手动触发不占用定时档期、
关联任务失效只跳过不自动解绑。

前端另有一套 jsdom 冒烟（30 项），重点验证新控件真的挂进了 DOM——之前踩过
`select` 忘 `appendChild`、看着没问题但界面上一个控件都没有的坑。
