# 风神数据处理 · 全量静态代码审查报告

- **审查日期**：2026-09-07
- **范围**：项目全部 Python 源码 + 工作台前端 `index.html` + `tasks.json`（排除 `.venv/`、`.git/`、`__pycache__/`、运行产物 `out/*.json`、记忆文件）
- **方法**：按模块分组并行深度审查（aeolus_sdk/quark_sdk、common、server、jobs 核心、jobs 其余），全程只读，**未修改任何代码文件**
- **覆盖维度**：性能 / 可读性 / 结构设计 / 命名规范 / 错误处理 / 复用性 / 工程最佳实践

> 注：下方 `file:line` 为审查时定位，后续改动可能导致行号漂移，请以符号/函数名为准。

---

## 〇、总览：最该先改的 6 件事

| # | 问题 | 位置 | 等级 |
|---|------|------|------|
| 1 | 工作台 `/api/file` 可读取任意文件（含 `cookie.txt` 会话凭据） | `server.py` `serve_artifact` | **High·安全** |
| 2 | 工作台全 API 无鉴权 / Origin 校验，`/api/run` 触发外部群发 | `server.py` 路由层 | **High·安全** |
| 3 | 手机号被渲染进 public-read 的 MinIO 公开图 | `common/report_render.py:122` | **High·隐私** |
| 4 | `ssl.CERT_NONE` 关闭证书校验，内网 MITM 可窃 cookie | `attendance.py` / `fetch_jidan.py` / `fetch_orange_storm.py` | **High·安全** |
| 5 | `unsat/config.py` 重抄 `ding_common` 常量，单一来源被破坏 | `jobs/unsat/config.py:64-90` | **High·架构** |
| 6 | `quark_da_auth.py:71` 硬编码 `/dev/null`，Windows 下 DA 兑换整条链路崩溃 | `quark_sdk/quark_da_auth.py:71` | **High·功能** |

---

## 一、高优先级（High）

### A. 安全与凭据泄露

**H1 · 任意文件读取（会话劫持）**
`server.py` 的 `serve_artifact` / `_safe_resolve` 仅约束路径在 `ROOT` 内，未限定为任务声明的 `outputs`/`runs` 白名单。攻击者（无需鉴权）可请求 `/api/file?path=aeolus_sdk/cookie.txt`、`server/data/todo.db`、`tasks.json`、`.venv` 等。
- **理由**：`cookie.txt` 是风神/钉钉登录态核心凭据，泄露即会话劫持。
- **建议**：仅放行「任务 outputs 展开白名单 + `runs/*.log`」；显式拒绝 `aeolus_sdk/`、`*/data/`、`*.db` 等敏感前缀；服务端校验，不信任前端传来的 rel。
- **收益**：堵住凭据外泄面。

**H2 · 全 API 零鉴权**
`Handler` 所有路由无 token / Origin / CSRF 防护。虽绑定 `127.0.0.1`，但 `/api/run` 副作用是向钉钉群发消息（含 @站长）、`/api/stop` 杀进程，恶意网页经 DNS 重绑到 127.0.0.1 即可驱动。
- **建议**：启动随机 `token`，前端 fetch 带 `X-Token`；校验 `Origin` 仅允许 `http://127.0.0.1:PORT`；JSON 以外请求直接拒。
- **收益**：外部不可逆动作受控。

**H3 · 手机号泄露到公开图床**
`common/report_render.py:122` 将骑手 `mobile` 渲染进图片，该图经 `minio_common` 上传到 **public-read** 桶，手机号随公开 URL 暴露。
- **建议**：手机号脱敏（中间 4 位掩码）；或该图改私有桶/不公开。
- **收益**：满足隐私合规。

**H4 · 关闭 TLS 证书校验**
`attendance.py`、`fetch_jidan.py`、`fetch_orange_storm.py` 设置 `ssl.CERT_NONE` + `check_hostname=False`，且请求头携带登录 cookie。
- **理由**：内网中间人可窃取风神/钉钉 cookie/token。
- **建议**：默认 `ssl.create_default_context()`；仅在确属内网自签场景、且仅对特定域名临时跳过并注释说明。
- **收益**：消除凭证泄露面。

**H5 · 明文账密 + cookie 文件权限**
`aeolus_sdk/login.py` 顶层明文 `ACCOUNT_RAW/PASSWORD_RAW`；落盘 cookie 未收紧权限。
- **建议**：凭据移入环境变量 / `keyring`；cookie 写入后 `os.chmod(path, 0o600)`（Windows 用 NTFS ACL）。
- **收益**：合规审计过关。

**H6 · 签名下载 URL 入日志**
`jobs/appeal/appeal_reminder.py:263` 把风神 OSS **签名下载链接**写进 `appeal_reminder.log`，外泄即他人可下载违规数据。
- **建议**：日志只记 `len(file_url)` 或脱敏。

---

### B. 功能性缺陷 / 正确性

**H7 · Windows 下 DA 兑换崩溃**
`quark_sdk/quark_da_auth.py:71` 写死 `/dev/null`，Windows 无此路径 → `curl` 报错 → `DA_SESSION` 提取失败 → DA 兑换整条链路在 Windows 不可用（项目明确跑 Windows）。
- **建议**：改用 `os.devnull`。**一行修复，但影响面极大，优先级最高。**

**H8 · 报表图被静默覆盖**
`common/report_render.py:86` 与 `:150`：`render_attendance_absent` 与 `render_all_teams` 的默认 `out_path` 都是 `attendance_absent.png`。调用 `render_all_teams()` 不传 `out_path` 会**覆盖**「未出勤」图。
- **建议**：给 `render_all_teams` 独立默认常量（如 `IMG_ONLINE`）。

**H9 · `unsat/main.py` 引用不存在模块 + 导入时机错误**
`:138` `import nodeflow` 仅写在 `if __name__=="__main__"` 内，但 `node_fetch` 等节点函数（`nodeflow.Stop`）在模块被 import 时调用会 `NameError`；`serve`/`schedule` 子命令 `from .callback import app` / `from .scheduler import start` 这两个模块**根本不存在**，运行即 `ModuleNotFoundError`。
- **建议**：`import nodeflow` 提到模块顶部；补齐或删除 `serve`/`schedule` 入口。

**H10 · `unsat/config.py` 破坏单一来源**
`:64,72,77,90` 把本应来自 `ding_common` 的 `MANAGER_OPENID / STATION_MANAGERS / DO_NOT_AT / GROUP_ID` **整份重抄**。站长改名（如 `房铭瑞`）时 unsat 流水线完全看不到，双份真相必然漂移；且 `房志才`/`房铭瑞` 疑似指向同一 openid 的笔误。
- **建议**：`unsat` 直接 `from ding_common import ...`，删本地副本。

**H11 · `appeal_reminder.py` 用 sys.argv 篡改 ding_common 模块常量**
`:339-345` 通过 `GROUP_ID = sys.argv[...]` 改写从 `ding_common` 导入的模块级常量来覆盖目标群，且 `--group` 未写入 `ctx`。若作为模块 import 或被其他编排调用，`ding_common.GROUP_ID` 仍是原值 → **静默发错群**。
- **建议**：`--group` 解析结果写入 `ctx["group_id"]`，`send_*` 统一读 `ctx["group_id"]`（参照 `task_board.py:385`）。

**H12 · `fetch_report_view` 重试强踢登录，违背 SSO 顶号设计**
`quark.py:625` 每次重试（attempt>1）都 `force=True` → 删本地 cookie + 重走完整 SSO。若失败发生在 DA 兑换/取数阶段（Aeolus 仍有效），会造成不必要重登、且绕开 `login.py` 的共享锁，加剧脚本↔浏览器乒乓。
- **建议**：仅当确认 Aeolus 401 时才 `force`，否则复用。

**H13 · `sync_nodes.py` AST 提取健壮性不足**
`:68-69` `ast.parse` 未包 `SyntaxError` → 任一脚本语法错误瘫痪全量同步；`:72-79` 只取**首个** `NODES` 赋值且要求顶层 List 字面量，reassign / 列表推导构造会误判「未节点化」。
- **建议**：捕获 `SyntaxError` 单独报该任务；支持多次赋值取最后一次；非字面量给明确告警。

---

### C. 架构 / 复用债（高影响）

**H14 · `ding_common` 缺统一发送封装，4 处各写一套**
`ding_common` 被 5+ 脚本 import，却只提供 `dws()`（无重试）与 `dws_run()`（有重试），没有统一的 `send_message()`。结果：`attendance` 用无重试 `dws`、`unsat` 自写 `_dws` 重试、`appeal`/`task_board` 又各拼一份 `--at-open-dingtalk-ids`。
- **建议**：新增 `send_markdown/send_file`（含 @ 黑名单解析 + 重试），各 job 委托调用。
- **收益**：消除重复、统一重试与 @ 规则、集中治理「发错群/泄凭证」风险。

**H15 · `unsat` 与 `appeal` 取数层重叠**
两者调同一接口 `violationOrderAeolusCenterApi.download/1.0`、同样 GBK 解码、同样「下载→筛选→渲染→@站长」骨架，仅筛选条件与字段不同。业务语义不同**不必合并**，但**取数层应去重**。
- **建议**：抽 `common/violation_fetch.py`（download + decode + filter 钩子），两者复用。

---

## 二、低优先级（Low）

### aeolus_sdk / quark_sdk

- **login.py**：`get_shared_cookies`/`refresh_shared_cookies`（L269-307）是**死代码**——`fetch_report_view` 实际走 `load_aeo_cookie→ensure_cookies`，从不用这两个带锁/内存缓存函数。注释承诺的「并发去重、401 自愈」未接入，**SSO 顶号保护名存实亡**，建议真正接通或删注释。**L174 裸 `except: pass`** 吞 SSO 票据交接异常，至少记 debug 日志。**缺类型提示**；`COOKIE_FILE`(L222) 与 `quark.py:164` `AEOLUS_COOKIE_FILE` 重复定义同一路径，应导出常量复用；顶层 `import venv_guard` 与 `quark.py` 的 `try/except` 兼容风格不一致。
- **quark_da_auth.py**：L37/26 docstring 过期路径（仍写「项目根」）；L115/L126 函数内 `import urllib.request` 应提顶部；L138 用 `open(jar,"a").close()` 不如 `Path.touch()`；`QUARK_PARAMS` 长度解析与 `quark.py` 重复。
- **quark.py**：魔法数字散落（L143 `DATASET_GUID`、L99 `reportId`、L458/L673 `"14:23:33"` 应提 `DEFAULT_META_TIME_SUFFIX`）；L328-348 与 `quark_da_auth` 构造近似相同的请求头 dict，可抽 `_aeo_request_headers()`；L3/L313 docstring 提及 `nodeflow`（本 SDK 零引用）属过期设计说明；`base` 参数语义失真（现只影响个别 cookie 路径，却贯穿签名，易误导调用方以为能改缓存位置），建议改名 `fallback_dir` 或删；缺类型提示与单测；`need_probe`（L666）恒 False 成死代码；`_curl_get`（L351-365）未检查 `returncode`，失败时静默拿到空串导致下游 `AttributeError`。

### common

- **nodeflow.py**（设计良好）：`take_range`(L146) 仅是 `_take` 公开别名，API 重复；`reject_legacy_date_args`(L55) 导出但各 job 未调用；`execute`(L216) 解析 `SystemExit.code` 分支偏绕，可抽小函数。
- **find_group.py**：`resolve_group_id` 用 `raise SystemExit` 报错，被模块调用时会冒泡杀进程且调用方无法 `except`，建议改自定义异常 `GroupResolveError`；L168-180 吞掉 `search_groups` 异常（`except: pass`），失败静默降级可能误选群，至少 `log.warning`；L40 `json.load(open(...))` 未用 `with`。
- **report_render.py**：字体路径硬编码 `C:/Windows/Fonts/simhei.ttf`（L28）未复用 `ding_common.FONT_PATH`，形成第二真相；`fit_font`（L35-46）逐像素 `-1` 递减 + 每步 `textlength`，长表性能差，可改二分；`Image` 对象普遍未 `img.close()`，靠 GC 释放，连渲多图句柄滞留；L459 `remaining_color` 三元嵌套可读性差，建议抽函数；`pad_x/row_h/title_h` 等魔法数字多处重复声明，建议集中为布局常量。
- **minio_common.py**：`@with_retry` 把 `load_minio_cfg+ensure_bucket_public+fput` 全包进重试，配置缺失/建桶失败也徒劳重试 3 次，建议只包 `fput_object`；L38-51 每次上传都 `bucket_exists`（网络往返）可缓存；`_content_sha256` 每次重算哈希，可按 `(path, mtime)` 缓存；L30 `json.load` 无 `with` 且缺 `img_path` 存在性校验。
- **theme_colors.py**：整洁，建议常量加 `Final` 类型提示。

### server

- **server.py**（1459 行单文件）：`build_cmd`(L326) 未校验入参/节点 id——用 `subprocess.Popen(cmd, [...])` **列表形式、无 `shell=True`，无命令注入风险**，但前端可 POST 任意 flag，`--begin/--end` 未与 `tasks.json` 的 `nodes` 校验，节点改名后运行时才失败；热重载指纹用 `(st_mtime_ns, st_size)`(L673-702) 非原子、size+mtime 理论可对不同内容重合，建议改用 `sha256(字节)` + `self.lock` 临界区保护；`run_id`(L382) 锁外计算可能冲突，建议 `uuid4().hex`；SSE 队列满(maxsize=2000)静默丢事件(L305)，建议调大或降级写 `runs/*.log`；魔法数字散落（20000/10000/5000、timeout 600、MAX_HISTORY 58）；建议拆 `http_handlers/artifacts/registry/cookies` 子模块；端口/主机(L1427)硬编码，建议 `TASKHUB_PORT/HOST` 环境变量。
- **todo_store.py**：动态 SQL 用 `",".join("%s=?"%k)` 列名来自**白名单字面量集合**，非用户串，无注入；建议保持「键须来自常量表」纪律并加注释。`todo_sched.py` 跨模块调用私有 `_parse_dt` 耦合偏紧，建议提供公开包装。`group_picker.py` 设计合理。`check_tokens.py`/`test_todo.py` 为开发/测试脚本，建议补 HTTP 层集成测试（覆盖 H1/H2）。
- **tasks.json**：`nodes` 与脚本实际节点链无服务端校验（呼应 server L326）；`delivery_pipeline` 的 `needs`/`outputs` 同指 `delivery_raw/`（环形但无害）。
- **index.html**（轻量）：XSS 处理得当（日志用 `textContent`、任务名/错误 `esc()`、rel 经 `encodeURIComponent`）；后端未越权下发内部状态（符合「不暴露部署细节」）；**部分 fetch 缺 `.catch`**，断网抛未捕获 rejection，建议统一 `.catch(toast)`；5114 行未组件化（SPA 可接受）。

### jobs · attendance

- L104-106 TLS 关闭见 H4。`json.load(open(SUMMARY_PATH))`(L367) 无 `with`；缺 `--group` 时静默回落生产群 `GROUP_ID`(L355) 仅打印警告，**与「send 必须显式指定目标群」背景矛盾**，建议 `--require-group` 或默认走 `--test`；L36/L3 重复 `import os,sys` 且挤一行；`run_send`(L370) 总是重调 `run_upload()`，MinIO 幂等仅多一次 IO，建议 `if "img_url" not in ctx`；全程 `print` 无 `setup_logging`（对比 appeal/board 有日志文件），建议接入落盘 `attendance.log`；L482 先 `None` 初始化又被覆盖，冗余；L199 延迟 import 可提顶部。

### jobs · appeal

- `nodeflow` 仅 `if __name__=="__main__"` 内 import(:318)，但 `node_filter`(:266) 用 `nodeflow.Stop`，模块被 import 时不跑 `__main__` 会 `NameError`，建议顶部 import。签名 URL 入日志见 H6。`raw.decode("gbk","ignore")`(:108) 忽略错误可能静默丢列，建议告警。`STATION_MANAGERS.get(r["站点"], []) if ... in ... else []`(:154) 多余 `in` 判断，直接用 `.get`。`upload_to_minio`(:287) 失败仅降级未重试，建议加 `with_retry`。群覆盖逻辑见 H11。

### jobs · board

- `nodeflow` 同样 `__main__` 内 import(:402) 潜在 `NameError`，建议顶部。`API_URL`(:81) 与请求头定义在 `fetch_all()` 函数内，而 appeal/attendance 放模块级，建议统一模块级常量。`fetch_all`(L75-120) 顺序分页无重试，cookie 中途失效即整条失败，建议套 `with_retry` 且 401 时刷新。`setup_logging`(:430) 写在文件底部、`main()` 之后，节点函数先于其文本定义就引用 `log`，依赖隐式执行顺序，建议移到顶部。`remaining_color`(:459) 用字符串判断做语义着色脆弱，建议返回结构化 `(days, seconds)`。`gid = group_id or GROUP_ID`(:244) 与 attendance 同款「缺参回落生产群」，建议统一策略。

### jobs · delivery

- `load_delivery_db.py` 批量写入已用 `execute_values` 批 500、值全参数化（✅ 正确），但 DDL 按 `;`(L93/129) 切分执行，`gen_pg_ddl` 的 `_col_note` 未转义分号（只转单引号），COMMENT 含分号会切断语句，建议转义或按语句列表解析。`to_cell()`(L66) 与 `analyze_columns.py:26` 近似重复，应抽到 `delivery_columns.py`。`analyze_columns.py:83` 魔法数 `5000` 建议命名常量。

### jobs · equipment / rush / orange_storm / ruledoc

- `task_equipment.py:142-208` 手写 argv 解析器(~65 行) 每脚本一份，建议 `nodeflow` 提供通用 `--date/--start-date/--end-date/--no-*` 解析；`collect_at`(L117) 与 appeal/unsat 的 openid 解析三处重复，应收敛 `ding_common`。
- `fetch_jidan.py`/`fetch_orange_storm.py` TLS 关闭见 H4；`fetch_jidan.py:91-103` `_post_retry` 用 `except Exception` 吞所有错误返回 `None`，失败原因仅 stderr，难排查，建议至少上抛关键异常。
- `gen_rule_doc.py:516` `node_build` 调两次 `_read_refs()` 读文件两次，可缓存到 ctx。

### jobs · unsat（除 H9/H10/H15 外）

- `store.py:102` `upsert_orders` 逐行 `SELECT`+`INSERT`，可改 `INSERT ... ON CONFLICT DO NOTHING`（一次性 `executemany`）。`sheet_writer.py:65` 自造 CSV 解析未处理引号内转义逗号，建议用 `csv` 模块。`config.py` 别名笔误（`房志才`/`房铭瑞` 同 openid）见 H10。

### tools

- `preview_renders.py` 直接 `R.render_*` 依赖 `report_render`，已 `sys.path` 注入 OK；但缺渲染失败异常捕获，单图失败中断后续。
- `sync_nodes.py` 见 H13。

---

## 三、跨领域系统性建议

1. **凭据与配置集中化**：消除三处硬编码（Linux 部署即失效的 `C:/Users/ChenQiang/...` 字体/二进制路径、明文账密、散落群 ID）。统一走 `.env` + 环境变量 + `keyring`；公共路径经 `ding_common` 解析，`report_render` 复用 `FONT_PATH`。
2. **公共能力上收 `common`，消灭「第二真相」**：发送/@（`send_message`）、群解析（`resolve_group_id` 已在 `find_group`）、openid 解析、违规取数（H15）全部收敛到 `common/*`，各 job 只填空业务函数。这能一次性消除 H10/H11/H14/H15 及多处重复。
3. **TLS 校验统一策略**：默认强校验，仅内网自签场景按域名白名单临时跳过并注释，杜绝 H4 三处各写各的。
4. **日志脱敏规范**：建立「日志不落 cookie/token/签名 URL/手机号」纪律（H3/H6 已暴露），`ding_common` 发送封装层对 `dws` 输出脱敏。
5. **补类型提示 + 关键路径单测**：SDK（`quark.py`/`login.py`）、`server.py` 鉴权与文件边界、`sync_nodes` AST 提取最该先补测试；`quark.py` 845 行、`server.py` 1459 行建议逐步拆函数/模块。
6. **跨平台路径**：一律 `pathlib` / `os.path.join` / `os.devnull`，避免任何 `/dev/null`、硬编码盘符、反斜杠。

---

## 四、建议整改顺序

- **Phase 1（安全 + 功能，立即）**：H1、H2（工作台鉴权与文件边界）、H3（手机号脱敏）、H4（TLS）、H7（`os.devnull`）、H8（图覆盖）、H9（unsat 模块缺失）、H13（sync_nodes 兜底）。
- **Phase 2（架构复用债，迭代）**：H5/H6（凭据与日志脱敏）、H10/H11（ding_common 单一来源 + ctx 传群）、H14（统一发送封装）、H15（抽 violation_fetch）。
- **Phase 3（可维护性 Low，常态）**：各 Low 项随相关模块改动顺手清理；同步补类型提示与单测。

> 说明：本次审查**未修改任何代码文件**，所有建议均为只读分析结论。落地前建议先就 H1/H2/H7 三项做独立验证（尤其 H7 的 Windows DA 兑换是否确已不可用）。
