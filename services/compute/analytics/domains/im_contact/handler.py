#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""IM 电联看板 —— HTTP handler（/api/im-contact/data）。

本文件与同包的 board.py / source.py 构成本看板在 Python 侧的完整私有实现：
  · board.py    区间聚合（电联率 / IM 及时回复率，站点 + 骑手）
  · source.py   IM 库读取（本看板私有数据源）
  · handler.py  站点权限闸门 + 调用 board + 响应塑形
                （2026-10-21 从共享的 compute_api/handlers.py 迁出）

隔离约定（各看板独立、同一指标可多套算法）：
  共享 handlers.py 里只保留一行转发，不含任何 IM 电联的业务逻辑。
  改本看板的字段 / 区间回落 / 响应结构只动本目录，不会波及考核、配送超时等看板。

调用约定：get_im_contact(h, qs)；h 为 compute_api 的 `_GatewayHandler` 替身，
提供 `_json` / `_enforce_team_scope`（见 compute_api/handlers.py 模块文档）。
"""


def get_im_contact(self, qs):
    """站点 IM 电联数据：权限闸门 → 区间回落 → board.build_one → 统一响应塑形。"""
    from analytics.domains.im_contact import board as ICB

    team = (qs.get("team") or [None])[0]
    if not team:
        self._json({"ok": False, "error": "缺少 team 参数"}, 400); return
    mode, val = self._enforce_team_scope(team)
    if mode == "deny":
        return
    try:
        from analytics.core import im_source as ICS
        # 前端展示区间（近 7 天等）；缺省回落已落盘区间。计算按传入区间进行。
        start = (qs.get("start") or [None])[0] or ""
        end = (qs.get("end") or [None])[0] or ""
        st = ICS.fetch_status() or {}
        start = start or st.get("start") or ""
        end = end or st.get("end") or ""
        row = ICB.build_one(team, start, end)
        miss = bool(row.get("need_refresh"))
        self._json({
            "ok": True,
            "team": team,
            "teamName": row.get("team_name"),
            # 响应顶层的 start/end = 已落盘区间（"数据区间"标签用），非展示区间
            "start": st.get("start"),
            "end": st.get("end"),
            "basis": "range",
            # 取数时间：落库的 last_fetched_at（Nest 写入时刻）
            "fetched_at": st.get("fetched_at"),
            "rows": [] if miss else [row],
            "data_status": "no_data" if miss else (row.get("data_status") or "ok"),
            "data_note": row.get("data_note"),
            "need_refresh": miss,
        })
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "data_status": "error", "need_refresh": False})
