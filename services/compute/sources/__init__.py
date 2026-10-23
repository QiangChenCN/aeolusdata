from analytics.core.paths import ROOT, PY_HOME, _ROOT  # noqa: E402,F401 <<<


"""sources —— 风神数据的**取数转发层**（单一来源）。

⚠️ 取数已整体迁到 NestJS（ADR：「取数不是计算」）。本包各模块**不自己打风神接口**，
只把参数转发给 Nest 的 `/api/fetch/*`（分页 / 反爬节奏 / 限流退避 / 会话重登都归 Nest）；
返回结构与迁移前逐字一致，上层（`analytics/*`）无需关心底层。

★ 约定：
- 每个模块 = 一个接口，只负责「把这个接口的原始数据拿回来」（dict / list[dict]）
- 查询参数（日期 / 站点 / page / period …）由调用方传入；模块内不做选日期、选站点
- 禁止在模块内做：统计 / 筛选 / 格式化、落盘写文件、CLI 解析、自动重登循环
- 会话失效：Nest 返回的 `code` 命中 `sources.session.SESSION_CODES` 时抛 `AuthError`，
  由上层作为失败上报即可 —— 重登已归 Nest 独占（`POST /api/fetch/aeolus-relogin` 由
  Nest 侧 `AeolusCookieService` 实现），Python 不再持有或触发任何登录逻辑

成员：
- attendance : 实时考勤 → `POST /api/fetch/attendance-raw`，`fetch_team(team_id, time_code, cookie=None)`
- schedule   : 排班统计 → `POST /api/fetch/sched-raw`，`query(team_id, start_date, end_date, retries=8, cookie=None)`
- violation  : 风控处罚 CSV → `POST /api/fetch/violation-csv`，`download_csv(start_ms, end_ms, cookie=None)`
- session    : 会话失效约定与重登原语（**不是取数模块**，被上面三者与调用方共用）
- _http      : 转发 Nest 的薄封装（内部，包外勿直接引用）

────────────────────────────────────────────────────────────
📦 2026-09-24 重构说明（原名 `get_data`）
────────────────────────────────────────────────────────────
改名理由（两条都是实际问题，不是洁癖）：
1. **同名包冲突**：旧结构里根 `get_data/` 与 `analytics/get_data/`（原 dashboard/get_data）
   两个包都叫 get_data，`sys.path` 顺序会让裸 `import get_data` 命中嵌套的那个，
   而它缺 `schedule_statistics` —— 是个会随机炸的隐式依赖。改名后彻底消除。
2. **名不副实**：本包并不"取数"（Nest 才取数），只是把请求转发出去，故名 `sources`
   （数据来路）。顺带避免与既有的 `common/nest_client.py`（真正的 HTTP 客户端）混淆。

同时收编了原先散在三处的重复门面（功能等价、实现重复），此处是**唯一入口**：
  · 原 `get_data/__init__.py`            —— 仅文档，已并入本文件
  · 原 `dashboard/get_data/__init__.py`  —— 看板友好签名门面，已并入本文件
  · 原 `dashboard/standard/get_data.py`  —— 纯 re-export shim，其 CLI 已随取数迁 Nest 删除（取数现由 NestJS 独占）
  · 原 `dashboard/standard/schedule_statistics.py` —— `flatten()` 与门面的
    `flatten_schedule()` **逐行重复**，只保留本文件的 `flatten_schedule`
    （保留 `flatten` 别名供旧引用过渡）
"""
# ===== 直接引用本包内已有的对应功能（无重复实现） =====
from .schedule import query as _sched_query
from .attendance import fetch_team as fetch_attendance          # 签名一致，直接别名
# 站点名唯一兜底源（与 analytics.core.teams_config.TEAM_NAMES 同源，避免散落硬编码）
from analytics.core.teams_config import TEAM_NAMES

__all__ = [
    "fetch_schedule", "fetch_attendance",
    "flatten_schedule", "flatten", "TEAM_NAMES",
]


# 原 `ensure_cookies()` 已于 2026-09-24 **删除**：Python 不再打开 cookie 文件。
#
# 登录态（读盘 / 失效重登）由 NestJS 独占：本包转发到 `/api/fetch/*` 时一律**不传** cookie，
# Nest 侧走 `cookie || await this.cookies.ensure()` 自行补齐、失效时自动重登
# （见 apps/api/src/modules/fetch/attendance-fetch.service.ts 与 schedule-fetch.service.ts）。
#
# 这样凭证只在一个进程里被打开 —— 「谁持有 cookie」不再有两个答案，
# 也避免了 Python 读到一个正在被 Nest 原子重写的半截文件。


def fetch_schedule(team_id, start_date, end_date):
    """排班目标：按 站点×日期 拉取，返回接口原始数据（每天含 timeList 时段明细）。

    登录态由 Nest 自行补齐（见上方 ensure_cookies 删除处的说明）；Python 不传 cookie、
    也不触发重登 —— 重登已归 Nest 独占。
    """
    return _sched_query(int(team_id), start_date, end_date)


def flatten_schedule(rows):
    """把按天的排班目标 rows 展平成「站×日期×时段」一行一条的列表。

    每条记录字段：
        team_id, shift_date, team_knight_num,
        time_code, time_name, start_time, end_time,
        actual_num, predict_num, predict_order, actual_order
    """
    out = []
    for d in rows or []:
        tid = d.get("teamId")
        sdate = d.get("shiftDate")
        tkn = d.get("teamKnightNum")
        for t in d.get("timeList") or []:
            out.append({
                "team_id": tid,
                "shift_date": sdate,
                "team_knight_num": tkn,
                "time_code": t.get("timeCode"),
                "time_name": t.get("timeName"),
                "start_time": t.get("startTime"),
                "end_time": t.get("endTime"),
                "actual_num": t.get("actualNum"),
                "predict_num": t.get("predictNum"),
                "predict_order": t.get("predictOrder"),
                "actual_order": t.get("actualOrder"),
            })
    return out


# 兼容别名：原 analytics.schedule_statistics.flatten 与本函数逐行重复，已合并，
# 保留 `flatten` 指向同一实现，避免旧引用一次性改不完。
flatten = flatten_schedule
