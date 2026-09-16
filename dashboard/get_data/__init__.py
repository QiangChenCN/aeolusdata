#!/usr/bin/env python3
"""看板公共取数模块（dashboard/get_data）。

为「数据看板」各子页（标准达成 / 时段出勤 / …）提供**统一、可复用**的取数入口。

★ 本包不实现任何 HTTP 细节 —— 底层取数全部委托根 get_data/（单一来源，jobs/* 也用同一套）：
   · fetch_schedule   → 根 get_data.schedule_statistics.query   （排班目标）
   · fetch_attendance → 根 get_data.attendance.fetch_team        （实时考勤）
   · fetch_delivery   → 根 get_data.delivery.fetch               （运单明细）
   · ensure_cookies   → aeolus_sdk.login.ensure_cookies           （风神 SSO 登录态）
  这里只做「看板友好签名归一」（cookie 前置）+ 调用方共享常量，避免每个看板各写一套。

对外 API（均返回接口原始数据，不聚合）：
  fetch_schedule(cookie, team_id, start_date, end_date) -> list[day dict]
  fetch_attendance(team_id, time_code, cookie)           -> 接口原始 JSON
  fetch_delivery(cookie, start_ms, end_ms, ...)          -> list[dict]
  ensure_cookies()                                       -> (cookie, status)
  flatten_schedule(rows)                                 -> list[「站×日期×时段」一行]（调用方展平逻辑，根包不含）
  TEAM_NAMES                                             -> {team_id: 站点名}
"""
import os
import sys

# dashboard/get_data 位于项目根下：把项目根加进 sys.path，
# 这样本包内 `from get_data...` / `from aeolus_sdk...` 不依赖运行时 cwd。
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# ===== 直接引用根 get_data 包 / aeolus_sdk 中已有的对应功能（无重复实现） =====
from get_data.schedule_statistics import query as _sched_query
from get_data.attendance import fetch_team as fetch_attendance          # 签名一致，直接别名
from get_data.delivery import fetch as _delivery_fetch
from aeolus_sdk import login as _L

__all__ = [
    "fetch_schedule", "fetch_attendance", "fetch_delivery",
    "ensure_cookies", "flatten_schedule", "TEAM_NAMES",
]


# fetch_attendance / ensure_cookies 已是根包函数的直接别名，无需包装。

def ensure_cookies():
    """返回 (cookie, status)；cookie 为空时自动登录。直接委托 aeolus_sdk.login。"""
    return _L.ensure_cookies()


def fetch_schedule(cookie, team_id, start_date, end_date):
    """排班目标：按 站点×日期 拉取，返回接口原始数据（每天含 timeList 时段明细）。

    签名归一：cookie 前置；底层调用根 get_data.schedule_statistics.query。
    """
    return _sched_query(int(team_id), start_date, end_date, cookie=cookie)


def fetch_delivery(cookie, start_ms, end_ms, page_size=50, period="0-86400", pace=0.0):
    """运单明细：分页拉取时间段内全部运单，返回行列表 list[dict]（接口原始字段）。

    签名归一：cookie 前置；底层调用根 get_data.delivery.fetch。
    """
    return _delivery_fetch(int(start_ms), int(end_ms), page_size, period, pace, cookie=cookie)


def flatten_schedule(rows):
    """把按天的排班目标 rows 展平成「站×日期×时段」一行一条的列表（调用方展平逻辑）。

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


# 看板通用站点清单（team_id -> 站点名），各看板共享，避免散落硬编码。
TEAM_NAMES = {
    "917521130": "东莞市黄江镇站-UB",
    "917521136": "东莞市长安万科站-UB",
    "917521139": "东莞市大岭山大学城站-UB",
}
