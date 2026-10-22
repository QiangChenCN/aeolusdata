"""商家拜访率（新专送拜访，15 分）历史真实值读取。

Nest `VisitFetchService` 把 querySubTaskPage 的（已拜访 / 总商家）落进
`assessment_history.db` 的 visit_history 表（按 mainTaskId × team_id='_all' × date 幂等 UPSERT）。
本模块按区间聚合并算拜访率（百分比）。

若区间内无任何拜访落库记录（例如接口尚未跑过 / 提取失败），返回 None，
由上层 period 降级为「实时 +15 假设」处理，绝不臆造数字。
"""
from __future__ import annotations

from datetime import date as _date, timedelta
from common.pg import connect


def _date_range(start: str, end: str):
    s = _date.fromisoformat(start)
    e = _date.fromisoformat(end)
    cur = s
    while cur <= e:
        yield cur.isoformat()
        cur += timedelta(days=1)


def fetch_visit_rate_period(team_id: str, start: str, end: str) -> float | None:
    """区间商家拜访率（百分比）。无数据返回 None。

    team_id 当前忽略（拜访是「全公司批次」维度，落库 team_id='_all'）；
    但保留参数以兼容按 team 过滤的扩展。
    """
    con = connect()
    if con is None:
        return None
    visited = 0.0
    total = 0.0
    have = False
    try:
        with con.cursor() as cur:
            for d in _date_range(start, end):
                # visit_history 主键 (main_task_id, team_id, date)，team_id='_all'
                # 故每天至多一行，无需 rowid 排序。
                cur.execute(
                    "SELECT visited, total FROM visit_history WHERE date = %s",
                    (d,),
                )
                row = cur.fetchone()
                if row is None:
                    continue
                v = row[0]
                t = row[1]
                if t is None:
                    continue
                try:
                    tv = float(t)
                    vv = float(v) if v is not None else 0.0
                except (TypeError, ValueError):
                    continue
                if tv <= 0:
                    continue
                visited += vv
                total += tv
                have = True
    except Exception:
        return None
    finally:
        con.close()
    if not have or total <= 0:
        return None
    return round(visited / total * 100.0, 2)
