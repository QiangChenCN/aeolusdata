#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""P4 状态层：SQLite 持久化 + 统一日志。

表设计：
  orders     每日写入在线表格的运单明细 + 反馈状态（去重启用）
  feedbacks  站长的每一次反馈（文字/素材），供 LLM 判定与追溯
  reminders  提醒发送记录（去重，避免同一轮重复 @）

状态机（orders.status）：
  pending      已填表、未反馈
  judging      已收到反馈、待 LLM 判定
  rejected     判定不合规，已 @ 站长补充
  done         判定合规，停止提醒
"""
import os
import sys
import json
import logging
import sqlite3
import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # jobs/
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "common"))

from . import config

# ---------- 日志（文件 + 控制台）----------
log = logging.getLogger("unsat")
if not log.handlers:
    log.setLevel(logging.INFO)
    _fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    _fh = logging.FileHandler(config.LOG_PATH, encoding="utf-8")
    _fh.setFormatter(_fmt)
    _sh = logging.StreamHandler(sys.stdout)
    _sh.setFormatter(_fmt)
    log.addHandler(_fh)
    log.addHandler(_sh)

BJ = datetime.timezone(datetime.timedelta(hours=8))

DDL = """
CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_date       TEXT NOT NULL,      -- 数据日期
    violation_no    TEXT NOT NULL,      -- 违规编号
    tracking_no     TEXT,               -- 运单号
    rider_name      TEXT,
    team_name       TEXT,
    station         TEXT,               -- 站点简称
    sheet_row       INTEGER,            -- 在线表格所在行（写表后回填）
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT,
    updated_at      TEXT,
    UNIQUE(stat_date, violation_no)
);
CREATE TABLE IF NOT EXISTS feedbacks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        INTEGER,
    sender          TEXT,               -- 反馈人
    reason          TEXT,               -- A 原因分析
    action          TEXT,               -- B 改善措施
    media_json      TEXT,               -- C 培训素材 [{"type":"image"/"video","url":..}]
    raw_text        TEXT,
    judged          INTEGER DEFAULT 0,  -- 是否已判定
    pass_flag       INTEGER,            -- 1 合规 / 0 不合规
    missing_json    TEXT,               -- 缺失项
    llm_reason      TEXT,
    created_at      TEXT
);
CREATE TABLE IF NOT EXISTS reminders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_date       TEXT,
    station         TEXT,
    remind_hour     INTEGER,
    created_at      TEXT,
    UNIQUE(stat_date, station, remind_hour)
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(stat_date, status);
CREATE INDEX IF NOT EXISTS idx_orders_station ON orders(station);
"""


def now_str():
    return datetime.datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S")


def connect():
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    with connect() as conn:
        conn.executescript(DDL)
    log.info("数据库就绪: %s", config.DB_PATH)


# ---------- orders ----------
def upsert_orders(rows, stat_date):
    """写入/更新当日运单；已存在则保留其状态与行号，返回 (新增数, 全部行记录)。"""
    init_db()
    new = 0
    with connect() as conn:
        for r in rows:
            cur = conn.execute(
                "SELECT id FROM orders WHERE stat_date=? AND violation_no=?",
                (stat_date, r.get("违规编号", "")),
            )
            if cur.fetchone():
                continue
            conn.execute(
                "INSERT INTO orders (stat_date, violation_no, tracking_no, rider_name,"
                " team_name, station, status, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?, 'pending', ?, ?)",
                (stat_date, r.get("违规编号", ""), r.get("运单号", ""),
                 r.get("骑手名称", ""), r.get("团队名称", ""), r.get("站点", ""),
                 now_str(), now_str()),
            )
            new += 1
        conn.commit()
        allrows = conn.execute(
            "SELECT * FROM orders WHERE stat_date=? ORDER BY id", (stat_date,)
        ).fetchall()
    log.info("入库：新增 %d 条，当日共 %d 条", new, len(allrows))
    return new, [dict(x) for x in allrows]


def set_sheet_row(violation_no, row):
    with connect() as conn:
        conn.execute("UPDATE orders SET sheet_row=?, updated_at=? WHERE violation_no=?",
                     (row, now_str(), violation_no))
        conn.commit()


def set_status(violation_no, status):
    with connect() as conn:
        conn.execute("UPDATE orders SET status=?, updated_at=? WHERE violation_no=?",
                     (status, now_str(), violation_no))
        conn.commit()


def find_by_tracking(tracking_no, stat_date=None):
    """按运单号定位运单（站长反馈时匹配用）。"""
    init_db()
    with connect() as conn:
        if stat_date:
            cur = conn.execute(
                "SELECT * FROM orders WHERE tracking_no=? AND stat_date=? ORDER BY id DESC",
                (tracking_no, stat_date))
        else:
            cur = conn.execute(
                "SELECT * FROM orders WHERE tracking_no=? ORDER BY id DESC", (tracking_no,))
        r = cur.fetchone()
    return dict(r) if r else None


# ---------- feedbacks ----------
def add_feedback(order_id, sender, reason, action, media, raw_text):
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO feedbacks (order_id, sender, reason, action, media_json,"
            " raw_text, created_at) VALUES (?,?,?,?,?,?,?)",
            (order_id, sender, reason, action,
             json.dumps(media or [], ensure_ascii=False), raw_text, now_str()))
        conn.commit()
        return cur.lastrowid


def mark_judged(fid, pass_flag, missing, llm_reason):
    with connect() as conn:
        conn.execute(
            "UPDATE feedbacks SET judged=1, pass_flag=?, missing_json=?, llm_reason=?"
            " WHERE id=?",
            (1 if pass_flag else 0, json.dumps(missing, ensure_ascii=False),
             llm_reason, fid))
        conn.commit()


if __name__ == "__main__":
    init_db()
    print("数据库初始化完成:", config.DB_PATH)
