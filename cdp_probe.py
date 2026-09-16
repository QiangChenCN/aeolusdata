import subprocess, time, json, sys, urllib.request, websocket

EDGE = r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
PORT = 9222
UDA = r"C:/tmp/edgedebug9222"
URL = "http://127.0.0.1:8909/"

def log(*a):
    print(*a, flush=True)

# 1) 同进程内启动带 CDP 的 Edge 调试实例（纯 ASCII user-data-dir）
proc = subprocess.Popen([EDGE, f"--remote-debugging-port={PORT}", "--remote-allow-origins=*", f"--user-data-dir={UDA}", "about:blank"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
log("Edge 启动 PID", proc.pid)

# 2) 等 9222 LISTENING
up = False; last = None
for _ in range(30):
    time.sleep(1)
    try:
        ver = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=2).read())
        up = True; break
    except Exception as e:
        last = e
if not up:
    log("Edge CDP 未就绪:", last); proc.terminate(); sys.exit(1)
log("Edge CDP 就绪:", ver.get("Browser"))

# 3) 连 browser ws
bws = websocket.create_connection(ver["webSocketDebuggerUrl"], timeout=10)
_bid = [0]
def bsend(method, params=None):
    _bid[0]+=1; rid=_bid[0]
    bws.send(json.dumps({"id":rid,"method":method,"params":params or {}}))
    return rid
def brecv(rid, timeout=5):
    bws.settimeout(timeout); end=time.time()+timeout
    while time.time()<end:
        try: raw=bws.recv()
        except: return None
        m=json.loads(raw)
        if m.get("id")==rid: return m
    return None

bsend("Target.createTarget", {"url":"about:blank"})
r=brecv(_bid[0]); target_id=r["result"]["targetId"]
log("新 page target:", target_id)

# 4) 连 page ws
pws = websocket.create_connection(f"ws://127.0.0.1:{PORT}/devtools/page/{target_id}", timeout=10)
_pid=[0]; events=[]
def psend(method, params=None, _await=True):
    _pid[0]+=1; rid=_pid[0]
    pws.send(json.dumps({"id":rid,"method":method,"params":params or {}}))
    if not _await: return rid
    return precv(rid)
def precv(rid, timeout=5):
    pws.settimeout(timeout); end=time.time()+timeout
    while time.time()<end:
        try: raw=pws.recv()
        except: return None
        m=json.loads(raw)
        if "method" in m: events.append(m)
        if m.get("id")==rid: return m
    return None
def evaluate(expr):
    m=psend("Runtime.evaluate", {"expression":expr,"returnByValue":True,"awaitPromise":True})
    if m and "result" in m:
        return m["result"].get("result",{}).get("value")
    return None
def drain(sec):
    pws.settimeout(0.3); end=time.time()+sec
    while time.time()<end:
        try: raw=pws.recv()
        except:
            if time.time()>=end: break
            continue
        m=json.loads(raw)
        if "method" in m: events.append(m)

psend("Runtime.enable"); psend("Page.enable"); psend("Log.enable"); psend("Network.enable")
psend("Page.navigate", {"url":URL})
log("navigate ->", URL)
time.sleep(6)
drain(1)
conn0 = evaluate("document.getElementById('connTxt') ? document.getElementById('connTxt').textContent : 'NO_CONN_EL'")
log("初始 connTxt:", repr(conn0))

def conn():
    return evaluate("document.getElementById('connTxt')?document.getElementById('connTxt').textContent:'NO'")
def click_text(txt):
    return evaluate("""(function(){
      var bs=[...document.querySelectorAll('#navBox button')];
      for(var b of bs){ var t=(b.querySelector('.nm')?b.querySelector('.nm').textContent:b.textContent).trim();
        if(t.indexOf(%s)>=0){ b.click(); return t; } }
      return 'NOT_FOUND';
    })()""" % json.dumps(txt))

# 聚焦对比：任务中心子视图(全部任务) vs 数据看板子视图(标准达成)
labels=["首页","任务中心","全部任务","排班考勤","数据看板","标准达成","工作内容"]
report=[]
for label in labels:
    before=conn()
    hit=click_text(label)
    time.sleep(1.5)
    after=conn()
    report.append((label, before, after, hit))
    log("[%s] hit=%r: %r -> %r" % (label, hit, before, after))

# 最终确认标准达成视图真的渲染（点进去读 #stdCards 内容）
click_text("标准达成"); time.sleep(1.5)
std = evaluate("document.querySelector('#stdCards')?document.querySelector('#stdCards').textContent.slice(0,120):'NO_STDCARDS'")
log("标准达成 #stdCards 内容(前120字):", repr(std))

log("\n=== Network 失败 / 4xx ===")
neterr=[m for m in events if m.get("method")=="Network.loadingFailed" or
        (m.get("method")=="Network.responseReceived" and m.get("params",{}).get("response",{}).get("status",0)>=400)]
for m in neterr[:40]:
    if m["method"]=="Network.loadingFailed":
        log("LOAD_FAIL", m["params"].get("type"), m["params"].get("errorText"))
    else:
        rr=m["params"]["response"]; log("HTTP", rr.get("status"), rr.get("url"))

log("\n=== 连接状态变化汇总 ===")
for t,b,a,h in report:
    flag="  <-- 断开!" if (a and "断开" in a) else ""
    log("%s: %s -> %s%s  (hit=%s)" % (t,b,a,flag,h))

errs=[m for m in events if m.get("method") in ("Runtime.consoleAPICalled","Runtime.exceptionThrown","Log.entryAdded")]
log("\n=== 控制台/异常事件 (%d) ===" % len(errs))
for m in errs[:60]:
    mm=m["method"]
    if mm=="Runtime.consoleAPICalled":
        args=[a.get("value","") for a in m["params"].get("args",[])]
        log("console", m["params"].get("type"), args)
    elif mm=="Runtime.exceptionThrown":
        d=m["params"]["exceptionDetails"]
        log("EXCEPTION", d.get("text"), (d.get("exception") or {}).get("description",""))
    elif mm=="Log.entryAdded":
        log("LOG", m["params"].get("level"), m["params"].get("text"))

proc.terminate()
log("done")
