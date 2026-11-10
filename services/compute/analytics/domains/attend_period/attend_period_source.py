#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""时段出勤看板 —— 共用数据源（single source of truth）。

把「站点数据」与「骑手明细」两处视图收敛到同一数据层，确保一次查询、同时同步、数据一致。

设计要点
========
1. 唯一真相源：以 rider_period_detail.compute(team, date) 的「骑手×时段」结果为底层真相。
   compute 已包含：每位骑手每时段的单量/在线时长/达标判定、排班目标 actual_num/predict_num、
   以及「全天」行的 full_day_schedule（predict_num/actual_num）。站点数据是它的**纯投影**，
   不再单独打任何接口、不再单独维护缓存。

2. 数据源结构（AttendPeriodDataset，进程内缓存一份）：
   {
     "team": "__all__" | 站点ID,
     "date": "YYYY-MM-DD",
     "fetched_at": ISO 时间戳,
     "source": "live" | "cache",
     "periods": [ {time_code, time_name, start_time, end_time, orders_req,
                   online_req_h, weight, configured, actual_num, predict_num} ],  # 真实时段（不含 9999/2）
     "rider_rows": [ {rider_id, rider_name, team_id, team_name, cells:{tc:{...}},
                      full_day_*, ...} ],                                   # 骑手×时段明细
     "full_day_schedule": {"predict_num", "actual_num"},                   # 排班目标 9999 行
     "station_rows": [ {team_id, team_name, metrics:{tc:{rate,target,scheduled,achieved,order,weight}, "9999":{...}}} ]
   }

3. 读取 / 更新接口：
   · 更新（唯一写路径）：get_dataset(team, date, refresh=True) —— 只算一次（__all__ 时逐站各算一次）、
     写一份进程内缓存；受 server 频控约束（调用方先过 _rate_check）。
   · 读取（投影，无重算）：to_rider_detail(ds) / to_station_data(ds) —— 两视图都是同一 ds 的投影。

4. 自动同步机制：两视图均投影自同一份 ds 缓存对象。一次 refresh 原子重建缓存，
   下次渲染两边同快照（fetched_at 完全一致）→ 天然数据一致。前端单一「查询」调用组合接口
   /api/attend-period/dataset（team=__all__）一次性取回 {rider_detail, station_data}，
   写入同一 localStorage，两 tab 均从它渲染。

数据口径（2026-09-13 与用户确认）：
  · 达标 = 单量达标 且 在线时长达标（阈值取 period_config 的 orders + effective_online_req_h），
    与 rider_period_detail.cells[].achieved 完全一致。
  · 时段达成率 = 达标人数 ÷ 时段目标人数（predict_num），保留 1 位小数（%），展示时不封顶。
  · 排班人数 = 排班目标 actual_num；时段排班且有单人数 = 该时段有排班(scheduled) 且 timeFinishOrder > 0。
  · 全天列（2026-11-10 起）：仅「时段有效达成率」一张表由前端按各时段值与
    「考核设置 → 时段设置」的权重加权平均（未结束/无目标按 100%，其余加权时封顶 100%）；
    另外三张表仍读后端 metrics['9999'] 原口径（full_day_* + full_day_schedule）；
    其中「有效达成」在投影时按当月全天标准重算，使缓存快照也能即时反映标准变更。
    各时段列展示原始达成率，不封顶。
"""
import os

from analytics.core.paths import ROOT, PY_HOME, _ROOT, dirs# noqa: E402,F401 <<<


import sys
import json
import datetime
from sources import TEAM_NAMES
from analytics.core import period_config as PC
from analytics.domains.attend_period import rider_period_detail as RPD
from analytics.domains.attend_period import attend_period_teams as APT

BJ = datetime.timezone(datetime.timedelta(hours=8))
DAY_TIME_CODE = "9999"     # 全天汇总行（排班目标接口）
REST_STATES = {2}          # 小休（暂离）
OFFLINE_STATES = {3}       # 下线（未在线装备）

# 进程内缓存：键 (team, date) -> dataset dict。server 单进程串行处理请求，无需加锁。
_DS_CACHE = {}

# 落盘目录（与原始层同根 apps/api/runtime/raw，子目录隔离避免污染 latest_cache_time_all）。
_DS_DIR = dirs.runtime("raw/attend_ds")


def _log(msg):
    ts = datetime.datetime.now(BJ).strftime("%H:%M:%S")
    print(f"[{ts}] [attend_period_source] {msg}", flush=True)


def _norm_int(v):
    """整数；缺失/非法返回 None（与 attend_period_station 语义一致：目标为 0/None 时达成率记 None）。"""
    try:
        if v is None or v == "":
            return None
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _rate(actual, target):
    """达成率（百分数，保留 1 位）。分子缺失或分母为 0/None 时返回 None。"""
    if actual is None or target in (None, 0):
        return None
    return round(actual / target * 1000) / 10


def _fmt_dur(sec):
    """秒 → 'XhYm' / 'Ym' / '0'。"""
    sec = int(sec or 0)
    if sec <= 0:
        return "0"
    h = sec // 3600
    m = (sec % 3600) // 60
    return f"{h}h{m}m" if h > 0 else f"{m}m"


# ----------------------- 投影：站点数据（由 rider_rows 派生） -----------------------
def _project_team_metrics(rows, periods, fd_sched):
    """单站：由骑手明细行投影出 时段→{rate,target,scheduled,achieved,order,weight}。

    rows      : 该站点的骑手明细列表（compute.rows 子集）
    periods   : compute.periods（真实时段，含 weight / predict_num / actual_num）
    fd_sched  : compute.full_day_schedule（全天行 predict/actual）

    全天列（9999）保持原有口径：达标/有单取自 full_day_*，目标/排班取
    full_day_schedule，供「时段排班有效出勤率 / 时段出勤满足率 / 时段排班出勤率」
    三张表使用。只有「时段有效达成率」的全天列由前端按时段权重加权计算，不读这里。
    weight 仅透出给前端加权使用，不参与本函数的全天汇总。
    """
    metrics = {}
    for pd in periods:
        tc = pd["time_code"]                 # 原始类型，与 cells 键一致
        target = _norm_int(pd.get("predict_num"))
        scheduled = _norm_int(pd.get("actual_num"))
        achieved = sum(1 for r in rows
                       if r.get("cells", {}).get(tc, {}).get("achieved") is True)
        # 时段排班且有单人数：仅统计「该时段有排班(scheduled=True) 且 单量>0」的骑手
        order = sum(1 for r in rows
                    if r.get("cells", {}).get(tc, {}).get("scheduled") is True
                    and (r.get("cells", {}).get(tc, {}).get("orders") or 0) > 0)
        metrics[str(tc)] = {
            "rate": _rate(achieved, target),
            "target": target, "scheduled": scheduled,
            "achieved": achieved, "order": order,
            "weight": PC.norm_weight(pd.get("weight")),
        }
    # 全天列（9999）：达标/有单取自 full_day_*，目标/排班取自 full_day_schedule
    fd_target = _norm_int(fd_sched.get("predict_num")) if fd_sched else None
    fd_scheduled = _norm_int(fd_sched.get("actual_num")) if fd_sched else None
    fd_achieved = sum(1 for r in rows if r.get("full_day_achieved") is True)
    fd_order = sum(1 for r in rows if (r.get("full_day_orders") or 0) > 0)
    metrics[DAY_TIME_CODE] = {
        "rate": _rate(fd_achieved, fd_target),
        "target": fd_target, "scheduled": fd_scheduled,
        "achieved": fd_achieved, "order": fd_order,
    }
    return metrics


def _full_day_standard(month):
    """取当月「时段设置」里的全天标准 (单量, 有效在线时长h)；未配置返回 None。"""
    if not month:
        return None
    cfg = PC.load(month=month)
    fd = next((p for p in cfg.get("periods") or []
               if p.get("name") == "全天"
               or (p.get("start"), p.get("end")) == ("00:00", "00:00")), None)
    if not fd:
        return None
    try:
        return (int(float(fd.get("orders") or 0)),
                float(fd.get("effective_online_req_h") or 0))
    except (TypeError, ValueError):
        return None


def _full_day_achieved(riders, std):
    """按全天标准统计达标人数（与 rider_period_detail 的全天判定同口径）。"""
    if std is None:
        return None
    orders_req, online_req_h = std
    n = 0
    for r in riders or []:
        orders = r.get("full_day_orders") or 0
        online_h = r.get("full_day_online_h") or 0
        if (orders_req == 0 or orders >= orders_req) and \
                (online_req_h == 0 or online_h >= online_req_h):
            n += 1
    return n


def _station_periods(periods, date=None):
    """站点卡片时段列顺序：全天(9999) 排第一，真实时段按开始时间升序。

    旧落盘快照（加权口径上线前生成）的 periods 不带 weight：按「时段设置」的
    名称 / 起止时间回填，让历史缓存无需重新拉取实时数据也能按当前权重加权。

    ended：按北京时间判断该时段是否已结束（历史日期全部已结束、未来日期全部未结束、
    当天按 end_time 比较；end <= start 视为跨到次日，当天内不算结束）。前端全天列
    对未结束的时段按 100% 参与加权，避免当天进行中的时段拖低全天达成率。
    """
    date_str = str(date or "")[:10]
    month = date_str[:7] if date_str else None
    now = datetime.datetime.now(BJ)
    today = now.strftime("%Y-%m-%d")
    now_hm = now.hour * 60 + now.minute

    by_name = {}
    by_time = {}
    if month:
        for c in PC.load(month=month).get("periods") or []:
            w = PC.norm_weight(c.get("weight"))
            by_name.setdefault(c.get("name"), w)
            by_time.setdefault((c.get("start"), c.get("end")), w)

    def _weight_of(p):
        if p.get("weight") is not None:
            return PC.norm_weight(p.get("weight"))
        w = by_name.get(p.get("time_name"))
        if w is None:
            w = by_time.get((p.get("start_time"), p.get("end_time")))
        return 100.0 if w is None else w

    def _hm(s):
        if not s or ":" not in str(s):
            return 9999
        try:
            a, b = str(s).split(":")
            return int(a) * 60 + int(b)
        except Exception:
            return 9999

    def _ended(p):
        if not date_str or date_str < today:
            return True
        if date_str > today:
            return False
        s, e = _hm(p.get("start_time")), _hm(p.get("end_time"))
        if s == 9999 or e == 9999:
            return True
        if e <= s:                 # 跨日时段（如 22:00-00:00）：当天内视为未结束
            return False
        return now_hm >= e

    real = [{
        "time_code": str(p.get("time_code")),
        "time_name": p.get("time_name"),
        "is_full_day": False,
        "weight": _weight_of(p),
        "ended": _ended(p),
        "end_time": p.get("end_time"),
    } for p in periods]
    real.sort(key=lambda p: _hm(p.get("time_name")))   # time_name 形如 "10:30-13:30"，按起始排序；回退用 start_time 亦可
    return [{"time_code": DAY_TIME_CODE, "time_name": "全天",
             "is_full_day": True, "weight": None, "ended": True}] + real


# ----------------------- 构建唯一真相源 -----------------------
def build_dataset(team, date, teams=None):
    """构建统一数据集。team="__all__" 时逐站 compute 一次、合并 rider_rows 并逐站投影站点行。

    teams: 显式站点 id 列表，覆盖 team=="__all__" 时的默认 attend_period_teams 配置，
           用于数据权限裁剪（服务端已过滤出用户可见站点）。
    """
    team = str(team)
    if teams is not None:
        teams = [str(t) for t in teams]
    else:
        teams = APT.get_teams() if team == "__all__" else [team]

    rider_rows = []
    station_rows = []
    periods_tpl = None
    fd_sched_tpl = None
    config_flags = []
    config_note = None
    for tid in teams:
        res = RPD.compute(tid, date)
        # 未保存月份：RPD.compute 直接返回 not_configured 空结果，此处汇总为数据集级状态。
        config_flags.append(res.get("configured", True))
        if res.get("data_note") and not config_note:
            config_note = res["data_note"]
        rows = res.get("rows") or []
        pers = res.get("periods") or []
        rider_rows.extend(rows)
        fds = res.get("full_day_schedule") or {}
        if periods_tpl is None and pers:
            periods_tpl = pers
            fd_sched_tpl = fds
        station_rows.append({
            "team_id": str(tid),
            "team_name": TEAM_NAMES.get(str(tid), res.get("teamName", tid)),
            "metrics": _project_team_metrics(rows, pers, fds),
        })

    if periods_tpl is None:
        periods_tpl = []
    configured = all(config_flags) if config_flags else True
    _log("统一数据集构建完成：%s，%d 名骑手，%d 站" % (team, len(rider_rows), len(station_rows)))
    return {
        "team": team,
        "date": date,
        "fetched_at": datetime.datetime.now(BJ).isoformat(timespec="seconds"),
        "source": "live" if configured else "none",
        "periods": periods_tpl,
        "rider_rows": rider_rows,
        "full_day_schedule": fd_sched_tpl or {"predict_num": None, "actual_num": None},
        "station_rows": station_rows,
        "configured": configured,
        "data_status": "ok" if configured else "not_configured",
        "data_note": config_note,
    }


def _ds_path(team, date):
    return os.path.join(_DS_DIR, "%s_%s.json" % (str(team), date))


def _save_ds_disk(team, date, ds):
    """数据集落盘（独立于进程内缓存，使 Python 重启后仍能「读缓存、不重取」）。
    失败仅告警，不影响内存缓存与本次返回。"""
    try:
        os.makedirs(_DS_DIR, exist_ok=True)
        tmp = _ds_path(team, date) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(ds, f, ensure_ascii=False)
        os.replace(tmp, _ds_path(team, date))
    except Exception as e:
        _log("数据集落盘失败（不影响内存缓存）：%s" % e)


def _load_ds_disk(team, date):
    p = _ds_path(team, date)
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def get_dataset(team, date, refresh, teams=None):
    """单一入口：读取（refresh=False）或更新（refresh=True）统一数据集。

    refresh=False：先查进程内缓存，未命中再读落盘文件；命中返回带 source="cache" 的 ds，
                   均未命中返回 None（调用方返回 need_refresh 提示前端点刷新）。
    refresh=True ：重建并写入「进程内缓存 + 落盘」，随后返回（频控由调用方负责）。

    teams: 仅 refresh=True 且 team=="__all__" 时生效，用于数据权限裁剪。
    """
    key = (str(team), date)
    if not refresh:
        ds = _DS_CACHE.get(key)
        if ds is None:
            ds = _load_ds_disk(str(team), date)
        if ds is not None:
            ds = dict(ds)
            ds["source"] = "cache"
            return ds
        return None
    ds = build_dataset(team, date, teams=teams)
    # 未配置月份不落缓存：避免「未配置」空快照被当成有效数据长期展示；
    # 用户保存配置后点刷新即可重建。
    if ds.get("data_status") != "not_configured":
        _DS_CACHE[key] = ds
        _save_ds_disk(str(team), date, ds)
    return ds


# ----------------------- 投影：两视图读取接口（无重算） -----------------------
def to_rider_detail(ds):
    """投影为「骑手明细」接口返回结构。"""
    rider_rows = ds.get("rider_rows") or []
    periods = ds.get("periods") or []
    summary = {
        "rider_count": len(rider_rows),
        "scheduled_total": sum(r.get("scheduled_periods", 0) for r in rider_rows),
        "achieved_total": sum(r.get("achieved_periods", 0) for r in rider_rows),
        "period_count": len(periods),
        "configured_periods": sum(1 for p in periods if p.get("configured")),
    }
    return {
        "ok": True,
        "team": ds.get("team"),
        "teamName": ("全部站点（%d 站）" % len(ds.get("station_rows") or []))
                    if ds.get("team") == "__all__" else TEAM_NAMES.get(str(ds.get("team")), ds.get("team")),
        "date": ds.get("date"),
        "periods": periods,
        "rows": rider_rows,
        "summary": summary,
        "fetched_at": ds.get("fetched_at"),
        "source": ds.get("source"),
        "configured": ds.get("configured", True),
        "data_status": ds.get("data_status", "ok"),
        "data_note": ds.get("data_note") or "",
    }


def to_station_data(ds):
    """投影为「站点数据」接口返回结构（4 张卡片数据源）。

    全天列「有效达成」按当月「时段设置」的全天标准判定：缓存快照可能生成于
    全天标准配置之前（full_day_achieved 全为 None），这里用骑手明细的
    full_day_orders / full_day_online_h 按当前标准重算，无需重新拉取实时数据。
    只有「时段排班有效出勤率」用到该分子，另两张表用「有单人数」不受影响。
    """
    station_rows = ds.get("station_rows") or []
    rider_rows = ds.get("rider_rows") or []
    std = _full_day_standard(str(ds.get("date") or "")[:7])
    if std is not None:
        for sr in station_rows:
            cell = (sr.get("metrics") or {}).get(DAY_TIME_CODE)
            if not isinstance(cell, dict):
                continue
            riders = [r for r in rider_rows
                      if str(r.get("team_id")) == str(sr.get("team_id"))]
            n = _full_day_achieved(riders, std)
            if n is None:
                continue
            cell["achieved"] = n
            cell["rate"] = _rate(n, cell.get("target"))
    periods = _station_periods(ds.get("periods") or [], str(ds.get("date") or ""))
    return {
        "ok": True,
        "team": ds.get("team"),
        "teamName": ("全部站点（%d 站）" % len(station_rows)) if ds.get("team") == "__all__" else None,
        "date": ds.get("date"),
        "periods": periods,
        "rows": station_rows,
        "missing_teams": None,
        "need_refresh": False,
        "source": ds.get("source"),
        "fetched_at": ds.get("fetched_at"),
        "configured": ds.get("configured", True),
        "data_status": ds.get("data_status", "ok"),
        "data_note": ds.get("data_note") or "",
    }


def to_time_period(ds):
    """投影为「时段出勤」返回结构（跨站点按时段合并）。

    完全由 rider_rows + station_rows 派生，与 attend_period_all.valid_all 口径一致：
    有效出勤 = 该时段 scheduled 骑手中 workStatus ∉ {2 小休, 3 下线}；
    时段目标/排班 = 各站 metrics 同 time_code 之和（periods 模板的 predict_num 仅首站，不可跨站直接取）；
    缺勤 = 目标 - 在线；达成率 = 在线 / 目标。不二次取数。
    """
    rider_rows = ds.get("rider_rows") or []
    periods = ds.get("periods") or []
    station_rows = ds.get("station_rows") or []

    # 站点口径时间戳辅助
    def _hm(s):
        if not s or ":" not in str(s):
            return 9999
        try:
            a, b = str(s).split(":")
            return int(a) * 60 + int(b)
        except Exception:
            return 9999

    # 跨站点目标 / 排班按 time_code 求和
    target_sum = {}
    sched_sum = {}
    for sr in station_rows:
        tid = str(sr.get("team_id"))
        for tc, m in (sr.get("metrics") or {}).items():
            t = _norm_int(m.get("target")) or 0
            s = _norm_int(m.get("scheduled")) or 0
            target_sum[tc] = target_sum.get(tc, 0) + t
            sched_sum[tc] = sched_sum.get(tc, 0) + s

    # 逐骑手归并到「全局时段」的有效出勤
    g_online = {}
    g_offline = {}
    g_rest = {}
    g_dur = {}
    for r in rider_rows:
        tid = str(r.get("team_id"))
        for tc_raw, cell in (r.get("cells") or {}).items():
            tc = str(tc_raw)
            if not cell or not cell.get("scheduled"):
                continue
            ws = cell.get("work_status")
            if ws in OFFLINE_STATES:
                g_offline[tc] = g_offline.get(tc, 0) + 1
            elif ws in REST_STATES:
                g_rest[tc] = g_rest.get(tc, 0) + 1
            else:
                g_online[tc] = g_online.get(tc, 0) + 1
                sec = cell.get("online_sec")
                if sec:
                    g_dur[tc] = g_dur.get(tc, 0) + sec

    real_periods = sorted(periods, key=lambda p: _hm(p.get("start_time")))
    rows = []
    for p in real_periods:
        tc = str(p.get("time_code"))
        t_on = g_online.get(tc)
        t_target = target_sum.get(tc) or None
        t_sched = sched_sum.get(tc) or None
        rate = _rate(t_on, t_target)
        absent = (t_target - t_on) if (t_target not in (None, 0) and t_on is not None) else None
        dur = g_dur.get(tc) or 0
        rows.append({
            "time_code": tc,
            "time_name": p.get("time_name"),
            "start_time": p.get("start_time"),
            "end_time": p.get("end_time"),
            "target": t_target,
            "scheduled": t_sched,
            "online": t_on,
            "offline": g_offline.get(tc) or None,
            "rest": g_rest.get(tc) or None,
            "absent": absent,
            "rate": rate,
            "valid_dur_sec": dur or None,
            "valid_dur": _fmt_dur(dur),
            "error": None,
        })

    tot_t = sum((r["target"] or 0) for r in rows if r["target"] is not None)
    tot_o = sum((r["online"] or 0) for r in rows if r["online"] is not None)
    tot_abs = sum((r["absent"] or 0) for r in rows if r["absent"] is not None)
    summary = {
        "target": tot_t, "online": tot_o, "absent": tot_abs,
        "rate": _rate(tot_o, tot_t), "period_count": len(rows),
        "team_count": len(station_rows),
    }
    return {
        "ok": True,
        "team": ds.get("team"),
        "teamName": ("全部站点（%d 站）" % len(station_rows)) if ds.get("team") == "__all__"
                    else TEAM_NAMES.get(str(ds.get("team")), ds.get("team")),
        "date": ds.get("date"),
        "rows": rows,
        "summary": summary,
        "missing_teams": None,
        "need_refresh": False,
        "source": ds.get("source"),
        "fetched_at": ds.get("fetched_at"),
        "configured": ds.get("configured", True),
        "data_status": ds.get("data_status", "ok"),
        "data_note": ds.get("data_note") or "",
    }


if __name__ == "__main__":
    import json as _json
    import argparse as _ap
    _a = _ap.ArgumentParser()
    _a.add_argument("--team", default="__all__")
    _a.add_argument("--date", default=datetime.datetime.now(BJ).strftime("%Y-%m-%d"))
    _ns = _a.parse_args()
    ds = build_dataset(_ns.team, _ns.date)
    print(_json.dumps({
        "rider_detail": to_rider_detail(ds),
        "station_data": to_station_data(ds),
    }, ensure_ascii=False, indent=2, default=str))
