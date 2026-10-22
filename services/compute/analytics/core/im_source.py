# >>> python-home bootstrap (added by layout migration) >>>
import os as _os
import sys as _sys

def _find_python_home():
    d = _os.path.dirname(_os.path.abspath(__file__))
    # 计算服务代码根：同时含 analytics/ 与 compute_api/ 子目录
    while d and not (
        _os.path.isdir(_os.path.join(d, "analytics"))
        and _os.path.isdir(_os.path.join(d, "compute_api"))
    ):
        d = _os.path.dirname(d)
    return d

def _find_repo_root():
    d = _os.path.dirname(_os.path.abspath(__file__))
    # 仓库根：含 .git 或根 package.json
    while d and d != _os.path.dirname(d) and not (
        _os.path.exists(_os.path.join(d, ".git"))
        or _os.path.exists(_os.path.join(d, "package.json"))
    ):
        d = _os.path.dirname(d)
    return d

PY_HOME = _find_python_home()
ROOT = _find_repo_root()
_ROOT = ROOT
if PY_HOME and PY_HOME not in _sys.path:
    _sys.path.insert(0, PY_HOME)
# <<< python-home bootstrap <<<


"""IM 电联看板数据读取层（PostgreSQL only，不再保留 SQLite）。

落库由 Nest ImContactStoreService 写入（PG 同源），按 送达日期+骑手id 去重累计；
同时 Nest 每月导出可读备份 `apps/api/runtime/IM电联明细.YYYY-MM.json`（对账用，本模块不直接读）。
本模块只做读取（计算的输入端口）：
    · load_rows(start, end) 按区间（或全量）取扁平 dict 列表；
    · fetch_status() 取数状态（是否失败 / 取数时间 / 已落盘区间 / 累计条数）。
rows 键为 Quark 报表字段中文名（见下方 F_* 常量），计数字段已是数字，比率为百分数。

未配置 DATABASE_URL 时 connect() 返回 None，load_rows/fetch_status 返回 None（优雅降级，不回退 SQLite）。
"""

import json
from common.pg import connect, pg_configured

# ---- 字段中文键（与 Nest 落盘行、Quark 报表 473269 字段配置一一对应）----
F_DATE = "送达日期"
F_WAR_ZONE = "战区"
F_CITY = "城市"
F_TEAM_ID = "站点id"
F_TEAM_NAME = "站点名称"
F_ZONE_ID = "商圈id"
F_ZONE_NAME = "商圈名称"
F_CAPACITY_LINE = "运力线"
F_AGENT_ID = "代理商id"
F_AGENT_NAME = "代理商名称"
F_RIDER_ID = "骑手id"
F_RIDER_NAME = "骑手姓名"
F_CALL_RATE = "送达电联率"
F_IM_REPLY_RATE = "IM及时回复率"
F_IM_REPLY_CNT = "IM及时回复单量"
F_IM_CONSULT_CNT = "IM咨询单量"
F_CALL_EXCLUDED = "电联剔除单量"
F_AFTER_EXCLUDE_ORDERS = "剔除后接单量"
F_VALID_CALL_ORDERS = "剔除后有效电联单量"

# 计数字段（跨行求和用；两个比率为派生量，禁止跨行平均）
COUNT_FIELDS = (
    F_IM_REPLY_CNT,
    F_IM_CONSULT_CNT,
    F_CALL_EXCLUDED,
    F_AFTER_EXCLUDE_ORDERS,
    F_VALID_CALL_ORDERS,
)


def fetch_status():
    """取数状态（供看板区分「从未拉取」与「本次拉取失败」并给出可操作提示）。

    数据源 = PostgreSQL（与 Nest 落盘 / 计算读侧同源）：
      · last_fetch_ok      '1' / '0' / 缺省（从未落盘）
      · last_fetch_error / last_fetched_at  见 im_contact_meta 表
      · start/end = 库内已落盘数据的最小/最大 送达日期（即"已落盘区间"）
    未配置 DATABASE_URL / 连接失败 / 无记录 → None（视为从未拉取）。
    """
    con = connect()
    if con is None:
        return None
    try:
        with con.cursor() as cur:
            ok_raw = cur.execute(
                "SELECT v FROM im_contact_meta WHERE k='last_fetch_ok'"
            ).fetchone()
            err_raw = cur.execute(
                "SELECT v FROM im_contact_meta WHERE k='last_fetch_error'"
            ).fetchone()
            fa_raw = cur.execute(
                "SELECT v FROM im_contact_meta WHERE k='last_fetched_at'"
            ).fetchone()
            rng = cur.execute(
                "SELECT MIN(stat_date), MAX(stat_date) FROM im_contact_records"
            ).fetchone()
            cnt = cur.execute("SELECT COUNT(*) FROM im_contact_records").fetchone()
        ok_v = ok_raw[0] if ok_raw else None
        fetch_ok = True if ok_v == "1" else (False if ok_v == "0" else None)
        return {
            "fetch_ok": fetch_ok,
            "fetch_error": (err_raw[0] if err_raw else "") or None,
            "start": (rng[0] if rng else None) or None,
            "end": (rng[1] if rng else None) or None,
            "fetched_at": (fa_raw[0] if fa_raw else "") or None,
            "total": (cnt[0] if cnt else 0) or 0,
        }
    except Exception:
        return None
    finally:
        con.close()


def load_rows(start=None, end=None):
    """读 IM 电联明细原始行（Nest 已累计落库到 PostgreSQL）。

    返回 list[dict]；不可用返回 None，不可用包含：
      · 未配置 DATABASE_URL / 连接失败；
      · 本次取数失败（last_fetch_ok='0'，Nest 置位，历史数据保留但不当有效数据）。
    指定 [start, end]（YYYY-MM-DD）只取该区间；否则取全量（由 board 按展示区间过滤 + 算环比）。
    """
    con = connect()
    if con is None:
        return None
    try:
        with con.cursor() as cur:
            ok_raw = cur.execute(
                "SELECT v FROM im_contact_meta WHERE k='last_fetch_ok'"
            ).fetchone()
            if ok_raw and ok_raw[0] == "0":
                return None
            if start and end:
                rows = cur.execute(
                    "SELECT raw_json FROM im_contact_records "
                    "WHERE stat_date >= %s AND stat_date <= %s ORDER BY stat_date, rider_id",
                    (start, end),
                ).fetchall()
            else:
                rows = cur.execute(
                    "SELECT raw_json FROM im_contact_records ORDER BY stat_date, rider_id"
                ).fetchall()
        return [json.loads(r[0]) for r in rows]
    except Exception:
        return None
    finally:
        con.close()


def to_num(v):
    """宽松数值化：None/空/非法 → 0.0；数字字符串（含 '1,234'/'85.3%'）→ float。"""
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "").rstrip("%")
    if not s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def to_int(v):
    return int(to_num(v))


def to_text(v):
    """维度值 → 去空白的字符串（None → ''）。"""
    if v is None:
        return ""
    return str(v).strip()


def rows_of_team(rows, team_id):
    """按站点过滤行；team_id 为空表示全部站点。"""
    tid = to_text(team_id)
    out = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        if tid and to_text(r.get(F_TEAM_ID)) != tid:
            continue
        out.append(r)
    return out


def team_ids(rows):
    """落盘数据里出现过的全部站点 id（保持首次出现顺序）。"""
    seen = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        tid = to_text(r.get(F_TEAM_ID))
        if tid and tid not in seen:
            seen.append(tid)
    return seen
