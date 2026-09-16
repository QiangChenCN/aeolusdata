#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""P1 数据层：风神违规处罚拉数 + 剔除「超时」「不成立」。

与既有 appeal_reminder.py 的差异（重要）：
  - appeal_reminder 只筛「违规分类!=超时 且 申诉状态==待申诉」，且只保留 10 个字段；
  - 本模块按新需求筛「违规分类!=超时 且 违规状态!=不成立」，
    并**保留 CSV 全部 15 列且顺序不变**，以便与在线表格 D:R 列 1:1 直贴写入。

可直接运行自检：
  python -m jobs.unsat.fetcher            # 拉昨天
  python -m jobs.unsat.fetcher --date 2026-08-27
"""
import os
import io
import csv
import json
import sys
import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # jobs/
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "common"))

from . import config
from .store import log
from get_data import violation   # 风控处罚 CSV 取数（单一来源；与 appeal 共用 download_csv）

# 注意：API_URL / STATIC_HEADERS 等取数常量已迁到 get_data.violation（单一来源），
# 本模块不再持有任何取数实现，只负责日期窗口 / 登录 / 落盘 / 筛选。

BJ = datetime.timezone(datetime.timedelta(hours=8))


def day_range(date_str=None):
    """返回 (start_ms, end_ms, date_str)。date_str 为空时取【昨天】。"""
    if date_str:
        d = datetime.date.fromisoformat(date_str)
    else:
        d = (datetime.datetime.now(BJ) - datetime.timedelta(days=1)).date()
    start = datetime.datetime.combine(d, datetime.time(0, 0, 0), tzinfo=BJ)
    end = datetime.datetime.combine(d, datetime.time(23, 59, 59, 999000), tzinfo=BJ)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000), d.isoformat()


def _login():
    """延迟导入登录模块：服务端无该项目时可替换为独立实现。"""
    from aeolus_sdk import login as L
    cookie, status = L.ensure_cookies()
    log.info("风神登录状态: %s", status)
    return cookie


def download_csv(date_str=None):
    """拉取指定日期的违规处罚 CSV，返回 (text, date_str, file_url)。

    取数走 get_data.violation.download_csv（cookie + 时间窗由本函数准备后传入）；
    本函数负责日期窗口（默认昨天）+ 登录 + 落盘。
    """
    start_ms, end_ms, date_str = day_range(date_str)
    cookie = _login()
    text, file_url = violation.download_csv(start_ms, end_ms, cookie=cookie)
    with open(config.CSV_PATH, "wb") as f:
        f.write(text.encode("utf-8-sig"))
    return text, date_str, file_url


def filter_rows(text):
    """剔除「超时」(违规分类) 与「不成立」(违规状态)，保留 CSV 全部 15 列。

    两个字段语义独立，必须分别判断：
      - 违规分类 取值含「超时」「餐货损」「取消」等
      - 违规状态 取值含「成立」「不成立」
    """
    reader = csv.DictReader(io.StringIO(text))
    kept, dropped = [], []
    for r in reader:
        rec = {k: (v or "").strip() for k, v in r.items()}
        if rec.get("违规分类") == "超时":
            dropped.append((rec.get("违规编号", ""), "超时"))
            continue
        if rec.get("违规状态") == "不成立":
            dropped.append((rec.get("违规编号", ""), "不成立"))
            continue
        team = rec.get("团队名称", "")
        rec["站点"] = config.TEAM_TO_STATION.get(team, "未匹配:" + team)
        kept.append(rec)
    log.info("筛选：保留 %d 条，剔除 %d 条 %s", len(kept), len(dropped),
             json.dumps(dropped, ensure_ascii=False) if dropped else "")
    return kept


def to_matrix(rows):
    """行 dict → 二维矩阵，列顺序严格按 config.DETAIL_COLUMNS（与表格 D:R 1:1）。"""
    return [[r.get(c, "") for c in config.DETAIL_COLUMNS] for r in rows]


def fetch(date_str=None):
    """一步到位：拉数 → 筛选。返回 (rows, date_str, file_url)。"""
    text, date_str, file_url = download_csv(date_str)
    rows = filter_rows(text)
    log.info("日期 %s 命中（非超时 & 非不成立）: %d 条", date_str, len(rows))
    return rows, date_str, file_url


if __name__ == "__main__":
    ds = None
    if "--date" in sys.argv:
        ds = sys.argv[sys.argv.index("--date") + 1]
    rows, date_str, file_url = fetch(ds)
    print("日期: %s  命中: %d 条  下载链接: %s" % (date_str, len(rows), file_url))
    for r in rows:
        print(json.dumps({k: r[k] for k in ("运单号", "骑手名称", "团队名称",
                                            "站点", "违规分类", "违规状态")},
                         ensure_ascii=False))
