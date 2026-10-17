"""IM 电联看板计算层：站点级 + 骑手级聚合（区间汇总 / 每日明细 / 较前日环比）。

行粒度 = 送达日期 × 站点 × 骑手（Quark 透视表展开）。本模块把一组行聚合为：
  · 区间汇总：5 个计数字段求和 + 2 个比率按「分子/分母」重算；
  · 每日明细（daily）：按日期分组同上口径，并带 dod（较前一自然日）；
  · 骑手级（riders）：按 (骑手id, 骑手姓名) 分组，含各自的区间汇总与每日明细。

口径（与报表一致，比率一律由单量重算、不跨行平均）：
  · 送达电联率   = 剔除后有效电联单量 / 剔除后接单量 × 100
  · IM及时回复率 = IM及时回复单量 / IM咨询单量 × 100
  · 环比 dod：比率为百分点差(pp)，计数为绝对差 + 涨幅%；前一自然日无数据时不编造（null）。

展示区间以落盘文件的 start/end 为准：Nest 取数时会多取一天（baseline_date）作为
首个展示日期的环比基准，该基准日**不计入**汇总与每日表，只用于算 dod。
"""

import datetime as _dt

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


def _date_of(r):
    """行的送达日期 → 'YYYY-MM-DD'（落盘值是 'YYYY-MM-DD HH:MM:SS'，取前 10 位）。"""
    return S.to_text(r.get(S.F_DATE))[:10]


def _prev_day(d):
    """前一自然日（ISO）。"""
    y, m, dd = (int(x) for x in d.split("-"))
    return (_dt.date(y, m, dd) - _dt.timedelta(days=1)).isoformat()


def _dod(prev, cur):
    """环比：比率为百分点差(pp)，计数为绝对差 + 涨幅%（分母为 0 时 pct 记 None）。"""
    def rate_delta(a, b):
        return None if a is None or b is None else round(b - a, 2)

    def cnt_delta(a, b):
        diff = b - a
        pct = round(diff * 100.0 / a, 2) if a else None
        return {"diff": diff, "pct": pct}

    return {
        "call_rate": rate_delta(prev["call_rate"], cur["call_rate"]),
        "im_reply_rate": rate_delta(prev["im_reply_rate"], cur["im_reply_rate"]),
        "im_consult_cnt": cnt_delta(prev["im_consult_cnt"], cur["im_consult_cnt"]),
        "im_reply_cnt": cnt_delta(prev["im_reply_cnt"], cur["im_reply_cnt"]),
        "valid_call_orders": cnt_delta(prev["valid_call_orders"], cur["valid_call_orders"]),
    }


def _daily(rows):
    """按日期分组聚合；每天带 dod（较前一自然日）。

    只在「前一自然日也有数据」时给 dod——中间断档的日子不与更早的日子比较，
    避免把 3 天前的量当成「前一日」算出误导性环比。
    """
    by_date = {}
    for r in rows or []:
        d = _date_of(r)
        if not d:
            continue
        by_date.setdefault(d, []).append(r)
    out = []
    prev_date = None
    prev_m = None
    for d in sorted(by_date):
        m = _agg(by_date[d])
        dod = _dod(prev_m, m) if (prev_date == _prev_day(d) and prev_m is not None) else None
        out.append({"date": d, **m, "dod": dod})
        prev_date, prev_m = d, m
    return out


def _in_range(d, d0, d1):
    if not d:
        return False
    if d0 and d < d0:
        return False
    if d1 and d > d1:
        return False
    return True


def _riders(all_rows, d0, d1):
    """骑手级：按 (骑手id, 骑手姓名) 分组，每组含区间汇总 + 每日明细（均按展示区间过滤）。"""
    groups = {}
    order = []
    for r in all_rows or []:
        key = (S.to_text(r.get(S.F_RIDER_ID)), S.to_text(r.get(S.F_RIDER_NAME)))
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(r)
    out = []
    for key in order:
        rid, rname = key
        rrows = groups[key]
        disp = [r for r in rrows if _in_range(_date_of(r), d0, d1)]
        daily = [x for x in _daily(rrows) if _in_range(x["date"], d0, d1)]
        out.append({
            "rider_id": rid,
            "rider_name": rname or rid,
            **_agg(disp),
            "daily": daily,
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
    """单站实时概览：区间汇总 + 每日明细(含环比) + 骑手明细(含各自的每日明细)。

    展示区间以**前端传入**的 start/end 为准（用户所选区间）；落盘仅作兜底
    （未传区间时回落已落盘区间）。落盘数据可能多含一天（环比基准），该日不进
    汇总/每日表，只用于算首个展示日的 dod。落盘不可用 → need_refresh=True。
    """
    team_id = str(team_id)
    st = S.fetch_status() or {}
    # 前端传入区间优先；未传则回落已落盘区间
    d0 = start or st.get("start") or ""
    d1 = end or st.get("end") or ""
    key_date = "%s~%s" % (d0, d1)
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
            "display_range": {"start": d0, "end": d1},
            "daily": [],
            "riders": [],
            **EMPTY_METRICS,
        }

    all_rows = S.rows_of_team(rows, team_id)
    disp = [r for r in all_rows if _in_range(_date_of(r), d0, d1)]
    daily = [x for x in _daily(all_rows) if _in_range(x["date"], d0, d1)]
    result = {
        "team_id": team_id,
        "team_name": _team_name(disp, team_id),
        "need_refresh": False,
        "data_status": "ok",
        "data_note": None,
        "display_range": {"start": d0, "end": d1},
        **_agg(disp),
        "daily": daily,
        "riders": _riders(all_rows, d0, d1),
    }
    CACHE.put_result(MODULE, team_id, key_date, "", "cache", result)
    return result


def cache_key_range():
    """当前落盘数据对应的日期区间（缓存键），供 Nest 落盘后失效回调使用。"""
    st = S.fetch_status() or {}
    return "%s~%s" % (st.get("start") or "", st.get("end") or "")
