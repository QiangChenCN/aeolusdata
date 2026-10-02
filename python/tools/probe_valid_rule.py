#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""in-process 验证：按新口径（移除 isAbnormalReport 剔除）算伍政荣 8 单。"""
import sys, os, json, datetime

# >>> python-home bootstrap (added by layout migration) >>>
import os as _os
import sys as _sys
def _find_python_home():
    d = _os.path.dirname(_os.path.abspath(__file__))
    while d and _os.path.basename(d) != 'python':
        d = _os.path.dirname(d)
    return d
PY_HOME = _find_python_home()
ROOT = _os.path.dirname(PY_HOME) if PY_HOME else _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
_ROOT = ROOT
if PY_HOME and PY_HOME not in _sys.path:
    _sys.path.insert(0, PY_HOME)
# <<< python-home bootstrap <<<
# 移除写死的 WorkBuddy 外机路径；PY_HOME 沿用上方 bootstrap 推导的 python 根
os.chdir(PY_HOME)

from analytics import order_rules as OR

BJ = datetime.timezone(datetime.timedelta(hours=8))
data = json.load(open('dashboard/data/orders_917521136_2026-09-10.json', encoding='utf-8'))
target_rid = '1040107752'
today = '2026-09-10'

hits = [o for o in data if str(o.get('knightId') or '') == target_rid]
print(f"伍政荣 {target_rid} 当天接单总数: {len(hits)}")

valid = []
excluded = []
for i, o in enumerate(hits, 1):
    accept = OR.order_val(o, OR.ACCEPT_KEYS)
    accept_date = datetime.datetime.fromtimestamp(accept / 1000, tz=BJ).strftime('%Y-%m-%d')
    in_day = (accept_date == today)
    is_valid = in_day and OR.is_valid_order(o)
    reasons = []
    if not in_day:
        reasons.append(f"非本日(accept={accept_date})")
    if not OR.is_completed(o):
        reasons.append("配送失败/未完成")
    if OR._is_truthy_flag(OR.order_val(o, ("是否作弊", "isCheat", "cheatFlag"))):
        reasons.append("作弊")
    if OR.is_excluded_type(o):
        reasons.append("逆向/改派")
    if OR._is_truthy_flag(OR.order_val(o, ("是否异常上报", "isAbnormalReport", "abnormalFlag"))):
        reasons.append("异常上报[新口径：不再剔除]")
    flag = "有效" if is_valid else "排除"
    detail = f"({' / '.join(reasons)})" if reasons else ""
    state = o.get("stateDesc") or o.get("state")
    print(f"  #{i} tid={o.get('trackingId')} state={state!r} accept={accept_date} → {flag} {detail}")
    (valid if is_valid else excluded).append(o)

print()
print(f"按新口径：有效 {len(valid)} / 排除 {len(excluded)}")
print(f"期望：有效 4（#3 #4 #5 #6）/ 排除 4（#1 改派、#2 配送失败、#7 #8 非本日）")
assert len(valid) == 4, f"FAIL: 期望 4 有效，实际 {len(valid)}"
print("PASS")
