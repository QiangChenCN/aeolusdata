#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""风神数据处理 · 任务运行工作台 后端服务

纯 Python 标准库实现，无任何第三方依赖。

职责：
  1. 读取 workbench/tasks.json 任务注册表
  2. 串行调度任务（全局单队列 —— 刻意串行，避免 aeolus_sdk/cookie.txt 并发争抢）
  3. 子进程执行 + 实时日志流式输出（SSE）
  4. 失败时按已知错误模式给出可读的诊断建议

启动：
  python server.py [--port 8917]
"""
import os
import io
import re
import sys
import json
import time
import queue
import glob
import shutil
import threading
import subprocess
import traceback
import logging
import urllib.request
import urllib.error
import secrets
import hashlib
import fnmatch
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# RBAC 权限核心（纯标准库：用户库 / 会话 / 角色权限 / 审计）
from core import auth
# 数据权限（行级隔离，按 team 维度）：本模块管「能看哪些站点的数据」
from core import dataperm

# P0：结构化日志替代散落 print（诊断/异常走 logger；启动横幅保留 print 给用户看）
# logging 是标准库，不引入第三方依赖。
log = logging.getLogger("workbench")
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s [%(name)s] %(message)s")

# 表格解析（开源库，可选）：xlsx 用 openpyxl、老 xls 用 xlrd。
# 没装不影响其它接口，仅 /api/sheet 会返回 ok:false。
try:
    import openpyxl
except Exception:
    openpyxl = None
try:
    import xlrd
except Exception:
    xlrd = None

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workbench")   # workbench/ 包目录：tasks.json / runs / data / 兄弟模块
ROOT = os.path.dirname(os.path.abspath(__file__))                            # 项目根目录（server.py 已移到根）
VENDOR = os.path.join(ROOT, "web", "vendor")   # 本地开源前端库（如 Tabulator），不引 CDN；统一放根目录 web/
WEB_DIR = os.path.join(ROOT, "web")              # 工作台前端文件集中目录（index 在根，其余在 web/）
# 公共模块已归集到 common/，模块加载时即把 common/ 加入 sys.path，
# 保证 server 内任何位置 import find_group / ding_common 等都能解析。
_COMMON = os.path.join(ROOT, "common")
if _COMMON not in sys.path:
    sys.path.insert(0, _COMMON)
REGISTRY = os.path.join(HERE, "tasks.json")
INDEX_HTML = os.path.join(ROOT, "index.html")
TOKENS_CSS = os.path.join(ROOT, "web", "tokens.css")   # 设计令牌（index.html 通过 <link> 引入，路径 /web/tokens.css）
DIST_DIR = os.path.join(ROOT, "web", "dist")             # Vite 构建产物目录
DIST_INDEX = os.path.join(DIST_DIR, "index.html")        # 构建后的入口（server 托管此文件，保持 token 替换）
RUNS_DIR = os.path.join(HERE, "runs")
HISTORY_FILE = os.path.join(RUNS_DIR, "history.json")
MAX_HISTORY = 60

os.makedirs(RUNS_DIR, exist_ok=True)

# H2: 接口访问令牌（持久化到 .api_token，重启不变），前端由本服务注入。
# 同源 localhost 浏览器请求由 index.html 注入；无法带自定义请求头的场景
# （<img>/<iframe> src、window.location 下载、EventSource）改用 ?token= 查询参数携带。
# 持久化目的：工作台重启后，已打开的浏览器标签页仍沿用旧 token，不会因 token 轮换
# 而全部 403（否则表现为「点了运行没反应」等静默失效）。文件权限收紧到 0o600。
_API_TOKEN_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".api_token")
def _load_or_create_token():
    """读取已持久化的 token；文件缺失则生成新 token 并落盘（权限 600）。"""
    try:
        with open(_API_TOKEN_PATH, "r", encoding="utf-8") as _f:
            _t = _f.read().strip()
        if _t:
            return _t
    except FileNotFoundError:
        pass
    _t = secrets.token_hex(16)
    try:
        with open(_API_TOKEN_PATH, "w", encoding="utf-8") as _f:
            _f.write(_t)
        try:
            os.chmod(_API_TOKEN_PATH, 0o600)
        except OSError:
            pass
    except OSError:
        pass
    return _t
API_TOKEN = _load_or_create_token()
# H2: 允许访问接口的 Origin 白名单（仅本机环回），由 main() 按实际端口填充。
SRV_ORIGINS = set()


# —— 标准达成「查询（实时刷新）」频控（2026-09-09）——
# 目的：实时拉取直连风神接口，间隔太近会触发上游「请求太频繁」。
# 维度：用户/会话（token 指纹 + 客户端地址）× 端点；以**服务端时间**为准，
#       不读任何前端传来的时间戳（前端那层只是体验优化，可被绕过）。
# 说明：仅内存态，重启自动清空；拒绝时不刷新计时（冷却到期时间不变）。
RATE_LIMIT_SEC = 60                    # 标准达成 / 骑手 / 成就 / 全量刷新 通用窗口
ATTEND_PERIOD_RATE_LIMIT_SEC = 5       # 时段出勤「时段有效 / 骑手明细」实时查询窗口（2026-09-12 用户要求改为 5s）
_RATE_STATE = {}                 # key -> 上次放行的服务端时间戳（秒）
_RATE_LOCK = threading.Lock()
# 用户/会话指纹：不落盘明文 token，只取 sha256 前 12 位
_USER_FP = hashlib.sha256(API_TOKEN.encode("utf-8")).hexdigest()[:12]


def _rate_check(handler, endpoint, window=RATE_LIMIT_SEC):
    """服务端频控：返回 (allowed, retry_after_sec)。

    allowed=True   已登记本次时间戳，调用方继续执行查询；
    allowed=False  retry_after 为还需等待秒数，调用方直接回 429、不执行查询。
    """
    try:
        ip = (handler.client_address or ("",))[0] or ""
    except Exception:
        ip = ""
    key = "%s|%s|%s" % (_USER_FP, ip, endpoint)
    now = time.time()
    with _RATE_LOCK:
        last = _RATE_STATE.get(key)
        if last is not None and (now - last) < window:
            return False, int(window - (now - last)) + 1
        _RATE_STATE[key] = now
        return True, 0


def _rate_limited_json(handler, endpoint, retry_after, window=RATE_LIMIT_SEC):
    """统一的 429 响应体（带明确错误码，供前端校正按钮倒计时）。"""
    handler._json({
        "ok": False,
        "code": "RATE_LIMITED",
        "error": ("查询太频繁，请 %d 秒后再试（实时查询每 %d 秒限一次）"
                  % (retry_after, window)),
        "retry_after": retry_after,
        "endpoint": endpoint,
    }, 429)



# ---------------------------------------------------------------- 基础工具
def now_str():
    return datetime.now().strftime("%H:%M:%S")


def resolve_python():
    """优先项目 .venv，其次当前解释器。"""
    cand = os.path.join(ROOT, ".venv", "Scripts", "python.exe")
    if os.path.isfile(cand):
        return cand
    cand = os.path.join(ROOT, ".venv", "bin", "python")
    if os.path.isfile(cand):
        return cand
    return sys.executable


PYTHON = resolve_python()


def load_registry():
    with open(REGISTRY, "r", encoding="utf-8") as f:
        return json.load(f)


def missing_prereqs(task):
    """检查任务声明的 needs（前置产物）是否齐备，返回缺失项列表。

    needs 里的取值相对项目根目录：
      · 以 / 结尾按目录算 —— 必须存在且非空
      · 其余按文件算     —— 必须存在

    只在展示与执行前提示用，不阻断执行（产物也可能由别的途径生成）。
    """
    missing = []
    for need in (task.get("needs") or []):
        rel = str(need).replace("\\", "/").lstrip("/")
        if not rel:
            continue
        path = os.path.join(ROOT, rel)
        try:
            if rel.endswith("/"):
                ok = os.path.isdir(path) and bool(os.listdir(path))
            else:
                ok = os.path.isfile(path)
        except OSError:
            ok = False
        if not ok:
            missing.append(rel)
    return missing


def load_history():
    if not os.path.isfile(HISTORY_FILE):
        return []
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


# ---------------------------------------------------------------- Cookie 状态探针
# 「实时在线播报」多选站点选择器的内存缓存。键：「data」= 最新响应体；「ts」= 拉取时刻。
# 5 分钟 TTL：弹窗反复开关不重打风神；TTL 到了再走一次 xtop 接口。
_TEAMS_CACHE = {"data": None, "ts": 0}
_TEAMS_CACHE_TTL = 300
def _teams_with_names():
    """全部站点 [(team_id, name)]：优先 /api/teams 的 5 分钟内存缓存，否则兜底三站。

    仅供「系统设置 → 参与站点」与「全部站点」合并取数使用；不主动打接口
    （缓存没有就返回兜底清单，等 /api/teams 被前端触发过自然就有全量了）。
    """
    cached = _TEAMS_CACHE.get("data") or {}
    items = cached.get("teams") or cached.get("fallback") or []
    out = []
    for t in items or []:
        tid = str((t or {}).get("id") or "").strip()
        if tid:
            out.append((tid, (t or {}).get("name") or tid))
    if out:
        return out
    from dashboard.standard import teams_config as TCFG
    return [(tid, name) for tid, name in TCFG.TEAM_NAMES.items()]


def _configured_teams():
    """「参与站点」配置 ∩ 已知站点名 → [(team_id, name)]，顺序同配置。"""
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    from dashboard.standard import teams_config as TCFG
    names = dict(_teams_with_names())
    ids = TCFG.get_teams()
    return [(str(t), names.get(str(t), str(t))) for t in ids]


def _fetch_all_teams():
    """全部站点 [{id, name}]：风神 xtop 官方封装拉取，5 分钟内存缓存复用。

    供 /api/teams（实时在线播报选择器）与 /api/attend-period/teams（时段出勤·站点管理）
    共用，单一事实来源；登录态失效 / 网络异常时降级到写死的三站兜底清单，绝不让选择器空白。
    """
    now = time.time()
    cached = _TEAMS_CACHE.get("data")
    ts = _TEAMS_CACHE.get("ts", 0)
    if cached and (now - ts) < _TEAMS_CACHE_TTL:
        return cached
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    out = {"ok": True, "teams": [], "source": "xtop", "stale": False,
           "fetched_at": now}
    err = None
    try:
        from aeolus_sdk import login as L
        cookie, _ = L.ensure_cookies()
        # 复用官方封装（与考勤出数同源），不再自实现 xtop 调用；
        # 失败由下方 except 捕获 → 走兜底清单。
        from get_data.teams import fetch_teams
        for tid, name in fetch_teams(cookie):
            out["teams"].append({"id": str(tid), "name": name})
    except Exception as e:
        err = "%s: %s" % (type(e).__name__, e)
    if err or not out["teams"]:
        out["ok"] = False
        out["source"] = "fallback"
        out["error"] = err or "风神接口未返回任何站点"
        # 兜底清单：与 attendance.FALLBACK_TEAMS 一致；写死三站，
        # 网络/登录异常时保底，绝不让选择器空白。
        from dashboard.standard import teams_config as TCFG
        out["fallback"] = [{"id": tid, "name": name}
                           for tid, name in TCFG.TEAM_NAMES.items()]
    _TEAMS_CACHE["data"] = out
    _TEAMS_CACHE["ts"] = now
    return out


def check_cookie_status():
    """只读探测 aeolus_sdk/cookie.txt（风神会话）与 quark_da_cache.json（Quark DA cookie）是否有效。
    绝不写文件、不触发重登。该接口单次 < 300ms、60s 才轮一次，与"顶部胶囊只读"语义一致。
    返回：aeolus 三态（status / checked_at / reason）+ quark 子状态（res["quark"]）。

    任何探针异常都被结构化捕获，绝不让异常冒泡成 500（否则前端 r.json() 失败、把真实错误
    吞成「状态未知」）。真实原因写入 reason，前端会如实展示、不隐藏。
    """
    checked_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        res = _check_aeolus_cookie()
    except Exception as e:
        res = {"ok": True, "status": "unknown",
               "reason": "aeolus 探针异常: %s" % str(e)[:120],
               "checked_at": checked_at}
        log.error("[cookies/status] aeolus 探针异常: %s" % e)
    try:
        res["quark"] = _check_quark_cookie()
    except Exception as e:
        res["quark"] = {"ok": True, "status": "unknown",
                        "reason": "quark 探针异常: %s" % str(e)[:120],
                        "checked_at": checked_at, "age_hours": None}
        log.error("[cookies/status] quark 探针异常: %s" % e)
    return res


def _check_aeolus_cookie():
    """风神 aeolus_sdk/cookie.txt 有效性（validToken 探针）。三态：valid / invalid / unknown。"""
    cookie_path = os.path.join(ROOT, "aeolus_sdk", "cookie.txt")
    checked_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if not os.path.isfile(cookie_path):
        return {"ok": True, "status": "unknown", "reason": "aeolus_sdk/cookie.txt 不存在",
                "checked_at": checked_at}
    try:
        with open(cookie_path, "r", encoding="utf-8") as f:
            cookie = f.read().strip()
    except OSError as e:
        return {"ok": True, "status": "unknown", "reason": "读取 aeolus_sdk/cookie.txt 失败: %s" % e,
                "checked_at": checked_at}
    if not cookie:
        return {"ok": True, "status": "unknown", "reason": "aeolus_sdk/cookie.txt 为空",
                "checked_at": checked_at}
    req = urllib.request.Request(
        "https://httpizza.ele.me/lpd.meepo.session/aeolus/validToken",
        headers={"Cookie": cookie, "User-Agent": "workbench/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read(64)
            return {"ok": True, "status": "valid", "checked_at": checked_at}
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return {"ok": True, "status": "invalid", "checked_at": checked_at}
        return {"ok": True, "status": "unknown", "reason": "HTTP %d" % e.code,
                "checked_at": checked_at}
    except Exception as e:
        return {"ok": True, "status": "unknown", "reason": str(e)[:80],
                "checked_at": checked_at}


def _check_quark_cookie():
    """Quark DA cookie 缓存有效性（FbiSiteAction 探针）。四态 + 元数据。

    状态：
      valid    —— 缓存存在且探针放行（返回 JSON 而非 HTML 登录页）
      invalid  —— 缓存存在但探针被踢回 HTML 登录页（DA cookie 已废，需重兑）
      nocache  —— quark_da_cache.json 不存在（尚未跑过需 Quark 的任务，没兑换过）
      unknown  —— 探针异常 / 导入 quark_sdk.creds 失败（网络超时等）

    字段：
      checked_at  本次校验时间
      reason      人类可读说明
      age_hours   缓存距现在的小时数（无缓存时为 None）

    实现：复用 quark_sdk.creds 的 load_da_cache（只读）与 probe_da_health（FbiSiteAction
    端点，看是否返回 HTML 登录页判断 DA 网关是否放行）。只读、绝不写盘、不触发重登。
    """
    checked_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        if ROOT not in sys.path:
            sys.path.insert(0, ROOT)
        import quark_sdk.creds as qk
    except Exception as e:
        return {"ok": True, "status": "unknown",
                "reason": "导入 quark_sdk.creds 失败: %s" % str(e)[:80],
                "checked_at": checked_at, "age_hours": None}
    c = qk.load_da_cache(ROOT)
    if not c:
        return {"ok": True, "status": "nocache",
                "reason": "quark_da_cache.json 不存在（尚未兑换 Quark DA cookie）",
                "checked_at": checked_at, "age_hours": None}
    age = (c["age_sec"] / 3600.0) if c.get("age_sec") is not None else None
    cookie = c.get("cookie")
    if not cookie:
        # 缓存存在但缺 cookie 字段 = 缓存格式损坏（如半写/旧版结构），照实报，不假装失效。
        return {"ok": True, "status": "unknown",
                "reason": "quark_da_cache.json 缺少 cookie 字段（缓存格式损坏，建议删除后重跑 Quark 任务）",
                "checked_at": checked_at, "age_hours": age}
    try:
        alive = qk.probe_da_health(cookie, verbose=False)
    except Exception as e:
        return {"ok": True, "status": "unknown", "reason": "探针异常: %s" % str(e)[:80],
                "checked_at": checked_at, "age_hours": age}
    return {"ok": True,
            "status": "valid" if alive else "invalid",
            "reason": ("探针放行（返回 JSON）" if alive else "探针被踢回 HTML 登录页（DA cookie 已废）"),
            "checked_at": checked_at, "age_hours": age}


def save_history(items):
    items = items[:MAX_HISTORY]
    tmp = HISTORY_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    os.replace(tmp, HISTORY_FILE)


# ---------------------------------------------------------------- 错误诊断
DIAG_RULES = [
    (re.compile(r"(401|validToken|顶号|result is null|result.*None)", re.I),
     "登录态失效", "风神是单点登录，浏览器活跃会把脚本会话顶掉。建议关闭/闲置浏览器后重试，或先跑「登录诊断」任务。"),
    (re.compile(r"cookie\.txt.*(Permission denied|Errno 13)|Errno 13.*cookie", re.I),
     "aeolus_sdk/cookie.txt 并发争抢", "多个脚本同时写 aeolus_sdk/cookie.txt 触发 Windows 文件占用。工作台已串行执行任务，直接重试一次通常即可。"),
    (re.compile(r"(Can't connect to MySQL|pymysql|OperationalError|2003|Access denied for user)", re.I),
     "MySQL 不可用", "MySQL 容器已于 2026-08-31 删除。需先重建容器并导入 business_data 备份，运单入库类任务才能跑通。"),
    (re.compile(r"(ModuleNotFoundError|ImportError)", re.I),
     "依赖缺失", "缺少 Python 包。用项目虚拟环境安装：.venv/Scripts/python.exe -m pip install <包名>"),
    (re.compile(r"(the following arguments are required|unrecognized arguments|invalid \w+ value|expected one argument|usage:\s*\S+\.py)", re.I),
     "参数缺失或错误", "命令行参数不对。检查必填项是否已填写、取值是否在允许范围内；也可点击卡片上的「产物」按钮确认任务用法。"),
    (re.compile(r"(SSLEOFError|SSL: |handshake|ConnectionReset|RemoteDisconnected|timed out|Timeout)", re.I),
     "网络抖动", "瞬时网络/SSL 握手问题，非代码错误。直接重跑一次即可。"),
    (re.compile(r"(FileNotFoundError|WinError 2).*(node|NODE)", re.I),
     "Node 路径失效", "ding_common 依赖的 node.exe 路径不存在（托管 node 升级后常见）。已内置自动探测，若仍失败检查本机 Node 安装。"),
    (re.compile(r"(找不到图片|找不到汇总|请先运行)", re.I),
     "前置产物缺失", "依赖的上游任务还没跑。先执行对应的「拉取」任务再执行本任务。"),
    (re.compile(r"(PAGE_SIZE_OVER_RANGE|PAGE_INDEX_OVER_RANGE)", re.I),
     "接口分页超限", "aeolus 运单接口 pageSize≤50 且 current*pageSize<10000。缩小日期范围或增大时段切片。"),
    (re.compile(r"(REQUEST_TOO_FREQUENT|请求太频繁)", re.I),
     "接口限流", "请求过于频繁被限流。脚本内置退避重试，若持续失败请稍后再跑。"),
    (re.compile(r"(DA_TOKEN|quark|403 Forbidden)", re.I),
     "Quark 鉴权失败", "Quark 报表网关拒绝了请求（urllib TLS 指纹会被拦）。确认本机 curl 可用，脚本会自动重登重试 3 次。"),
    (re.compile(r"(请一次性查询不要超过7天)", re.I),
     "查询跨度超限", "单次查询跨度不能超过 7 天，请缩短日期区间。"),
    (re.compile(r"(超过60天|不能早于|时间范围)", re.I),
     "超出接口窗口", "运单接口只保留最近 60 天数据，过期不可回溯。"),
]


def diagnose(log_text, exit_code):
    """返回 (错误类型, 可读建议)；无法识别时给通用建议。"""
    if exit_code == 0:
        return None, None
    tail = log_text[-4000:]
    for pat, kind, advice in DIAG_RULES:
        if pat.search(tail):
            return kind, advice
    if exit_code == -9:
        return "已手动终止", "任务被用户或超时机制终止。"
    return "脚本非零退出", "退出码 %s。请查看日志末尾的 Traceback 定位具体报错行。" % exit_code


# ---------------------------------------------------------------- 运行管理
QUEUE_PUSH_MIN_S = 0.25   # queue 事件的最小推送间隔：窗口内的多次变化合并成一次（尾部补发）


class RunManager:
    def __init__(self):
        self.lock = threading.Lock()
        self.registry = load_registry()
        self._apply_hidden_filter()
        self._registry_sig = self._stat_registry()   # 自动重载用的磁盘指纹
        self.queue = []                 # 待执行 [ {run_id, task_id, args, label} ]
        self.current = None             # 当前 run dict
        self.runs = {}                  # run_id -> run dict（含 lines）
        self.history = load_history()
        self.subscribers = []
        # queue 事件合并推送状态。单独用一把锁：self.lock 是普通 Lock（不可重入），
        # 而合并逻辑里要先算 queue_state()（它自己会取 self.lock）再 emit（也会取）。
        self._q_lock = threading.Lock()
        self._q_timer = None            # 待发的合并窗口定时器
        self._q_pushed_at = 0.0         # 上次真正推送的时刻（time.monotonic）
        self._q_last_sig = None         # 上次推送的快照签名（内容去重用）
        self.proc = None
        self.stop_flag = False
        self.killed_pids = set()
        threading.Thread(target=self._worker, daemon=True).start()

    def _apply_hidden_filter(self):
        """过滤掉注册表中标记了 hidden:true 的任务。

        隐藏的目的有两种：
          · 工具/探针类脚本已转为顶部胶囊自动检测，不再需要用户手动入口；
          · 留作内部预留，暂时不希望出现在任务列表里。

        （登录诊断原先是这类 hidden 任务，2026-09-02 已移除出注册表 ——
          它本质是 SDK 自带的诊断入口，跑 `python -m aeolus_sdk.login` 即可，
          不该占一个任务条目，也不需要节点化。）

        过滤后 /api/state / api/reload /api/run 三处都自然拿不到 hidden 任务：
        · state 用 registry_view()，它读 self.registry["tasks"]；
        · run 端点用 self.task_map 做合法性检查。
        """
        before = len(self.registry.get("tasks", []))
        self.registry["tasks"] = [t for t in self.registry.get("tasks", []) if not t.get("hidden")]
        self.task_map = {t["id"]: t for t in self.registry["tasks"]}
        # 控制台起手时打印一次，方便排错「为啥我加的任务不见了」
        if before != len(self.registry["tasks"]):
            log.info("[server] 隐藏任务过滤：%d -> %d 个（hidden=true 的任务不暴露给前端）"
                  % (before, len(self.registry["tasks"])))

    # ---- SSE ----
    def subscribe(self):
        q = queue.Queue(maxsize=2000)
        with self.lock:
            self.subscribers.append(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            if q in self.subscribers:
                self.subscribers.remove(q)

    def emit(self, evt):
        with self.lock:
            subs = list(self.subscribers)
        for q in subs:
            try:
                q.put_nowait(evt)
            except queue.Full:
                pass

    def emit_queue(self):
        """合并推送 queue 快照（内容去重 + 250ms 去抖 + 尾部补发）。

        队列的入队 / 出队 / 取消都会改它，每次变化都广播给所有客户端，前端就得跟着重建界面。
        这里两层收敛：
          · 内容去重：与上次推送的快照一致就不发 —— _worker 跑完那次推送（队列其实没变）
            原本是纯重复，每个任务白多发一条；批量 N 个任务就是 N 条无用广播。
          · 时间合并：窗口内的多次变化合并成一次，且推的永远是「当下最新」快照（flush 时重新取），
            末尾必补发一次 —— 既降频又不丢最终状态。
        """
        snap = self.queue_state()
        sig = tuple(r["run_id"] for r in snap)
        with self._q_lock:
            if sig == self._q_last_sig:
                return                       # 内容没变 → 一条都不用发
            self._q_last_sig = sig
            now = time.monotonic()
            wait = QUEUE_PUSH_MIN_S - (now - self._q_pushed_at)
            if wait <= 0:
                self._q_pushed_at = now
                due_now = True
            else:
                if self._q_timer is None:
                    self._q_timer = threading.Timer(wait, self._q_flush)
                    self._q_timer.daemon = True
                    self._q_timer.start()
                due_now = False
        if due_now:
            self.emit({"type": "queue", "queue": snap})

    def _q_flush(self):
        """合并窗口到期：重新取「当下最新」快照推送（而非窗口开始时的旧数据）。"""
        with self._q_lock:
            self._q_timer = None
            self._q_pushed_at = time.monotonic()
        snap = self.queue_state()
        with self._q_lock:
            self._q_last_sig = tuple(r["run_id"] for r in snap)
        self.emit({"type": "queue", "queue": snap})

    # ---- 构建命令 ----
    def build_cmd(self, task_id, args):
        task = self.task_map[task_id]
        cmd = [PYTHON if p == "{py}" else p for p in task["cmd"]]
        for p in task.get("params", []):
            val = args.get(p["flag"], p.get("default", ""))
            flag = p["flag"]
            if p.get("raw"):                       # 值本身就是一个完整开关
                if val:
                    cmd.append(val)
                continue
            if p["type"] == "switch":
                if val in (True, "true", "True", "1", 1):
                    cmd.append(flag)
            elif p["type"] == "group":
                # 「目标群」选择器：从下拉「选中」时隐藏域已是 cid；但用户也可能手打群名后
                # 直接点运行（未真正选中）。attendance / appeal_reminder / task_board 的
                # --group 只认 cid，收到群名会被 dws 判 OPEN_CID_INVALID。这里统一把群名
                # 解析成 cid 再下发；task_equipment 的 --group 两种写法都认，无副作用。
                # 已是 cid（cid 开头）直接透传；解析失败则保留原值（让脚本侧报更清晰的错，
                # 而非在此吞掉）。
                gval = val
                if val not in (None, "", False) and not str(val).startswith("cid"):
                    try:
                        import group_picker
                        gval = group_picker.resolve(str(val))["id"]
                    except BaseException:
                        gval = val
                if gval not in (None, "", False):
                    if flag.startswith("--") and "=" not in flag:
                        cmd.append("%s=%s" % (flag, gval))
                    else:
                        cmd += [flag, str(gval)]
            else:
                if val not in (None, "", False):
                    if flag.startswith("--") and "=" not in flag:
                        cmd.append("%s=%s" % (flag, val))
                    else:
                        cmd += [flag, str(val)]
        return cmd

    def _note_group_used(self, args):
        """任务入队时把 --group 登记进「最近使用的群」。

        值为 cid 直接记；值是群名则尝试解析成 cid（解析不动就不记，避免脏数据）。
        补群名只用内存缓存（peek_groups），绝不为了一个名字去打 dws
        —— 运行按钮不能因为登记最近使用而卡住。
        缓存冷、拿不到群名时**不写群号**：交给 recent() 事后用全量缓存回填真名。
        """
        val = str((args or {}).get("--group") or "").strip()
        if not val:
            return
        try:
            import group_picker
            gid = val
            if not gid.startswith("cid"):
                try:
                    gid = group_picker.resolve(gid)["id"]
                except Exception:
                    return
            title = ""
            for g in group_picker.peek_groups():
                if g["id"] == gid:
                    title = g["title"]
                    break
            group_picker.note_used(gid, title)
        except Exception:
            pass

    # ---- 入队 ----
    def enqueue(self, items):
        """items: [ {task_id, args} ] → 返回 run_id 列表"""
        run_ids = []
        for it in items:
            tid = it.get("task_id")
            if tid not in self.task_map:
                continue
            run_id = "r%d" % int(time.time() * 1000) + str(len(self.runs))
            run = {
                "run_id": run_id,
                "task_id": tid,
                "name": self.task_map[tid]["name"],
                "group": self.task_map[tid].get("group", ""),
                "args": it.get("args", {}),
                "status": "queued",
                "start": None,
                "end": None,
                "exit_code": None,
                "lines": [],
                "error_kind": None,
                "error_advice": None,
            }
            self._note_group_used(it.get("args", {}))
            with self.lock:
                self.runs[run_id] = run
                self.queue.append(run)
            run_ids.append(run_id)
        self.emit_queue()
        return run_ids

    def queue_state(self):
        with self.lock:
            return [
                {"run_id": r["run_id"], "task_id": r["task_id"], "name": r["name"]}
                for r in self.queue
            ]

    def cancel_queued(self, run_id):
        with self.lock:
            before = len(self.queue)
            self.queue = [r for r in self.queue if r["run_id"] != run_id]
            removed = len(self.queue) < before
        if removed:
            self.emit_queue()
        return removed

    def stop_current(self):
        """终止当前进程，并取消队列中尚未开始的任务。

        旧行为只 kill 当前进程，队列里的任务会照跑——批量执行时点「终止」
        仍会继续发出后续的真实钉钉消息，属于外部副作用失控。这里一并清空。
        """
        with self.lock:
            run = self.current
            proc = self.proc
            self.stop_flag = True
            dropped = list(self.queue)
            self.queue = []
        if run:
            self._append(run, "[系统] 收到终止指令，正在结束进程…")
            if dropped:
                self._append(run, "[系统] 同时取消了队列中尚未开始的 %d 个任务：%s"
                             % (len(dropped), "、".join(r["name"] for r in dropped)))
        if proc and proc.poll() is None:
            self._kill_tree(proc.pid)
        # 队列已变化，立即广播，否则前端还显示着已被取消的排队项
        self.emit_queue()
        return True if run else False

    def _kill_tree(self, pid):
        if os.name == "nt":
            try:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
                return
            except Exception:
                pass
        try:
            import signal
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass

    def _append(self, run, line):
        run["lines"].append(line)
        if len(run["lines"]) > 20000:
            run["lines"] = run["lines"][-10000:]
        self.emit({"type": "log", "run_id": run["run_id"], "line": line,
                   "ts": now_str()})

    # ---- 工作线程 ----
    def _worker(self):
        while True:
            with self.lock:
                if not self.queue:
                    run = None
                else:
                    run = self.queue.pop(0)
                    self.current = run
                    self.stop_flag = False
            if run is None:
                time.sleep(0.25)
                continue
            self.emit_queue()
            self._execute(run)
            with self.lock:
                self.current = None
                self.proc = None
            self.emit_queue()
            self.emit({"type": "run_end", "run": self.public_run(run)})
            time.sleep(0.2)

    def _execute(self, run):
        task = self.task_map[run["task_id"]]
        try:
            cmd = self.build_cmd(run["task_id"], run["args"])
        except Exception as e:
            run["status"] = "failed"
            run["exit_code"] = -1
            run["error_kind"] = "参数错误"
            run["error_advice"] = str(e)
            self._append(run, "[错误] 构建命令失败：%s" % e)
            return

        run["status"] = "running"
        run["start"] = time.time()
        run["cmd"] = " ".join(cmd)
        # 必须先广播 run_start，否则前几行日志会先于 run_start 到达前端而被丢弃
        self.emit({"type": "run_start", "run": self.public_run(run)})
        self._append(run, "$ %s" % " ".join(cmd))
        self._append(run, "[开始] %s  （工作目录：%s）" % (task["name"], ROOT))

        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONUTF8"] = "1"

        timeout = int(task.get("timeout", 600))
        try:
            proc = subprocess.Popen(
                cmd, cwd=ROOT, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
            )
        except Exception as e:
            run["status"] = "failed"
            run["exit_code"] = -1
            run["error_kind"] = "启动失败"
            run["error_advice"] = str(e)
            self._append(run, "[错误] 无法启动进程：%s" % e)
            return

        with self.lock:
            self.proc = proc

        # 读取输出（阻塞读，超时由外层 wait 保证）
        reader = threading.Thread(target=self._reader, args=(run, proc), daemon=True)
        reader.start()

        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self._append(run, "[系统] 超过 %d 秒未完成，强制终止。" % timeout)
            self._kill_tree(proc.pid)
            try:
                proc.wait(timeout=20)
            except Exception:
                pass
            run["exit_code"] = -9
            run["timeout"] = True
        else:
            run["exit_code"] = proc.returncode

        reader.join(timeout=10)
        run["end"] = time.time()

        full = "\n".join(run["lines"])
        if run.get("stop_flag") or self.stop_flag:
            run["status"] = "stopped"
        elif run["exit_code"] == 0:
            run["status"] = "success"
        else:
            run["status"] = "failed"

        if run["status"] != "success":
            if run["status"] == "stopped":
                kind, advice = "已手动终止", "任务被用户终止，没有跑完。"
            elif run.get("timeout"):
                kind = "执行超时"
                advice = ("任务超过 %d 秒未完成，已被强制终止。先用更小的范围（单日/少量条数）"
                          "确认脚本能跑通，再放大日期区间或条数。" % timeout)
            else:
                kind, advice = diagnose(full, run["exit_code"] or -1)
            run["error_kind"] = kind
            run["error_advice"] = advice
            self._append(run, "")
            self._append(run, "✗ 失败（退出码 %s）｜诊断：%s" % (run["exit_code"], kind))
            self._append(run, "  建议：%s" % advice)
        else:
            self._append(run, "")
            self._append(run, "✓ 完成（退出码 0，耗时 %.1f 秒）" % (run["end"] - run["start"]))

        # 落盘完整日志
        try:
            with open(os.path.join(RUNS_DIR, run["run_id"] + ".log"), "w", encoding="utf-8") as f:
                f.write(full)
        except Exception:
            pass

        # 写入历史
        entry = {
            "run_id": run["run_id"], "task_id": run["task_id"], "name": run["name"],
            "group": run.get("group", ""), "status": run["status"],
            "exit_code": run["exit_code"],
            "start": datetime.fromtimestamp(run["start"]).strftime("%Y-%m-%d %H:%M:%S"),
            "duration": round((run["end"] or time.time()) - (run["start"] or time.time()), 1),
            "error_kind": run.get("error_kind"),
            "error_advice": run.get("error_advice"),
        }
        with self.lock:
            self.history.insert(0, entry)
            self.history = self.history[:MAX_HISTORY]
            save_history(self.history)
        self.emit({"type": "history", "history": self.history[:30]})

    def _reader(self, run, proc):
        try:
            for line in iter(proc.stdout.readline, ""):
                if line is None:
                    break
                self._append(run, line.rstrip("\r\n"))
        except Exception:
            pass
        finally:
            try:
                proc.stdout.close()
            except Exception:
                pass

    # ---- 对外视图 ----
    def public_run(self, run):
        return {
            "run_id": run["run_id"], "task_id": run["task_id"], "name": run["name"],
            "group": run.get("group", ""), "status": run["status"],
            "exit_code": run["exit_code"], "start": run["start"], "end": run["end"],
            "cmd": run.get("cmd", ""),
            "error_kind": run.get("error_kind"), "error_advice": run.get("error_advice"),
        }

    def run_status(self, run_id):
        """供工作内容调度器轮询用：{"status","exit_code"}，查不到返回 None。

        调度器不订阅 SSE —— SSE 的队列满了会丢事件，一丢执行记录就永远卡在
        running。拉模式虽然笨，但不会因为背压把状态弄丢。
        """
        with self.lock:
            r = self.runs.get(run_id)
        if not r:
            return None
        return {"status": r["status"], "exit_code": r["exit_code"]}

    def link_state(self, task_id):
        """工作内容关联的任务现在还能不能跑：ok / missing / disabled。

        tasks.json 是外部数据，任务随时可能被删掉或被标 hidden/disabled。
        这里只做判定、不做清理 —— 关联关系由用户自己决定怎么处置。
        """
        if not task_id:
            return "missing"
        self._sync_registry_if_changed()
        t = self.task_map.get(task_id)
        if not t:
            return "missing"
        if t.get("hidden") or t.get("disabled"):
            return "disabled"
        return "ok"

    def snapshot(self):
        with self.lock:
            cur = self.public_run(self.current) if self.current else None
            # 带上当前任务已有的日志，便于页面刷新 / 断线重连后把丢失的输出补回来
            cur_lines = list(self.current["lines"][-5000:]) if self.current else None
            states = {}
            for tid in self.task_map:
                last = next((h for h in self.history if h["task_id"] == tid), None)
                states[tid] = last
            queued = [r["task_id"] for r in self.queue]
        return {
            "current": cur,
            "current_lines": cur_lines,
            "queue": self.queue_state(),
            "queued_ids": queued,
            "last": states,
            "history": self.history[:30],
        }

    def _stat_registry(self):
        """tasks.json 的磁盘指纹（mtime 纳秒 + 体积），拿不到就返回 None。"""
        try:
            st = os.stat(REGISTRY)
            return (st.st_mtime_ns, st.st_size)
        except OSError:
            return None

    def _sync_registry_if_changed(self):
        """tasks.json 在磁盘上被改过就自动重载。

        背景：registry 只在服务启动时加载一次，之后手工改 tasks.json
        （合并任务、加任务、改节点链）页面完全不会感知，只能手动 POST
        /api/reload 或重启服务 —— 这坑踩过一次（合并 task_board 后页面
        仍显示旧的两条任务）。

        这里用 mtime+size 做廉价探测，没变就直接返回，避免每次请求都
        parse 一遍 JSON；解析失败时保留旧表，不让工作台开天窗。
        """
        sig = self._stat_registry()
        if sig is None or sig == self._registry_sig:
            return
        try:
            self.registry = load_registry()
            self._apply_hidden_filter()
            self._registry_sig = sig
            log.info("[server] 检测到 tasks.json 变更，已自动重载：%d 个任务"
                  % len(self.registry.get("tasks", [])))
        except Exception as e:
            log.error("[server] tasks.json 自动重载失败，保留旧表：%s" % e)

    def registry_view(self):
        """registry 的只读视图，按当前磁盘状态给每个任务补上 missing（缺失的前置产物）。

        每次请求现算，不用缓存 —— 前置产物会随任务执行而出现或消失。
        取视图前先做一次磁盘变更探测，保证改完 tasks.json 刷新页面即可生效。
        """
        self._sync_registry_if_changed()
        reg = self.registry
        view = dict(reg)
        view["tasks"] = []
        for t in reg.get("tasks", []):
            t2 = dict(t)
            t2["missing"] = missing_prereqs(t)
            view["tasks"].append(t2)
        return view

    def run_log(self, run_id):
        with self.lock:
            run = self.runs.get(run_id)
            if run:
                return list(run["lines"])
        path = os.path.join(RUNS_DIR, run_id + ".log")
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                return f.read().splitlines()
        return None


# ---------------------------------------------------------------- 产物（artifacts）
# 任务在 tasks.json 的 outputs 里声明会产出的文件（相对 ROOT）。
# 这里把它展开成「实际已生成」的文件清单，供前端直接在工作台内预览。
def _artifact_info(fp):
    rel = os.path.relpath(fp, ROOT).replace("\\", "/")
    ext = os.path.splitext(fp)[1].lower()
    if ext in (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"):
        t = "image"
    elif ext in (".html", ".htm"):
        t = "html"
    elif ext in (".csv", ".tsv", ".json", ".jsonl", ".txt", ".md", ".log"):
        t = "text"
    elif ext in (".xlsx", ".xls"):
        t = "sheet"
    else:
        t = "other"
    st = os.stat(fp)
    return {"name": os.path.basename(fp), "rel": rel, "size": st.st_size,
            "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
            "type": t}


def _last_run_args(task_id):
    """取该任务最近一次运行的参数，用于替换 outputs 里的 <id> 类占位符。

    runs 里每条都存了 enqueue 时的 args（见 RunManager.enqueue）。
    按 start 时间戳取最大的一条；从没跑过则返回 {}。
    """
    best = None
    with MGR.lock:
        for r in MGR.runs.values():
            if r.get("task_id") != task_id:
                continue
            if best is None or (r.get("start") or 0) > (best.get("start") or 0):
                best = r
    return (best or {}).get("args") or {}


def _expand_placeholders(pattern, task, args):
    """把 outputs 里的 <name> 占位符替换成最近一次运行的实际参数值。

    tasks.json 用 `output_vars` 声明占位符 → 参数 flag 的映射，例如
        "outputs": ["rule_doc_<id>.html"], "output_vars": {"id": "--rule"}
    跑过 `--rule 6923` 之后就精确展开成 rule_doc_6923.html。

    glob 不认识 <...>，所以不做这层替换的话这类条目永远匹配不到文件
    （产物面板会显示"没有产物"）。取不到值（没跑过 / 参数为空 / 未声明映射）
    时退化成 `*`，保证至少能看到文件；此时按 mtime 倒序，最近产物排最前。
    """
    vars_ = task.get("output_vars") or {}

    def _sub(m):
        flag = vars_.get(m.group(1))
        v = args.get(flag) if flag else None
        if v is None or str(v).strip() == "":
            return "*"
        return str(v).strip()

    return re.sub(r"<([A-Za-z_][A-Za-z0-9_]*)>", _sub, pattern)


def list_artifacts(task_id):
    """按任务声明的 outputs 展开出实际已生成的产物文件清单。

    outputs 支持四种写法：
      · 普通相对路径（如 attendance_absent.png）
      · 含通配符（如 aeolus_delivery_*.csv → 用 glob 展开）
      · 含占位符（如 rule_doc_<id>.html → 按 output_vars 映射 + 最近一次
        运行参数展开，见 _expand_placeholders）
      · 目录（以 / 结尾，如 attendance_raw/ → 列出目录下文件）
    不存在的条目静默跳过；目录/通配无匹配也跳过。
    """
    task = MGR.task_map.get(task_id)
    if not task:
        return []
    args = _last_run_args(task_id)
    files = []
    seen = set()
    for o in (task.get("outputs") or []):
        o = str(o)
        if "<" in o:
            o = _expand_placeholders(o, task, args)
        if o.endswith("/"):
            d = os.path.join(ROOT, o.rstrip("/"))
            if not os.path.isdir(d):
                continue
            for fn in sorted(os.listdir(d)):
                fp = os.path.join(d, fn)
                if os.path.isfile(fp) and fp not in seen:
                    seen.add(fp)
                    files.append(_artifact_info(fp))
        else:
            for fp in sorted(glob.glob(os.path.join(ROOT, o))):
                if os.path.isfile(fp) and fp not in seen:
                    seen.add(fp)
                    files.append(_artifact_info(fp))
    files.sort(key=lambda x: x["mtime"], reverse=True)
    return files


CONTENT_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jsonl": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
}
INLINE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
               ".html", ".htm", ".csv", ".tsv", ".json", ".jsonl",
               ".txt", ".md", ".log"}


# H1: 敏感路径黑名单 —— /api/file、/api/sheet 一律拒绝落入这些区域的文件，
# 防止通过 path 参数读取 aeolus_sdk/cookie.txt、*.db、tasks.json、.venv 等凭证/运行数据。
_SENSITIVE_DIRS = frozenset({
    "aeolus_sdk", "quark_sdk", ".venv", "venv",
    "node_modules", ".git", "credentials", "secrets", "runs",
})
_SENSITIVE_FILES = frozenset({
    "tasks.json", "cookie.txt", "cookies_meituan.json",
    "db_config.json", "quark_da_cache.json",
})
_SENSITIVE_GLOBS = ("*.db", "*.sqlite", "*.sqlite3",
                    "*.key", "*.pem", "*.pfx", "*.p12",
                    "*.env", ".env")


def _is_sensitive_path(rel):
    """相对 ROOT 的路径是否命中敏感区域（凭证 / 运行数据 / 不应外发文件）。"""
    norm = os.path.normpath(rel).replace("\\", "/").strip("./")
    if not norm or norm == ".":
        return True  # 不允许直接读 ROOT 本身
    parts = norm.split("/")
    # workbench/data 等运行数据目录
    if len(parts) >= 2 and parts[0] == "workbench" and parts[1] == "data":
        return True
    for part in parts:
        low = part.lower()
        if part in _SENSITIVE_DIRS or part in _SENSITIVE_FILES:
            return True
        for g in _SENSITIVE_GLOBS:
            if fnmatch.fnmatch(low, g):
                return True
    return False


def _safe_resolve(rel):
    """防目录穿越 + 敏感路径黑名单：归一化到 ROOT 内，
    越界或命中敏感区域（凭证 / 运行数据）返回 None。"""
    if _is_sensitive_path(rel):
        return None
    target = os.path.normpath(os.path.join(ROOT, rel))
    if not (target == ROOT or target.startswith(ROOT + os.sep)):
        return None
    return target


def sheet_to_json(target, max_rows=5000):
    """把 xlsx/xls 解析成 {sheets:[{name, headers, rows}]}。

    rows 为二维数组；表头取第一行。超 max_rows 行截断并标记 truncated。
    单元格统一转字符串（None → 空串）。
    """
    ext = os.path.splitext(target)[1].lower()
    sheets = []
    truncated = False
    if ext == ".xlsx":
        if not openpyxl:
            return None, "未安装 openpyxl（pip install openpyxl）"
        wb = openpyxl.load_workbook(target, read_only=True, data_only=True)
        for ws in wb.worksheets:
            rows_iter = ws.iter_rows(values_only=True)
            grid = []
            for r in rows_iter:
                if len(grid) >= max_rows:
                    truncated = True
                    break
                grid.append(["" if c is None else str(c) for c in r])
            sheets.append(_grid_to_sheet(ws.title, grid))
        wb.close()
    elif ext == ".xls":
        if not xlrd:
            return None, "未安装 xlrd（pip install xlrd）"
        wb = xlrd.open_workbook(target)
        for ws in wb.sheets():
            grid = []
            for ri in range(ws.nrows):
                if len(grid) >= max_rows:
                    truncated = True
                    break
                grid.append(["" if c is None else str(c) for c in ws.row_values(ri)])
            sheets.append(_grid_to_sheet(ws.name, grid))
    else:
        return None, "不支持的表格类型：" + ext
    return {"sheets": sheets, "truncated": truncated}, None


def _smart_header(grid, lookahead=5):
    """从 grid 前 lookahead 行中挑出真正的表头行索引。

    真实业务报表常含：合并大标题行（仅首格有值，其余空）、空行、说明行。
    若直接拿第一行当表头，会导致列名大量为空 → 前端兜底成「列2/列3…」。
    表头行判定：非空单元格数 >= max(2, 列数//2)。
    返回 (header_index, data_start_index)。前 lookahead 行都找不到时退回 (0, 1) 保持原行为。
    """
    if not grid:
        return 0, 0
    ncols = max((len(r) for r in grid), default=0)
    if ncols == 0:
        return 0, 0
    threshold = max(2, ncols // 2)
    for i in range(min(len(grid), lookahead)):
        nonempty = sum(1 for c in grid[i] if str(c).strip() != "")
        if nonempty >= threshold:
            return i, i + 1
    return 0, 1


def _grid_to_sheet(name, grid):
    hi, di = _smart_header(grid)
    headers = grid[hi] if hi < len(grid) else []
    rows = grid[di:] if di < len(grid) else []
    return {"name": name, "headers": headers, "rows": rows,
            "ncols": len(headers), "nrows": len(rows)}


def serve_artifact(self, rel):
    """安全 serve 单个产物文件：

    · 防目录穿越 + 敏感路径黑名单：归一化后必须仍落在 ROOT 内且非受限文件，否则 403；
    · 按扩展名设正确 Content-Type（图片 / 文本 / HTML 都带 charset 防中文乱码）；
    · 图片与文本/HTML 用 inline 内联（浏览器直接预览），其余用 attachment 触发下载。
    """
    target = _safe_resolve(rel)
    if target is None:
        self._send(403, "非法路径或受限文件", "text/plain; charset=utf-8")
        return
    if not os.path.isfile(target):
        self._send(404, "文件不存在", "text/plain; charset=utf-8")
        return
    ext = os.path.splitext(target)[1].lower()
    ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
    disp = "inline" if ext in INLINE_EXTS else "attachment"
    try:
        with open(target, "rb") as f:
            data = f.read()
    except OSError as e:
        self._send(500, "读取失败: %s" % e, "text/plain; charset=utf-8")
        return
    self.send_response(200)
    self.send_header("Content-Type", ctype)
    self.send_header("Content-Length", str(len(data)))
    self.send_header("Content-Disposition",
                     '%s; filename="%s"' % (disp, os.path.basename(target)))
    self.send_header("Cache-Control", "no-store")
    self.end_headers()
    try:
        self.wfile.write(data)
    except Exception:
        pass


def serve_under(self, base, sub):
    """serve 某目录下的静态资源（如 vendor 库、web/ 下的 tokens.css），限定在 base 目录内，防目录穿越。"""
    target = os.path.normpath(os.path.join(base, sub))
    if not (target == base or target.startswith(base + os.sep)):
        self._send(403, "非法路径", "text/plain; charset=utf-8")
        return
    if not os.path.isfile(target):
        self._send(404, "文件不存在", "text/plain; charset=utf-8")
        return
    ext = os.path.splitext(target)[1].lower()
    ctype = {
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".map": "application/json; charset=utf-8",
        ".woff2": "font/woff2",
    }.get(ext, "application/octet-stream")
    try:
        with open(target, "rb") as f:
            data = f.read()
    except OSError as e:
        self._send(500, "读取失败: %s" % e, "text/plain; charset=utf-8")
        return
    self.send_response(200)
    self.send_header("Content-Type", ctype)
    self.send_header("Content-Length", str(len(data)))
    self.send_header("Cache-Control", "no-store")
    self.end_headers()
    try:
        self.wfile.write(data)
    except Exception:
        pass


MGR = RunManager()

# 工作内容（提醒事项）的 SQLite 库与定时调度器。
# sys.path 兜底是为了两种启动方式都能 import：python server.py（脚本）
# 和 from server import server（包）。
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import todo_sched                                     # noqa: E402
import todo_store                                     # noqa: E402

try:
    todo_store.init_db()
    SCHED = todo_sched.start(MGR)
except Exception as _e:                               # 调度器起不来不能拖垮工作台
    SCHED = None
    log.error("[server] 工作内容调度器启动失败：%s" % _e)


def _todo_broadcast():
    """工作内容有变动时广播，让其它已打开的标签页跟着刷新。"""
    try:
        MGR.emit({"type": "todo", "event": "changed"})
    except Exception:
        pass


def _todo_default_list():
    ls = todo_store.list_lists()
    return ls[0]["id"] if ls else todo_store.create_list("工作")["id"]


def _todo_item_out(row):
    """写操作的返回体一律走 api_item，和 GET /api/todo 保持同一形状。

    前端只认一种字段命名，别让「读回来是驼峰、写完返回是蛇形」这种事发生。
    """
    if not row:
        return None
    ls = MGR.link_state(row["task_id"]) if row["task_id"] else ""
    return todo_store.api_item(row, link_state=ls,
                               has_open_run=bool(todo_store.open_run_of(row["id"])))


def todo_payload():
    """列表 + 事项 + 调度器状态。

    link_state（关联任务还有效吗）在后端算好再下发：任务注册表是后端的东西，
    前端不该自己去比对任务 id 存不存在。
    """
    items = []
    for it in todo_store.list_items():
        items.append(todo_store.api_item(
            it,
            link_state=MGR.link_state(it["task_id"]) if it["task_id"] else "",
            has_open_run=bool(todo_store.open_run_of(it["id"]))))
    return {
        "lists": [todo_store.api_list(x) for x in todo_store.list_lists()],
        "items": items,
        "scheduler": {
            "running": bool(SCHED and SCHED.is_alive()),
            "catchup_grace_min": todo_store.CATCHUP_GRACE_SEC // 60,
            "max_attempts": todo_store.MAX_ATTEMPTS,
        },
    }


# ---------------------------------------------------------------- HTTP
def _is_loopback_origin(origin):
    """同源/本机回环来源放行；非回环来源仅作兜底——真正闸门是 token（见 _check_auth）。

    本服务默认仅绑本机回环（127.0.0.1），局域网其他设备不可直达；
    但无 token 的外站嵌入请求仍会被此处挡掉（拿不到数据）。
    解析失败（非法 Origin 字符串）一律按「非回环」处理，交给 token 这一道真闸门拦截。
    """
    if not origin:
        return False
    try:
        host = urlparse(origin).hostname or ""
    except Exception:
        return False
    return host in ("127.0.0.1", "localhost", "[::1]", "::1") or host.endswith(".localhost")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # 静默访问日志，避免刷屏

    def handle_one_request(self):
        """客户端（页面刷新 / 关闭标签 / SSE 断连）主动断开是常态，
        不把它当异常处理，否则每刷新一次页面控制台就刷一段 traceback。"""
        try:
            BaseHTTPRequestHandler.handle_one_request(self)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def _cors(self):
        # 预览面板以跨源 iframe 加载本工作台时，EventSource / fetch 需要 CORS 头
        # 才被浏览器接受。仅反射请求的 Origin（不盲目 *），且只在已携带有效 token
        # （_check_auth 通过后）才由调用方决定是否放行跨源 —— 这里只负责补头。
        origin = self.headers.get("Origin")
        if not origin:
            return
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "X-Token, Content-Type")

    def _check_auth(self, require_token=True):
        """H2 接口鉴权：

        · token 可由 X-Token 请求头或 ?token= 查询参数携带（img/src/navigation/
          EventSource 无法带自定义请求头，只能走查询参数）；
        · token 是真正的闸门：一旦携带有效 token，无论来自哪个 Origin 都放行
          （预览面板以跨源 iframe 加载、或 SSE 跨源连接都依赖这一点）。
        · 仅当「没有有效 token」时，才用 Origin 回环判定兜底，拦截外站把本服务
          当图片/iframe 嵌入的 CSRF 场景（无 token 的外站拿不到数据）。
        返回 True 表示放行。
        """
        token = self.headers.get("X-Token")
        if not token:
            q = parse_qs(urlparse(self.path).query)
            token = (q.get("token") or [None])[0]
        if require_token and token != API_TOKEN:
            return False
        # 有效 token 即已授权 —— 不再叠加 Origin 限制（token 是 bearer 闸门）
        if token == API_TOKEN:
            return True
        # 无有效 token：仅放行本机环回来源，挡掉外站嵌入型 CSRF
        origin = self.headers.get("Origin")
        if origin and not _is_loopback_origin(origin):
            return False
        return True

    def do_OPTIONS(self):
        # CORS 预检：不带鉴权，直接回 204 + CORS 头（fetch 带 X-Token 自定义头会触发）
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- RBAC 鉴权辅助 ----
    def _extract_token(self):
        """从 X-Token 头 / ?token= 查询参数 / wb_session Cookie 取出令牌。"""
        t = self.headers.get("X-Token")
        if not t:
            q = parse_qs(urlparse(self.path).query)
            t = (q.get("token") or [None])[0]
        if not t:
            ck = self.headers.get("Cookie") or ""
            m = re.search(r"(?:^|;\s*)wb_session=([^;]+)", ck)
            if m:
                t = m.group(1)
        return t

    def _auth_user(self):
        return auth.get_session(self._extract_token())

    # ---------------- 数据权限（行级隔离）闸门 ----------------
    # 当前系统报表以 team（站点）为隔离维度；本闸门把「请求了哪个 team」与
    # 「当前登录用户被允许看哪些 team」做比对，杜绝越权读取他人站点数据。
    def _enforce_team_scope(self, requested_team):
        """按当前会话对 team 维度做行级隔离。返回 (mode, val)：
          ("all",   None) -> 用户可看全部，原 '__all__' 分支按 universe 走
          ("scoped", ids) -> 受限用户看 '__all__'，ids 为被允许的 team id 集合
          ("one",   tid)  -> 单站请求且被允许（tid 即请求值，已通过校验）
          ("deny",  None) -> 已发送 403，调用方必须 return
        admin 角色永远全量；无规则用户默认全量（见 dataperm.DEFAULT_SCOPE）。
        """
        s = self.session
        role = (s or {}).get("role")
        if role == "admin":
            return ("all", None) if requested_team == "__all__" else ("one", requested_team)
        ids = dataperm.allowed_team_ids(s["user"], role)   # set 或 None
        if ids is None:
            return ("all", None) if requested_team == "__all__" else ("one", requested_team)
        if requested_team == "__all__":
            return ("scoped", ids)
        if str(requested_team) in ids:
            return ("one", requested_team)
        auth.audit("data:scope", False, s["user"], self.client_address[0],
                   s["role"], "GET", "team=%s" % requested_team)
        self._json({"ok": False, "error": "无权访问该站点数据",
                    "code": "DATA_SCOPE_DENIED"}, 403)
        return ("deny", None)

    def _scoped_universe(self, universe):
        """universe: [(id, name), ...]（某报表默认覆盖的全部站点）。
        返回当前用户被允许的子集（admin/无限制 -> 原样；受限 -> 仅保留可见站点）。
        供无 team 参数的聚合型报表（数据大屏）按权限裁剪。
        """
        s = self.session
        role = (s or {}).get("role")
        if role == "admin":
            return list(universe)
        ids = dataperm.allowed_team_ids(s["user"], role)
        if ids is None:
            return list(universe)
        return [t for t in universe if str(t[0]) in ids]

    def _handle_login(self):
        data = self._body()
        if not isinstance(data, dict):
            data = {}
        uname = (data.get("username") or "")
        pw = (data.get("password") or "")
        ip = self.client_address[0]
        res = auth.login(uname, pw, ip)
        if not res:
            self._json({"ok": False, "error": "用户名或密码错误"}, 401)
            return
        token, role = res
        body = json.dumps({"ok": True, "token": token, "user": uname,
                           "role": role, "expires_in": auth.SESSION_TTL},
                          ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Set-Cookie",
            "wb_session=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d"
            % (token, auth.SESSION_TTL))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_logout(self):
        t = self._extract_token()
        if t:
            auth.logout(t)
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Set-Cookie", "wb_session=; Path=/; HttpOnly; Max-Age=0")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_change_pw(self):
        s = self._auth_user()
        if not s:
            self._json({"ok": False, "error": "unauthorized"}, 401)
            return
        data = self._body()
        if not isinstance(data, dict):
            data = {}
        try:
            auth.change_password(s["user"],
                                 data.get("old_password") or "",
                                 data.get("new_password") or "")
            self._json({"ok": True})
        except ValueError as e:
            self._json({"ok": False, "error": str(e)}, 400)
        except Exception as e:
            self._json({"ok": False, "error": "服务器错误：" + str(e)}, 500)

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        qs = parse_qs(u.query)

        # 静态资源（无鉴权）：/、/index.html、/tokens.css、/favicon、/vendor/、/web/
        if _serve_static_get(self, p):
            return

        if p.startswith("/api/"):
            # 登录态自检：无需有效会话也可访问（前端据此决定是否弹登录框）
            if p == "/api/auth/me":
                s = self._auth_user()
                if s:
                    self._json({"authenticated": True, "user": s["user"], "role": s["role"]})
                else:
                    self._send(401,
                        json.dumps({"authenticated": False, "error": "unauthorized"},
                                   ensure_ascii=False),
                        "application/json; charset=utf-8")
                return
            s = self._auth_user()
            if not s:
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            self.session = s
            # 路由 → 权限（GET 未列出默认 view）
            perm = auth.GET_ROUTE_PERMS.get(p, "view")
            if not auth.has_perm(s["role"], perm):
                auth.audit(perm, False, s["user"], self.client_address[0],
                           s["role"], "GET", p)
                self._json({"ok": False, "error": "forbidden", "need": perm}, 403)
                return
            if perm in auth.SENSITIVE_AUDIT:
                auth.audit(perm, True, s["user"], self.client_address[0],
                           s["role"], "GET", p)
            fn = GET_ROUTES.get(p)
            if fn is not None:
                fn(self, qs)
                return
            self._json({"ok": False, "error": "not found"}, 404)
            return

        self._json({"ok": False, "error": "not found"}, 404)

    def _sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self._cors()
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        q = MGR.subscribe()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    evt = q.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                payload = ("data: %s\n\n" % json.dumps(evt, ensure_ascii=False)).encode("utf-8")
                self.wfile.write(payload)
                self.wfile.flush()
        except Exception:
            pass
        finally:
            MGR.unsubscribe(q)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        raw = self.rfile.read(n).decode("utf-8")
        try:
            return json.loads(raw)
        except Exception:
            return {}

    def do_POST(self):
        p = urlparse(self.path).path

        if p.startswith("/api/"):
            # 认证端点：无需有效会话
            if p == "/api/auth/login":
                self._handle_login()
                return
            if p == "/api/auth/logout":
                self._handle_logout()
                return
            # 个人改密：已登录即可（perm="self"），无需管理员权限
            if p == "/api/account/change-pw":
                self._handle_change_pw()
                return
            s = self._auth_user()
            if not s:
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            self.session = s
            # 非 JSON 请求体一律拒绝（防畸形/非预期请求）
            ct = self.headers.get("Content-Type") or ""
            if int(self.headers.get("Content-Length") or 0) > 0 \
                    and not ct.startswith("application/json"):
                self._json({"ok": False, "error": "仅接受 application/json 请求体"}, 415)
                return
            data = self._body()
            perm = auth.POST_ROUTE_PERMS.get(p, "view")
            if not auth.has_perm(s["role"], perm):
                auth.audit(perm, False, s["user"], self.client_address[0],
                           s["role"], "POST", p)
                self._json({"ok": False, "error": "forbidden", "need": perm}, 403)
                return
            auth.audit(perm, True, s["user"], self.client_address[0],
                       s["role"], "POST", p)
            fn = POST_ROUTES.get(p)
            if fn is not None:
                fn(self, data)
                return
            self._json({"ok": False, "error": "not found"}, 404)
            return

        self._json({"ok": False, "error": "not found"}, 404)


# ---- 路由 handler（由 do_GET/do_POST 路由表驱动；原 if 链已下沉至此）----

def _get_std_achievement(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    from dashboard.standard import cache as CACHE
    from dashboard.standard import multi_team as MT
    team = (qs.get("team") or ["917521136"])[0]
    start = (qs.get("start") or [""])[0] or CACHE.today_ymd()
    end = (qs.get("end") or [""])[0] or CACHE.today_ymd()
    refresh = (qs.get("refresh") or ["0"])[0] == "1"
    mode, val = self._enforce_team_scope(team)
    if mode == "deny":
        return
    if team == MT.ALL_TEAM_ID:
        if refresh:
            self._json({"ok": False, "code": "USE_REFRESH_ALL",
                        "error": "全部站点不支持同步实时拉取，请点「刷新数据」走全量刷新",
                        "rows": [], "summary": None}, 400)
            return
        _teams = _configured_teams() if mode == "all" else \
            [t for t in _configured_teams() if t[0] in val]
        self._json(MT.achievement_all(_teams, start, end))
        return
    if refresh:
        _ok, _wait = _rate_check(self, "achievement")
        if not _ok:
            _rate_limited_json(self, "achievement", _wait)
            return
    try:
        from dashboard.standard import achievement as AC
        data = (AC.compute(team, start, end) if refresh
                else AC.recompute(team, start, end))
        self._json(data)
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "start": start, "end": end,
                    "source": "error", "rows": [], "summary": None,
                    "attendance": None, "need_refresh": False})


def _get_std_riders(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    from dashboard.standard import cache as CACHE
    from dashboard.standard import multi_team as MT
    team = (qs.get("team") or ["917521136"])[0]
    start = (qs.get("start") or [""])[0] or CACHE.today_ymd()
    end = (qs.get("end") or [""])[0] or CACHE.today_ymd()
    tc = (qs.get("tc") or [""])[0] or None
    month = (qs.get("month") or [""])[0].strip() or None
    refresh = (qs.get("refresh") or ["0"])[0] == "1"
    mode, val = self._enforce_team_scope(team)
    if mode == "deny":
        return
    if team == MT.ALL_TEAM_ID:
        if refresh:
            self._json({"ok": False, "code": "USE_REFRESH_ALL",
                        "error": "全部站点不支持同步实时拉取，请点「刷新数据」走全量刷新",
                        "rows": [], "summary": None}, 400)
            return
        _teams = _configured_teams() if mode == "all" else \
            [t for t in _configured_teams() if t[0] in val]
        self._json(MT.riders_all(_teams, start, end,
                                 time_code=tc, month=month))
        return
    if refresh:
        _ok, _wait = _rate_check(self, "riders")
        if not _ok:
            _rate_limited_json(self, "riders", _wait)
            return
    try:
        from dashboard.standard import rider_dimension as RD
        if refresh:
            data = RD.compute(team, time_code=tc, start=start, end=end, month=month)
        else:
            data = RD.recompute(team, time_code=tc, start=start, end=end, month=month)
        self._json(data)
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "start": start, "end": end,
                    "source": "error", "rows": [], "summary": None,
                    "need_refresh": False})


def _get_std_station_report(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    from dashboard.standard import cache as CACHE
    from dashboard.standard import multi_team as MT
    team = (qs.get("team") or ["__all__"])[0]
    start = (qs.get("start") or [""])[0] or CACHE.today_ymd()
    end = (qs.get("end") or [""])[0] or CACHE.today_ymd()
    month = (qs.get("month") or [""])[0].strip() or None
    mode, val = self._enforce_team_scope(team)
    if mode == "deny":
        return
    if team == MT.ALL_TEAM_ID:
        try:
            from dashboard.standard import station_report as SR
            _teams = _configured_teams() if mode == "all" else \
                [t for t in _configured_teams() if t[0] in val]
            self._json(SR.build_all(_teams, start, end, month))
        except Exception as e:
            self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                        "team": team, "rows": [], "data_status": "error"})
        return
    try:
        from dashboard.standard import station_report as SR
        row = SR.build_one(team, start, end, month, "cache")
        miss = bool(row.get("need_refresh"))
        self._json({
            "ok": True,
            "team": team,
            "teamName": row.get("team_name"),
            "start": start, "end": end, "basis": "day",
            "rows": [] if miss else [row],
            "data_status": "no_data" if miss else "ok",
            "data_note": row.get("data_note"),
            "need_refresh": miss,
        })
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "start": start, "end": end,
                    "data_status": "error", "need_refresh": False})


def _get_std_teams_config(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    from dashboard.standard import teams_config as TCFG
    self._json({"ok": True, "teams": TCFG.get_teams(),
                "default": list(TCFG.DEFAULT_TEAMS),
                "all": [{"id": i, "name": n} for i, n in _teams_with_names()]})


def _get_std_refresh_all_status(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    from dashboard.standard import refresh_all as RA
    self._json({"ok": True, "status": RA.status()})


def _get_std_grade_standards(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    month = (qs.get("month") or [""])[0].strip() or None
    team_only = (qs.get("team") or [""])[0].strip() or None
    try:
        from dashboard.standard import grade_standards as GS
        if team_only:
            rec = GS.get(team_only, month or "")
            self._json({"ok": True, "record": rec,
                        "month": rec.get("month"),
                        "team_id": rec.get("team_id"),
                        "thresholds": GS.build_levels(
                            team_only, rec.get("month") or "")[1:6]})
        else:
            out = GS.get_all(month or "")
            self._json({"ok": True, **out})
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


def _get_std_thresholds(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    try:
        from dashboard.standard import threshold_config as TC
        month = (qs.get("month") or [None])[0]
        self._json({"ok": True, **TC.get(month)})
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


# >>>ROUTES_MARKER<<<

def _post_std_teams_config(self, data):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    from dashboard.standard import teams_config as TCFG
    ok, teams, msg = TCFG.set_teams(data.get("teams"))
    self._json({"ok": ok, "teams": teams, "error": (msg or None)})


def _post_std_refresh_all(self, data):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    from dashboard.standard import refresh_all as RA
    from dashboard.standard import cache as CACHE
    if RA.status().get("running"):
        # 已有刷新在跑：不再报错 409，而是把当前进度返回给前端，
        # 由前端转入轮询（始终只跑一个全量刷新，这里只是「接入」已存在的任务）。
        self._json({"ok": True, "already_running": True,
                    "msg": "已有刷新任务在运行，已接入进度轮询",
                    "status": RA.status()})
        return
    _ok, _wait = _rate_check(self, "refresh-all")
    if not _ok:
        _rate_limited_json(self, "refresh-all", _wait)
        return
    s = str(data.get("start") or "").strip() or CACHE.today_ymd()
    e = str(data.get("end") or "").strip() or s
    ok, msg = RA.start(teams=data.get("teams"), start_date=s, end_date=e)
    self._json({"ok": ok, "error": (None if ok else msg), "msg": msg,
                "status": RA.status()})


def _post_std_grade_standards(self, data):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    tid = str(data.get("team_id") or "").strip()
    mo = str(data.get("month") or "").strip()
    action = str(data.get("action") or "save").strip()
    if not tid or not mo:
        self._json({"ok": False, "error": "team_id 与 month 都必填"}, 400)
        return
    from dashboard.standard import cache as _CACHE
    try:
        from dashboard.standard import grade_standards as _GS
        if action == "delete":
            deleted = _GS.delete(tid, mo)
            _CACHE.clear_results()
            self._json({"ok": True, "deleted": deleted})
            return
        order = data.get("order")
        dur_h = data.get("duration_h") or data.get("duration")
        if not isinstance(order, list) or len(order) != 5:
            self._json({"ok": False, "error": "order 须是长度为 5 的数组"}, 400)
            return
        if not isinstance(dur_h, list) or len(dur_h) != 5:
            self._json({"ok": False, "error": "duration_h 须是长度为 5 的数组"}, 400)
            return
        saved = _GS.save(tid, mo, order, dur_h)
        _CACHE.clear_results()
        self._json({"ok": True, "saved": saved})
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, 400)


def _post_std_thresholds(self, data):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    try:
        from dashboard.standard import threshold_config as _TC
        from dashboard.standard import cache as _CACHE
        tp = data.get("threshold_pct")
        cp = data.get("cap_pct")
        month = data.get("month")
        saved = _TC.save(tp, cp, month)
        _CACHE.clear_results()
        self._json({"ok": True, **saved})
    except ValueError as e:
        self._json({"ok": False, "error": str(e)}, 400)
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, 400)


# >>>ROUTES_MARKER<<<

def _get_ap_valid(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    from dashboard.standard import cache as CACHE
    team = (qs.get("team") or ["917521136"])[0]
    date = (qs.get("start") or [""])[0] or CACHE.today_ymd()
    refresh = (qs.get("refresh") or ["0"])[0] == "1"
    mode, val = self._enforce_team_scope(team)
    if mode == "deny":
        return
    if not refresh:
        self._json({"ok": True, "need_refresh": True, "rows": [],
                    "summary": None, "team": team, "date": date,
                    "source": "none",
                    "data_note": "请点「查询」拉取实时数据"})
        return
    _ok, _wait = _rate_check(self, "attend_period", window=ATTEND_PERIOD_RATE_LIMIT_SEC)
    if not _ok:
        _rate_limited_json(self, "attend_period", _wait, window=ATTEND_PERIOD_RATE_LIMIT_SEC)
        return
    try:
        if team == "__all__":
            from dashboard.standard import attend_period_all as APA
            from dashboard.standard import attend_period_teams as APT
            _ids = APT.get_teams() if mode == "all" else \
                [t for t in APT.get_teams() if t in val]
            data = APA.valid_all(_ids, date)
        else:
            from dashboard import attend_period as AP
            data = AP.compute_valid(team, date)
        self._json(data)
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "date": date, "rows": [], "summary": None})


def _get_ap_rider_detail(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    from dashboard.standard import cache as CACHE
    team = (qs.get("team") or ["917521136"])[0]
    date = (qs.get("start") or [""])[0] or CACHE.today_ymd()
    refresh = (qs.get("refresh") or ["0"])[0] == "1"
    mode, val = self._enforce_team_scope(team)
    if mode == "deny":
        return
    if not refresh:
        self._json({"ok": True, "need_refresh": True, "rows": [], "periods": [],
                    "summary": None, "team": team, "date": date,
                    "source": "none",
                    "data_note": "请点「查询」拉取实时数据"})
        return
    _ok, _wait = _rate_check(self, "attend_period", window=ATTEND_PERIOD_RATE_LIMIT_SEC)
    if not _ok:
        _rate_limited_json(self, "attend_period", _wait, window=ATTEND_PERIOD_RATE_LIMIT_SEC)
        return
    try:
        from dashboard.standard import attend_period_source as APSRC
        if team == "__all__":
            from dashboard.standard import attend_period_teams as APT
            _ids = APT.get_teams() if mode == "all" else \
                [t for t in APT.get_teams() if t in val]
            ds = APSRC.get_dataset("__all__", date, refresh=True, teams=_ids)
        else:
            ds = APSRC.get_dataset(team, date, refresh=True)
        self._json(APSRC.to_rider_detail(ds))
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "date": date, "rows": [], "periods": [],
                    "summary": None})


def _get_ap_station_data(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    from dashboard.standard import cache as CACHE
    team = (qs.get("team") or ["917521136"])[0]
    date = (qs.get("start") or [""])[0] or CACHE.today_ymd()
    refresh = (qs.get("refresh") or ["0"])[0] == "1"
    mode, val = self._enforce_team_scope(team)
    if mode == "deny":
        return
    if not refresh:
        self._json({"ok": True, "need_refresh": True, "rows": [], "periods": [],
                    "team": team, "date": date, "source": "none",
                    "data_note": "请点「查询」拉取实时数据"})
        return
    _ok, _wait = _rate_check(self, "attend_period", window=ATTEND_PERIOD_RATE_LIMIT_SEC)
    if not _ok:
        _rate_limited_json(self, "attend_period", _wait, window=ATTEND_PERIOD_RATE_LIMIT_SEC)
        return
    try:
        from dashboard.standard import attend_period_source as APSRC
        if team == "__all__":
            from dashboard.standard import attend_period_teams as APT
            _ids = APT.get_teams() if mode == "all" else \
                [t for t in APT.get_teams() if t in val]
            ds = APSRC.get_dataset("__all__", date, refresh=True, teams=_ids)
        else:
            ds = APSRC.get_dataset(team, date, refresh=True)
        self._json(APSRC.to_station_data(ds))
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "date": date, "rows": [], "periods": []})


def _get_ap_dataset(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    from dashboard.standard import cache as CACHE
    team = (qs.get("team") or ["__all__"])[0]
    date = (qs.get("start") or [""])[0] or CACHE.today_ymd()
    refresh = (qs.get("refresh") or ["0"])[0] == "1"
    mode, val = self._enforce_team_scope(team)
    if mode == "deny":
        return
    if not refresh:
        self._json({"ok": True, "need_refresh": True, "dataset": None,
                    "team": team, "date": date, "source": "none",
                    "data_note": "请点「查询」拉取实时数据"})
        return
    _ok, _wait = _rate_check(self, "attend_period", window=ATTEND_PERIOD_RATE_LIMIT_SEC)
    if not _ok:
        _rate_limited_json(self, "attend_period", _wait, window=ATTEND_PERIOD_RATE_LIMIT_SEC)
        return
    try:
        from dashboard.standard import attend_period_source as APSRC
        if team == "__all__":
            from dashboard.standard import attend_period_teams as APT
            _ids = APT.get_teams() if mode == "all" else \
                [t for t in APT.get_teams() if t in val]
            ds = APSRC.get_dataset("__all__", date, refresh=True, teams=_ids)
        else:
            ds = APSRC.get_dataset(team, date, refresh=True)
        self._json({"ok": True, "team": ds["team"], "date": ds["date"],
                    "fetched_at": ds["fetched_at"], "source": ds["source"],
                    "dataset": {"rider_detail": APSRC.to_rider_detail(ds),
                                "station_data": APSRC.to_station_data(ds)}})
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "date": date, "dataset": None})


def _get_ap_config(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    month = (qs.get("month") or [""])[0] or None
    try:
        from dashboard.standard import period_config as PC
        self._json({"ok": True, **PC.load(month)})
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


def _get_ap_months(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    try:
        from dashboard.standard import period_config as PC
        self._json({"ok": True, **PC.list_months()})
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


def _get_ap_teams(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    try:
        from dashboard.standard import attend_period_teams as APT
        res = _fetch_all_teams()
        raw = res.get("teams") or res.get("fallback") or []
        s = self.session
        _ids = None
        if (s or {}).get("role") != "admin":
            _ids = dataperm.allowed_team_ids(s["user"], s["role"])
        all_list = [{"id": str(t.get("id")), "name": t.get("name")} for t in raw
                    if _ids is None or str(t.get("id")) in _ids]
        _cfg = APT.get_teams()
        if _ids is not None:
            _cfg = [t for t in _cfg if str(t) in _ids]
        self._json({"ok": res.get("ok", True), "teams": _cfg,
                    "all": all_list, "source": res.get("source"),
                    "error": res.get("error")})
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


def _post_ap_config(self, data):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    try:
        from dashboard.standard import period_config as _PC
        month = data.get("month") or None
        periods = data.get("periods")
        saved = _PC.save(periods, month)
        self._json({"ok": True, **saved})
    except ValueError as e:
        self._json({"ok": False, "error": str(e)}, 400)
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, 400)


def _post_ap_teams(self, data):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    try:
        from dashboard.standard import attend_period_teams as APT
        ok, teams, msg = APT.set_teams(data.get("teams"))
        self._json({"ok": ok, "teams": teams, "error": (msg or None)})
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, 400)


# >>>ROUTES_MARKER<<<

def _post_todo_lists(self, data):
    op = data.get("op")
    try:
        if op == "create":
            r = todo_store.create_list(
                (data.get("name") or "").strip() or "新列表",
                data.get("icon") or "list-checks",
                data.get("color") or "#FF5000")
            self._json({"ok": True, "list": r})
        elif op == "update":
            r = todo_store.update_list(
                data.get("id"), name=data.get("name"),
                icon=data.get("icon"), color=data.get("color"))
            self._json({"ok": bool(r), "list": r})
        elif op == "delete":
            ok, msg = todo_store.delete_list(data.get("id"))
            self._json({"ok": ok, "error": None if ok else msg})
        else:
            self._json({"ok": False, "error": "未知操作"}, 400)
    except Exception as e:
        self._json({"ok": False, "error": str(e)}, 500)
    if op in ("create", "update", "delete"):
        _todo_broadcast()


def _post_todo_items(self, data):
    op = data.get("op")
    try:
        if op == "create":
            lid = data.get("list_id") or _todo_default_list()
            r = todo_store.create_item(
                title=(data.get("title") or "").strip(),
                list_id=lid, note=data.get("note") or "",
                remind_at=data.get("remind_at") or "",
                flag=data.get("flag"), repeat=data.get("repeat") or {},
                task_id=data.get("task_id") or "",
                auto_run=data.get("auto_run"))
            self._json({"ok": True, "item": _todo_item_out(r)})
        elif op == "update":
            if not data.get("id"):
                self._json({"ok": False, "error": "缺少 id"}, 400)
                return
            kw = {}
            for k in ("title", "note", "remind_at", "list_id", "task_id",
                      "auto_run", "flag", "status"):
                if k in data:
                    kw[k] = data[k]
            if "repeat" in data:
                kw["repeat"] = data["repeat"]
            r = todo_store.update_item(data["id"], **kw)
            self._json({"ok": bool(r), "item": _todo_item_out(r)})
        elif op == "toggle":
            r = todo_store.set_done(data.get("id"), bool(data.get("done")))
            self._json({"ok": bool(r), "item": _todo_item_out(r)})
        elif op == "delete":
            ok = todo_store.delete_item(data.get("id"))
            self._json({"ok": ok})
        elif op == "unlink":
            r = todo_store.unlink_task(data.get("id"))
            self._json({"ok": bool(r), "item": _todo_item_out(r)})
        else:
            self._json({"ok": False, "error": "未知操作"}, 400)
    except Exception as e:
        self._json({"ok": False, "error": str(e)}, 500)
    _todo_broadcast()


def _post_todo_trigger(self, data):
    if not SCHED:
        self._json({"ok": False, "error": "调度器未启动"}, 500)
        return
    ok, msg = SCHED.trigger_now(data.get("item_id"))
    self._json({"ok": ok, "error": None if ok else msg})


def _post_todo_import(self, data):
    try:
        n = todo_store.import_payload(data)
        self._json({"ok": True, "lists": n[0], "items": n[1]})
    except Exception as e:
        self._json({"ok": False, "error": str(e)}, 500)


# >>>ROUTES_MARKER<<<

def _get_state(self, qs):
    self._json({"ok": True, **MGR.snapshot(),
                "registry": MGR.registry_view()})


def _get_groups(self, qs):
    # ?id=<cid> → 按群号精确反查群名（前端把已保存的 gid 回填成群名用）；
    # ?q=<关键词> → 模糊搜索。两者都只返回群名作 title，绝不回退成群号。
    gid = ((qs.get("id") or [""])[0] or "").strip()
    q = (qs.get("q") or [""])[0]
    try:
        limit = int((qs.get("limit") or [0])[0] or 0) or 20
    except ValueError:
        limit = 20
    try:
        import group_picker
        if gid:
            self._json({"ok": True, **group_picker.by_id(gid)})
        else:
            self._json({"ok": True, **group_picker.search(q, limit)})
    except Exception as e:
        try:
            import group_picker
            rec = group_picker.recent(limit)
        except Exception:
            rec = []
        self._json({"ok": False, "error": str(e),
                    "groups": rec, "source": "recent-fallback"})


def _get_teams(self, qs):
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    res = _fetch_all_teams()
    # 数据权限：非管理员只暴露其可见站点，避免站点清单泄露
    s = self.session
    if (s or {}).get("role") != "admin":
        ids = dataperm.allowed_team_ids(s["user"], s["role"])
        if ids is not None:
            res = dict(res)
            for _k in ("teams", "all", "fallback"):
                _lst = res.get(_k) or []
                res[_k] = [t for t in _lst
                           if str(t.get("id") if isinstance(t, dict) else t) in ids]
    self._json(res)


# ---------------- 实时数据：用户所选站点（按账号持久化，多端同步） ----------------
# 与数据权限闸门（_enforce_team_scope / dataperm.allowed_team_ids）协同：
# 读取/保存都只保留当前用户有权限的 team id，越权站点不落库（纵深防御）。
REALTIME_SEL_FILE = os.path.join(ROOT, ".realtime_selection.json")

def _load_realtime_sel():
    try:
        with open(REALTIME_SEL_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}

def _save_realtime_sel(obj):
    tmp = REALTIME_SEL_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush(); os.fsync(f.fileno())
    os.replace(tmp, REALTIME_SEL_FILE)
    try:
        os.chmod(REALTIME_SEL_FILE, 0o600)
    except OSError:
        pass

def _get_realtime_selection(self, qs):
    s = self.session
    if not s:
        self._json({"ok": False, "error": "未登录"}, 401); return
    username, role = s["user"], s["role"]
    sel = _load_realtime_sel().get(username, [])
    ids = dataperm.allowed_team_ids(username, role)
    if ids is not None:
        sel = [t for t in sel if str(t) in ids]
    self._json({"ok": True, "teams": sel})

def _post_realtime_selection(self, qs):
    s = self.session
    if not s:
        self._json({"ok": False, "error": "未登录"}, 401); return
    username, role = s["user"], s["role"]
    # do_POST 已将解析后的请求体 dict 作为第二参传入（qs），不可再读 body 流（已消费）
    data = qs if isinstance(qs, dict) else {}
    incoming = data.get("teams") or []
    ids = dataperm.allowed_team_ids(username, role)
    clean, seen = [], set()
    for t in incoming:
        t = str(t).strip()
        if not t or t in seen:
            continue
        if ids is not None and t not in ids:
            continue   # 越权站点不落库（纵深防御）
        seen.add(t); clean.append(t)
    obj = _load_realtime_sel()
    obj[username] = clean
    _save_realtime_sel(obj)
    self._json({"ok": True, "teams": clean})


def _get_history(self, qs):
    self._json({"ok": True, "history": MGR.history[:30]})


def _get_log(self, qs):
    rid = (qs.get("run_id") or [""])[0]
    lines = MGR.run_log(rid)
    if lines is None:
        self._json({"ok": False, "error": "未找到该运行记录"}, 404)
    else:
        self._json({"ok": True, "run_id": rid, "lines": lines})


def _get_events(self, qs):
    self._sse()


def _get_cookies_status(self, qs):
    self._json(check_cookie_status())


def _get_download(self, qs):
    rid = (qs.get("run_id") or [""])[0]
    lines = MGR.run_log(rid) or []
    body = "\n".join(lines)
    self._send(200, body, "text/plain; charset=utf-8")


def _get_files(self, qs):
    tid = (qs.get("task_id") or [""])[0]
    self._json({"ok": True, "task_id": tid,
                "files": list_artifacts(tid)})


def _get_file(self, qs):
    rel = (qs.get("path") or [""])[0]
    if not rel:
        self._send(400, "缺少 path", "text/plain; charset=utf-8")
        return
    serve_artifact(self, rel)


def _get_sheet(self, qs):
    rel = (qs.get("path") or [""])[0]
    if not rel:
        self._json({"ok": False, "error": "缺少 path"}, 400)
        return
    target = _safe_resolve(rel)
    if target is None:
        self._json({"ok": False, "error": "非法路径"}, 403)
        return
    if not os.path.isfile(target):
        self._json({"ok": False, "error": "文件不存在"}, 404)
        return
    try:
        data, err = sheet_to_json(target)
    except Exception as e:
        self._json({"ok": False, "error": "解析失败：%s" % e}, 500)
        return
    if err:
        self._json({"ok": False, "error": err}, 400)
        return
    self._json({"ok": True, "file": os.path.basename(target), **data})


def _get_todo(self, qs):
    self._json({"ok": True, "todo": todo_payload()})


def _get_todo_runs(self, qs):
    iid = (qs.get("item_id") or [""])[0]
    try:
        limit = max(1, min(50, int((qs.get("limit") or ["20"])[0])))
    except Exception:
        limit = 20
    self._json({"ok": True, "runs": todo_store.item_runs(iid, limit)})


def _post_run(self, data):
    MGR._sync_registry_if_changed()
    items = data.get("items") or []
    if len(items) > 1:
        self._json({"ok": False, "error": "每次仅支持执行一个任务"}, 400)
        return
    if not items:
        self._json({"ok": False, "error": "没有要执行的任务"}, 400)
        return
    ids = MGR.enqueue(items)
    self._json({"ok": True, "run_ids": ids})


def _post_stop(self, data):
    ok = MGR.stop_current()
    self._json({"ok": True, "stopped": ok})


def _post_cancel(self, data):
    rid = data.get("run_id")
    self._json({"ok": MGR.cancel_queued(rid)})


def _post_groups_used(self, data):
    try:
        import group_picker
        ok = group_picker.note_used(data.get("id") or "",
                                    data.get("title") or "")
        self._json({"ok": bool(ok), "recent": group_picker.recent(10)})
    except Exception as e:
        self._json({"ok": False, "error": str(e)}, 500)


def _post_groups_forget(self, data):
    try:
        import group_picker
        group_picker.forget(data.get("id") or "")
        self._json({"ok": True, "recent": group_picker.recent(10)})
    except Exception as e:
        self._json({"ok": False, "error": str(e)}, 500)


def _serve_static_get(self, p):
    # 返回 True 表示已处理静态资源；False 表示需走 API 路由表
    if p in ("/", "/index.html"):
        # 托管 Vite 构建产物（web/dist/index.html），并保持 token 占位替换
        try:
            with open(DIST_INDEX, "rb") as f:
                data = f.read()
        except Exception:
            self._send(500, "index.html 缺失（请先 npm run build）", "text/plain; charset=utf-8")
            return True
        self._send(200, data, "text/html; charset=utf-8")
        return True
    if p.startswith("/assets/"):
        # Vite 打包后的 JS/CSS（如 /assets/index-xxx.js），带内容哈希，可安全缓存
        sub = urllib.parse.unquote(p[1:])
        if not sub:
            self._send(404, "not found", "text/plain; charset=utf-8")
            return True
        serve_under(self, DIST_DIR, sub)
        return True
    if p == "/tokens.css":
        try:
            with open(TOKENS_CSS, "rb") as f:
                data = f.read()
        except Exception:
            self._send(500, "tokens.css 缺失", "text/plain; charset=utf-8")
            return True
        self._send(200, data, "text/css; charset=utf-8")
        return True
    if p == "/favicon.ico":
        self._send(204, b"", "image/x-icon")
        return True
    if p.startswith("/vendor/"):
        sub = urllib.parse.unquote(p[len("/vendor/"):])
        if not sub:
            self._send(404, "not found", "text/plain; charset=utf-8")
            return True
        serve_under(self, VENDOR, sub)
        return True
    if p.startswith("/web/"):
        sub = urllib.parse.unquote(p[len("/web/"):])
        if not sub:
            self._send(404, "not found", "text/plain; charset=utf-8")
            return True
        serve_under(self, WEB_DIR, sub)
        return True
    return False


# ---------------------------------------------------------------- 数据大屏（首页）
def _get_ov_site_orders(self, qs):
    """数据大屏 —— 站点维度「接单量 / 配送完成量」。

    归属口径：骑手接单时间（acceptAtLast）的北京时间自然日，跨午夜归接单当天；
    数据来自本地运单缓存 dashboard/data/orders_<team>_<date>.json（口径单一来源 order_rules）。
    默认区间：end（默认今天）往前 7 天。
    """
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    import datetime as _dt
    from dashboard.standard import cache as CACHE
    from dashboard.standard import site_orders as SO
    end = (qs.get("end") or [""])[0].strip() or CACHE.today_ymd()
    start = (qs.get("start") or [""])[0].strip()
    if not start:
        start = (_dt.date.fromisoformat(end) - _dt.timedelta(days=6)).isoformat()
    try:
        _allowed = self._scoped_universe(_configured_teams())
        payload = SO.build_site_orders(start, end, teams=[t[0] for t in _allowed] or None)
    except Exception as e:
        payload = {"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                   "range": {"start": start, "end": end}, "sites": [], "totals": {}}
    self._json(payload)


def _get_ov_standard(self, qs):
    """数据大屏 —— 站点维度「标准达成」（今日）。

    直接复用 station_report（站点维度报表）这一单一来源：规模目标 / 排班 / 出勤 / 达标人数 /
    标准1~5 等级分布 / 门槛人数 / 封顶人数，口径与「标准达成」视图完全一致。
    注意该报表是**单日**口径（只看 date 那一天，不看区间），所以大屏上固定标「今日」。
    三源（排班目标 / 运单明细 / 考勤）缺任一则该站落 need_refresh，被排除在 rows 外并给出 note。
    """
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    from dashboard.standard import cache as CACHE
    date = (qs.get("date") or [""])[0].strip() or CACHE.today_ymd()
    month = (qs.get("month") or [""])[0].strip() or None
    try:
        from dashboard.standard import station_report as SR
        payload = SR.build_all(self._scoped_universe(_configured_teams()), date, date, month)
    except Exception as e:
        payload = {"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                   "start": date, "end": date, "rows": []}
    payload["date"] = date
    self._json(payload)


def _get_ov_assessment(self, qs):
    """考核结算大屏 —— 跨源聚合（运力达标 / 大网质量 / 时段出勤 / 历史对比 / 红黄灯）。

    只读 dashboard/data 三源缓存（与「标准达成」「时段出勤」同源，零口径漂移），
    时段出勤复用 attend_period_source 的进程内数据集缓存（用户未点查询则留空提示）。
    支持 ?date=YYYY-MM-DD（默认今天）与 ?refresh=1（清模块缓存重算）。
    """
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    from dashboard.standard import cache as CACHE
    date = (qs.get("date") or [""])[0].strip() or CACHE.today_ymd()
    refresh = (qs.get("refresh") or [""])[0].strip() in ("1", "true", "yes")
    try:
        from dashboard.standard import assessment_overview as AO
        payload = AO.build_assessment(date, self._scoped_universe(_configured_teams()), refresh=refresh)
    except Exception as e:
        payload = {"ok": False, "error": "%s: %s" % (type(e).__name__, e), "date": date}
    self._json(payload)


# ===================== 账号 / 角色 / 策略 管理接口（模块级处理器） =====================
def _admin_err(self, code, msg):
    self._json({"ok": False, "error": msg}, code)

def _get_admin_users(self, qs):
    self._json({"ok": True, "users": auth.list_users_safe()})

def _get_admin_roles(self, qs):
    catalog = [{"perm": p, "label": l, "group": g} for (p, l, g) in auth.PERM_CATALOG]
    self._json({"ok": True, "roles": auth.list_roles(),
                "catalog": catalog, "all_perms": sorted(auth.ALL_PERMS)})

def _get_policy(self, qs):
    self._json({"ok": True, "policy": auth.get_policy(), "defaults": auth.PW_POLICY_DEFAULT})

# 数据权限专用：站点明细持久化（仅供本接口「失败回退」用，不影响 /api/teams 等既有行为）
_DP_TEAMS_LAST_PATH = os.path.join(ROOT, "workbench", "data", "data_perms_teams_last.json")


def _dp_load_teams_last():
    """数据权限上次成功获取的站点明细 [{id, name}]；文件缺失 / 损坏 → []。"""
    try:
        with open(_DP_TEAMS_LAST_PATH, "r", encoding="utf-8") as f:
            obj = json.load(f)
    except Exception:
        return []
    teams = (obj or {}).get("teams")
    if not isinstance(teams, list):
        return []
    out = []
    for t in teams:
        tid = str((t or {}).get("id") or "").strip()
        if tid:
            out.append({"id": tid, "name": (t or {}).get("name") or tid})
    return out


def _dp_save_teams_last(teams):
    """原子写：把本次成功获取的站点明细落盘，供数据权限接口下次失败回退。"""
    try:
        os.makedirs(os.path.dirname(_DP_TEAMS_LAST_PATH), exist_ok=True)
        tmp = _DP_TEAMS_LAST_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"teams": teams,
                       "saved_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")},
                      f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, _DP_TEAMS_LAST_PATH)
    except Exception as e:
        log.warning("[data-perms] 站点明细落盘失败：%s" % e)


def _get_data_perms(self, qs):
    """数据权限管理：返回账号清单、组织树(业务线→城市→站点)、当前规则、可选站点清单。

    站点清单以风神为准：主动调 _fetch_all_teams() 拉取（5 分钟缓存复用）。
    该拉取失败（source="fallback"）时，回退到**本接口上次成功获取的明细**；
    从未成功过则返回空。此回退仅作用于数据权限，不改动 /api/teams 的行为。
    """
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    _ft = _fetch_all_teams()
    if _ft.get("source") != "fallback" and _ft.get("teams"):
        _dp_save_teams_last(_ft["teams"])
        _items, _src = _ft["teams"], "xtop"
    else:
        _items = _dp_load_teams_last()
        _src = "cache" if _items else "none"
    all_teams = [{"id": str(t.get("id")), "name": t.get("name") or str(t.get("id"))}
                 for t in _items if t.get("id")]
    org = {}        # city -> [{"id", "name"}]
    ungrouped = []  # 未归入任何城市的站点（供组织编辑器归类）
    for t in all_teams:
        c = dataperm.city_of(t["id"])
        if c:
            org.setdefault(c, []).append(t)
        else:
            ungrouped.append(t)
    self._json({"ok": True,
                "users": auth.list_users_safe(),
                "rules": dataperm.list_rules(),
                "all_teams": all_teams,
                "teams_source": _src,   # "xtop"(风神) / "cache"(上次明细) / "none"
                "org": org,
                "ungrouped": ungrouped,
                "cities": dataperm.cities(),
                "business_lines": dataperm.business_lines(),
                "bl_of_city": {c: (dataperm.business_line_of(c) or "") for c in dataperm.cities()},
                "default_new_site": dataperm.get_default_new_site(),
                "default_scope": dataperm.DEFAULT_SCOPE})

def _post_data_perms(self, data):
    """保存 / 删除某用户的数据权限规则，或保存组织树。

    组织树：body {action:"set_org", cities:{城市:[站点id...]}, default_new_site?}
    规则：   body {username, action?, scope?, teams?, cities?, inherit_new?}
    """
    act = (data.get("action") or "set")
    if act == "set_org":
        cities_map = data.get("cities") or {}
        bl_map = data.get("business_lines") or {}
        dns = data.get("default_new_site")
        ok, msg = dataperm.set_org(cities_map, dns, bl_map)
        auth.audit("data:org", ok, self.session["user"], self.client_address[0],
                   "business_lines=%d cities=%d" % (len(bl_map or {}), len(cities_map or {})))
        self._json({"ok": ok, "error": (msg or None)}, 200 if ok else 400)
        return
    uname = (data.get("username") or "").strip()
    if not uname:
        self._json({"ok": False, "error": "用户名不能为空"}, 400)
        return
    if act == "delete":
        ok, msg = dataperm.delete_rule(uname)
    else:
        scope = data.get("scope") or "all"
        teams = data.get("teams") or []
        cities = data.get("cities") or []
        business_lines = data.get("business_lines") or []
        inherit_new = bool(data.get("inherit_new"))
        ok, msg = dataperm.set_rule(uname, scope, teams, cities=cities,
                                    business_lines=business_lines, inherit_new=inherit_new)
    auth.audit("data:perm", ok, self.session["user"], self.client_address[0], uname)
    self._json({"ok": ok, "error": (msg or None)}, 200 if ok else 400)

def _post_admin_add_user(self, data):
    try:
        auth.add_user((data.get("username") or "").strip(),
                      data.get("password") or "", data.get("role") or "")
        self._json({"ok": True})
    except ValueError as e:
        _admin_err(self, 400, str(e))
    except Exception as e:
        _admin_err(self, 500, "服务器错误：" + str(e))

def _post_admin_update_user(self, data):
    try:
        uname = (data.get("username") or "").strip()
        kw = {}
        if data.get("role") is not None:
            kw["role"] = data.get("role")
        if data.get("disabled") is not None:
            kw["disabled"] = bool(data.get("disabled"))
        auth.update_user(uname, **kw)
        self._json({"ok": True})
    except ValueError as e:
        _admin_err(self, 400, str(e))
    except Exception as e:
        _admin_err(self, 500, "服务器错误：" + str(e))

def _post_admin_reset_pw(self, data):
    try:
        auth.reset_password((data.get("username") or "").strip(), data.get("password") or "")
        self._json({"ok": True})
    except ValueError as e:
        _admin_err(self, 400, str(e))
    except Exception as e:
        _admin_err(self, 500, "服务器错误：" + str(e))

def _post_admin_delete_user(self, data):
    s = self._auth_user()
    cur = s["user"] if s else None
    try:
        auth.delete_user((data.get("username") or "").strip(), current_user=cur)
        self._json({"ok": True})
    except ValueError as e:
        _admin_err(self, 400, str(e))
    except Exception as e:
        _admin_err(self, 500, "服务器错误：" + str(e))

def _post_admin_create_role(self, data):
    try:
        auth.create_role(data.get("name") or "", data.get("perms"), data.get("parents"))
        self._json({"ok": True})
    except ValueError as e:
        _admin_err(self, 400, str(e))
    except Exception as e:
        _admin_err(self, 500, "服务器错误：" + str(e))

def _post_admin_update_role(self, data):
    try:
        auth.update_role(data.get("name") or "", data.get("perms"), data.get("parents"))
        self._json({"ok": True})
    except ValueError as e:
        _admin_err(self, 400, str(e))
    except Exception as e:
        _admin_err(self, 500, "服务器错误：" + str(e))

def _post_admin_delete_role(self, data):
    try:
        auth.delete_role(data.get("name") or "")
        self._json({"ok": True})
    except ValueError as e:
        _admin_err(self, 400, str(e))
    except Exception as e:
        _admin_err(self, 500, "服务器错误：" + str(e))

def _post_set_policy(self, data):
    try:
        pol = auth.set_policy(data or {})
        self._json({"ok": True, "policy": pol})
    except ValueError as e:
        _admin_err(self, 400, str(e))
    except Exception as e:
        _admin_err(self, 500, "服务器错误：" + str(e))


GET_ROUTES = {
    "/api/state": _get_state,
    "/api/groups": _get_groups,
    "/api/teams": _get_teams,
    "/api/standard/achievement": _get_std_achievement,
    "/api/standard/riders": _get_std_riders,
    "/api/standard/station-report": _get_std_station_report,
    "/api/standard/teams-config": _get_std_teams_config,
    "/api/standard/refresh-all-status": _get_std_refresh_all_status,
    "/api/standard/grade-standards": _get_std_grade_standards,
    "/api/standard/thresholds": _get_std_thresholds,
    "/api/attend-period/valid": _get_ap_valid,
    "/api/attend-period/rider-detail": _get_ap_rider_detail,
    "/api/attend-period/station-data": _get_ap_station_data,
    "/api/attend-period/dataset": _get_ap_dataset,
    "/api/attend-period/config": _get_ap_config,
    "/api/attend-period/months": _get_ap_months,
    "/api/attend-period/teams": _get_ap_teams,
    "/api/history": _get_history,
    "/api/log": _get_log,
    "/api/events": _get_events,
    "/api/cookies/status": _get_cookies_status,
    "/api/download": _get_download,
    "/api/files": _get_files,
    "/api/file": _get_file,
    "/api/sheet": _get_sheet,
    "/api/todo": _get_todo,
    "/api/todo/runs": _get_todo_runs,
    "/api/overview/site-orders": _get_ov_site_orders,
    "/api/overview/standard": _get_ov_standard,
    "/api/overview/assessment": _get_ov_assessment,
    "/api/realtime/selection":  _get_realtime_selection,
}

POST_ROUTES = {
    "/api/standard/teams-config": _post_std_teams_config,
    "/api/standard/refresh-all": _post_std_refresh_all,
    "/api/standard/grade-standards": _post_std_grade_standards,
    "/api/standard/thresholds": _post_std_thresholds,
    "/api/attend-period/config": _post_ap_config,
    "/api/attend-period/teams": _post_ap_teams,
    "/api/run": _post_run,
    "/api/stop": _post_stop,
    "/api/cancel": _post_cancel,
    "/api/todo/lists": _post_todo_lists,
    "/api/todo/items": _post_todo_items,
    "/api/todo/trigger": _post_todo_trigger,
    "/api/todo/import": _post_todo_import,
    "/api/groups/used": _post_groups_used,
    "/api/groups/forget": _post_groups_forget,
    "/api/realtime/selection": _post_realtime_selection,
}

# 管理类路由（账号 / 角色 / 策略；鉴权由 POST_ROUTE_PERMS/GET_ROUTE_PERMS 的权限点控制）
GET_ROUTES.update({
    "/api/admin/users": _get_admin_users,
    "/api/admin/roles": _get_admin_roles,
    "/api/policy":      _get_policy,
    "/api/data-perms":  _get_data_perms,
})
POST_ROUTES.update({
    "/api/admin/user":         _post_admin_add_user,
    "/api/admin/user/update":  _post_admin_update_user,
    "/api/admin/user/reset-pw": _post_admin_reset_pw,
    "/api/admin/user/delete":  _post_admin_delete_user,
    "/api/admin/role":         _post_admin_create_role,
    "/api/admin/role/update":   _post_admin_update_role,
    "/api/admin/role/delete":   _post_admin_delete_role,
    "/api/policy":             _post_set_policy,
    "/api/data-perms":         _post_data_perms,
})


def main():
    port = 8917
    host = "127.0.0.1"   # 默认仅绑定本机回环，仅限本机访问（局域网不可达）
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    if "--host" in sys.argv:
        host = sys.argv[sys.argv.index("--host") + 1]
    srv = ThreadingHTTPServer((host, port), Handler)
    # RBAC：首次运行无用户库则建默认管理员（admin / admin123 或 WB_ADMIN_PASSWORD）
    auth.ensure_bootstrap()
    url = "http://127.0.0.1:%d" % port
    # H2: token 是真正的闸门（见 _check_auth）；SRV_ORIGINS 仅作本机回环兜底。
    SRV_ORIGINS.clear()
    SRV_ORIGINS.update({"http://127.0.0.1:%d" % port,
                        "http://localhost:%d" % port})
    print("=" * 60)
    print(" 风神数据处理 · 任务运行工作台")
    print("=" * 60)
    print(" 本机访问: %s" % url)
    print(" 绑定地址: %s:%d" % (host, port))
    print(" 项目目录: %s" % ROOT)
    print(" 解释器  : %s" % PYTHON)
    print(" 任务数量: %d" % len(MGR.registry["tasks"]))
    print("-" * 60)
    print(" 浏览器会自动打开；如未打开请手动访问上面的地址。")
    print(" 关闭本窗口即停止服务。")
    print("=" * 60)
    threading.Timer(1.0, lambda: _open_browser(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


def _open_browser(url):
    try:
        import webbrowser
        webbrowser.open(url)
    except Exception:
        pass


if __name__ == "__main__":
    main()
