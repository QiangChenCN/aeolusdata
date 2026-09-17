#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标准达成看板 —— 全量刷新（所有「参与站点」）。

背景（2026-09-09 需求）：以前「获取数据 / 刷新数据」只覆盖前端当前选中的单个站点
（默认万科），生成数据也只有那一个站。现在改为：一次刷新按 teams_config 里的
「参与站点」逐个站点拉三源 + 生成结果，看板可切「全部站点」看合并数据。

为什么要后台线程：
  每站运单 3000~5000 条，翻页要走随机节奏防限流（0.3~1.0s/页），单站 1~2 分钟，
  多站就是好几分钟 —— 同步等待会超时。因此点刷新后立刻返回，前端轮询进度。

每个站点的执行顺序（同一份运单只拉一次）：
  1) rider_dimension.compute(team)  → 拉考勤 + 运单，落盘 orders / att，生成骑手结果
  2) achievement.compute(team, reuse_orders=True) → 排班目标(当天缓存优先) + 复用运单
     + 考勤，生成站点结果
  3) 两份结果写结果层缓存（CACHE.save("rider"/"ach")），供「生成所有站点数据」落地

状态机放模块级 _STATE（进程内单例）；同一时刻只允许一个全量刷新在跑。
"""
import os
import sys
import time
import json
import threading
import datetime
import traceback

if __package__ in (None, ""):   # 允许 `python dashboard/standard/refresh_all.py` 直接跑
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))))

from dashboard.standard import cache as CACHE          # noqa: E402
from dashboard.standard import achievement as AC       # noqa: E402
from dashboard.standard import rider_dimension as RD   # noqa: E402
from dashboard.standard import teams_config as TCFG    # noqa: E402
from dashboard.standard import orders_fetch as OF      # noqa: E402

BJ = datetime.timezone(datetime.timedelta(hours=8))

# 阶段 0「共享运单」不属于某个具体站点，用这个伪 id 占位，前端显示为「全部站点」
SHARED_TEAM_KEY = "__shared__"

_LOCK = threading.Lock()
_STATE = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "start": None,
    "end": None,
    "total": 0,
    "done": 0,
    "current_team": None,   # 当前正在处理的站点 id
    "current_stage": "",    # 当前阶段文案：考勤 / 运单 / 排班目标 / 生成结果
    "teams": [],            # [{id, name, status: pending|running|ok|error, msg, rows}]
    "error": None,
    # 抓取统计（由 orders_fetch 采集）：请求数 / 成功 / 被限流 / 其它失败 / 重试 / 重登
    "stats": None,
    "log_file": None,       # 本次刷新的日志文件（dashboard/standard/logs/ 下）
}
_THREAD = None            # 当前刷新线程引用，用于检测「running 残留但未真正在跑」

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")


def _now():
    return datetime.datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S")


_LOG_PATH = None          # 由 _run 在启动时设置，_log 同时写文件


def _log(msg):
    line = "[%s] [refresh-all] %s" % (_now(), msg)
    print(line, flush=True)
    if _LOG_PATH:
        try:
            with open(_LOG_PATH, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass


def status():
    """返回进度快照（供前端轮询）。不暴露内部可变对象。"""
    with _LOCK:
        snap = json.loads(json.dumps(_STATE, ensure_ascii=False))
    snap["server_time"] = _now()
    if snap["running"] and snap["started_at"]:
        try:
            t0 = datetime.datetime.strptime(snap["started_at"], "%Y-%m-%d %H:%M:%S")
            snap["elapsed_sec"] = int((datetime.datetime.now() - t0).total_seconds())
        except Exception:
            snap["elapsed_sec"] = None
        # 运行中：下发实时抓取统计（被限流几次可以边跑边看）
        try:
            snap["stats"] = OF.stats_snapshot()
        except Exception:
            pass
    return snap


def start(teams=None, start_date=None, end_date=None, time_code=None, month=None):
    """启动全量刷新。返回 (ok, msg)。

    teams 为空时取 teams_config 的参与站点。已在跑 → ok=False, msg="已有刷新任务在运行"。
    """
    if not start_date:
        start_date = CACHE.today_ymd()
    if not end_date:
        end_date = start_date
    if not teams:
        teams = TCFG.get_teams()
    teams = [str(t).strip() for t in (teams or []) if str(t).strip()]
    if not teams:
        return False, "参与站点为空，请先到『系统设置』勾选站点"

    with _LOCK:
        # 防御：上一刷新线程已不在运行（异常退出/被回收），但 running 未被 finally 复位，
        # 此时放行新任务，避免「409 永久卡死」无法再刷新。
        if _STATE["running"] and (_THREAD is None or not _THREAD.is_alive()):
            _STATE["running"] = False
            _STATE["finished_at"] = _now()
            _STATE["current_stage"] = "（检测到上次刷新异常中断，已复位）"
        if _STATE["running"]:
            return False, "已有刷新任务在运行"
        _STATE.update({
            "running": True,
            "started_at": _now(),
            "finished_at": None,
            "start": start_date,
            "end": end_date,
            "total": len(teams),
            "done": 0,
            "current_team": None,
            "current_stage": "准备中",
            "error": None,
            "teams": [{"id": t, "name": AC.TEAM_NAMES.get(str(t), str(t)),
                       "status": "pending", "msg": "", "rows": 0} for t in teams],
        })

    th = threading.Thread(
        target=_run, args=(teams, start_date, end_date, time_code, month),
        name="std-refresh-all", daemon=True)
    _THREAD = th
    th.start()
    return True, "已启动，共 %d 个站点" % len(teams)


def _set_current(team_id, stage):
    with _LOCK:
        _STATE["current_team"] = str(team_id)
        _STATE["current_stage"] = stage
        for t in _STATE["teams"]:
            if t["id"] == str(team_id):
                t["status"] = "running"
                t["msg"] = stage
                break


def _finish_team(team_id, ok, msg, rows=0):
    with _LOCK:
        for t in _STATE["teams"]:
            if t["id"] == str(team_id):
                t["status"] = "ok" if ok else "error"
                t["msg"] = msg
                t["rows"] = rows
                break
        _STATE["done"] = sum(1 for t in _STATE["teams"]
                             if t["status"] in ("ok", "error"))


def _failed(res):
    """结果 dict 是否算失败（compute 内部异常会返回 source=error 的空结构）。"""
    if not isinstance(res, dict):
        return True, "返回结构异常"
    if res.get("source") == "error" or res.get("error"):
        return True, str(res.get("error") or "未知错误")
    if res.get("need_refresh"):
        return True, "落盘数据缺失（拉取未写入）"
    return False, ""


def _fetch_shared_orders(teams, start_date, end_date):
    """一次拉全量运单，按 teamId 分组后给每个参与站点分别落盘。

    关键事实：运单明细接口请求体**没有站点参数**，返回的是当前账号权限下的
    全部站点数据。所以「每个站点各拉一遍」拉的是同一批数据 —— 3 个站点就是
    3 倍请求数、3 倍耗时、3 倍限流风险。改为一次拉全量 + 内存里按 teamId 分组。

    失败不导致整个刷新中止：返回 (False, 原因)，调用方降级为「各站点自行拉取」。

    时间维度按**运单终态时间(trackingFinish)**抓（接口默认值，也是风神前端「运单数据」页
    与你抓到的那个请求所用的字段）。选它的原因：生成时间(trackingCreated)窗口取不到
    「生成早于当天、但当天接单并完成」的运单 —— 2026-09-17 实测同一天少 34 行
    （trackingCreated 5820 vs trackingFinish 5854），直接导致个别骑手少算一单
    （孙源源 18 单被算成 17 单，缺失那单 create=09-16 09:57 / accept=今天 08:20 /
    finish=今天 08:37，为当日生成的改派类运单）。

    已知取舍（务必知情）：本项目聚合侧仍按「骑手接单时间」归属日期（order_rules 单一来源），
    而接口没有「接单时间」维度。因此改成终态时间后，**「今天接单、次日完成」的跨午夜单**
    会落到次日文件里：当天取不到、次日归属又不符 → 与 2026-09-09 之前那次口径问题的成因一
    致（见 site_orders.py 的历史遗留说明）。若要彻底零丢失，需把归属口径也改为完成时间
    （那样与平台 fullDayFinishOrder 完全一致），或对两个字段取并集。

    切换后**历史缓存必须按新口径重新刷新**：已落盘的旧文件是按生成时间抓的，混用会算错。
    """
    try:
        sess = OF.Session()
        s_ms = AC._ymd_to_ms(start_date, False)
        e_ms = AC._ymd_to_ms(end_date, True)
        grouped = OF.fetch_orders_grouped(sess, s_ms, e_ms, time_field="trackingFinish")
    except Exception as e:
        return False, "%s: %s" % (type(e).__name__, e)
    hit = 0
    for tid in teams:
        rows = grouped.get(str(tid)) or []
        hit += len(rows)
        CACHE.save_raw("orders", str(tid), rows, start_date)
    return True, "全量 %d 条，本批站点命中 %d 条" % (
        sum(len(v) for v in grouped.values()), hit)


def _run(teams, start_date, end_date, time_code, month):
    global _LOG_PATH
    failed = []
    # 一次刷新一个日志文件：事后可回查「被限流几次 / 哪一站在哪一步卡住」
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        _LOG_PATH = os.path.join(
            LOG_DIR, "refresh_%s.log" % datetime.datetime.now().strftime("%Y%m%d_%H%M%S"))
    except Exception:
        _LOG_PATH = None
    OF.stats_reset()
    OF.set_log_path(_LOG_PATH)
    with _LOCK:
        _STATE["log_file"] = _LOG_PATH
        _STATE["stats"] = None
    _log("开始：站点 %s，日期 %s~%s" % (",".join(teams), start_date, end_date))
    try:
        # 阶段 0：一次拉全量运单并按站点分组落盘（失败则降级为各站点自行拉取）
        shared = False
        _set_current(SHARED_TEAM_KEY, "拉取全站运单明细")
        ok, msg = _fetch_shared_orders(teams, start_date, end_date)
        if ok:
            shared = True
            _log("共享运单：%s" % msg)
        else:
            _log("共享运单失败，降级为逐站拉取：%s" % msg)
        _set_current(SHARED_TEAM_KEY, "共享运单完成" if shared else "共享运单失败，逐站拉取")

        for tid in teams:
            name = AC.TEAM_NAMES.get(str(tid), str(tid))
            try:
                # 1) 骑手维度：考勤（+ 复用已落盘运单）→ 生成骑手结果
                _set_current(tid, "拉取考勤 / 生成骑手数据")
                rd = RD.compute(tid, time_code=time_code, start=start_date,
                                end=end_date, month=month, reuse_orders=shared)
                bad, why = _failed(rd)
                if bad:
                    raise RuntimeError("骑手维度：%s" % why)
                CACHE.save("rider", tid, rd, start_date)

                # 2) 站点维度：排班目标（+ 复用运单）+ 考勤 → 生成站点结果
                _set_current(tid, "拉取排班目标 / 生成站点数据")
                ac = AC.compute(tid, start_date, end_date, reuse_orders=shared)
                bad, why = _failed(ac)
                if bad:
                    raise RuntimeError("站点维度：%s" % why)
                CACHE.save("ach", tid, ac, start_date)

                _set_current(tid, "生成结果")
                n = len(rd.get("rows") or [])
                _finish_team(tid, True, "骑手 %d 人" % n, n)
            except Exception as e:
                failed.append({"id": str(tid), "name": name,
                               "error": "%s: %s" % (type(e).__name__, e)})
                _finish_team(tid, False, "%s: %s" % (type(e).__name__, e))
                traceback.print_exc()
    finally:
        st = OF.stats_snapshot()
        with _LOCK:
            _STATE["running"] = False
            _STATE["finished_at"] = _now()
            _STATE["current_team"] = None
            _STATE["current_stage"] = "完成" if not failed else "完成（有失败站点）"
            _STATE["error"] = failed or None
            _STATE["stats"] = st
        _log("结束：%s | 请求 %s 次，成功 %s，被限流 %s 次，其它失败 %s 次，"
             "重试 %s 次，重登 %s 次" % (
                 _STATE["current_stage"], st.get("requests"), st.get("ok"),
                 st.get("throttle"), st.get("failed"), st.get("retries"),
                 st.get("relogin")))
        OF.set_log_path(None)
        _LOG_PATH = None


if __name__ == "__main__":
    # 自测：不联网，只看状态机（把 compute 换成假函数）
    RD.compute = lambda t, **kw: {"ok": True, "source": "live", "rows": [{"x": 1}]}
    AC.compute = lambda t, s, e, **kw: {"ok": True, "source": "live", "rows": []}
    ok, msg = start(teams=["917521130", "917521136"])
    print("start:", ok, msg)
    for _ in range(20):
        st = status()
        print(" running=%s done=%s/%s stage=%s" % (
            st["running"], st["done"], st["total"], st["current_stage"]))
        if not st["running"]:
            break
        time.sleep(0.2)
    print(json.dumps(status(), ensure_ascii=False, indent=2)[:600])
