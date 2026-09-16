#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证 queryTaskUrl（拿 fileUrl）+ 下载文件（验证无需 cookie）。"""
import json, urllib.request, urllib.error

CK = open(r"E:/WorkBuddy/风神数据处理/aeolus_sdk/cookie.txt", encoding="utf-8").read().strip()
H = {"accept": "application/json, text/plain, */*", "content-type": "application/json",
      "origin": "https://aeolus.ele.me", "referer": "https://aeolus.ele.me/", "cookie": CK}

def post_json(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=H, method="POST")
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode())

TASK_ID = 118344788  # 上次 queryExportTask 里 status=1 导出成功的任务
url = "https://httpizza.ele.me/xtop/xtop.merchant.agencyTrackingFs.agencyTrackingFs.queryTaskUrl/2.0"
print("=== queryTaskUrl ===")
j = post_json(url, {"params": {"request": {"taskId": TASK_ID}}})
print(json.dumps(j, ensure_ascii=False)[:800])

# result.data 直接是 fileUrl 字符串（OSS 签名链接）
file_url = (j.get("result") or {}).get("data")
if not isinstance(file_url, str):
    file_url = (file_url or {}).get("fileUrl") or (file_url or {}).get("url")
print("\nfileUrl =", file_url[:160], "...")

if file_url:
    print("\n=== 下载文件（不带 cookie，验证 violation 同款免鉴权）===")
    try:
        req = urllib.request.Request(file_url, headers={"user-agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        print("下载成功: %d 字节, content-type=%s" % (len(data), r.headers.get("content-type")))
        # 存盘供检查（落 _sniff 目录）
        import os
        os.makedirs(r"E:/WorkBuddy/风神数据处理/_sniff", exist_ok=True)
        fn = r"E:/WorkBuddy/风神数据处理/_sniff/export_sample.xlsx"
        open(fn, "wb").write(data)
        print("已存:", fn)
        # 看表头（xlsx 是 zip，先看前几个字节确认）
        print("magic:", data[:4].hex())
    except Exception as e:
        print("下载失败:", type(e).__name__, str(e)[:300])
