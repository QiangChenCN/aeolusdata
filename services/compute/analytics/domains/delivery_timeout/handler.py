#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""配送超时看板 —— HTTP handler（/api/delivery-timeout/data）。

本文件与同包的 timeout.py 构成本看板在 Python 侧的完整私有实现：

  · timeout.py   纯计算（站点超时汇总 / 骑手下钻 / 订单明细）
  · handler.py   站点权限闸门 + 调用 timeout + 响应塑形
                 （2026-10-21 从共享的 compute_api/handlers.py 迁出）

隔离约定（各看板独立、同一指标可多套算法）：
  共享 handlers.py 里只保留一行转发，不含任何配送超时的业务逻辑。
  因此改本看板的取数口径 / 响应字段，只动本目录，不会波及
  标准达成 / 考核 / IM 电联等其他看板。

调用约定：get_delivery_timeout(h, qs)；h 为 compute_api 的 `_GatewayHandler`
替身，提供 `_json` / `_enforce_team_scope`（见 compute_api/handlers.py 模块文档）。
"""


def get_delivery_timeout(self, qs):
    """配送超时看板站点数据：站点权限闸门 → timeout.build_one → 统一响应塑形。"""
    from analytics.core import cache as CACHE
    from analytics.domains.delivery_timeout import data_source as DTS
    from analytics.domains.delivery_timeout import timeout as RTO

    team = (qs.get("team") or [None])[0]
    if not team:
        self._json({"ok": False, "error": "缺少 team 参数"}, 400); return
    mode, val = self._enforce_team_scope(team)
    if mode == "deny":
        return
    try:
        date = CACHE.today_ymd()
        row = RTO.build_one(team, date)
        from analytics.core import result_store as RS
        RS.save_result("timeout", team, date, row)
        miss = bool(row.get("need_refresh"))
        self._json({
            "ok": True,
            "team": team,
            "teamName": row.get("team_name"),
            "start": date, "end": date, "basis": "day",
            # 取数时间：实时运单明细（PG）本轮入库时间（北京时间），即「拉取数据」的时刻
            "fetched_at": DTS.fetched_at(team, date),
            "rows": [] if miss else [row],
            "data_status": "no_data" if miss else (row.get("data_status") or "ok"),
            "data_note": row.get("data_note"),
            "need_refresh": miss,
        })
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "start": CACHE.today_ymd(), "end": CACHE.today_ymd(),
                    "data_status": "error", "need_refresh": False})
