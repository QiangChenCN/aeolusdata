#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标准达成看板 —— 骑手维度计算逻辑。

把「实时考勤(骑手级) / 运单明细(有效单量) / 等级标准(全天阈值)」三源关联到
骑手粒度，算出每个骑手的 12 项指标，供 /api/standard/riders 渲染。

与 achievement.py（站点×日期 全天维度）互补：本模块把同一批数据下钻到「骑手」。

**全天口径（2026-09-09 起）**：标准达成一律按整天统计，不再逐时段判定。
  · 有效单量 / 有效在线时长 都取**全天**值（不再取时段切片）
  · 达成门槛取等级标准的「标准1」全天阈值（考勤接口没有全天目标字段，
    只有 timeFinishOrderTarget 这类时段目标，全天口径下不可用）
  · 时段码 time_code 仍会传给考勤接口（该接口必须传才返回数据），
    但它**只用于取数**，不参与任何达成判定 —— 见 att_time_code / att_time_name

12 项指标（按用户给定顺序）：
  1  rider_id              骑手ID
  2  rider_name            骑手姓名
  3  team_id / team_name   所属站点
  4  valid_orders          全天有效单量（接单时间归属当天 + 配送完成 + 剔除逆向单/改派单）
  5  valid_online_min      全天有效在线时长（分钟，fullDayValidOnlineTime）
  6  achieved              达成标准（全天：有效单量≥标准1 且 有效在线时长≥标准1）
  7  next_level_order_gap  距离下一等级单量差值（升一级还差多少有效单量）
  8  prev_level_duration_gap 距离上一等级有效时长差值（升一级还差多少有效在线分钟）
  9  online_status         在线状态
 10  est_achievable        预计达标（仅看有效在线时长，cur_min + 剩余分钟 是否够 6h）
 11  full_day_orders       全天有效单量
 12  full_day_online_min   全天有效在线时长（分钟）

等级标准（RIDER_GRADE_STANDARD）：按「全天有效单量 + 全天有效在线分钟」双门槛
从低到高分级。阈值属于业务口径，当前为占位默认值，需按实际考核规则校准
（见下方常量注释）。字段 7 / 8 的「等级」即指这套分级；两字段均表示
「距离升到下一级还差多少」（单量轴 / 有效时长轴），已封顶则记 0。

对外 API：
  compute(team_id, time_code=None, start=None, end=None, month=None) -> dict
"""
import os
import sys
import json
import datetime

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from get_data.attendance import fetch_team as _att_fetch
from aeolus_sdk import login as L
from dashboard.standard import grade_standards as GS
from dashboard.standard import cache as CACHE
from dashboard.standard import orders_fetch as OF
from dashboard.standard import order_rules as OR

BJ = datetime.timezone(datetime.timedelta(hours=8))

TEAM_NAMES = {
    "917521130": "东莞市黄江镇站-UB",
    "917521136": "东莞市长安万科站-UB",
    "917521139": "东莞市大岭山大学城站-UB",
}

# 全天达成门槛取自等级标准的第几档（levels[0]=未定级，levels[1]=标准1）。
# 业务上「达成」= 至少达到最低一档标准，因此默认取 1（标准1）；要调高门槛改这里即可。
ACHIEVE_LEVEL_INDEX = 1

# 时段窗口（北京分钟数）：与 jobs/attendance/attendance.py TIME_SLOTS 对齐。
# 仅用于「考勤接口取数」——该接口必须传 time_code 才返回数据。
# 全天口径下它不参与任何达成判定（标准达成一律按整天统计）。
TIME_SLOTS = {
    100: (0, 120, "凌晨1"),
    111: (360, 480, "早餐1"),
    112: (480, 630, "早餐2"),
    120: (630, 810, "午高峰"),
    130: (810, 930, "下午茶1"),
    131: (930, 1050, "下午茶2"),
    140: (1050, 1200, "晚高峰"),
    150: (1200, 1320, "夜宵1"),
    151: (1320, 1440, "夜宵2"),
    2: (0, 0, "休息"),
    9999: (0, 0, "全天"),
}

# 骑手等级标准（占位默认值，需按业务口径校准）。
# 每档：level（序号，0 为兜底未定级）/ name / min_valid_orders（全天有效单量下限）
#        / min_valid_minutes（全天有效在线分钟下限）。从低到高排列。
# 等级标准由 dashboard.standard.grade_standards.build_levels(team_id, month) 提供；
# _grade() 现在吃传入的 levels，不再读这个常量（保留以备离线/未配置场景兜底）

# 取数键与「有效单」口径 **单一来源** = dashboard.standard.order_rules
# （站点维度 achievement.py 用的是同一份，避免两边口径漂移）。
# 这里只做别名透出，本模块不再自己实现任何有效性判定。
RIDER_ID_KEYS = OR.RIDER_ID_KEYS
RIDER_NAME_KEYS = OR.RIDER_NAME_KEYS
TEAM_KEYS = OR.TEAM_KEYS
CREATE_KEYS = OR.CREATE_KEYS
ACCEPT_KEYS = OR.ACCEPT_KEYS          # 订单日期归属以此为准（骑手接单时间）
EXCLUDE_TYPE_KEYS = OR.EXCLUDE_TYPE_KEYS


def _order_val(o, keys):
    return OR.order_val(o, keys)


def _is_excluded_type(o):
    return OR.is_excluded_type(o)


def _is_valid_order(o):
    """有效单判定 —— 委托 order_rules（配送完成 + 非作弊 + 非异常 + 非逆向 + 非改派）。"""
    return OR.is_valid_order(o)


def _is_completed(o):
    """完成单判定 —— 委托 order_rules（仅认「是否配送完成」）。"""
    return OR.is_completed(o)


def _log(msg):
    ts = datetime.datetime.now(BJ).strftime("%H:%M:%S")
    print("[%s] [rider] %s" % (ts, msg), flush=True)


# ===================== 基础工具 =====================
def _norm_int(v):
    try:
        if v is None or v == "":
            return 0
        return int(float(v))
    except (ValueError, TypeError):
        return 0


def _to_min(sec):
    try:
        sec = float(sec or 0)
    except (ValueError, TypeError):
        sec = 0.0
    return sec / 60.0


def _ms_to_bj(ms):
    return datetime.datetime.fromtimestamp(int(ms) / 1000, tz=BJ)


def _ymd_to_ms(s, end_of_day=False):
    y, m, d = (int(x) for x in s.split("-"))
    if end_of_day:
        dt = datetime.datetime(y, m, d, 23, 59, 59, 999000, tzinfo=BJ)
    else:
        dt = datetime.datetime(y, m, d, 0, 0, 0, 0, tzinfo=BJ)
    return int(dt.timestamp() * 1000)


def _std_ymd(d):
    return d.strftime("%Y-%m-%d")


def _in_slot(tod_min, start_min, end_min):
    if start_min is None or end_min is None:
        return False
    if start_min == 0 and end_min == 0:
        return False
    if start_min <= end_min:
        return start_min <= tod_min < end_min
    return tod_min >= start_min or tod_min < end_min


# ===================== 时段解析（仅用于考勤取数）=====================
def current_slot_code():
    """返回当前北京时间所在的时段码（TIME_SLOTS 中第一个命中窗口的；无命中取已开始的最后一段）。"""
    now = datetime.datetime.now(BJ)
    now_min = now.hour * 60 + now.minute
    hit = None
    for code, (sm, em, _name) in TIME_SLOTS.items():
        if code in (2, 9999):
            continue
        if sm <= em and sm <= now_min < em:
            return code
        if sm <= now_min:
            hit = code
    return hit if hit is not None else 120


# ===================== 运单聚合（骑手×时段）=====================
def _aggregate_rider_orders(orders, team_id, today_ymd):
    """按骑手聚合「全天有效单量」，返回 {rider_id_str: count}。

    全天口径（2026-09-09 起）：不再区分时段，一个骑手当天只出一个数。
      · 归属：订单按「骑手接单时间」(acceptAtLast) 的北京时间日期归属，必须 = today_ymd
      · 有效：order_rules.is_valid_order（配送完成 + 非作弊 + 非异常 + 非逆向 + 非改派）
      · 去重：按 trackingId 兜底去重，同一单只计一次
      · 跨午夜单归属接单那天，不会被两天各计一次
      · 按 team_id 过滤（team_str 非空时），避免跨站串数据

    注：考勤接口必须传 time_code 才能拉到数据，所以时段码仍会作为参数传递
    （见 current_slot_code），但它**只用于取数**，不参与任何达成判定。
    """
    team_str = str(team_id).strip() if team_id else None
    counts = {}
    seen = set()
    for o in orders:
        rid = _order_val(o, RIDER_ID_KEYS)
        if rid is None:
            continue
        if not _is_valid_order(o):
            continue
        if team_str:
            ot = _order_val(o, TEAM_KEYS)
            if ot is not None and str(ot).strip() != team_str:
                continue
        # 归属时间：骑手接单时间（acceptAtLast）；缺失时兜底用创建时间，避免漏算
        raw = _order_val(o, ACCEPT_KEYS)
        if raw is None:
            raw = _order_val(o, CREATE_KEYS)
        if raw is None:
            continue
        try:
            ms = int(raw)
        except (ValueError, TypeError):
            continue
        if _std_ymd(_ms_to_bj(ms)) != today_ymd:
            continue  # 非当日接单，不计入当天有效单
        tid = o.get("trackingId")
        if tid is not None:
            if tid in seen:
                continue
            seen.add(tid)
        rs = str(rid)
        counts[rs] = counts.get(rs, 0) + 1
    return counts


def _aggregate_rider_all_orders(orders, team_id, today_ymd):
    """按骑手聚合「全天单量」，返回 {rider_id_str: count}。

    口径（2026-09-11 用户定稿）：
      · 仅统计状态为「配送成功 / 已完成（40）」的订单（即 _is_completed）
      · 不额外剔除作弊、逆向单、改派单、异常上报等任何记录
      · 日期归属：骑手接单时间（acceptAtLast）的北京时间日期 = today_ymd
      · 去重：按 trackingId 兜底去重，同一单只计一次
      · 跨午夜单归属接单当天，不会被两天各计一次
      · 按 team_id 过滤（team_str 非空时），避免跨站串数据

    与「全天有效单量」的区别：有效单在「配送成功」基础上，再剔除作弊 / 逆向 / 改派；
    而「全天单量」只卡状态，保留所有配送成功的记录。
    """
    team_str = str(team_id).strip() if team_id else None
    counts = {}
    seen = set()
    for o in orders:
        if not _is_completed(o):
            continue
        rid = _order_val(o, RIDER_ID_KEYS)
        if rid is None:
            continue
        if team_str:
            ot = _order_val(o, TEAM_KEYS)
            if ot is not None and str(ot).strip() != team_str:
                continue
        raw = _order_val(o, ACCEPT_KEYS)
        if raw is None:
            raw = _order_val(o, CREATE_KEYS)
        if raw is None:
            continue
        try:
            ms = int(raw)
        except (ValueError, TypeError):
            continue
        if _std_ymd(_ms_to_bj(ms)) != today_ymd:
            continue
        tid = o.get("trackingId")
        if tid is not None:
            if tid in seen:
                continue
            seen.add(tid)
        rs = str(rid)
        counts[rs] = counts.get(rs, 0) + 1
    return counts


# ===================== 未排班但有单的骑手 =====================
def riders_with_completed_orders_today(orders, team_id, today_ymd):
    """返回「今日有完成单」的骑手集合（用于补齐未排班骑手）。

    口径（2026-09-09 用户要求）：
      · 订单日期归属 = 骑手接单时间（acceptAtLast / 最近接单时间）的北京时间日期
      · 完成单 = 状态 已完成（40 / 配送成功）（见 _is_completed）
      · 仅统计本 team_id 的完成单（避免跨站串数据）
    返回 { rider_id_str: {"name": str, "completed": int} }
    """
    team_str = str(team_id).strip() if team_id else None
    out = {}
    for o in orders:
        if not _is_completed(o):
            continue
        rid = _order_val(o, RIDER_ID_KEYS)
        if rid is None:
            continue
        if team_str:
            ot = _order_val(o, TEAM_KEYS)
            if ot is not None and str(ot).strip() != team_str:
                continue
        raw = _order_val(o, ACCEPT_KEYS)
        if raw is None:
            # 兜底：接单时间缺失时退用创建时间，避免漏算已完成单
            raw = _order_val(o, CREATE_KEYS)
        if raw is None:
            continue
        try:
            ms = int(raw)
        except (ValueError, TypeError):
            continue
        bj = _ms_to_bj(ms)
        if bj.strftime("%Y-%m-%d") != today_ymd:
            continue
        rs = str(rid)
        name = _order_val(o, RIDER_NAME_KEYS) or ""
        rec = out.get(rs)
        if rec is None:
            rec = {"name": name, "completed": 0}
            out[rs] = rec
        rec["completed"] += 1
        if not rec["name"] and name:
            rec["name"] = name
    return out


# ===================== 等级判定 =====================
def _grade(full_valid_orders, full_valid_min, levels):
    """按全天有效单量 + 全天有效在线分钟，定位当前等级与升一级的缺口。
    levels 由 grade_standards.build_levels(team_id, month) 提供；约定
      levels[0] = 未定级，levels[1..5] = 标准1..5（按老板截图口径）。
    full_valid_min 传 None 表示「全天有效在线时长未知（典型：未排班骑手，
    考勤接口未返回）」—— 此时按时长轴无法定位，按未排班处理返回未定级，
    且 next_duration_gap=None（避免对运营产生"还差 360 分钟"等误导）。
    """
    cur = levels[0]
    if full_valid_min is not None:
        for g in levels:
            if full_valid_orders >= g["min_valid_orders"] and full_valid_min >= g["min_valid_minutes"]:
                cur = g
    idx = levels.index(cur)
    nxt = levels[idx + 1] if idx + 1 < len(levels) else None
    if nxt and full_valid_min is not None:
        order_gap = max(0, nxt["min_valid_orders"] - full_valid_orders)
        dur_gap = max(0, nxt["min_valid_minutes"] - full_valid_min)
    elif nxt:
        order_gap = max(0, nxt["min_valid_orders"] - full_valid_orders)
        dur_gap = None
    else:
        order_gap = 0
        dur_gap = 0
    return {
        "level": cur["level"],
        "name": cur["name"],
        "next_level": nxt["name"] if nxt else None,
        "next_order_gap": order_gap,
        "next_duration_gap": dur_gap,
    }


def _status_label(ws):
    if ws == 3:
        return "下线"
    if ws == 2:
        return "小休"
    return "在线"


# ===================== 预计达成（外推）=====================
def _est_achievable_day(valid_online_min, valid_orders, day_order_target):
    """"预计达标"综合判定（2026-09-10 用户定稿 + 修正）。

    两步：
      ① 先按时长差值判断骨架：
           · 已达标  : 时长 >= 360 且 单量 >= 目标（两指标都满足才判已达标）
           · 不可达标: 时长 + 剩余分钟 < 360            （时长维度已无可能）
           · 可达标  : 其余（时长还差，或时长已够但单量未达标）→ 进入②
      ② 仅对「可达标」的人，再按单量节奏细分：
           比值 = (目标单量 - 已完成有效单量) / 当天剩余小时
           · 比值 >= 8 → 达成困难
           · 比值 >= 4 → 有望达成
           · 比值 <  4 → 轻松达成
         阈值从大到小比较，边界(8/4)归属高阈值档。

    返回 (achieved: bool|None, label: str)
    """
    cur = valid_online_min or 0
    THRESHOLD = 360  # 6 小时 = 360 分钟
    target = day_order_target or 0
    done = valid_orders or 0
    now = datetime.datetime.now(BJ)
    now_min = now.hour * 60 + now.minute
    # ① 时长骨架 + 已达标需「时长达标 且 单量达标」双条件
    if now_min >= 1440:
        # 已过 0 点：按当日最后看到的 cur 判定（理论不会触发）
        achieved = (cur >= THRESHOLD) and (done >= target)
        return (achieved, "已达标" if achieved else "不可达标")
    remaining = 1440 - now_min
    if cur >= THRESHOLD and done >= target:
        return (True, "已达标")
    if cur + remaining < THRESHOLD:
        return (False, "不可达标")
    # ② 时长可达标（含「时长已够但单量未达标」）：按单量比值细分
    gap = target - done
    remain_h = remaining / 60.0
    if remain_h <= 0:
        # 理论不会到这（remaining>0 才进本分支），兜底：有单量缺口即困难
        return (None, "达成困难" if gap > 0 else "轻松达成")
    if gap <= 0:
        return (None, "轻松达成")  # 单量已达标，只需补时长
    ratio = gap / remain_h
    if ratio >= 8:
        return (None, "达成困难")
    if ratio >= 4:
        return (None, "有望达成")
    return (None, "轻松达成")




# ===================== 主聚合 =====================
def _build(team_id, start, end, month, riders_raw, orders, target_tc, source):
    """把三源原始数据组装成骑手维度结果（纯本地计算，不发任何 HTTP 请求）。

    实时路径（compute）与本地重算路径（recompute）共用本函数，
    区别只在于三源是新拉的还是从落盘读的。

    target_tc 直接取「拉取时记录的时段码」，不随当前时间漂移 ——
    保证「拉的是午高峰就按午高峰算」，切站点 / 切维度时口径一致。

    month: YYYY-MM（默认 = 当前北京时间当月）；从 grade_standards.build_levels 取阈值。
    """
    team_id = str(team_id)
    team_name = TEAM_NAMES.get(team_id, "team " + team_id)
    if not month:
        month = datetime.datetime.now(BJ).strftime("%Y-%m")
    levels = GS.build_levels(team_id, month)
    error = None
    riders_raw = riders_raw or []
    orders = orders or []
    target_tc = int(target_tc) if target_tc else None

    # 全天有效单量（一个骑手当天只有一个数，不再区分时段）
    today_ymd = _std_ymd(datetime.datetime.now(BJ))
    allday_orders = _aggregate_rider_orders(orders, team_id, today_ymd)
    allday_all = _aggregate_rider_all_orders(orders, team_id, today_ymd)  # 全天单量（含非有效）

    # 全天达成门槛 = 等级标准的「标准1」（最低一档）。
    # 考勤接口只有时段目标(timeFinishOrderTarget)，没有全天目标字段，
    # 因此全天口径下用 grade_standards 的全天阈值（min_valid_orders / min_valid_minutes）。
    base_level = levels[ACHIEVE_LEVEL_INDEX] if len(levels) > ACHIEVE_LEVEL_INDEX else None
    if base_level:
        day_order_target = base_level["min_valid_orders"]
        day_online_target_min = base_level["min_valid_minutes"]
    else:
        day_order_target, day_online_target_min = 0, 0.0

    # —— 骑手集合 = 今日排班(考勤快照 status==2) ∪ 今日未排班但有完成单的骑手 ——
    # 考勤快照返回整个站点骑手（含休息 status==1 / 其他状态），只有 status==2 才是"今日排班"。
    # 今日有单口径（2026-09-09）：订单日期归属 = 接单时间(acceptAtLast) 的北京时间日期；
    #   完成单 = 状态已完成(40 / 配送成功)；仅补本站点今天有完成单、且不在排班集合里的骑手。
    today_ymd = _std_ymd(datetime.datetime.now(BJ))
    # 考勤快照按 knightId 建索引（含休息 / 其它状态，不止 status==2）。
    # 未排班但有单的骑手同样在这份快照里，其 fullDayValidOnlineTime 是真实在线时长；
    # 早期实现给这类骑手造了 fullDayValidOnlineTime=0 的假记录，
    # 造成「未排班 = 没有时长」的假象（如李奕祥实际 21447 秒）。
    raw_by_id = {}
    for r in riders_raw:
        rid0 = r.get("knightId")
        if rid0 is None:
            rid0 = _order_val(r, RIDER_ID_KEYS)
        if rid0 is None:
            continue
        raw_by_id.setdefault(str(rid0), r)

    scheduled_ids = set()
    riders_sched = []   # 仅含 status==2 的排班骑手
    for r in riders_raw:
        st = r.get("status")
        if st is None or str(st) != "2":
            continue   # 休息 / 其他状态不算排班，排除（除非后面因有单并入）
        rid = r.get("knightId")
        if rid is None:
            rid = _order_val(r, RIDER_ID_KEYS)
        if rid is None:
            continue
        scheduled_ids.add(str(rid))
        riders_sched.append(r)
    n_sched0 = len(riders_sched)
    if orders:
        completed_today = riders_with_completed_orders_today(orders, team_id, today_ymd)
        for rid_str, rec in completed_today.items():
            if rid_str in scheduled_ids:
                continue
            # 快照里有这个人就沿用其真实考勤字段（时长 / 在线时间等）；
            # 只有快照里确实查无此人时才退化为 0 —— 未排班 ≠ 没有在线时长。
            src = raw_by_id.get(rid_str) or {}
            riders_sched.append({
                "knightId": rid_str,
                "knightName": rec["name"] or src.get("knightName") or "",
                "teamId": src.get("teamId", team_id),
                "workStatus": src.get("workStatus"),
                "timeValidOnlineTime": src.get("timeValidOnlineTime", 0),
                "fullDayFinishOrder": src.get("fullDayFinishOrder"),
                "fullDayOnlineTime": src.get("fullDayOnlineTime", 0),
                "fullDayValidOnlineTime": src.get("fullDayValidOnlineTime", 0),
                "timeFinishOrderTarget": src.get("timeFinishOrderTarget", 0),
                "timeOnlineTimeTarget": src.get("timeOnlineTimeTarget", 0),
                "_unscheduled": True,
            })
            scheduled_ids.add(rid_str)
    n_unsched = len(riders_sched) - n_sched0
    _log("骑手集合：排班 %d + 未排班有单 %d = %d" % (n_sched0, n_unsched, len(riders_sched)))

    rows = []
    for r in riders_sched:
        rid = r.get("knightId")
        if rid is None:
            rid = _order_val(r, RIDER_ID_KEYS)
        name = r.get("knightName") or _order_val(r, RIDER_NAME_KEYS) or ""
        tid = r.get("teamId")
        if tid is None:
            tid = _order_val(r, TEAM_KEYS)
        ws = r.get("workStatus")
        unscheduled = bool(r.get("_unscheduled"))
        # 全天口径：有效单量 / 有效在线时长均取全天值，不再取时段切片。
        # 注意（2026-09-09 修正）：考勤快照返回的是整个站点骑手（含休息 status=1），
        # 未排班骑手同样带 fullDayValidOnlineTime —— 早期以为「接口只返回有排班的」
        # 是错的，据此把时长写死 0 / None，导致未排班骑手显示不出真实时长。
        if unscheduled:
            # 未排班：考勤快照里一般仍有 fullDayValidOnlineTime / fullDayOnlineTime（休息状态但实际跑过单），
            # 有真实值就用真实值；只有快照里确实没有这个字段时才记 None（"未知"），
            # 不用 0 冒充 —— 0 会让「未排班」误显示成「00小时00分钟」。
            _fv = r.get("fullDayValidOnlineTime")
            full_day_valid_min = None if _fv is None else _to_min(_fv or 0)
            # 全天在线时长 = fullDayOnlineTime（总在线，不分有效）；缺失记 None
            _fo = r.get("fullDayOnlineTime")
            full_day_online_min = None if _fo is None else _to_min(_fo or 0)
        else:
            full_day_valid_min = _to_min(r.get("fullDayValidOnlineTime") or 0)
            full_day_online_min = _to_min(r.get("fullDayOnlineTime") or 0)  # 全天在线时长
        valid_orders = allday_orders.get(str(rid), 0)      # 4 全天有效单量
        full_day_orders = allday_all.get(str(rid), 0)       # 4b 全天单量（含非有效，归属当天+去重）
        valid_online_min = full_day_valid_min              # 5 全天有效在线时长（分钟）

        # 6) 达成标准（全天口径）：全天有效单量 ≥ 标准1单量 且 全天有效在线 ≥ 标准1时长。
        #    2026-09-09 老板确认：未排班骑手**不特殊**，与排班骑手同一套判定标准
        #    （考勤快照里他们同样带真实单量 / 时长），不再因"无排班目标"记 None。
        #    目标为 0 视为该轴无需考核；时长缺失(None)时不拿缺失当达成。
        order_ok = (day_order_target == 0) or (valid_orders >= day_order_target)
        dur_ok = (day_online_target_min == 0) or (
            valid_online_min is not None and valid_online_min >= day_online_target_min)
        achieved = bool(order_ok and dur_ok)
        achieved_label = "达成" if achieved else "未达成"
        # 10) 预计达标（综合判定：时长骨架三态 + 单量节奏细分；已达标需时长与单量双指标均达标）
        est, est_label = _est_achievable_day(valid_online_min or 0, valid_orders or 0, day_order_target)

        # 等级 + 7/8 缺口（_grade 自身会处理 valid_min=None 的情况）
        g = _grade(valid_orders, full_day_valid_min, levels)

        rows.append({
            "rider_id": rid,
            "rider_name": name,
            "team_id": tid,
            "team_name": TEAM_NAMES.get(str(tid), str(tid) if tid is not None else team_name),
            "scheduled": (not unscheduled),
            "rider_set": "排班" if not unscheduled else "未排班有单",
            "valid_orders": valid_orders,                       # 4 全天有效单量
            "valid_online_min": (None if valid_online_min is None
                                  else round(valid_online_min, 1)),  # 5 全天有效在线时长
            "achieved": achieved,                               # 6 达成标准（全天口径）
            "achieved_label": achieved_label,
            "next_level_order_gap": g["next_order_gap"],        # 7 距下一等级单量差值
            # 8 距上一等级有效时长差值（浮点，保留 1 位，避免前端出现 2.5500000000000114）
            "prev_level_duration_gap": (round(g["next_duration_gap"], 1)
                                        if g["next_duration_gap"] is not None else None),
            "online_status": _status_label(ws),  # 9 在线状态（真实上下线：在线/小休/下线；不再把未排班骑手覆盖为"未排班"，"排班/未排班有单"由 rider_set 与骑手姓名圆点区分）
            "online_status_code": ws,
            "est_achievable": est,                              # 10 预计达标 bool
            "est_achievable_label": est_label,                  # 已达标 / 不可达标 / 达成困难 / 有望达成 / 轻松达成
            "full_day_orders": full_day_orders,                 # 11 全天单量（含非有效）
            "full_day_online_min": (None if full_day_online_min is None
                                       else round(full_day_online_min, 1)),  # 12 全天在线时长
            "grade": g,
            "att_time_code": target_tc,   # 仅考勤取数用的时段码，不参与达成判定
        })

    # 默认排序：达成在前 → 未达成 → 有效单量升序 → 姓名
    # （未排班不再单列一档：判定标准已与排班骑手统一，achieved 恒为 bool）
    def _sort_key(x):
        if x["achieved"]:
            return (0, 0, x["valid_orders"], str(x["rider_name"]))
        if x["achieved"] is None:
            return (2, 0, x["valid_orders"], str(x["rider_name"]))
        return (1, 0, x["valid_orders"], str(x["rider_name"]))
    rows.sort(key=_sort_key)

    achieved_n = sum(1 for x in rows if x["achieved"])
    summary = {
        "rider_count": len(rows),
        "scheduled_count": n_sched0,
        "unscheduled_count": n_unsched,
        "achieved_count": achieved_n,
        "achieved_rate": (round(achieved_n * 1000 / max(1, len(rows))) / 10) if rows else None,
        # 以下两个是「达成门槛」与「考勤取数时段」，供前端展示口径说明
        "day_order_target": day_order_target,
        "day_online_target_min": round(day_online_target_min, 1),
        "att_time_code": target_tc,
        "att_time_name": TIME_SLOTS.get(target_tc, (None, None, "未知"))[2],
    }

    return {
        "ok": True,
        "source": source,
        "error": error,
        "team": team_id,
        "teamName": team_name,
        "start": start,
        "end": end,
        "basis": "day",                       # 口径标记：按整天统计
        "att_time_code": target_tc,           # 仅考勤取数用，不参与达成判定
        "att_time_name": TIME_SLOTS.get(target_tc, (None, None, "未知"))[2],
        "cache_time": CACHE.latest_cache_time(team_id, start) if source == "cache" else None,
        "summary": summary,
        "rows": rows,
        "grade_note": "等级阈值取自 grade_standards（按站点 × 月份），老板通过『等级标准设置』tab 维护。",
        "rider_set_note": "骑手集合 = 今日排班(考勤快照) ∪ 今日未排班但有完成单的骑手；"
                          "「今日有单」按运单接单时间(acceptAtLast)归属日期，状态=已完成(40/配送成功)即算 1 单。"
                          "有效单量口径：接单时间归属当天 + 配送完成 + 剔除逆向单/改派单。",
        "grade_month": month,
        "grade_thresholds": {  # 5 个标准的实际取值，方便前端在表头/侧栏展示
            "orders": [int(l["min_valid_orders"]) for l in levels[1:6]],
            "duration_h": [round(l["min_valid_minutes"] / 60.0, 2) for l in levels[1:6]],
        },
    }


def _empty(team_id, start, end, source, error=None, need_refresh=False,
           month=None, time_code=None):
    """统一空 / 错误结构。need_refresh=True 时前端提示「请点查询拉取实时数据」。"""
    tid = str(team_id)
    tc = int(time_code) if time_code else None
    return {
        "ok": True,
        "source": source,
        "error": error,
        "team": tid,
        "teamName": TEAM_NAMES.get(tid, "team " + tid),
        "start": start,
        "end": end,
        "basis": "day",
        "att_time_code": tc,
        "att_time_name": (TIME_SLOTS.get(tc, (None, None, "未知"))[2] if tc else None),
        "summary": None,
        "rows": [],
        "need_refresh": need_refresh,
        "grade_month": month,
    }


def compute(team_id, time_code=None, start=None, end=None, cookie=None, month=None,
            reuse_orders=False):
    """实时拉取路径 —— 仅点「查询」按钮时走。

    拉考勤 + 运单明细 → 原始层落盘 → 调 _build 组装。要点：
      · 运单明细走 orders_fetch：随机页间隔 + 段间 + 超阈值按时段切片
        + AuthError 自动重登 5 次
      · 考勤连同时段码 tc 一起落盘，供本地重算复用同一口径

    reuse_orders=True（全量刷新用）：若当天运单原始层已有落盘就直接复用。
    全量刷新会先「一次拉全量运单并按 teamId 分组落盘」，
    各站点再各自拉考勤即可，运单不重复拉（见 refresh_all._run）。
    """
    team_id = str(team_id)
    today = datetime.datetime.now(BJ)
    s = start or _std_ymd(today)
    e = end or _std_ymd(today)
    if not month:
        month = today.strftime("%Y-%m")
    try:
        sess = OF.Session(cookie)
        cookie = sess.cookie
        target_tc = int(time_code) if time_code else current_slot_code()
        data = _att_fetch(int(team_id), target_tc, cookie=cookie)
        riders_raw = (data.get("result") or {}).get("data") or []
        start_ms = _ymd_to_ms(s, False)
        end_ms = _ymd_to_ms(e, True)
        orders = CACHE.load_raw("orders", team_id, s) if reuse_orders else None
        if orders is not None:
            _log("运单明细复用已落盘 %d 条（跳过拉取）" % len(orders))
        else:
            orders = OF.fetch_orders(sess, start_ms, end_ms)
            CACHE.save_raw("orders", team_id, orders, s)
        CACHE.save_raw("att", team_id, {
            "tc": target_tc, "rows": riders_raw,
            "fetched_at": today.isoformat(timespec="seconds"),
        }, s)
        _log("实时拉取完成 考勤%d人 运单%d条" % (len(riders_raw), len(orders)))
    except Exception as ex:
        return _empty(team_id, s, e, "error",
                      "%s: %s" % (type(ex).__name__, ex),
                      month=month, time_code=time_code)
    return _build(team_id, s, e, month, riders_raw, orders, target_tc, "live")


def recompute(team_id, time_code=None, start=None, end=None, month=None):
    """本地重算路径 —— 切站点 / 切维度时走，零 HTTP 请求。

    读原始层落盘的「运单明细 + 考勤」重算；时段码用落盘时记录的 tc，
    不随当前时间漂移。缺任一源就返回 need_refresh=True，由前端提示
    点「查询」—— 绝不因为「没缓存」就自动发起实时请求。
    """
    team_id = str(team_id)
    today = datetime.datetime.now(BJ)
    s = start or _std_ymd(today)
    e = end or _std_ymd(today)
    if not month:
        month = today.strftime("%Y-%m")
    orders = CACHE.load_raw("orders", team_id, s)
    att = CACHE.load_raw("att", team_id, s)
    if orders is None or att is None:
        return _empty(team_id, s, e, "none", need_refresh=True, month=month)
    riders_raw = att.get("rows") or []
    target_tc = att.get("tc")
    _log("本地重算 运单%d条 考勤%d人 时段%s" % (
        len(orders), len(riders_raw), target_tc))
    return _build(team_id, s, e, month, riders_raw, orders, target_tc, "cache")


if __name__ == "__main__":
    import argparse as _ap
    _a = _ap.ArgumentParser()
    _a.add_argument("--team", default="917521136")
    _a.add_argument("--tc", default=None)
    _a.add_argument("--start", default=None)
    _a.add_argument("--end", default=None)
    _a.add_argument("--month", default=None)
    _ns = _a.parse_args()
    print(json.dumps(compute(_ns.team, _ns.tc, _ns.start, _ns.end,
                             month=_ns.month),
                     ensure_ascii=False, indent=2))
