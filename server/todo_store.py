#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""工作内容（提醒事项）· SQLite 持久层

设计要点
========
1) 连接模型
   ThreadingHTTPServer 是多线程的，所以连接按线程本地化（threading.local），
   每个线程一把自己的 sqlite3 连接，避免跨线程用连接报错。
   进程内的写操作再用一把 RLock 串行；跨进程/跨实例由 SQLite 的 WAL +
   busy_timeout 兜底。三重保险，任一层都不会把库写坏。

2) 迁移方式（PRAGMA user_version）
   版本号存在 SQLite 自带的 user_version 头里，不额外建元数据表。
   MIGRATIONS 是有序的 (目标版本, [SQL 语句]) 列表：启动时读出当前版本，
   把大于它的步骤按序补齐，每步执行完立刻写回版本号。
   · 全新库 user_version=0 → 从头跑完所有步骤，天然等价于建表，不用维护两份 DDL；
   · 老库只跑增量步骤，且每步都是幂等的 CREATE TABLE IF NOT EXISTS / ADD COLUMN；
   · 升级失败会整体回滚（单步一个事务），不会留下半截 schema。
   新增字段的正确姿势：在 MIGRATIONS 末尾追加 (2, ["ALTER TABLE ..."])，
   不要去改已经发布过的步骤。

3) 重复规则：不预生成实例
   事项只存「模板 + 当前到期时间 remind_at」。触发或完成后用
   compute_next_due() 滚出下一次时间并写回，库里永远只有一条记录。
   对比「预生成未来 N 条实例」：不会随时间爆炸、改规则不用批量改实例、
   也不会在用户改了重复周期后留下一堆脏数据。

4) 幂等的最后一道防线
   todo_run.fire_key = "<item_id>#<到期时间>"，带 UNIQUE 约束。
   同一事项的同一到期时刻，在数据库层面最多只能插入一条执行记录 ——
   即使调度线程和手动点击同时到达，也只有一个能插进去，另一个拿
   IntegrityError 直接放弃。代码层的检查只是降低冲突概率，
   真正的互斥由这个约束保证。

时间格式：统一本地时间字符串 "YYYY-MM-DDTHH:MM"（ remind_at 也允许
只到 "YYYY-MM-DD"，比较时按当天 00:00 处理）。定长格式可以直接用
字符串比较排序，索引能生效，也方便人肉查库。
"""
import os
import re
import json
import time
import sqlite3
import threading
from datetime import datetime, timedelta, date

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "data", "todo.db")

_local = threading.local()
_lock = threading.RLock()

# ----------------------------------------------------------------- 常量
STATUS_OPEN = "open"
STATUS_DONE = "done"

# 执行记录状态：running 已派发未结束 / retrying 等待重试 / 终态 success failed skipped missed
RUN_RUNNING = "running"
RUN_RETRYING = "retrying"
RUN_SUCCESS = "success"
RUN_FAILED = "failed"
RUN_SKIPPED = "skipped"
RUN_MISSED = "missed"

MAX_ATTEMPTS = 3                      # 最多 3 次（1 次正式 + 2 次重试）
RETRY_DELAYS = [60, 300]              # 第 1、2 次重试的退避秒数
CATCHUP_GRACE_SEC = 15 * 60           # 重启补跑宽限期：超过 15 分钟视为错过，不补跑

WEEKDAY_CN = {1: "周一", 2: "周二", 3: "周三", 4: "周四",
              5: "周五", 6: "周六", 7: "周日"}


# ----------------------------------------------------------------- 迁移
# 每项是 (目标版本号, SQL 语句列表)。已发布的步骤不要修改，只能往后追加。
MIGRATIONS = [
    (1, [
        # ---- 列表（分组）----
        """CREATE TABLE IF NOT EXISTS todo_list (
             id          TEXT PRIMARY KEY,           -- 'l_xxxx'
             name        TEXT    NOT NULL,
             icon        TEXT    NOT NULL DEFAULT 'list-checks',
             color       TEXT    NOT NULL DEFAULT '#FF5000',
             sort_order  INTEGER NOT NULL DEFAULT 0,
             created_at  TEXT    NOT NULL,
             updated_at  TEXT    NOT NULL
           )""",

        # ---- 事项 ----
        """CREATE TABLE IF NOT EXISTS todo_item (
             id              TEXT PRIMARY KEY,        -- 'i_xxxx'
             list_id         TEXT    NOT NULL,
             title           TEXT    NOT NULL,
             note            TEXT    NOT NULL DEFAULT '',
             status          TEXT    NOT NULL DEFAULT 'open',   -- open | done
             done_at         TEXT,
             done_count      INTEGER NOT NULL DEFAULT 0,        -- 重复事项累计完成次数
             flag            INTEGER NOT NULL DEFAULT 0,        -- 标记重要
             remind_at       TEXT,                              -- 当前实例到期时间
             repeat_type     TEXT    NOT NULL DEFAULT 'none',   -- none|daily|weekly|monthly|custom
             repeat_interval INTEGER NOT NULL DEFAULT 1,
             repeat_by       TEXT    NOT NULL DEFAULT '',       -- weekly:'1,3,5' monthly:'15'|'L'
             repeat_end      TEXT    NOT NULL DEFAULT '',       -- 重复截止日，空=不限
             task_id         TEXT,                              -- 关联的任务中心任务 id（可空）
             task_args       TEXT    NOT NULL DEFAULT '{}',     -- 执行参数 JSON
             auto_run        INTEGER NOT NULL DEFAULT 0,        -- 到点自动执行开关
             last_run_at     TEXT,
             last_run_status TEXT,
             created_at      TEXT    NOT NULL,
             updated_at      TEXT    NOT NULL
           )""",

        # ---- 执行记录 ----
        """CREATE TABLE IF NOT EXISTS todo_run (
             id          INTEGER PRIMARY KEY AUTOINCREMENT,
             item_id     TEXT    NOT NULL,
             fire_key    TEXT    NOT NULL UNIQUE,    -- 去重键：item_id#到期时间
             due_at      TEXT    NOT NULL,
             started_at  TEXT,
             finished_at TEXT,
             status      TEXT    NOT NULL,           -- running|retrying|success|failed|skipped|missed
             attempt     INTEGER NOT NULL DEFAULT 1,
             retry_at    TEXT,                       -- retrying 状态下的下次重试时刻
             run_id      TEXT,                       -- RunManager 的运行 id
             message     TEXT    NOT NULL DEFAULT ''
           )""",

        # ---- 索引 ----
        # 列表视图：按列表 + 状态取未完成，最常走的路径
        "CREATE INDEX IF NOT EXISTS idx_item_list_status ON todo_item(list_id, status)",
        # 调度扫描：只扫「开了自动执行且未完成且有到期时间」的行，部分索引保持极小
        """CREATE INDEX IF NOT EXISTS idx_item_due ON todo_item(remind_at)
             WHERE auto_run=1 AND status='open'""",
        # 提醒展示：计划视图按 remind_at 排序
        "CREATE INDEX IF NOT EXISTS idx_item_remind ON todo_item(remind_at)",
        # 执行记录：按事项查历史（前端执行记录面板）
        "CREATE INDEX IF NOT EXISTS idx_run_item ON todo_run(item_id, due_at DESC)",
        # 轮询未完成执行：调度器每 tick 扫这个
        "CREATE INDEX IF NOT EXISTS idx_run_open ON todo_run(status) WHERE status IN ('running','retrying')",
    ]),
]


def use_path(path, reset=True):
    """切换数据库文件（测试、备份恢复用），顺带关掉当前线程的连接。

    不这么干的话测试会写脏用户的真实待办库 —— 这个口子就是为了避免那种事故。
    """
    global DB_PATH
    DB_PATH = path
    if reset:
        conn = getattr(_local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        _local.conn = None


def _connect():
    conn = sqlite3.connect(DB_PATH, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")      # 读写不互斥
    conn.execute("PRAGMA synchronous=NORMAL")    # WAL 下够安全，且快很多
    conn.execute("PRAGMA busy_timeout=15000")    # 抢不到锁先等，不要立刻报错
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def connect():
    """线程本地连接（每个线程只创建一次，之后复用）。"""
    conn = getattr(_local, "conn", None)
    if conn is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        conn = _connect()
        _local.conn = conn
    return conn


def init_db():
    """建库 / 迁移到最新版本。返回 (旧版本, 新版本)。"""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = connect()
    with _lock:
        cur = conn.execute("PRAGMA user_version")
        old = int(cur.fetchone()[0] or 0)
        new = old
        for target, stmts in MIGRATIONS:
            if target <= old:
                continue
            try:
                conn.execute("BEGIN IMMEDIATE")
                for s in stmts:
                    conn.execute(s)
                conn.execute("PRAGMA user_version = %d" % target)
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            new = target
        if old == 0 and new >= 1:
            _seed_default_lists()
    return (old, new)


def _seed_default_lists():
    """全新库塞三个默认列表，避免第一次进来是空的。"""
    now = _now()
    for i, (lid, name, icon, color) in enumerate([
        ("l_work",    "工作", "list-checks", "#FF5000"),
        ("l_station", "站点", "store",       "#1A73E8"),
        ("l_temp",    "临时", "lightbulb",   "#F5A623"),
    ]):
        connect().execute(
            "INSERT OR IGNORE INTO todo_list(id,name,icon,color,sort_order,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?)", (lid, name, icon, color, i, now, now))
    connect().commit()


# ----------------------------------------------------------------- 基础工具
def _now():
    return datetime.now().strftime("%Y-%m-%dT%H:%M")


def _now_full():
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _parse_dt(s):
    """'YYYY-MM-DDTHH:MM' 或 'YYYY-MM-DD' → datetime；非法返回 None。"""
    s = (s or "").strip()
    if not s:
        return None
    try:
        if len(s) == 10:
            return datetime.strptime(s, "%Y-%m-%d")
        return datetime.strptime(s[:16], "%Y-%m-%dT%H:%M")
    except Exception:
        return None


def api_list(row):
    return {"id": row["id"], "name": row["name"],
            "icon": row["icon"], "color": row["color"]}


def api_item(row, link_state="", has_open_run=False):
    """DB 行 → 前端用的驼峰结构。

    库里一律蛇形（SQL 习惯），前端一律驼峰（JS 习惯），只在这个边界上转一次。
    不转的话前端要到处写 it.remind_at 和 it.remindAt 两种写法，迟早出错。
    """
    return {
        "id":         row["id"],
        "listId":     row["list_id"],
        "title":      row["title"],
        "note":       row["note"] or "",
        "status":     row["status"],
        "done":       row["status"] == STATUS_DONE,
        "doneAt":     row["done_at"] or "",
        "doneCount":  int(row["done_count"] or 0),
        "flag":       bool(row["flag"]),
        "remindAt":   row["remind_at"] or "",
        "repeatType": row["repeat_type"] or "none",
        "repeatInterval": int(row["repeat_interval"] or 1),
        "repeatBy":   row["repeat_by"] or "",
        "repeatEnd":  row["repeat_end"] or "",
        "repeatLabel": describe_rule(rule_of(row)),
        "taskId":     row["task_id"] or "",
        "autoRun":    bool(row["auto_run"]),
        "lastRunAt":  row["last_run_at"] or "",
        "lastRunStatus": row["last_run_status"] or "",
        "linkState":  link_state,
        "hasOpenRun": bool(has_open_run),
        "createdAt":  row["created_at"],
        "updatedAt":  row["updated_at"],
    }


def _fmt(dt):
    return dt.strftime("%Y-%m-%dT%H:%M") if dt else None


def _uid(prefix):
    import uuid
    return prefix + uuid.uuid4().hex[:12]


# ----------------------------------------------------------------- 重复规则
def rule_of(row):
    """把一行事项的重复字段抽成规则字典（前端也用这个形状）。"""
    return {
        "type":     (row["repeat_type"] or "none") if row is not None else "none",
        "interval": int(row["repeat_interval"] or 1) if row is not None else 1,
        "by":       (row["repeat_by"] or "") if row is not None else "",
        "end":      (row["repeat_end"] or "") if row is not None else "",
    }


def normalize_rule(d):
    """校验并规范化前端传来的重复规则，返回 (type, interval, by, end)。

    越界值一律收敛到合法范围（interval<1 → 1，月份日期 >31 → 31，
    星期只保留 1..7 去重后升序），不让脏数据进库 —— 否则算下一次时间时会出怪值。
    """
    if not isinstance(d, dict):
        return ("none", 1, "", "")
    t = str(d.get("type") or "none").lower()
    if t not in ("none", "daily", "weekly", "monthly", "custom"):
        t = "none"
    try:
        n = int(d.get("interval") or 1)
    except Exception:
        n = 1
    n = max(1, min(999, n))

    by = ""
    if t == "weekly":
        raw = str(d.get("by") or "")
        days = sorted({int(x) for x in re.findall(r"\d+", raw) if 1 <= int(x) <= 7})
        by = ",".join(str(x) for x in days)
    elif t == "monthly":
        raw = str(d.get("by") or "").strip()
        if raw.upper() == "L":
            by = "L"
        else:
            m = re.search(r"\d+", raw)
            by = str(max(1, min(31, int(m.group(0))))) if m else ""

    end = str(d.get("end") or "").strip()
    if end:
        dt = _parse_dt(end)
        end = dt.strftime("%Y-%m-%d") if dt else ""
    if t == "none":
        n, by, end = 1, "", ""
    return (t, n, by, end)


def describe_rule(rule):
    """规则 → 中文说明（列表徽标与详情页都用它）。"""
    t = rule.get("type") or "none"
    n = max(1, int(rule.get("interval") or 1))
    by = rule.get("by") or ""
    if t == "none":
        return "不重复"
    if t == "daily":
        s = "每天" if n == 1 else ("每 %d 天" % n)
    elif t == "weekly":
        days = [int(x) for x in by.split(",") if x.strip()]
        names = "、".join(WEEKDAY_CN.get(d, str(d)) for d in days) or "当天"
        s = ("每%s" % names) if n == 1 else ("每 %d 周的 %s" % (n, names))
    elif t == "monthly":
        if by.upper() == "L":
            s = "每月最后一天" if n == 1 else ("每 %d 个月的最后一天" % n)
        else:
            day = by or "1"
            s = ("每月 %s 日" % day) if n == 1 else ("每 %d 个月的 %s 日" % (n, day))
    elif t == "custom":
        s = "每 %d 小时" % n
    else:
        s = "不重复"
    if rule.get("end"):
        s += "（至 %s）" % rule["end"]
    return s


def _last_day(y, m):
    if m == 12:
        return 31
    return (date(y, m + 1, 1) - timedelta(days=1)).day


def compute_next_due(rule, anchor_str, now_dt=None):
    """计算严格晚于 now_dt 的下一次到期时间。

    anchor_str 是「相位锚点」（首次提醒时间），决定每周几 / 每月几号 / 每天的时分。
    返回 datetime；不重复、已过截止日或算不出来时返回 None。
    """
    t = rule.get("type") or "none"
    if t == "none":
        return None
    anchor = _parse_dt(anchor_str)
    if anchor is None:
        return None
    now_dt = now_dt or datetime.now()
    n = max(1, int(rule.get("interval") or 1))
    end = _parse_dt(rule.get("end") or "")
    end_date = end.date() if end else None
    tm = anchor.time()

    def _ok(cand):
        if cand is None:
            return None
        if end_date and cand.date() > end_date:
            return None
        return cand

    if t == "daily":
        d = anchor.date()
        step = timedelta(days=n)
        for _ in range(4000):                       # 上限约 10 年，防死循环
            cand = datetime.combine(d, tm)
            if cand > now_dt:
                return _ok(cand)
            d += step
        return None

    if t == "custom":                               # 每 N 小时
        step = timedelta(hours=n)
        if anchor > now_dt:
            return _ok(anchor)
        k = int((now_dt - anchor).total_seconds() // (n * 3600)) + 1
        cand = anchor + timedelta(hours=n * k)
        while cand <= now_dt:
            cand += step
        return _ok(cand)

    if t == "weekly":
        days = [int(x) for x in str(rule.get("by") or "").split(",") if x.strip()]
        days = [d for d in days if 1 <= d <= 7]
        if not days:
            days = [anchor.isoweekday()]
        d = max(anchor.date(), now_dt.date())
        anchor_week = anchor.date() - timedelta(days=anchor.date().weekday())
        for _ in range(1200):                       # 约 3 年
            this_week = d - timedelta(days=d.weekday())
            diff = (this_week - anchor_week).days // 7
            if diff >= 0 and diff % n == 0 and d.isoweekday() in days:
                cand = datetime.combine(d, tm)
                if cand > now_dt:
                    return _ok(cand)
            d += timedelta(days=1)
        return None

    if t == "monthly":
        raw = str(rule.get("by") or "").strip()
        use_last = raw.upper() == "L"
        m = re.search(r"\d+", raw)
        dom = max(1, min(31, int(m.group(0)))) if m else anchor.day
        for offset in range(0, 600):                # 50 年
            if offset % n:
                continue
            mm = anchor.month - 1 + offset
            yy = anchor.year + mm // 12
            mm = mm % 12 + 1
            day = _last_day(yy, mm) if use_last else min(dom, _last_day(yy, mm))
            cand = datetime.combine(date(yy, mm, day), tm)
            if cand > now_dt:
                return _ok(cand)
        return None

    return None


# ----------------------------------------------------------------- 列表 CRUD
def list_lists():
    rows = connect().execute(
        "SELECT * FROM todo_list ORDER BY sort_order, created_at").fetchall()
    return [dict(r) for r in rows]


def create_list(name, icon="list-checks", color="#FF5000"):
    now = _now()
    lid = _uid("l_")
    with _lock:
        conn = connect()
        n = conn.execute("SELECT COUNT(*) c FROM todo_list").fetchone()["c"]
        conn.execute("INSERT INTO todo_list(id,name,icon,color,sort_order,created_at,updated_at)"
                     " VALUES(?,?,?,?,?,?,?)", (lid, name, icon, color, n, now, now))
        conn.commit()
    return get_list(lid)


def get_list(lid):
    r = connect().execute("SELECT * FROM todo_list WHERE id=?", (lid,)).fetchone()
    return dict(r) if r else None


def update_list(lid, **kw):
    fields = {k: v for k, v in kw.items()
              if k in ("name", "icon", "color", "sort_order") and v is not None}
    if not fields:
        return get_list(lid)
    fields["updated_at"] = _now()
    sql = "UPDATE todo_list SET %s WHERE id=?" % ",".join("%s=?" % k for k in fields)
    with _lock:
        conn = connect()
        conn.execute(sql, tuple(fields.values()) + (lid,))
        conn.commit()
    return get_list(lid)


def delete_list(lid):
    """删列表：下面还有事项就拒绝，前端会提示先移走。返回 (ok, 提示)。"""
    with _lock:
        conn = connect()
        n = conn.execute("SELECT COUNT(*) c FROM todo_item WHERE list_id=?", (lid,)).fetchone()["c"]
        if n:
            return (False, "列表下还有 %d 条事项，先删掉或移走" % n)
        conn.execute("DELETE FROM todo_list WHERE id=?", (lid,))
        conn.commit()
    return (True, "已删除列表")


# ----------------------------------------------------------------- 事项 CRUD
def list_items():
    rows = connect().execute(
        "SELECT * FROM todo_item ORDER BY created_at").fetchall()
    return [dict(r) for r in rows]


def get_item(iid):
    r = connect().execute("SELECT * FROM todo_item WHERE id=?", (iid,)).fetchone()
    return dict(r) if r else None


def create_item(title, list_id, note="", remind_at="", flag=0,
                repeat=None, task_id="", auto_run=0, task_args=None):
    now = _now()
    t, n, by, end = normalize_rule(repeat or {})
    iid = _uid("i_")
    with _lock:
        connect().execute(
            "INSERT INTO todo_item(id,list_id,title,note,status,flag,remind_at,"
            " repeat_type,repeat_interval,repeat_by,repeat_end,"
            " task_id,task_args,auto_run,created_at,updated_at)"
            " VALUES(?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?)",
            (iid, list_id, title, note or "", 1 if flag else 0, remind_at or "",
             t, n, by, end, task_id or "",
             json.dumps(task_args or {}, ensure_ascii=False),
             1 if auto_run else 0, now, now))
        connect().commit()
    return get_item(iid)


def update_item(iid, **kw):
    """局部更新事项。repeat 传 dict；remind_at / task_id / auto_run 等直接给值。"""
    row = get_item(iid)
    if not row:
        return None
    now = _now()
    fields = {}
    for k in ("title", "note", "remind_at", "list_id", "done_at", "last_run_at",
              "last_run_status", "task_id", "task_args"):
        if k in kw and kw[k] is not None:
            fields[k] = kw[k]
    if "flag" in kw and kw["flag"] is not None:
        fields["flag"] = 1 if kw["flag"] else 0
    if "auto_run" in kw and kw["auto_run"] is not None:
        fields["auto_run"] = 1 if kw["auto_run"] else 0
    if "status" in kw and kw["status"] in (STATUS_OPEN, STATUS_DONE):
        fields["status"] = kw["status"]
    if "repeat" in kw and isinstance(kw["repeat"], dict):
        t, n, by, end = normalize_rule(kw["repeat"])
        fields.update({"repeat_type": t, "repeat_interval": n,
                       "repeat_by": by, "repeat_end": end})

    if not fields:
        return row
    fields["updated_at"] = now
    sql = "UPDATE todo_item SET %s WHERE id=?" % ",".join("%s=?" % k for k in fields)
    with _lock:
        conn = connect()
        conn.execute(sql, tuple(fields.values()) + (iid,))
        conn.commit()
    return get_item(iid)


def delete_item(iid):
    with _lock:
        conn = connect()
        conn.execute("DELETE FROM todo_item WHERE id=?", (iid,))
        conn.execute("DELETE FROM todo_run WHERE item_id=?", (iid,))
        conn.commit()
    return True


def set_done(iid, done):
    """勾选 / 取消勾选完成。

    重复事项勾选后不进「已完成」，而是原地滚到下一次（remind_at 前移，
    status 保持 open），done_count +1 —— 跟 iPad 提醒事项一致：
    重复的提醒勾掉后又会出现一条新的。
    """
    row = get_item(iid)
    if not row:
        return None
    now_dt = datetime.now()
    if done:
        fields = {"status": STATUS_OPEN, "done_at": _now(),
                  "done_count": int(row["done_count"] or 0) + 1, "updated_at": _now()}
        rule = rule_of(row)
        if rule["type"] != "none":
            nxt = compute_next_due(rule, row["remind_at"], now_dt)
            if nxt:
                fields["remind_at"] = _fmt(nxt)
            fields["status"] = STATUS_OPEN
        else:
            fields["status"] = STATUS_DONE
    else:
        fields = {"status": STATUS_OPEN, "done_at": None, "updated_at": _now()}
        if row["done_count"]:
            fields["done_count"] = max(0, int(row["done_count"]) - 1)
    sql = "UPDATE todo_item SET %s WHERE id=?" % ",".join("%s=?" % k for k in fields)
    with _lock:
        conn = connect()
        conn.execute(sql, tuple(fields.values()) + (iid,))
        conn.commit()
    return get_item(iid)


# ----------------------------------------------------------------- 任务关联
def link_task(iid, task_id, auto_run=None):
    """关联任务。task_id 为空即取消关联（顺带关掉自动执行、清空执行参数）。"""
    if task_id:
        kw = {"task_id": task_id}
        if auto_run is not None:
            kw["auto_run"] = auto_run
        return update_item(iid, **kw)
    return update_item(iid, task_id="", auto_run=0, task_args="{}",
                       last_run_status=None)


def unlink_task(iid):
    """取消关联：只解绑，事项本身保留（用户的待办不该因为解绑而消失）。"""
    return link_task(iid, "")


def items_linked_to(task_id):
    """反查哪些事项关联了这个任务（任务被删时给前端提示用）。"""
    rows = connect().execute(
        "SELECT id,title FROM todo_item WHERE task_id=?", (task_id,)).fetchall()
    return [dict(r) for r in rows]


# ----------------------------------------------------------------- 调度查询
def due_items(now_str):
    """到期且需要自动执行的未完成事项。"""
    rows = connect().execute(
        "SELECT * FROM todo_item WHERE auto_run=1 AND status=? AND remind_at IS NOT NULL"
        " AND remind_at<>'' AND remind_at<=? ORDER BY remind_at",
        (STATUS_OPEN, now_str)).fetchall()
    return [dict(r) for r in rows]


def find_run(item_id, due_at):
    r = connect().execute("SELECT * FROM todo_run WHERE fire_key=?",
                          (fire_key(item_id, due_at),)).fetchone()
    return dict(r) if r else None


def fire_key(item_id, due_at):
    return "%s#%s" % (item_id, due_at or "")


def claim_run(item_id, due_at, run_id, attempt=1):
    """占位式领取一次触发。

    fire_key 上有 UNIQUE 约束：并发的第二次 INSERT 会抛 IntegrityError，
    调用方据此判定「已触发过」并放弃 —— 去重由数据库保证，不靠代码里的 if。
    """
    with _lock:
        conn = connect()
        conn.execute(
            "INSERT INTO todo_run(item_id,fire_key,due_at,started_at,status,attempt,run_id)"
            " VALUES(?,?,?,?,?,?,?)",
            (item_id, fire_key(item_id, due_at), due_at, _now_full(),
             RUN_RUNNING, attempt, run_id))
        conn.commit()
    return find_run(item_id, due_at)


def mark_missed(item_id, due_at, message):
    """错过本次（服务没在运行）—— 写一条记录占位，避免以后重复补跑。"""
    with _lock:
        conn = connect()
        try:
            conn.execute(
                "INSERT INTO todo_run(item_id,fire_key,due_at,started_at,finished_at,"
                " status,attempt,message) VALUES(?,?,?,?,?,?,0,?)",
                (item_id, fire_key(item_id, due_at), due_at, _now_full(), _now_full(),
                 RUN_MISSED, message))
            conn.commit()
        except sqlite3.IntegrityError:
            return None
    return find_run(item_id, due_at)


def mark_skipped(item_id, due_at, message):
    """到期了但没跑（关联任务已不存在 / 已被禁用）。

    同样写一条记录占位：一是让「本轮已处理」这个事实落库，调度线程下个 tick
    不会再碰它；二是在执行记录里留下痕迹，用户能查到为什么没跑。
    """
    with _lock:
        conn = connect()
        try:
            conn.execute(
                "INSERT INTO todo_run(item_id,fire_key,due_at,started_at,finished_at,"
                " status,attempt,message) VALUES(?,?,?,?,?,?,0,?)",
                (item_id, fire_key(item_id, due_at), due_at, _now_full(), _now_full(),
                 RUN_SKIPPED, message))
            conn.commit()
        except sqlite3.IntegrityError:
            return None          # 已有人处理过，直接放弃
    return find_run(item_id, due_at)


def finish_run(item_id, due_at, status, message=""):
    with _lock:
        connect().execute(
            "UPDATE todo_run SET status=?, finished_at=?, message=?, retry_at=NULL"
            " WHERE fire_key=?",
            (status, _now_full(), message or "", fire_key(item_id, due_at)))
        connect().commit()
        connect().execute(
            "UPDATE todo_item SET last_run_at=?, last_run_status=?, updated_at=?"
            " WHERE id=?", (_now_full(), status, _now_full(), item_id))
        connect().commit()


def schedule_retry(item_id, due_at, attempt, message=""):
    """失败后排队重试：状态转 retrying，重试时刻 = 现在 + 该次退避秒数。

    重试不新开一条记录（fire_key 仍指向同一个到期时刻），attempt 递增，
    这样「同一时间点只触发一次」的语义不被重试破坏。
    """
    delay = retry_delay_for(attempt)
    retry_at = (datetime.now() + timedelta(seconds=delay)).strftime("%Y-%m-%d %H:%M:%S")
    with _lock:
        connect().execute(
            "UPDATE todo_run SET status=?, attempt=?, message=?, retry_at=?"
            " WHERE fire_key=?",
            (RUN_RETRYING, attempt, message or "", retry_at, fire_key(item_id, due_at)))
        connect().commit()
    return True


def retry_delay_for(attempt):
    """第 attempt 次失败后等多久再试（attempt 从 1 开始）。"""
    idx = max(0, min(len(RETRY_DELAYS) - 1, attempt - 1))
    return RETRY_DELAYS[idx]


def retry_due(now_str=None):
    """到点该重试的记录。"""
    now_str = now_str or (datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    rows = connect().execute(
        "SELECT * FROM todo_run WHERE status=? AND retry_at IS NOT NULL AND retry_at<=?"
        " ORDER BY retry_at", (RUN_RETRYING, now_str)).fetchall()
    return [dict(r) for r in rows]


def open_runs():
    """尚未结束的执行记录（running 已派发 / retrying 等重试）。"""
    rows = connect().execute(
        "SELECT * FROM todo_run WHERE status IN (?,?) ORDER BY id",
        (RUN_RUNNING, RUN_RETRYING)).fetchall()
    return [dict(r) for r in rows]


def open_run_of(item_id):
    """该事项是否还有一次没跑完的执行（含等重试）。

    调度线程和手动点击都先看这个：同一事项同时只让一个执行在飞，
    既避免重复跑，也避免前一次还没结束就又排下一次。
    """
    r = connect().execute(
        "SELECT * FROM todo_run WHERE item_id=? AND status IN (?,?) ORDER BY id DESC LIMIT 1",
        (item_id, RUN_RUNNING, RUN_RETRYING)).fetchone()
    return dict(r) if r else None


def mark_dispatched(item_id, due_at, run_id, attempt):
    """重试派发：复用同一条记录，换 run_id 并回到 running。"""
    with _lock:
        connect().execute(
            "UPDATE todo_run SET status=?, run_id=?, attempt=?, started_at=?,"
            " finished_at=NULL, retry_at=NULL WHERE fire_key=?",
            (RUN_RUNNING, run_id, attempt, _now_full(), fire_key(item_id, due_at)))
        connect().commit()
    return find_run(item_id, due_at)


def item_runs(item_id, limit=10):
    rows = connect().execute(
        "SELECT * FROM todo_run WHERE item_id=? ORDER BY id DESC LIMIT ?",
        (item_id, limit)).fetchall()
    return [dict(r) for r in rows]


def advance_after_run(iid):
    """一次执行结束后推进事项状态，返回更新后的事项。

    · 重复事项：remind_at 滚到下一次，status 回 open（勾过也没关系，重复项不进已完成）；
    · 一次性事项：成功就标 done，失败保持 open（让用户看见没跑成，自己决定删还是重跑）。
    """
    row = get_item(iid)
    if not row:
        return None
    rule = rule_of(row)
    if rule["type"] != "none":
        nxt = compute_next_due(rule, row["remind_at"] or _now(), datetime.now())
        return update_item(iid, remind_at=_fmt(nxt) if nxt else row["remind_at"])
    return row


def settle_success(iid):
    row = get_item(iid)
    if not row:
        return None
    if rule_of(row)["type"] == "none":
        return update_item(iid, status=STATUS_DONE, done_at=_now())
    return advance_after_run(iid)


def prune_runs(keep_days=30):
    cutoff = (datetime.now() - timedelta(days=keep_days)).strftime("%Y-%m-%d %H:%M:%S")
    with _lock:
        connect().execute(
            "DELETE FROM todo_run WHERE finished_at IS NOT NULL AND finished_at < ?",
            (cutoff,))
        connect().commit()


# ----------------------------------------------------------------- 导入导出
def import_payload(payload):
    """把 localStorage 时代的老数据一次性迁进来。

    只在库是空的时候调用（前端判断），重复调用也不会产生重复数据：
    列表用 INSERT OR IGNORE，事项按原 id 写入，id 冲突时跳过。
    """
    lists = (payload or {}).get("lists") or []
    items = (payload or {}).get("items") or []
    now = _now()
    n_list = n_item = 0
    with _lock:
        conn = connect()
        for l in lists:
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO todo_list(id,name,icon,color,sort_order,"
                    " created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                    (l.get("id") or _uid("l_"), l.get("name") or "未命名",
                     l.get("icon") or "list-checks", l.get("color") or "#FF5000",
                     n_list, now, now))
                n_list += 1
            except Exception:
                pass
        for it in items:
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO todo_item(id,list_id,title,note,status,done_at,"
                    " flag,remind_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (it.get("id") or _uid("i_"),
                     it.get("listId") or "l_work",
                     it.get("title") or "未命名",
                     it.get("note") or "",
                     STATUS_DONE if it.get("done") else STATUS_OPEN,
                     it.get("doneAt") or None,
                     1 if it.get("flag") else 0,
                     it.get("remindAt") or "",
                     it.get("createdAt") or now, now))
                n_item += 1
            except Exception:
                pass
        conn.commit()
    return (n_list, n_item)


def db_info():
    """诊断用：版本、表、索引、条数。python -m server.todo_store 会打印。"""
    init_db()
    conn = connect()
    ver = conn.execute("PRAGMA user_version").fetchone()[0]
    tables = [r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    idx = [r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")]
    counts = {t: conn.execute("SELECT COUNT(*) c FROM %s" % t).fetchone()["c"]
              for t in tables}
    return {"db_path": DB_PATH, "schema_version": ver,
            "tables": tables, "indexes": idx, "counts": counts}


if __name__ == "__main__":
    import pprint
    pprint.pprint(db_info())
