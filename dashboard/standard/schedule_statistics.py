#!/usr/bin/env python3
"""排班目标（排班统计）HTTP 取数 —— 单一来源（位于 dashboard/standard）。

封装对 aeolus 排班统计接口 `xtop.fs.special.schedule.listScheduleStatistics/1.0` 的纯 HTTP 取数，
供「标准达成」看板（dashboard/standard）取「排班目标 / 预测基线」使用。

为什么集中到这里
----------------
排班目标是「标准达成」的核心分母/目标数据源，接口约束（请求体结构、origin/referer、
鉴权、会话失效处理）集中在此，避免在工作台 server、看板渲染、标准达成脚本里各写一套
build_body / query / AuthError / 重登逻辑。

接口说明（2026-09-09 实测）
--------------------------
- POST https://httpizza.ele.me/xtop/xtop.fs.special.schedule.listScheduleStatistics/1.0
- 请求体：{"params":{"request":{"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","teamId":<int>}}}
- 返回 result.data：长度为天数的列表，每一天 = {
    teamId, shiftDate, teamKnightNum, timeCarrierPlanReady,
    timeList: [ {timeCode, timeName, startTime, endTime,
                 actualNum(实际排班人数), predictNum(预测人数),
                 predictOrder(预测单量), actualOrder(实际单量, 常为空), shiftTrackingCnt} ]
  }
- 字段语义（对「标准达成」）：
    teamKnightNum  = 站内骑手总数
    actualNum      = 该时段实际排班人数（已有值）
    predictNum     = 该时段预测/计划排班人数
    predictOrder   = 该时段预测/计划单量（= 排班目标的单量基线）
    actualOrder    = 该时段实际完成单量（本接口通常为 null，需从运单明细聚合补齐）

对外提供的能力
--------------
- query(team_id, start_date, end_date, cookie=None) -> rows   低层单次请求，返回 result.data
- Session                                            封装 cookie + 遇 AuthError 自动重登
- fetch(team_id, start_date, end_date, cookie=None)    高层：自动登录 + 重登，返回 rows
- flatten(rows) -> list[dict]                         展平成「站×日期×时段」一行一条
"""

import os
import sys
import time
import random
import datetime

# dashboard/standard 位于项目根下：把项目根加进 sys.path，
# 这样本模块里 `from aeolus_sdk import login` 以及 `from get_data...` 都不依赖运行时的 cwd。
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from get_data.schedule_statistics import AuthError, build_body, query
from aeolus_sdk import login as L

BJ = datetime.timezone(datetime.timedelta(hours=8))
SLEEP_MIN = 0.1
SLEEP_MAX = 1.0
# 失败退避倍数抖动：多个请求同时被限流时，固定退避会让它们同步重试（惊群），
# 各乘一个 0.7~1.3 的随机系数把重试时刻错开。
BACKOFF_JITTER = (0.7, 1.3)


def log(msg):
    ts = datetime.datetime.now(BJ).strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def rand_sleep(lo, hi):
    """[lo, hi] 区间内均匀随机 sleep，返回实际秒数（便于测试断言）。"""
    if hi < lo:
        lo, hi = hi, lo
    s = random.uniform(lo, hi)
    time.sleep(s)
    return s


def backoff_sleep(base):
    """失败退避：在 base 秒基础上乘 0.7~1.3 的随机系数再睡（错开重试时刻，避免惊群）。"""
    return rand_sleep(base * BACKOFF_JITTER[0], base * BACKOFF_JITTER[1])


# 取数（_as_date_str / build_body / query / AuthError）已迁到 get_data.schedule_statistics（单一来源）。
# 本文件保留 Session（自动重登）/ fetch（高层）/ flatten（展平）/ log 等调用方逻辑。


class Session:
    """封装 cookie，遇 AuthError 自动重登（最多 5 次）。"""

    def __init__(self):
        self.cookie, st = L.ensure_cookies()
        self.relogin = 0
        log(f"登录态: {st}")

    def call(self, *a, **kw):
        while True:
            try:
                return query(*a, cookie=self.cookie, **kw)
            except AuthError as e:
                if self.relogin >= 5:
                    raise RuntimeError(f"会话连续失效 5 次: {e}")
                self.relogin += 1
                log(f"会话失效({e})，重新登录 第{self.relogin}次")
                self.cookie = L.get_cookies()
                L.save_cookies(self.cookie)
                backoff_sleep(2)   # 等新会话在服务端生效，抖动避免与其它实例同步


def fetch(team_id, start_date, end_date, cookie=None):
    """高层取数：自动登录 + 会话失效重登，返回 result.data 列表（按天）。"""
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    refreshes = 0
    while True:
        try:
            return query(team_id, start_date, end_date, cookie=cookie)
        except AuthError:
            if refreshes >= 3:
                raise RuntimeError("会话连续失效，已重试 3 次仍失败；请确认浏览器风神未活跃顶号后重试")
            cookie = L.get_cookies()
            L.save_cookies(cookie)
            refreshes += 1
            log(f"[重试] 会话失效，已重新登录 (第 {refreshes} 次)")


def flatten(rows):
    """把按天的 rows 展平成「站×日期×时段」一行一条的列表。

    每条记录字段：
        team_id, shift_date, team_knight_num,
        time_code, time_name, start_time, end_time,
        actual_num, predict_num, predict_order, actual_order
    """
    out = []
    for d in rows:
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


__all__ = [
    "AuthError", "build_body", "query", "Session", "fetch", "flatten",
]
