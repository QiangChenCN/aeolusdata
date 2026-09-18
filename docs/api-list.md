# 风神数据处理 — 接口清单（已接入 / 已验证）

> 维护说明：本文件盘点当前工作区所有**已落地、跑通**的数据接口。所有接口均**纯 HTTP**，
> cookie 统一由 `aeolus_sdk.login.ensure_cookies()` 获取（工作区自带，无需 CDP / 接管浏览器）。
> 最后整理：2026-09-02（新增 §5 脚本节点执行约定）
> 注：所有接口**运行时一律纯 HTTP**；新接口的**发现**阶段可用 CDP 嗅探（见 1.5），嗅探到后落库为纯 HTTP 脚本。

---

## 0. 统一登录（所有业务接口的前置）

所有业务接口都需要在请求头带 `Cookie: <AEOLUS_MOZI_TOKEN…>`，由 `aeolus_sdk/login.py` 提供。

| 步骤 | 接口 | 方法 | 说明 |
|---|---|---|---|
| 取公钥 | `GET https://mozi-login.alibaba-inc.com/?APP_NAME=LOGISTICS_COMPANY&BACK_URL=…&moziAppType=LOGISTICS_COMPANY` | GET | 解析 `rsaPublicKey` / `_sso_csrftoken_` / `umidTokenId` |
| 登录 | `POST https://mozi-login.alibaba-inc.com/rpc/login/doLogin.json` | POST | 账密经 Dave Koelle RSA 加密后表单提交；返回 302 redirect |
| 票据交接 | `GET <doLogin 返回的 redirectURL>`（ssoLogin.htm） | GET | 同会话完成 SSO 票据交接 |
| 拿 Token | `GET https://aeolus.ele.me?_tplCode=…` | GET | 写入 `AEOLUS_MOZI_TOKEN` |
| 登录态校验 | `GET https://httpizza.ele.me/lpd.meepo.session/aeolus/validToken` | GET | 生效 → HTTP 200；失效/被顶号 → HTTP 401（看状态码即可，无副作用） |

**对外函数**：`ensure_cookies()`（优先复用本地 `aeolus_sdk/cookie.txt`，失效才登录并落盘）、`get_cookies()`（强制登录）、`check_login()`（validToken 探测）、`get_shared_cookies()` / `refresh_shared_cookies()`（进程内带锁共享，抗 SSO 顶号）。

**⚠️ 关键坑**：风神是单点登录，浏览器活跃会把脚本会话顶掉，刚拿到的 token 可能几秒失效。最稳用法：现登现用，或浏览器空闲时再跑。

---

## 1. 风神 xtop 业务接口（`https://httpizza.ele.me/xtop/...`）

请求体通用结构：`{"params": {"request": { ... }}}`；时间字段为**毫秒时间戳**。
`result.code` 是**字符串**（如 `"200"`），需 `str(code)=="200"` 判断；`result` 可能为 `null`（被顶号）。

### 1.1 违规处罚申诉提醒
- **脚本**：`appeal_reminder.py`
- **接口**：`POST /xtop/xtop.lpd.quality.control.violation.violationOrderAeolusCenterApi.download/1.0`
- **请求体**：`{"params":{"request":{"violationStartTime":<ms>, "violationEndTime":<ms>}}}`（当天北京时间 00:00:00 ~ 23:59:59.999）
- **返回**：`result.data.fileUrl` —— 风神 OSS 签名 CSV 下载链接（下载无需 cookie，GBK 编码）
- **筛选**：CSV 中 `违规分类 != "超时"` 且 `申诉状态 == "待申诉"`（9 列明细）
- **发送**：图片 + 链接 + 按站点 @站长（钉钉 dws CLI）

### 1.1b 站点（团队）列表 —— `getTeamsAll`（2026-09-08 逆向接入）
- **来源**：`r.ele.me/pikipek/schedule.html`（排班页）加载的 JS bundle 里扫到的接口名
  （猜名字全部 404，最后靠 **下载页面 JS + 正则扫 `xtop.xxx/1.0`** 找到；方法见文末「逆向方法」）
- **接口**：`POST /xtop/xtop.lpd.intelligentConfig.getTeamsAll/1.0`
- **请求体**：`{}`（空 body 即可，`params`/`metas` 都不要也返回全量）
- **请求头**：`origin/referer` 用 `https://r.ele.me`（排班页），cookie 用 `ensure_cookies()`
- **返回**：`result.data` 数组，字段用 **下划线命名**（与其它接口的驼峰不同）：
  `id`（=teamId）、`team_name`、`city_id`、`teamStatus`（1=有效）、`delivery_mode`
  （1=UB 站点、2=店配，如瑞幸店配）、`tenant_id`、`org_id`、`online_time`/`offline_time` 等 28 个字段
- **实测**：当前账号可见 **9 个站点** —— 4 个 UB 站（黄江镇/长安万科/大岭山大学城/大岭山镇大片美）
  + 5 个瑞幸店配。其中「大岭山镇大片美站」是原写死清单里**没有**的
- **用法**：`jobs/attendance/attendance.py` 的 `fetch_teams()`，取代写死的 `TEAMS`；
  瑞幸店配在考勤场景排班恒为 0（店配不走站点排班），但按既有约定仍保留在列表里
- **调用时机（2026-09-08 定论，重要）**：**只在界面展开「选择站点」多选下拉时拉一次**
  （前端 `ensureTeams()` → 后端 `/api/teams`，5 分钟 TTL 缓存，拉过就不再打第二次）。
  **跑任务时完全不调这个接口**——站点清单走 `--teams`（`id=名称`）或
  `last_teams.txt`（上次选择），避免每次出数多一个网络往返
  （实测：单次 fetch 从 11 次请求降到 10 次，`getTeamsAll` 为 0 次）
- **诊断脚本**：`tools/probe_teams.py`（打印接口返回的站点清单，接口变了可复验）

### 1.2 排班未上线骑手考勤（实时在线）
- **脚本**：`attendance.py`（单一入口，4 节点流水线；2026-09-02 起取代原 `attendance_all_teams.py` + `send_attendance.py`）
  - 节点：`fetch` 拉取 → `render` 出图 → `upload` 上传 MinIO → `send` 发钉钉
  - 区间选择：`--begin <节点> --end <节点>`（连续区间，默认 `fetch`→`send` 全跑；`end` 早于 `begin` 直接报错退出）
  - 例：`python attendance.py`（全跑）/ `python attendance.py --begin render --end upload`（只重出图并上传）
- **接口**：`POST /xtop/xtop.fs.special.realtimeattendance.listAttendance/1.0`
- **请求体**：`{"params":{"request":{"teamId":<站点ID>, "timeCode":"<时段码>", "shiftedOffline":0}}}`
  - **站点 ID 不再写死**，优先级：`--teams`（界面勾选 / 命令行）> 上次选择 > 内置 3 站兜底清单。
    - 界面勾选：`--teams` 传的是 `id=名称,id=名称`，名称随值一起带下来；
    - 不带 `--teams`：沿用 `jobs/attendance/out/last_teams.txt`（上次实际用过的站点），
      文件不存在才回落兜底清单（917521130/917521136/917521139），日志会打 ⚠ 提示。
  - 时段码：100 凌晨 / 111 早餐1 / 112 早餐2 / 120 午高峰 / 130 下午茶1 / 131 下午茶2 / 140 晚高峰 / 150 夜宵1 / 151 夜宵2
- **返回**：`result.data`（骑手数组，每人含 `timeCode[]`、`workStatus`{1上班/2小休/3下线/5部分在线}、`deliveryOrder`、`timeValidOnlineTime`、`fullDayValidOnlineTime`…）
- **判定**：在线=workStatus∉{2,3}；不在线明细=workStatus∈{2,3}
- **发送**：`attendance_absent.png` + `attendance_summary.json` → 钉钉（内联图 + @站长）

### 1.2b 排班目标（排班统计）—— `listScheduleStatistics`（2026-09-09 逆向接入）
- **来源**：`r.ele.me/pikipek/schedule.html`（排班页）的接口，由用户提供 curl 确认命中（=「标准达成」所需的排班目标数据源）
- **接口**：`POST /xtop/xtop.fs.special.schedule.listScheduleStatistics/1.0`
- **请求体**：`{"params":{"request":{"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","teamId":<int>}}}`
  - 单站、按周区间查询（如 09-07~09-13）；跨多站需逐站循环
- **请求头**：`origin/referer` 用 `https://r.ele.me`（排班页），cookie 用 `ensure_cookies()`
- **返回**：`result.data` 数组，长度为天数；每一天 = `teamId` / `shiftDate` / `teamKnightNum`（站内骑手总数）/ `timeCarrierPlanReady` / `timeList[]`
  - `timeList[]` 每时段字段：`timeCode` / `timeName`（休息·凌晨1·早餐1·早餐2·午高峰·下午茶1·下午茶2·晚高峰·夜宵1·夜宵2·全天）/ `startTime` / `endTime` / `actualNum`（实际排班人数）/ `predictNum`（预测人数）/ `predictOrder`（预测单量=排班目标单量基线）/ `actualOrder`（实际单量，常为空）/ `shiftTrackingCnt`
- **字段语义（对「标准达成」）**：
  - 排班达成 = `actualNum / predictNum`（本接口已可算）
  - 单量达成 = 实际完成单量 / `predictOrder`（实际完成单量需从运单明细 `get_data/delivery.py` 按站点×时段聚合补齐，`actualOrder` 本接口通常空）
- **封装**：取数低层 `query` / `build_body` / `AuthError` 已迁到 `get_data/schedule_statistics.py`（单一来源，与 violation/board/rush 等同款）；`dashboard/standard/schedule_statistics.py` 只保留 `Session`（自动重登）/ `fetch`（高层）/ `flatten`（展平）；`__all__` 导出 `AuthError`/`build_body`/`query`/`Session`/`fetch`/`flatten`（前三者转自 get_data）
- **用法**：`from dashboard.standard.schedule_statistics import fetch, flatten`；`fetch(team_id, start, end)` 得按天 rows，`flatten(rows)` 展平为「站×日期×时段」一行一条
- **样本**：`dashboard/standard/schedule_statistics_sample_917521136.csv`（长安万科站本周，78 行）

### 1.2c 骑手排班明细 —— `listSchedule`（2026-09-09 验证，非标准达成）
- **来源**：`r.ele.me/pikipek/schedule.html`（排班页）接口，用户提供 curl 验证（= 按骑手粒度的排班计划明细）
- **接口**：`POST /xtop/xtop.fs.special.schedule.listSchedule/1.0`
- **请求体**：`{"params":{"request":{"teamId":<int>,"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","knightMobile":[]}}}`
  - 单站 + 骑手手机号筛选（空数组 `[]` = 全部骑手）；按周区间查询（如 09-07~09-13）
- **请求头**：`origin/referer` 用 `https://r.ele.me`（排班页），cookie 用 `ensure_cookies()`
- **返回**：`result.data[]` 数组，每一元素 = 一个骑手：
  - `knightId` / `deliveryName`（骑手名）
  - `shiftDetailList[]`：按天（`shiftDate`）列出当天班次
    - `status`：`4`=未排/休息（`typeDetailList` 为空）；`2`=已排（含时段明细）
    - `typeDetailList[]`：当天各时段班次，含 `shiftTypeName`（午高峰/下午茶1/下午茶2/晚高峰）、`startTime`/`endTime`、以及要求值 vs 实际值——`requiredDuration`/`actualDuration`（时长）、`requiredFinishedOrder`/`finishedOrderCount`（单量）、`effectiveType`
- **与 1.2b 的区别**：本接口是**按骑手明细**（谁、哪天、排了哪些班次、要求/实际时长单量）；1.2b 是**按站×日期×时段聚合统计**（实际排班人数/预测人数/预测单量）。二者同源互补，粒度不同。
- **用途**：**不是「标准达成」数据源**（用户 2026-09-09 确认标准达成用 1.2b 的 `listScheduleStatistics`）。本接口作为「骑手级排班明细」备案，**后续可能用于骑手维度排班核对 / 到人明细**，暂未封装为模块（需要时按 `dashboard/standard/schedule_statistics.py` 同风格在 `dashboard/standard/` 下补 `schedule.py` 即可）。
- **样本**：`dashboard/standard/schedule_sample_917521139.csv`（大岭山大学城站本周 63 骑手 × 班次时段，含要求/实际时长单量，442 行）

### 1.3 运单数据（aeolus 后台「运单数据」页）
- **脚本**：`download_delivery.py`（新落地，2026-08-24）
- **接口**：`POST /xtop/xtop.agencyTrackingFs.queryTracking/2.0`
- **请求体**：时间字段**平铺**在 `request` 内（切勿套 `condition`，会走错校验分支）：
  `{"params":{"request":{"trackingFinishStart":<ms>, "trackingFinishEnd":<ms>, "merchantConsumerDistanceStart":"0", "merchantConsumerDistanceEnd":"999999", "payAmountStart":"0","payAmountEnd":"999999","weightStart":"0","weightEnd":"999999", "current":1, "pageSize":50, "trackingStateKey":"all", "trackingLabelKey":"all", "trackingFinishTimePeriodList":["0-86400"]}}}`
- **约束**（2026-08-24 实测，全部踩过）：
  1. `pageSize ≤ 50`（>50 报 `PAGE_SIZE_OVER_RANGE`）
  2. **查询开始时间不能早于 60 天前** —— 窗口每天右移，**过期数据永久不可回溯**，要历史数据必须尽早拉
  3. **单次查询跨度 ≤ 7 天**（超出报「请一次性查询不要超过7天的跨度」）→ 按天查最稳
  4. **页码上限 `current*pageSize < 10000`**（超出报 `PAGE_INDEX_OVER_RANGE`）→ 单日 >9000 单需按 `trackingFinishTimePeriodList` 时段切片（实测 4 段可用：`0-21600`/`21600-43200`/`43200-64800`/`64800-86400`，单位=当日秒偏移）
  5. 限流较严：页间需 ~1s 延迟，命中 `REQUEST_TOO_FREQUENT`/「请求太频繁」需退避重试
- **数据特征**：`result.data.data` 为运单数组（**99 字段**），`result.data.total` 为总量；日均 ~7.4k~9.7k 单；`trackingId` 偶有重复但为**整行完全相同**（分页抖动），可作主键 + upsert 去重；8 个字段原始类型是 list/dict（`weatherCode`、`cancelDuty`、3 个 `*PredictDeliveryRange`、3 个 `*ReasonIds`），CSV 看不出、入库需存 JSON 字符串
- **字段中文化**：`delivery_columns.py`（99 字段映射单一来源）
- **产物**：
  - CSV：`download_delivery.py` → `aeolus_delivery_<date>_<date>.csv`（UTF-8-BOM，Excel 直接可开）
  - 入库：`fetch_delivery_raw.py`（落 `delivery_raw/<date>.jsonl` 原始层，断点续传/超量自动时段切片）→ `load_delivery_db.py` → PostgreSQL `ods_delivery_tracking`（DDL 单一来源 `jobs/delivery/db_schema.py` 的 `gen_pg_ddl()`，运行期直接生成，无外部 .sql 导出件；旧的 MySQL `sql/ods_delivery_tracking.sql` 已删除）

### 1.4 商站任务看板
- **脚本**：`task_board.py`（合并了原 `fetch_tasks.py` + `send_task_board.py`）
- **接口**：`POST /xtop/xtop.ryze.fs.agency.team.task.listByPage/1.0`
- **请求体**：`{"params":{"queryVO":{"pageSize":100, "pageIndex":<n>}}}`
- **返回**：`result.data.data`（任务数组，`status`="已开始"/…、`taskName`、`taskObject`、`taskExpireTime`、`executorName`、`priority`）
- **筛选**：`status == "已开始"`，按 `taskExpireTime` 计算剩余时间
- **发送**：`task_started.png` → 钉钉（生产 + 测试群）
- **节点链**（统一入口按区间跑）：`fetch` → `filter` → `render` → `resolve` → `send`，详见 DESIGN.md §8.9

### 1.5 骑士规则中心 — 规则详情（CDP 嗅探发现，2026-08-25）
- **前端**：`https://aero-rush.ele.me/knight-rule-center/index.html#/rule-details?rule=<id>&isHistory=<bool>&platform=aeolus`
- **脚本**：`gen_rule_doc.py`（CDP 嗅探 `cdp_probe_knight_rule.py` + 整理/生成一体）
- **接口**：`POST /xtop/xtop.robot.admin.ruleInfoViewFs.queryRuleInfo/1.0`
- **请求体**：`{"params":{"request":{"isHistory":<bool>,"id":<ruleId:int>}}}`
  - `id` = URL 中 `rule=` 参数；`isHistory` = URL 中 `isHistory` 参数（查历史版本）
- **返回**：`result.data`（核心字段见下）；`result.code` 为**数字 200**（注意：与 1.1~1.4 的**字符串** `"200"` 不同，此处是 int）
- **核心字段**：
  - `ruleName` / `ruleSerialId`（如 `JSWL-ST-00121`）/ `ruleVesion`（如 `4.0`）
  - `isPublish` / `publishDays` / `publishStartTime` / `publishEndTime`
  - `publishContent` → Slate 富文本（**JSON 字符串，需再 `json.loads`**）：公示公告语
  - `ruleContent` → Slate 富文本（**JSON 字符串**）：规则正文（块类型 `h1` 章 / `h3` 条 / `h4` 款 / `p` 段落）
  - `ruleContentMd` → Markdown 正文（多数规则为 `null`，回退渲染 `ruleContent`）
- **请求头**：`content-type: application/json` + `referer: https://aero-rush.ele.me/knight-rule-center/index.html` + `origin: https://aero-rush.ele.me`（CORS 预检通过，纯 HTTP 带 cookie 即可）
- **产物**：`rule_doc_<id>.html`（淘宝闪购橙 #FF5000 主题，章/条/款层级渲染）+ `rule_doc_<id>.md`
- **Slate→HTML/MD 渲染**：`gen_rule_doc.py` 内置 `slate_to_html` / `slate_to_md`（块级 h1/h2/h3/h4/p/ul/ol/li/table，行内 `bold`）

---

## 2. 调度台 dispatcher 接口（运单查询）

页面在 `dispatcher.ele.me`，但 API 同样落在 `https://httpizza.ele.me/xtop/...`。
请求体结构：`{"metas":{"teamid":<站点ID>}, "params":{ ... }}`，带 `x-user-id`/`x-shard`/`x-city-id` 头。
站点：917521130=黄江、917521136=万科、917521139=大岭山大学城；`userId=13053485`，`cityId=51`。

### 2.1 在途运单分页（拉 trackingId）
- **脚本**：`fetch_jidan.py`
- **接口**：`POST /xtop/xtop.lpdcs.skyeye.shippingorder.paging/1.0`
- **请求体**：`{"metas":{"teamid":tid}, "params":{"request":{"teamId":tid, "userId":13053485, "status":[10|20|30], "pageIndex":n, "pageSize":200, "shippingOrderSort":"exceptionTime", "knightIdList":[], "retailerIdList":[], "shopTeam":False}}}`
  - `status`：10 待接单 / 20 待到店 / 30 待送达 / 40 已完成 / 80 已取消 / 90 异常；paging **不接受多状态**，需逐状态循环
- **返回**：`result.data.shippingOrderInfoList`（仅含 trackingId）、`result.data.total`

### 2.2 运单批量概要
- **脚本**：`fetch_jidan.py`
- **接口**：`POST /xtop/xtop.lpd.matrix.intervention.shippingOrderQuery.getShippingOrderList/1.0`
- **请求体**：`{"metas":{"teamid":tid}, "params":{"request":{"teamId":tid, "trackingIds":[…最多80], "cityId":51, "shopTeam":False}}}`
- **返回**：`result.data.shippingOrderInfoList`，含 `isRushOrder`、`rushOrderDefineTypes`、`rushOrderHighestPriority`、`state`、`mname`、`maddress`、`name`、`knightPhone`、`caddress` 等

### 2.3 运单完整详情（97 字段）
- **脚本**：`fetch_jidan.py`
- **接口**：`POST /xtop/xtop.lpd.matrix.intervention.shippingOrderQuery.getOrderDetail/1.0`
- **请求体**：`{"metas":{"teamid":tid}, "params":{"teamId":tid, "trackingId":"<str>"}}`
- **返回**：单条 97 字段（商家/顾客/骑手/时间/异常/商品 `itemList`/轨迹 `eventList`/异常报备 `reportAbnormalEventList`）

> 急单定义：`isRushOrder===true` 且 `state∈{10,20,30}`（在途可处理）。

---

## 3. Quark 报表（骑手装备点亮数据）

独立于风神 xtop 体系，走 Quark + 内部 kunkka 报表网关。含一套独立鉴权链路（已纯 HTTP 闭环，但 DA 兑换依赖 `curl` 的中性 TLS 指纹，urllib 会被网关按指纹拒 403）。

> **调用方**（2026-09-03 起统一）：取数 / 凭证 / 解析全在 `quark_sdk/quark.py`，上层 `task_equipment.py` 的 fetch 节点只剩一行 `quark_sdk.quark.fetch_report_view(base=BASE, ...)`。新报表任务直接复用 SDK，不必再各写一套 getReport / DA 兑换 / WidgetAction。

| 接口 | 方法 | 脚本 | 说明 |
|---|---|---|---|
| `GET https://app2-edu.ele.me/kunkka-svr/fs/fbi/getReport?reportId=860325` | GET（带 AEOLUS_MOZI_TOKEN） | `quark_sdk/da_auth.py` / `quark_sdk/creds.py` | 返回带 `QUARK_PARAMS` 的 iframe URL（Aeolus 下发给 Quark 的签名票据） |
| `GET https://quark.alibaba.com/fbi/fbi.json?action=site/FbiSiteAction&event_submit_doGetSite=true` | GET（带 DA cookie） | `quark_sdk/creds.py` | ✅ **DA cookie 健康探针**（2026-09-03 选定）。有效 → JSON（`code:510 "site is null"`，510 只是本场景无 site 的业务码）；失效 → HTML 登录页。只读、无参数、响应 188 B、约 0.3s |
| `POST https://quark.alibaba.com/fbi/.json?action=report/WidgetAction&event_submit_doGetWidgetData=true&componentName=fbi-common-table&_widgetId=mmds9k0ty_f1vr3j&_ts_=mszj2wz8` | POST（form: `params=<json>`） | `get_data/rider_equipment.py` | ✅ 取数主接口，返回 `data.value.columns`（官方中文列名）+ `data.value.values`（二维表），约 184 行 |
| `GET https://quark.alibaba.com/common/ClipAction/doQueryClipConfig?region=cn` | GET（带不带 cookie 都一样） | — | ❌ 反例，**勿再当探针**：`/common/**` 不鉴权，空 cookie 也 `code:0`。它是 FBI 报表页拉编辑器配置的业务接口 |

**DA_TOKEN 兑换链路**（全 HTTP，见 `quark_sdk.da_auth.acquire_da_token`）：
Aeolus 登录 → `getReport` 拿票据 → `curl` 访问 `report.htm?QUARK_PARAMS=…`（→302 daLogin）→ `daLogin.htm?DA_SESSION=…`（带 AEOLUS token，跟随 302 回 quark 种下 `DA_TOKEN_lpd_meepo_ws`）→ 带 DA cookie 打 WidgetAction 取数。

**DA cookie 缓存（2026-09-03 加）**：`DA_TOKEN` 是有有效期的普通 cookie，没必要每次跑数都重兑一遍（兑换一次要 3 次网络往返）。`quark_sdk/quark.py` 增加了缓存层 `ensure_da_cookie()`：缓存文件 `quark_sdk/quark_da_cache.json`（原子写，已入 `.gitignore`），命中缓存 → `probe_da_health()` 探活 → 通过即复用，失效才重兑。Quark 系凭据（`quark_cookie.txt` / `quark_da_cookies.txt` / `quark_da_cache.json`）统一收口在 `quark_sdk/` 包内，路径不再依赖调用方传入的 `base`。

**探活端点怎么选出来的（2026-09-03，两轮修正，结论重要）**：

**核心规律：DA 网关只保护 `/fbi/**` 路径，`/common/**` 不鉴权。** 这是从 FBI 前端 `report.js`（`g.alicdn.com/dt/fbi/3.7.729/fbi/report.js`，6 MB）里挖出 54 个 action 后逐个做三组对照实验（真 / 伪造 / 空 cookie）得出的：

| 候选端点 | 路径 | 真 cookie | 伪造/空 cookie | 鉴别力 |
|---|---|---|---|---|
| `common/ClipAction/doQueryClipConfig`（旧用） | `/common/**` | `code:0` | `code:0`（**完全一样**） | ❌ 恒真 |
| `report.htm` 不带 `QUARK_PARAMS` | — | `code:400 token为空` | 同左 | ❌ 缺的是 URL 票据 |
| `IndexAction&doUserProfile`（名字最像"取当前用户"） | `/fbi/**` | JSON | HTML 登录页 | ✅ 但实际是前端告警上报接口，语义不符 |
| **`site/FbiSiteAction&doGetSite`**（**最终选用**） | `/fbi/**` | JSON `code:510` | HTML 登录页 | ✅ 只读、无参数、188 B |

判据刻意**只看"是否被踢回 HTML 登录页"**，不看 `code` 值——`code:510` 只是"这个 embed 场景没有 site"的业务码，业务码会随环境变，"是否被踢回登录页"才稳定。

**实测收益**：缓存被污染（写入假 cookie）时，探活能**当场拦下**而不用等取数失败 —— 自愈耗时从 `attempts=2 / 16.42s` 降到 **`attempts=1 / 7.99s`**（省掉 5s 退避 + 一次失败取数 + 一次强制重登）。缓存有效时 `attempts=1 / 3.7s`。取数阶段的兜底（WidgetAction 也返回 HTML → 清缓存 → 强制重兑）依然保留，双保险。手动排查：`python -m quark_sdk.quark`（看缓存 + 探活）／`--clear`（清缓存）／`--full`（跑完整取数自检）。

**坑（已修复）**：`reportIdToken`/`secureParams`/`metaTime` 原本是浏览器复制的静态签名值，换时间/换报表需手动从 Network 重拷。2026-08-24 逆向 `report.js` 确认三者均来自报表页 `window.PageInfo`（`auth.reportIdToken` / `secParam` / `gmtModified`），现由 `task_equipment.auto_fetch_tokens()` **全自动提取**（getReport → 带 QUARK_PARAMS 抓报表页 → 正则抠 PageInfo），无需任何手动复制、无需 CDP。仍可用 `--token`/`--secure`/`--meta-time` 强制覆盖（排查用）。

---

## 4. 已观测但未接入的 dispatcher 接口（`dispatcher_capture.json`）

以下接口在浏览器抓包中出现、功能明确，但当前脚本未调用，留作扩展储备：

- `xtop.lpdcs.skyeye.teams/1.0` / `txdteam/1.0` —— 团队/站点列表
- `xtop.lpdcs.skyeye.team.getTeamBusinessDistrictInfo/1.0` —— 团队商圈信息
- `xtop.lpdcs.skyeye.shippingorder.count/1.0` / `polling/1.0` —— 在途单计数 / 轮询
- `xtop.lpdcs.skyeye.knight.completecount/1.0` / `applylist/1.0` / `maplist/1.0` / `entrytimelist/1.0` / `workstatuslist/1.0` / `locationlist/1.0` / `knightcontrollist/1.0` / `extendinfo/1.0` —— 骑手维度统计
- `xtop.lpdcs.skyeye.knight.shiftgroup/1.0` / `teamsquad/1.0` / `subgroup/1.0` / `groupinfo/1.0` —— 排班/分组结构
- `xtop.lpdcs.skyeye.shippingorder.abnormaltype/1.0` / `constant/1.0` —— 异常类型 / 常量枚举
- `xtop.lpd.matrix.intervention.shippingOrderQuery.getAbnormalOrderAuditList/1.0` —— 异常单审核列表
- `xtop.lpd.matrix.intervention.txdSerial.listSerialRelativeOrderByTeamIdWithXTop/1.0` —— 同城达串行关联单

> aeolus「运单数据」页初始化还会发 `xtop.merchant.agencyTrackingFs.queryEnumerate/2.0`、`queryTeamInfos/2.0`、`querySecondThirdTrackingFilterInfo/2.0`、`queryDescriptionInfo/2.0`（筛选项枚举），当前下载脚本未用，必要时可查团队/筛选条件。

---

## 5. 橙色风暴明细（QC 抽检判定列表，2026-09-04 接入）

```
GET https://httpizza.ele.me/alsc-lpd-omp-inspection-prod/qc/fs/judgement/queryQcList
    ?hitTimeStart=<ms>&hitTimeEnd=<ms>&pageIndex=1&pageSize=200
```

- **请求头**：`origin: https://a.ele.me`、`referer: https://a.ele.me/`、`sec-fetch-site: same-site`、
  UA 仿 Edge。cookie 直接用 `ensure_cookies()` 的 `AEOLUS_MOZI_TOKEN`，**无需额外鉴权/DA 兑换**。
- **返回**：`{code:200, data:{pageIndex, pageSize, total, data:[ {...} ]}}`。
  `pageSize=200` 实测可用（8 月整月 3655 条 = 19 页，约 17~20s）。
- **单条记录 91 个字段**（扁平化后），常用：`qcId` / `teamName` / `knightName` / `knightMobile` /
  `qcTypeName`（刷脸抽检 / 装备抽检）/ `status`+`statusDesc`（通过 | 不通过）/ `reasons[]`（reasonName）/
  `punishment` / `punishDecimalAmount` / `appealStatusDesc` / `trackingId` / 各时间字段（毫秒）。
- **脚本** `jobs/orange_storm/fetch_orange_storm.py`（2026-09-07 已迁至 `jobs/` 并节点化，任务 id `orange_storm`）：
  `--month YYYY-MM`（默认上个月）或 `--start-date/--end-date`，自动分页拉满，
  产物落 `jobs/orange_storm/out/` 下 JSON + 全字段 CSV + 15 列精简 CSV。节点：`login → fetch → write`。
- 时间字段（hitTime/photoTime/completeTime/checkTime/punishTime/appealTime…）自动转东八区可读值，
  原值保留 `<字段>_ms`；嵌套 `reasons` / `punishInfoList` / `extraInfo` 转 JSON 字符串。
  精简版取 `reasons` 时必须用**原始行**（扁平行里已是字符串）。

---

## 6. 脚本执行约定：节点区间 `--begin` / `--end`（2026-09-02 全量推广）

所有工作台任务脚本（**12 个脚本 / 15 个任务入口**）内部都拆成了**有序节点**，统一由根目录
`nodeflow.py` 驱动，命令行口径一致：

```bat
<script> --begin <节点id> --end <节点id>     :: 只跑这段连续区间；不传 = 全跑
```

- 节点清单的**单一事实来源是脚本源码里的 `NODES`**，`workbench/tasks.json` 由
  `sync_nodes.py`（AST 只读提取，`--write` 写入，幂等）同步过去，界面步进条据此渲染。
- `end` 早于 `begin`、或 id 不在节点表里 → 打印 `✗ …` 并 `exit 1`。
- 区间内**筛出 0 条属正常中止**：抛 `nodeflow.Stop`，exit 0，不发消息不打扰。
- **日期参数改名**：`download_delivery.py` / `fetch_delivery_raw.py` 的日期参数原为
  `--start` / `--end`，与节点 `--end` 撞名，改为 `--start-date` / `--end-date`；
  传旧写法且取值是 `YYYY-MM-DD` 时由 `nodeflow.reject_legacy_date_args()` 友好拦截。
- 一个脚本多种模式时各有一套节点：`load_delivery_db.py`（`NODES_INIT`/`NODES_LOAD`/`NODES_VERIFY`）、
  `unsat_automation/main.py`（`NODES_RUN`/`NODES_REMIND`）。
- **节点化对任务是强制约束**：`tasks.json` 里没有 `nodes` 的任务会被 `sync_nodes.py`
  列进「未节点化」并以 exit 1 结束，新增任务不会悄悄漏掉。
- **SDK 自带的诊断入口不参与**：`python -m aeolus_sdk.login`（登录诊断）不是任务，
  不在 `tasks.json` 里，也不接 nodeflow —— SDK 是被人 import 的库，保持零外部依赖。

各脚本节点一览见 `workbench/README.md` 第三节任务清单。

---

## 通用约束小结

1. **Cookie 单一来源**：所有接口统一 `from aeolus_sdk import login` + `ensure_cookies()`，禁止硬编码 token。
2. **请求头**：业务接口带 `origin`/`referer`（多为 `https://aeolus.ele.me` 或 `https://a.ele.me`/`https://dispatcher.ele.me`）、`content-type: application/json`、UA 仿 Edge。
3. **单点登录顶号**：`result is null` / HTTP 401 → 触发重登（`ensure_cookies` 或 `refresh_shared_cookies`）。
4. **时间格式**：毫秒时间戳；申诉/运单按天窗口用北京时间当天 00:00:00 ~ 23:59:59.999。
5. **分页上限**：aeolus 运单 `pageSize≤50`；dispatcher paging 实测可用 200；任务 `pageSize=100`；橙色风暴 QC 列表 `pageSize=200`。
6. **限流**：`REQUEST_TOO_FREQUENT` 需退避重试（下载/查询脚本已内置 `with_retry` 或 sleep）。

---

## 逆向方法：如何找到「未知接口」（2026-09-08 踩坑总结）

找新接口时**不要猜接口名**——xtop 的 action 命名空间极大，猜中的概率接近 0
（历史教训：找「规则历史版本列表」时试了 21 个 action + 6 个 appId 变体，全部 404）。
正确顺序是：

1. **先查本机已有的抓包记录**：`docs/接口清单.md` 第 4 节（dispatcher 抓包观测到的接口）
   常有现成的名字。但**注意它们可能已失效或不在同一域**（本次 `xtop.lpdcs.skyeye.teams/1.0`
   实测 404）。
2. **再从页面 JS bundle 里扫接口名（最有效）**：
   - Playwright（`.venv` 已装）打开目标页面 → `performance.getEntriesByType('resource')`
     过滤 `.js` → 下载所有 JS → 正则 `xtop\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+/\d+\.\d+` 扫全部接口名。
   - 本次一次扫出 11 个接口名，其中 `xtop.lpd.intelligentConfig.getTeamsAll/1.0` 就是「站点列表」。
   - 页面需要登录态时：用 `context.add_cookies()` 注入 `aeolus_sdk/cookie.txt` 解析出的
     cookie（domain 填 `.ele.me`），本次靠它直接打开了排班页（title 正常）。
3. **最后才试调用**：空 body `{}` 先打一发，再逐个试 `{"params":{}}` 等形态。
   401（未登录）vs 404（接口不存在）是两类信号，别混为一谈。

注意：SPA 页面初始化往往**不发业务请求**（本次只发了 `lpd.meepo.session/aeolus/init`），
所以「监听网络请求」可能一无所获 —— 扫 JS bundle 才是稳的。
