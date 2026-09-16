#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据大屏 —— 站点维度运单量汇总（原始数据与判定口径都复用既有实现，不另起一套）。

数据来源
--------
dashboard/data/orders_<teamId>_<date>.json —— 等价于 cache.load_raw("orders", team, date)，
即 aeolus queryTracking 的运单明细原始行（list[dict]，99+ 个原始键），
由「标准达成 → 全量刷新」落盘（dashboard/standard/refresh_all.py）。

口径（单一来源 dashboard/standard/order_rules.py，与标准达成 / 时段出勤完全一致）
------------------------------------------------------------------------------
  归属日 = 骑手接单时间（acceptAtLast，缺失兜底创建时间）的北京时间日期；
           跨午夜的订单归到「接单那一天」，不会被两天各计一次。

抓取口径与归属口径的配合（重要）
------------------------------
  接口没有「接单时间」维度，只有 运单生成 / 用户下单 / 运单终态 三个
  （见 get_data.delivery.TIME_FIELDS）；落盘的运单缓存按**运单生成时间**抓
  （refresh_all._fetch_shared_orders 显式传 trackingCreated）。
  生成必然早于/等于接单，所以「接单日在 D」的单，生成时间落在 [D-1, D]
  —— 本模块据此读 D 与 D-1 两个文件（LOOKBACK_DAYS）。
  历史遗留：早期缓存是按「运单终态时间」抓的，跨午夜单（今天接、次日完成）落在次日文件里，
  今天算不到、次日又归属不符 → 两天都丢，属系统性少计。要修正历史区间需按新口径重新刷新那几天。
  接单量     accepted      = 归属日落在 [start, end] 内的运单条数（不论最终是否完成）
  配送完成量 completed     = 其中 is_completed() 为真（stateDesc=配送成功 / state=40）
  有效单量   valid         = 其中 is_valid_order() 为真（完成 + 非作弊 + 非逆向 + 非改派）
  完成率     complete_rate = completed / accepted

站点清单 = 通用站点表 TEAM_NAMES ∪ 缓存里实际出现过的站点，
所以「有数据但不在表里」的站点不会被漏掉；反之没有数据的日子会记进 missing，便于前端如实提示。
"""
import os
import re
import sys
import glob
import datetime

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from dashboard.standard import cache as CACHE
from dashboard.standard import order_rules as RULES
from dashboard.get_data import TEAM_NAMES

BJ = datetime.timezone(datetime.timedelta(hours=8))
_RAW_KIND = "orders"
_DATA_DIR = os.path.join(_ROOT, "dashboard", "data")
_FNAME_RE = re.compile(r"^orders_(?P<team>[^_]+)_(?P<date>\d{4}-\d{2}-\d{2})\.json$")
NAME_KEYS = ("teamName", "团队/站点名称", "团队名称")
# 「接单日在 D」的单，其运单生成时间最早落在 D-1（生成 <= 接单，且两者通常只隔几分钟）
LOOKBACK_DAYS = 1


def _prev_date(date):
    """归属日往前推 LOOKBACK_DAYS 天：用于读取「生成时间落在前一天」的运单。"""
    return (datetime.date.fromisoformat(date) - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()


def _daterange(start, end):
    """[start, end] → 北京时间自然日列表（ISO 字符串，升序）。"""
    d0 = datetime.date.fromisoformat(start)
    d1 = datetime.date.fromisoformat(end)
    if d1 < d0:
        d0, d1 = d1, d0
    return [(d0 + datetime.timedelta(days=i)).isoformat() for i in range((d1 - d0).days + 1)]


def _cached_teams(date):
    """该日期在缓存里出现过的站点 id（只解析文件名，不读文件内容）。"""
    out = []
    for p in glob.glob(os.path.join(_DATA_DIR, "orders_*_%s.json" % date)):
        m = _FNAME_RE.match(os.path.basename(p))
        if m:
            out.append(m.group("team"))
    return out


def _count_day(team_id, date):
    """单站点单日聚合（只计「接单日 = date」的运单）；两份文件都为空时返回 None。

    读 D 与 D-1 两份缓存：抓取按**运单生成时间**落盘，而生成 <= 接单，
    所以「接单日在 D」的单其生成时间可能落在 D-1（深夜生成、凌晨接单）—— 只看 D 会漏。
    两文件按 trackingId 去重（分页抖动会产生整行完全相同的重复）。
    """
    rows, seen = [], set()
    for d in (date, _prev_date(date)):
        for o in (CACHE.load_raw(_RAW_KIND, team_id, d) or []):
            tid = o.get("trackingId")
            if tid is not None:
                if tid in seen:
                    continue
                seen.add(tid)
            rows.append(o)
    if not rows:
        return None
    acc = comp = val = 0
    name = ""
    for o in rows:
        if not name:
            name = str(RULES.order_val(o, NAME_KEYS) or "")
        ms = RULES.accept_ms(o)
        if ms is None:
            continue
        if RULES.ms_to_ymd(ms) != date:
            continue
        acc += 1
        if RULES.is_completed(o):
            comp += 1
        if RULES.is_valid_order(o):
            val += 1
    return {"accepted": acc, "completed": comp, "valid": val, "name": name}


def build_site_orders(start, end):
    """站点维度运单量汇总。[start, end] 为北京时间自然日（含端点）。"""
    dates = _daterange(start, end)

    # 1) 先摸清区间内「哪些站点 × 哪些天」有缓存
    have = set()
    teams_seen = set()
    for date in dates:
        for tid in _cached_teams(date):
            have.add((tid, date))
            teams_seen.add(tid)
    all_teams = sorted(set(TEAM_NAMES.keys()) | teams_seen)

    # 2) 逐站点聚合（有缓存的日子才参与求和）
    sites = []
    for tid in all_teams:
        per = {}
        name = TEAM_NAMES.get(tid, "")
        for date in dates:
            if (tid, date) not in have:
                continue
            rec = _count_day(tid, date)
            if rec is None:
                continue
            per[date] = rec
            if not name and rec.get("name"):
                name = rec["name"]
        acc = sum(v["accepted"] for v in per.values())
        comp = sum(v["completed"] for v in per.values())
        val = sum(v["valid"] for v in per.values())
        sites.append({
            "team_id": tid,
            "team_name": name or tid,
            "accepted": acc,
            "completed": comp,
            "valid": val,
            # 完成率 / 有效单占比：口径写在分母（接单量）上，前端无需再算
            "complete_rate": round(comp / acc, 4) if acc else 0.0,
            "valid_rate": round(val / acc, 4) if acc else 0.0,
            "days": len(per),
            "daily": [dict(date=d, **per[d]) for d in sorted(per)],
        })
    sites.sort(key=lambda s: s["accepted"], reverse=True)

    totals = {
        "sites": len([s for s in sites if s["days"]]),
        "accepted": sum(s["accepted"] for s in sites),
        "completed": sum(s["completed"] for s in sites),
        "valid": sum(s["valid"] for s in sites),
    }
    totals["complete_rate"] = round(totals["completed"] / totals["accepted"], 4) if totals["accepted"] else 0.0
    totals["valid_rate"] = round(totals["valid"] / totals["accepted"], 4) if totals["accepted"] else 0.0

    # 3) 数据缺口：应有无缓存的日子（如实告诉前端，别让空白卡片显得像 0 单）
    missing = []
    for tid in all_teams:
        for date in dates:
            if (tid, date) not in have:
                missing.append({"team_id": tid, "team_name": TEAM_NAMES.get(tid, tid), "date": date})

    # 最新缓存落盘时间：大屏上标「数据截止」
    cached_at = None
    for tid in all_teams:
        t = CACHE.latest_cache_time(tid, dates[-1])
        if t and (cached_at is None or t > cached_at):
            cached_at = t

    return {
        "ok": True,
        "basis": "accept_date",          # 归属口径：按骑手接单时间的北京时间自然日
        "range": {"start": dates[0], "end": dates[-1], "days": len(dates)},
        "sites": sites,
        "totals": totals,
        "missing": missing[:60],
        "missing_count": len(missing),
        "cached_at": cached_at,
    }


if __name__ == "__main__":
    import json
    import argparse

    _a = argparse.ArgumentParser(description="站点维度运单量汇总（数据大屏数据源）")
    _a.add_argument("--start", default=(datetime.date.fromisoformat(CACHE.today_ymd())
                                        - datetime.timedelta(days=6)).isoformat())
    _a.add_argument("--end", default=CACHE.today_ymd())
    _ns = _a.parse_args()
    print(json.dumps(build_site_orders(_ns.start, _ns.end), ensure_ascii=False, indent=2))
