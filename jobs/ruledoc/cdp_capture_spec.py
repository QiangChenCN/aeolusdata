"""CDP（真 Edge，非 headless）抓取骑士规则中心「排版逻辑 + 数据接口」。

目的：只做【一次性发现】，不用于最终生成。
  1. 启动【非 headless】的真实 Edge（remote-debugging + allow-origins），可见窗口
  2. 注入 Aeolus 登录态为 .ele.me cookie
  3. 打开 rule-details 页，捕获所有网络请求 → 定位数据接口 queryRuleInfo
  4. 等前台渲染完成后，抓取「标题+生效栏+正文」外层容器 div.rule-details 的
     完整渲染 DOM，并把整棵子树 computed style 内联（faithful，不改任何宽高/对齐）
     —— 这就是「前台原生排版逻辑」的模板

产物（均为模板/参考，不直接交付给用户）：
  knight_rule_cdp_capture.json   —— 网络请求原始 capture（含 queryRuleInfo 接口）
  rule_native_reference.html     —— 前台原生渲染 DOM（自包含，样式已内联）

之后 gen_rule_doc.py 用纯 HTTP 取数据，套用本脚本产出的原生模板渲染。
"""
import json
import os
import sys
import time
import threading
import subprocess
import urllib.request
import base64
from websocket import create_connection

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
DEBUG_PORT = 9222
HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = os.path.join(HERE, "cdp_profile_knight")
COOKIE_FILE = os.path.join(os.path.dirname(HERE), "aeolus_sdk", "cookie.txt")
RULE_ID = int(os.environ.get("RULE_ID", "6355"))
IS_HISTORY = os.environ.get("IS_HISTORY", "true").lower() == "true"
TARGET_URL = (
    "https://aero-rush.ele.me/knight-rule-center/index.html"
    "#/rule-details?rule=%d&isHistory=%s&platform=aeolus" % (RULE_ID, "true" if IS_HISTORY else "false")
)
CAPTURE_OUT = os.path.join(HERE, "knight_rule_cdp_capture.json")
REFERENCE_OUT = os.path.join(HERE, "rule_native_reference_%d.html" % RULE_ID)
WAIT_SECONDS = int(os.environ.get("CDP_WAIT", "35"))


class CDP:
    def __init__(self, url):
        self.ws = create_connection(url, timeout=40)
        self._id = 0
        self._lock = threading.Lock()
        self._pending = {}
        self._events = []
        self._t = threading.Thread(target=self._read_loop, daemon=True)
        self._t.start()

    def _read_loop(self):
        while True:
            try:
                msg = self.ws.recv()
            except Exception:
                break
            if not msg:
                continue
            try:
                data = json.loads(msg)
            except Exception:
                continue
            if "id" in data and ("result" in data or "error" in data):
                self._pending[data["id"]] = data
            else:
                self._events.append(data)

    def send(self, method, params=None, wait=True):
        with self._lock:
            self._id += 1
            cid = self._id
        self.ws.send(json.dumps({"id": cid, "method": method, "params": params or {}}))
        if not wait:
            return None
        deadline = time.time() + 40
        while time.time() < deadline:
            if cid in self._pending:
                return self._pending.pop(cid)
            time.sleep(0.02)
        raise TimeoutError("no response for %s" % method)

    def events(self):
        return self._events


def is_port_up():
    try:
        urllib.request.urlopen("http://127.0.0.1:%d/json/version" % DEBUG_PORT, timeout=2)
        return True
    except Exception:
        return False


def launch_browser():
    if is_port_up():
        print("[browser] 9222 已在运行，复用")
        return
    # 注意：非 headless —— 真 Edge 可见窗口（用户要求），不传 --headless
    cmd = [
        EDGE,
        "--remote-debugging-port=%d" % DEBUG_PORT,
        "--user-data-dir=%s" % PROFILE,
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1366,900",
    ]
    subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
    )
    for _ in range(40):
        if is_port_up():
            print("[browser] 已启动并监听 9222（真 Edge 窗口）")
            return
        time.sleep(1)
    raise RuntimeError("Edge 调试实例未就绪")


def get_json(path):
    with urllib.request.urlopen("http://127.0.0.1:%d%s" % (DEBUG_PORT, path), timeout=5) as r:
        return json.loads(r.read())


def get_page_ws(target_id, retries=15):
    for _ in range(retries):
        try:
            targets = get_json("/json/list")
        except Exception:
            targets = []
        for t in targets:
            if t.get("id") == target_id and t.get("webSocketDebuggerUrl"):
                return t["webSocketDebuggerUrl"]
        time.sleep(0.3)
    raise RuntimeError("找不到页面 WS: %s" % target_id)


def parse_cookies(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read().strip()
    out = []
    for part in raw.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        out.append((k.strip(), v.strip()))
    return out


def kill_debug_edge():
    subprocess.run(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'msedge.exe\'\\" | Where-Object { $_.CommandLine -like \'*cdp_profile_knight*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
        shell=True,
    )


def main():
    launch_browser()
    ver = get_json("/json/version")
    print("[browser] %s" % ver.get("Browser"))

    b = CDP(ver["webSocketDebuggerUrl"])
    b.send("Target.enable")
    res = b.send("Target.createTarget", {"url": "about:blank"})
    target_id = res["result"]["targetId"]
    print("[tab] targetId=%s" % target_id)
    ws_url = get_page_ws(target_id)
    cdp = CDP(ws_url)

    cdp.send("Page.enable")
    cdp.send("Network.enable")
    cdp.send("Runtime.enable")

    cookies = parse_cookies(COOKIE_FILE)
    ok = 0
    for name, value in cookies:
        r = cdp.send("Network.setCookie", {
            "name": name, "value": value,
            "domain": ".ele.me", "path": "/", "secure": True,
        })
        if r.get("result", {}).get("success"):
            ok += 1
    print("[cookie] 已注入 %d/%d 个 .ele.me cookie" % (ok, len(cookies)))

    print("[nav] %s" % TARGET_URL)
    cdp.send("Page.navigate", {"url": TARGET_URL})

    # ---- 1) 收集网络请求（定位数据接口） ----
    req_meta = {}
    seen = set()
    start = time.time()
    while time.time() - start < WAIT_SECONDS:
        for ev in cdp.events():
            mid = id(ev)
            if mid in seen:
                continue
            seen.add(mid)
            method = ev.get("method")
            params = ev.get("params", {})
            if method == "Network.requestWillBeSent":
                rid = params["requestId"]
                req = params["request"]
                req_meta[rid] = {
                    "url": req.get("url"),
                    "method": req.get("method"),
                    "headers": req.get("headers", {}),
                    "postData": req.get("postData"),
                    "resourceType": params.get("type"),
                }
            elif method == "Network.responseReceived":
                rid = params["requestId"]
                resp = params.get("response", {})
                m = req_meta.setdefault(rid, {})
                m["status"] = resp.get("status")
                m["mimeType"] = resp.get("mimeType")
                m["respHeaders"] = resp.get("headers", {})
                m["resourceType"] = m.get("resourceType") or params.get("type")
            elif method == "Network.loadingFinished":
                rid = params["requestId"]
                m = req_meta.get(rid)
                if not m:
                    continue
                try:
                    body_res = cdp.send("Network.getResponseBody", {"requestId": rid}, wait=True)
                    bb = body_res.get("result", {})
                    data = bb.get("body", "")
                    if bb.get("base64Encoded"):
                        data = base64.b64decode(data).decode("utf-8", "replace")
                    m["body"] = data
                except Exception as ex:
                    m["body_error"] = str(ex)
        time.sleep(0.3)
    print("[capture] 收集到 %d 个网络请求" % len(req_meta))

    # ---- 2) 抓前台原生渲染 DOM（faithful，不改任何宽高/对齐） ----
    js = r"""
    (function(){
      function findBody(){
        var eds=document.querySelectorAll('[data-cangjie-editable="true"]');
        var best=null;
        for(var i=0;i<eds.length;i++){
          var t=eds[i].innerText||'';
          if(t.length>200 && (!best || t.length>best.innerText.length)) best=eds[i];
        }
        return best;
      }
      function findTitleEl(){
        var h=document.querySelector('h1.text-limit-two-lines');
        if(h) return h;
        var hs=document.querySelectorAll('h1,h2');
        for(var i=0;i<hs.length;i++){
          var t=hs[i].innerText||'';
          if(t.indexOf('制度')>=0||t.indexOf('规则')>=0||t.indexOf('办法')>=0||t.indexOf('标准')>=0||t.indexOf('规范')>=0)
            return hs[i];
        }
        return null;
      }
      // 把 computed style 逐属性内联（faithful：保留前台真实计算样式，不改）
      function inline(node){
        var props=['font-family','font-size','font-weight','font-style','font-variant',
          'color','line-height','letter-spacing','word-spacing','text-align','text-indent',
          'text-decoration','text-transform','white-space','word-break','overflow-wrap',
          'vertical-align','background-color','background','border-radius',
          'border-top-width','border-right-width','border-bottom-width','border-left-width',
          'border-top-style','border-right-style','border-bottom-style','border-left-style',
          'border-top-color','border-right-color','border-bottom-color','border-left-color',
          'margin-top','margin-right','margin-bottom','margin-left',
          'padding-top','padding-right','padding-bottom','padding-left',
          'width','min-width','max-width','height','min-height','max-height','display',
          'box-sizing','box-shadow','list-style-type','text-overflow','opacity',
          'flex-direction','justify-content','align-items','flex-wrap','gap','flex','flex-grow','flex-shrink'];
        function copy(el){
          var cs=getComputedStyle(el); var s='';
          for(var i=0;i<props.length;i++){
            var v=cs.getPropertyValue(props[i]);
            if(v && v!=='0px' && v!=='normal' && v!=='none' && v!=='auto' && v!=='start')
              s+=props[i]+':'+v+';';
          }
          var ex=el.getAttribute('style')||'';
          if(ex && ex.charAt(ex.length-1)!==';') ex+=';';
          el.setAttribute('style', ex+s);
          for(var c=0;c<el.children.length;c++) copy(el.children[c]);
        }
        copy(node);
      }
      var titleEl=findTitleEl();
      var bodyEl=findBody();
      var root=null;
      var rds=document.querySelectorAll('div.rule-details');
      for(var i=0;i<rds.length;i++){
        if(bodyEl && rds[i].contains(bodyEl)){ root=rds[i]; break; }
      }
      if(!root && rds.length) root=rds[0];
      if(!root) root = (titleEl&&bodyEl) ? (function(){return null;})() : (bodyEl||titleEl);
      if(!root) return JSON.stringify({title:null,eff:null,html:null});
      inline(root);   // 仅内联计算样式，不改任何布局
      return JSON.stringify({
        title: titleEl?titleEl.innerText.trim():null,
        html: root.outerHTML
      });
    })()
    """
    res = cdp.send("Runtime.evaluate", {"expression": js, "returnByValue": True})
    val = res.get("result", {}).get("result", {}).get("value")
    dom = json.loads(val) if isinstance(val, str) else (val or {})

    cdp.ws.close()
    b.ws.close()
    # 注意：保留 Edge 调试窗口（不 kill），方便用户手动调试/查看

    # 落盘网络 capture
    api_calls = []
    for rid, m in req_meta.items():
        rt = m.get("resourceType")
        url = m.get("url", "")
        if (rt in ("XHR", "Fetch")) or ("ele.me" in url and "static" not in url
                and (m.get("postData") or "json" in (m.get("mimeType") or "")
                     or any(k in url.lower() for k in ("api", "query", "rule", "detail", "get", "list", "info")))):
            api_calls.append(m)
    with open(CAPTURE_OUT, "w", encoding="utf-8") as f:
        json.dump({"target": TARGET_URL, "requests": req_meta, "api_calls": api_calls}, f, ensure_ascii=False, indent=2)
    print("[save] 网络 capture -> %s" % CAPTURE_OUT)

    # 落盘原生参考 DOM
    html_doc = None
    if dom.get("html"):
        html_doc = (
            "<!DOCTYPE html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\n"
            "<title>" + (dom.get("title") or "reference") + "</title>\n"
            "</head>\n<body>\n" + dom["html"] + "\n</body></html>"
        )
        with open(REFERENCE_OUT, "w", encoding="utf-8") as f:
            f.write(html_doc)
        print("[save] 原生参考 DOM -> %s (title=%s, %d KB)"
              % (REFERENCE_OUT, dom.get("title"), len(html_doc.encode("utf-8")) // 1024))
    else:
        print("[warn] 未抓到原生渲染 DOM")

    # 控制台打印数据接口摘要
    print("\n===== API / XHR / Fetch 请求摘要 =====")
    for m in api_calls:
        print("\n--- %s %s" % (m.get("method"), m.get("url")))
        if m.get("postData"):
            print("    postData=%s" % m["postData"][:600])
        body = m.get("body")
        if body:
            print("    body=%s" % (body if len(body) <= 800 else body[:800] + "...[truncated]"))

    return 0


if __name__ == "__main__":
    sys.exit(main())
