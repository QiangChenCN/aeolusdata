"""IM 电联看板计算层：站点级 + 骑手级聚合。

行粒度 = 送达日期 × 站点 × 骑手（Quark 透视表展开）。本模块把一组行聚合为：
  · 站点级指标：5 个计数字段求和 + 2 个比率按「分子/分母」重算；
  · 骑手级指标：按 (骑手id, 骑手姓名) 分组，同上口径。

比率一律由单量重算，**不跨行平均**报表里的比率值（避免「比率的平均」失真）。
缓存键带日期区间（start~end），换区间取数自然换键；Nest 落盘后回调失效。
"""

from analytics import cache as CACHE
from analytics.im_contact import source as S

MODULE = "im_contact_v1"


def _agg(rows):
    """一组行 → 聚合指标（计数求和 + 比率重算）。"""
    c = {k: 0 for k in S.COUNT_FIELDS}
    for r in rows or []:
        for k in S.COUNT_FIELDS:
            c[k] += S.to_int(r.get(k))
    reply, consult = c[S.F_IM_REPLY_CNT], c[S.F_IM_CONSULT_CNT]
    valid_call, orders = c[S.F_VALID_CALL_ORDERS], c[S.F_AFTER_EXCLUDE_ORDERS]
    return {
        "im_reply_cnt": reply,
        "im_consult_cnt": consult,
        "call_excluded_cnt": c[S.F_CALL_EXCLUDED],
        "after_exclude_orders": orders,
        "valid_call_orders": valid_call,
        # 送达电联率 = 剔除后有效电联单量 / 剔除后接单量
        "call_rate": (valid_call * 100.0 / orders) if orders else None,
        # IM及时回复率 = IM及时回复单量 / IM咨询单量
        "im_reply_rate": (reply * 100.0 / consult) if consult else None,
    }


EMPTY_METRICS = {
    "im_reply_cnt": 0, "im_consult_cnt": 0, "call_excluded_cnt": 0,
    "after_exclude_orders": 0, "valid_call_orders": 0,
    "call_rate": None, "im_reply_rate": None,
}


def _riders(rows):
    """骑手级：按 (骑手id, 骑手姓名) 分组聚合，按 IM咨询单量降序。"""
    groups = {}
    order = []
    for r in rows or []:
        rid = S.to_text(r.get(S.F_RIDER_ID))
        rname = S.to_text(r.get(S.F_RIDER_NAME))
        key = (rid, rname)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(r)
    out = []
    for key in order:
        rid, rname = key
        out.append({
            "rider_id": rid,
            "rider_name": rname or rid,
            **_agg(groups[key]),
        })
    out.sort(key=lambda x: (-x["im_consult_cnt"], x["rider_id"]))
    return out


def _team_name(rows, team_id):
    """站点名：取落盘行里的站点名称；缺失回落 id。"""
    for r in rows or []:
        nm = S.to_text(r.get(S.F_TEAM_NAME))
        if nm:
            return nm
    return str(team_id)


def build_one(team_id, start=None, end=None):
    """单站实时概览：站点级指标 + 骑手明细。

    start/end 仅作缓存键的一部分（数据以落盘文件里的区间为准）；缺省取落盘区间。
    落盘不可用 → need_refresh=True（前端据此提示去刷新，而非展示 0）。
    """
    team_id = str(team_id)
    st = S.fetch_status() or {}
    rng = st.get("start") or start or ""
    rng_end = st.get("end") or end or ""
    key_date = "%s~%s" % (rng, rng_end)
    cached = CACHE.get_result(MODULE, team_id, key_date, "", "cache")
    if cached is not None:
        return cached

    rows = S.load_rows()
    if rows is None:
        if st.get("fetch_ok") is False:
            err = (st.get("fetch_error") or "").strip()
            note = "IM 电联数据本次拉取失败，指标暂不展示%s，请点「刷新数据」重试" % (
                ("（%s）" % err) if err else "")
        elif not st:
            note = "IM 电联数据尚未拉取，请点「刷新数据」拉取"
        else:
            note = "IM 电联数据不可用，请点「刷新数据」重试"
        return {
            "team_id": team_id,
            "team_name": team_id,
            "need_refresh": True,
            "data_status": "no_data",
            "data_note": note,
            "riders": [],
            **EMPTY_METRICS,
        }

    trows = S.rows_of_team(rows, team_id)
    result = {
        "team_id": team_id,
        "team_name": _team_name(trows, team_id),
        "need_refresh": False,
        "data_status": "ok",
        "data_note": None,
        **_agg(trows),
        "riders": _riders(trows),
    }
    CACHE.put_result(MODULE, team_id, key_date, "", "cache", result)
    return result


def cache_key_range():
    """当前落盘数据对应的日期区间（缓存键），供 Nest 落盘后失效回调使用。"""
    st = S.fetch_status() or {}
    return "%s~%s" % (st.get("start") or "", st.get("end") or "")
