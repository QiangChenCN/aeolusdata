# >>> python-home bootstrap (added by layout migration) >>>
import os as _os
import sys as _sys
def _find_python_home():
    d = _os.path.dirname(_os.path.abspath(__file__))
    while d and _os.path.basename(d) != "python":
        d = _os.path.dirname(d)
    return d
PY_HOME = _find_python_home()
ROOT = _os.path.dirname(PY_HOME) if PY_HOME else _os.path.dirname(
    _os.path.dirname(_os.path.abspath(__file__)))
if PY_HOME and PY_HOME not in _sys.path:
    _sys.path.insert(0, PY_HOME)
# <<< python-home bootstrap <<<

"""IM 电联看板数据读取层：读 Nest 落盘的 `backend/data/im-contact-实时.json`。

落盘 payload 形态（由 Nest ImContactFetchService 写入，与考核看板违规明细同构）：
    { start, end, fetched_at, fetch_ok, fetch_error, total, rows }
其中 rows 为扁平 dict 列表，键为 Quark 报表字段中文名（见下方 F_* 常量），
计数字段已是数字（Nest 落盘前做过 coercion），比率为报表原始值（字符串/数字均可）。
"""

import json
import os

DATA_FILE = "im-contact-实时.json"

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


def _file_path():
    return os.path.join(ROOT, "backend", "data", DATA_FILE)


def load_payload():
    """读落盘 payload；文件缺失 / 损坏返回 None。"""
    p = _file_path()
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return None
    return d if isinstance(d, dict) else None


def load_rows():
    """读落盘 rows；不可用返回 None。

    不可用包含：从未落盘 / 本次取数失败（fetch_ok=false，Nest 覆盖写时置位）/
    rows 结构异常。与考核看板违规明细读侧同一口径——失败不把盘上旧数据当有效数据。
    """
    d = load_payload()
    if d is None:
        return None
    if d.get("fetch_ok") is False:
        return None
    rows = d.get("rows")
    return rows if isinstance(rows, list) else None


def fetch_status():
    """取数状态（供看板区分「从未拉取」与「本次拉取失败」并给出可操作提示）。"""
    d = load_payload()
    if d is None:
        return None
    return {
        "fetch_ok": d.get("fetch_ok"),
        "fetch_error": d.get("fetch_error"),
        "start": d.get("start"),
        "end": d.get("end"),
        "fetched_at": d.get("fetched_at"),
        "total": d.get("total"),
    }


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
