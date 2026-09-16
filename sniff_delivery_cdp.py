#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CDP 嗅探 Aeolus 运单查询页的导出(下载中心)链路。

同进程内启动真实 Edge(CDP) + 注入登录态 + 打开运单查询页
  https://aeolus.ele.me/?targetId=55220#/delivery/data
自动点「查询」→「导出」，用 Network.getResponseBody 截获：
  1) agencyTrackingFs.exportTracking/2.0   的请求体（导出条件：日期/站点/筛选）
  2) agencyTrackingFs.queryExportTask/2.0  的轮询响应（任务状态）
  3) agencyTrackingFs.queryTaskUrl/2.0     的响应（fileUrl 结构）
产物：sniff_delivery_export.json
"""
import subprocess, time, json, sys, os, urllib.request, websocket

EDGE = r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
PORT = 9222
PROFILE = r"C:/tmp/edgedebug9222"
COOKIE_FILE = r"E:/WorkBuddy/风神数据处理/aeolus_sdk/cookie.txt"
OUT = r"E:/WorkBuddy/风神数据处理/sniff_delivery_export.json"
URL = "https://aeolus.ele.me/?targetId=55220#/delivery/data"
WAIT_LOAD = 30
WAIT_QUERY = 10
WAIT_EXPORT = 12

def log(*a):
    print(*a, flush=True)

cookies = []
with open(COOKIE_FILE, encoding="utf-8") as f:
    for part in f.read().strip().split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            cookies.append((k.strip(), v.strip()))
log("cookie 条目:", [k for k, _ in cookies])

os.makedirs(PROFILE, exist_ok=True)
proc = subprocess.Popen(
    [EDGE, f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
     f"--user-data-dir={PROFILE}", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
log("Edge 启动 PID", proc.pid)

up = False
for _ in range(30):
    time.sleep(1)
    try:
        ver = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=2).read())
        up = True
        break
    except Exception:
        pass
if not up:
    log("Edge CDP 未就绪")
    proc.terminate()
    sys.exit(1)
log("Edge CDP 就绪:", ver.get("Browser"))

bws = websocket.create_connection(ver["webSocketDebuggerUrl"], timeout=15)
_bid = [0]
def bsend(method, params=None):
    _bid[0] += 1
    bws.send(json.dumps({"id": _bid[0], "method": method, "params": params or {}}))
    return _bid[0]
def brecv(rid, timeout=8):
    bws.settimeout(timeout)
    end = time.time() + timeout
    while time.time() < end:
        try:
            m = json.loads(bws.recv())
        except Exception:
            return None
        if m.get("id") == rid:
            return m
    return None

bsend("Target.createTarget", {"url": "about:blank"})
r = brecv(_bid[0])
target_id = r["result"]["targetId"]
log("新 page target:", target_id)

pws = websocket.create_connection(f"ws://127.0.0.1:{PORT}/devtools/page/{target_id}", timeout=15)
_pid = [0]
events = []
def psend(method, params=None, _await=True):
    _pid[0] += 1
    pws.send(json.dumps({"id": _pid[0], "method": method, "params": params or {}}))
    if not _await:
        return _pid[0]
    return precv(_pid[0])
def precv(rid, timeout=8):
    pws.settimeout(timeout)
    end = time.time() + timeout
    while time.time() < end:
        try:
            m = json.loads(pws.recv())
        except Exception:
            return None
        if "method" in m:
            events.append(m)
        if m.get("id") == rid:
            return m
    return None

psend("Network.enable")
psend("Runtime.enable")
psend("Page.enable")

for k, v in cookies:
    psend("Network.setCookie", {
        "name": k, "value": v, "domain": ".ele.me", "path": "/",
        "secure": True, "httpOnly": False,
    }, _await=False)

psend("Page.navigate", {"url": URL})
log("navigate ->", URL)
time.sleep(WAIT_LOAD)
log("页面加载等待完毕")

def click_btn(txt):
    expr = ("""function(){var btns=document.querySelectorAll('button');"""
            """for(var i=0;i<btns.length;i++){var t=(btns[i].innerText||'').trim();"""
            """if(t==='%s'){btns[i].click();return 'clicked:'+t;}}return 'notfound:%s';}()""" % (txt, txt))
    try:
        res = psend("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        return res["result"]["result"]["value"]
    except Exception as e:
        return "err:" + str(e)

def diag():
    expr = ("""JSON.stringify({"""
            """body: (document.body?document.body.innerText.slice(0,400):'NO_BODY'),"""
            """hit: [...document.querySelectorAll('*')].filter(e=>{var t=(e.innerText||'').trim();"""
            """return (t.indexOf('查询')>=0||t.indexOf('导出')>=0) && t.length<20;})"""
            """.slice(0,15).map(e=>e.tagName+'.'+e.className+':'+e.innerText.trim().slice(0,15)),"""
            """btnCount: document.querySelectorAll('button').length,"""
            """antBtn: document.querySelectorAll('.ant-btn').length})""")
    try:
        res = psend("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        return res["result"]["result"]["value"]
    except Exception as e:
        return "err:%r" % e

log("页面诊断:", diag())
time.sleep(2)

def drain(sec):
    pws.settimeout(0.3)
    end = time.time() + sec
    while time.time() < end:
        try:
            m = json.loads(pws.recv())
        except Exception:
            if time.time() >= end:
                break
            continue
        if "method" in m:
            events.append(m)
drain(6)

# 采集：对每个 agencyTrackingFs 请求，抓 postData + response body
xdump = {}
for m in events:
    if m.get("method") == "Network.requestWillBeSent":
        req = m["params"].get("request", {})
        url = req.get("url", "")
        if "agencyTrackingFs" in url:
            rid = m["params"]["requestId"]
            xdump.setdefault(url, {})["request_id"] = rid
            xdump[url]["method"] = req.get("method")
            pd = req.get("postData")
            xdump[url]["postData"] = pd
    if m.get("method") == "Network.responseReceived":
        url = m["params"]["response"].get("url", "")
        if "agencyTrackingFs" in url:
            rid = m["params"]["requestId"]
            xdump.setdefault(url, {})["request_id"] = rid
            xdump[url]["status"] = m["params"]["response"].get("status")

# 抓响应体
for url, info in xdump.items():
    rid = info.get("request_id")
    if not rid:
        continue
    try:
        rb = psend("Network.getResponseBody", {"requestId": rid}, _await=True)
        if rb and "result" in rb:
            body = rb["result"].get("body", "")
            info["response_body"] = body[:4000]
        else:
            info["response_body"] = "<getResponseBody failed: %s>" % json.dumps(rb)[:200]
    except Exception as e:
        info["response_body"] = "<err:%s>" % e

# 精简：只保留关心的三个导出接口
def short(u):
    return u.split("/xtop/")[-1] if "/xtop/" in u else u
result = {
    "page_url": URL,
    "captured_agencyTrackingFs": {short(u): info for u, info in xdump.items()},
}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
log(f"已写出 {OUT}：捕获 {len(xdump)} 个 agencyTrackingFs 接口")
for u, info in xdump.items():
    log(" -", short(u), "| status=", info.get("status"), "| postLen=",
        len(info.get("postData") or ""), "| respLen=", len(info.get("response_body") or ""))
proc.terminate()
log("done")
