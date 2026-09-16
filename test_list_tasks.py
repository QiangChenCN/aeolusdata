#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只读：试多个 body 候选，调 queryExportTask，dump 任务完整字段。"""
import json, urllib.request

CK = open(r"E:/WorkBuddy/风神数据处理/aeolus_sdk/cookie.txt", encoding="utf-8").read().strip()
H = {"accept": "application/json, text/plain, */*", "content-type": "application/json",
     "origin": "https://aeolus.ele.me", "referer": "https://aeolus.ele.me/", "cookie": CK}

def post_json(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=H, method="POST")
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode())

url = "https://httpizza.ele.me/xtop/xtop.merchant.agencyTrackingFs.agencyTrackingFs.queryExportTask/2.0"
candidates = [
    {"activeTabKey": "1"},
    {},
    {"current": 1, "pageSize": 50},
    {"activeTabKey": "1", "current": 1, "pageSize": 50},
]
for body in candidates:
    print("=" * 60)
    print("body:", json.dumps(body, ensure_ascii=False))
    try:
        j = post_json(url, {"params": {"request": body}})
    except Exception as e:
        print("  异常:", e); continue
    print("  code:", j.get("code"), "msg:", j.get("msg"))
    data = (j.get("result") or {}).get("data")
    print("  data type:", type(data).__name__)
    tasks = data if isinstance(data, list) else (data.get("list") or data.get("records") or data.get("data") or [])
    print("  任务数:", len(tasks))
    if tasks:
        print("  --- 第一个任务完整字段 ---")
        print(json.dumps(tasks[0], ensure_ascii=False, indent=2)[:1500])
        break
