"""AeolusData 计算 handler 库（原 server.py 的计算子集）。

背景：`server.py` 曾同时充当「工作台 HTTP 单体」与「计算 handler 库」两个角色。
工作台职责（路由 / 鉴权 / RBAC / 任务队列 / 静态托管 / 产物 / SSE / 诊断）已全部迁到
NestJS（`backend/`），HTTP 外壳（8917）也已移除；本文件只保留 compute_api 真正
需要的计算侧，故从根目录 `server.py` 迁到 `compute_api/` 下。

保留内容（由 AST 传递闭包精确确定，非手工增删）：
  · 命名空间 handler：standard / attend-period / overview / assessment
  · 其依赖：速率限制、站点缓存、Cookie 探针、路径守卫、表格解析

已剔除（迁 NestJS 或废弃，约 900 行）：
  RunManager（任务队列）、产物列举、静态托管、鉴权令牌、诊断规则、
  任务注册表读写、data-perms 站点快照、_is_loopback_origin。

调用约定：handler 形如 `fn(h, qs|data)`；h 为 compute_api 的 `_GatewayHandler`
替身，只实现 `_json` / `_enforce_team_scope` / `_scoped_universe` / `_visible_ids` /
`session` / `client_address`。数据权限一律由 Nest 下发的 `x-scope` 裁决。
"""
import fnmatch
import hashlib
import json
import logging
import os

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

import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime

# 项目根：本文件位于 compute_api/ 下，故上溯两级（原 server.py 在根目录，是单级）。
for _d in [ROOT, os.path.join(PY_HOME, "workbench"), os.path.join(PY_HOME, "common")]:
    if _d not in sys.path:
        sys.path.insert(0, _d)

# 取数统一经 nest_client：它会把网关下发的会话令牌（X-Token）透传给 Nest，
# 因此在机器令牌缺失/不一致时，只要前端已登录即可通过 Nest 鉴权闸门。
from common import nest_client

log = logging.getLogger("workbench")

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

# 频控的兜底指纹：原先由全局 API_TOKEN 派生，但鉴权已整体收敛到 NestJS，
# 本进程不再持有令牌 —— 也就不该再读写 .api_token（那是「鉴权」的副作用，
# 不属于计算服务）。正常路径按 Nest 下发的 x-user 分桶（见 _rate_user_fp），
# 这里仅在取不到用户时兜底成一个共用桶，与原行为语义一致。
_USER_FP = "anon"


# —— 标准达成「查询（实时刷新）」频控（2026-09-09）——
# 目的：实时拉取直连风神接口，间隔太近会触发上游「请求太频繁」。
# 维度：用户/会话（token 指纹 + 客户端地址）× 端点；以**服务端时间**为准，
#       不读任何前端传来的时间戳（前端那层只是体验优化，可被绕过）。
# 说明：仅内存态，重启自动清空；拒绝时不刷新计时（冷却到期时间不变）。
RATE_LIMIT_SEC = 60                    # 标准达成 / 骑手 / 成就 通用窗口
ATTEND_PERIOD_RATE_LIMIT_SEC = 5       # 时段出勤「时段有效 / 骑手明细」实时查询窗口（2026-09-12 用户要求改为 5s）
# 注：原 `REFRESH_ALL_GLOBAL_GAP_SEC`（全量刷新的全局最小间隔）已随 refresh-all 迁到 Nest
# —— 见 backend/src/modules/fetch/refresh-runner.service.ts。
_RATE_STATE = {}                 # key -> 上次放行的服务端时间戳（秒）
_RATE_LOCK = threading.Lock()


def _rate_user_fp(handler):
    """频控的「用户维度」指纹（决定限流桶归属）。

    此前用 _USER_FP（由全局 API_TOKEN 派生）+ IP 作键，而经 compute_api 调用时
    client_address 恒为 127.0.0.1，于是**所有用户共用同一个桶** —— A 刷新完 60s 内
    B 再点就被 429 挡住。这里改为按登录用户名分桶：

      · 网关（compute_api）：取 Nest 下发的 x-user（_GatewayHandler._user）
      · 单体直跑：取会话里的 user
      · 都取不到（未登录 / 匿名）：回落到全局指纹 _USER_FP，保持原行为

    用户名不落盘明文，只取 sha256 前 12 位。
    """
    user = ""
    try:
        user = str(getattr(handler, "_user", "") or "").strip()
    except Exception:
        user = ""
    if not user or user == "gateway":
        try:
            sess = getattr(handler, "session", None) or {}
            user = str(sess.get("user") or "").strip()
        except Exception:
            user = ""
    if user and user != "gateway":
        return "u:" + hashlib.sha256(user.encode("utf-8")).hexdigest()[:12]
    return _USER_FP


def _rate_key(fp, ip, endpoint):
    return "%s|%s|%s" % (fp, ip, endpoint)


def _rate_peek(key, window):
    """只读判断是否放行 —— 不登记时间戳（供多重检查先统一判定）。"""
    now = time.time()
    with _RATE_LOCK:
        last = _RATE_STATE.get(key)
        if last is not None and (now - last) < window:
            return False, int(window - (now - last)) + 1
        return True, 0


def _rate_commit(key):
    with _RATE_LOCK:
        _RATE_STATE[key] = time.time()


def _rate_check(handler, endpoint, window=RATE_LIMIT_SEC):
    """服务端频控：返回 (allowed, retry_after_sec)。

    allowed=True   已登记本次时间戳，调用方继续执行查询；
    allowed=False  retry_after 为还需等待秒数，调用方直接回 429、不执行查询。

    桶维度 = 用户 × IP × 端点（同一账号换 IP 仍是独立桶，防误伤）。
    """
    try:
        ip = (handler.client_address or ("",))[0] or ""
    except Exception:
        ip = ""
    key = _rate_key(_rate_user_fp(handler), ip, endpoint)
    ok, wait = _rate_peek(key, window)
    if ok:
        _rate_commit(key)
    return ok, wait


# 注：原 `_rate_check_multi`（用户桶 + 全局桶双重频控）只被 refresh-all 使用，
# 已随该端点迁到 Nest（refresh-runner.service.ts::rateCheck）。其余 handler 用单桶
# 的 `_rate_check`，仍然保留。


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


# ---------------------------------------------------------------- Cookie 状态探针
# 「实时在线播报」多选站点选择器的内存缓存。键：「data」= 最新响应体；「ts」= 拉取时刻。
# 5 分钟 TTL：弹窗反复开关不重打风神；TTL 到了再走一次 xtop 接口。
_TEAMS_CACHE = {"data": None, "ts": 0}
_TEAMS_CACHE_TTL = 300
def _teams_with_names():
    """全部站点 [(team_id, name)]：优先 /api/teams 的 5 分钟内存缓存，否则读落盘站点目录文件。

    仅供「系统设置 → 参与站点」与「全部站点」合并取数使用；不主动打接口
    （缓存没有就读取盘文件，等 /api/teams 被前端触发过自然就有全量了）。
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
    from analytics import teams_config as TCFG
    return [(tid, name) for tid, name in TCFG.get_team_names().items()]


def _configured_teams():
    """「参与站点」配置 ∩ 已知站点名 → [(team_id, name)]，顺序同配置。"""
    from analytics import teams_config as TCFG
    names = dict(_teams_with_names())
    ids = TCFG.get_teams()
    return [(str(t), names.get(str(t), str(t))) for t in ids]


def _part_teams(month):
    """参与考核的站点 [(team_id, name)]（标准达成设置：某月下【配置了记录的站点】即参与）。

    标准达成看板仅展示这些站点，实现「站点考核按需配置 + 看板联动」。
    """
    from analytics import grade_standards as GS
    from analytics import teams_config as TCFG
    names = dict(_teams_with_names())
    names.update(TCFG.get_team_names())
    out = []
    for tid in GS.graded_team_ids(month):
        out.append((tid, names.get(tid, tid)))
    return out


def _nest_base():
    """NestJS 基址：`NEST_BASE` / `DING_NEST_BASE` → 回落 loopback。

    与 `common/nest_client.nest_base` 同口径。两个服务同机时无需任何配置
    （`NEST_FETCH_URL` 那套推导已随阶段 0 原生化一并废弃）。
    """
    for key in ("NEST_BASE", "DING_NEST_BASE"):
        v = (os.environ.get(key) or "").strip()
        if v:
            return v.rstrip("/")
    return "http://127.0.0.1:8787"


def _fetch_all_teams():
    """全部站点 [{id, name}]：取数已迁 NestJS —— 这里只转发 `GET /api/fetch/teams`。

    为什么不再自己打 xtop：站点目录属于「取数」，按分工归 Nest；且前端 `/api/teams`
    （`backend/src/modules/teams/`）与本函数的两个消费者（`_teams_with_names` /
    `_get_ap_teams`）必须共用**同一份**缓存，否则两侧各存 5 分钟 TTL、各打一次风神。

    保留一层本地 5 分钟缓存（TTL 与 Nest 侧一致）：Nest 短暂不可用时不必每次都打空。
    Nest 整体不可达时退回本地末位兜底清单，绝不让选择器空白。
    """
    now = time.time()
    cached = _TEAMS_CACHE.get("data")
    if cached and (now - _TEAMS_CACHE.get("ts", 0)) < _TEAMS_CACHE_TTL:
        return cached

    out = None
    try:
        # 改走 nest_client：自动带上网关下发的会话令牌（X-Token），在机器令牌缺失/不一致时
        # 也能凭前端登录态通过 Nest 鉴权闸门（原先裸 urllib 只带机器令牌，故一直 401）。
        j = nest_client.get_json("/api/fetch/teams")
        if isinstance(j, dict) and "teams" in j:
            out = j
        else:
            raise RuntimeError("Nest 返回结构异常: " + str(j)[:200])
    except Exception as e:
        out = {"ok": False, "teams": [], "source": "fallback", "stale": False,
               "fetched_at": now,
               "error": "Nest 站点取数不可达: %s: %s" % (type(e).__name__, e)}

    if not out.get("teams") and not out.get("fallback"):
        # Nest 整体不可达时的末位兜底：读上次落盘的站点目录文件（不再硬编码任何清单）。
        from analytics import teams_config as TCFG
        nm = TCFG.get_team_names()
        out["fallback"] = [{"id": tid, "name": name} for tid, name in nm.items()]

    _TEAMS_CACHE["data"] = out
    _TEAMS_CACHE["ts"] = now
    return out


# 注：原 `check_cookie_status` / `_check_aeolus_cookie` / `_check_quark_cookie` 三个登录态
# 探针函数已于 2026-09-23 迁为 NestJS 原生实现，供 `GET /api/cookies/status`：
#   · 风神 validToken 探针 → `backend/src/modules/fetch/cookie-status.service.ts`
#   · Quark DA 缓存 + 探针 → `backend/src/modules/fetch/quark-creds.service.ts`
#     （`probeDetail` 用 curl 的 `%{http_code}` 区分「401/403 硬拒」与「HTML 登录页」，
#       `cacheStatus` 区分「未兑换」与「缓存损坏」）
# 计算进程不再持有登录态探针，也不读写任何凭证缓存 —— 登录态归 Nest。


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


def _get_std_achievement(self, qs):
    from analytics import cache as CACHE
    from analytics import multi_team as MT
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
        from analytics import achievement as AC
        data = (AC.compute(team, start, end) if refresh
                else AC.recompute(team, start, end))
        self._json(data)
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "start": start, "end": end,
                    "source": "error", "rows": [], "summary": None,
                    "attendance": None, "need_refresh": False})


def _get_std_riders(self, qs):
    from analytics import cache as CACHE
    from analytics import multi_team as MT
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
        _part = _part_teams(month)
        _teams = _part if mode == "all" else \
            [(t, n) for (t, n) in _part if t in val]
        self._json(MT.riders_all(_teams, start, end,
                                 time_code=tc, month=month))
        return
    # 单站：未启用考核（该月无配置记录）则看板隐藏（与站点报表一致）
    from analytics import grade_standards as GS
    if str(team) not in GS.graded_team_ids(month):
        self._json({"ok": True, "team": team, "rows": [],
                    "data_status": "not_enabled",
                    "data_note": "该站点未启用考核，已在看板中隐藏",
                    "need_refresh": False})
        return
    if refresh:
        _ok, _wait = _rate_check(self, "riders")
        if not _ok:
            _rate_limited_json(self, "riders", _wait)
            return
    try:
        from analytics import rider_dimension as RD
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
    from analytics import cache as CACHE
    from analytics import multi_team as MT
    team = (qs.get("team") or ["__all__"])[0]
    start = (qs.get("start") or [""])[0] or CACHE.today_ymd()
    end = (qs.get("end") or [""])[0] or CACHE.today_ymd()
    month = (qs.get("month") or [""])[0].strip() or None
    mode, val = self._enforce_team_scope(team)
    if mode == "deny":
        return
    if team == MT.ALL_TEAM_ID:
        try:
            from analytics import station_report as SR
            _part = _part_teams(month)
            _teams = _part if mode == "all" else \
                [(t, n) for (t, n) in _part if t in val]
            payload = SR.build_all(_teams, start, end, month)
            # 隐藏未启用考核的站点（防御性双保险；_part_teams 已过滤）
            payload["rows"] = [r for r in (payload.get("rows") or [])
                              if r.get("data_status") != "not_enabled"]
            # 取数时间：全部站点原始数据最近一次落盘时间（北京时间），用于前端判断是否过期
            payload["data_time"] = CACHE.latest_cache_time_all(start)
            self._json(payload)
        except Exception as e:
            self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                        "team": team, "rows": [], "data_status": "error"})
        return
    try:
        from analytics import station_report as SR
        row = SR.build_one(team, start, end, month, "cache")
        miss = bool(row.get("need_refresh"))
        hidden = (row.get("data_status") == "not_enabled")
        self._json({
            "ok": True,
            "team": team,
            "teamName": row.get("team_name"),
            "start": start, "end": end, "basis": "day",
            "rows": [] if (miss or hidden) else [row],
            "data_status": ("not_enabled" if hidden else ("no_data" if miss else "ok")),
            "data_note": row.get("data_note"),
            "need_refresh": miss,
            "data_time": CACHE.latest_cache_time(team, start),
        })
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "start": start, "end": end,
                    "data_status": "error", "need_refresh": False})


# 注：`/api/standard/refresh-all-status` 已于 2026-09-23 迁为 NestJS 原生端点
# （`backend/src/modules/fetch/refresh.controller.ts` → `RefreshRunnerService.status()`）。
# 全量刷新的**编排**（阶段调度 / 状态机 / 日志 / 单飞 / 频控 / 数据权限收敛）归 Nest；
# **计算**留在本服务，见 compute_api/main.py 的 `/api/compute/{violations,rider-dimension,achievement}`。


# >>>ROUTES_MARKER<<<

# 注：`POST /api/standard/refresh-all` 已于 2026-09-23 迁为 NestJS 原生端点。
# 频控（60s/用户 + 15s 全局间隔）、数据权限收敛（收敛为空必须 403，绝不能把空列表交给
# 编排器 —— 那会回落成全量参与站点，等于越权）、单飞接入，现全在
# `backend/src/modules/fetch/refresh-runner.service.ts::startFromRequest`，
# 并由 `tests/refresh-runner.spec.ts` 覆盖（原 `tests/test_data_scope.py` 的对应用例已随之移除）。


# >>>ROUTES_MARKER<<<

def _get_ap_valid(self, qs):
    from analytics import cache as CACHE
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
            from analytics import attend_period_all as APA
            from analytics import attend_period_teams as APT
            _ids = APT.get_teams() if mode == "all" else \
                [t for t in APT.get_teams() if t in val]
            data = APA.valid_all(_ids, date)
        else:
            from analytics import attend_period as AP
            data = AP.compute_valid(team, date)
        self._json(data)
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "date": date, "rows": [], "summary": None})


def _get_ap_rider_detail(self, qs):
    from analytics import cache as CACHE
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
        from analytics import attend_period_source as APSRC
        if team == "__all__":
            from analytics import attend_period_teams as APT
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
    from analytics import cache as CACHE
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
        from analytics import attend_period_source as APSRC
        if team == "__all__":
            from analytics import attend_period_teams as APT
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
    from analytics import cache as CACHE
    from analytics import attend_period_source as APSRC
    team = (qs.get("team") or ["__all__"])[0]
    date = (qs.get("start") or [""])[0] or CACHE.today_ymd()
    refresh = (qs.get("refresh") or ["0"])[0] == "1"
    mode, val = self._enforce_team_scope(team)
    if mode == "deny":
        return
    ds = None
    if not refresh:
        # 只读缓存（进程内 / 落盘），绝不实时拉取；未命中返回 need_refresh 提示点刷新。
        ds = APSRC.get_dataset(team, date, refresh=False)
        if ds is None:
            self._json({"ok": True, "need_refresh": True, "dataset": None,
                        "team": team, "date": date, "source": "none",
                        "data_note": "请点「刷新数据」拉取实时数据"})
            return
    else:
        _ok, _wait = _rate_check(self, "attend_period", window=ATTEND_PERIOD_RATE_LIMIT_SEC)
        if not _ok:
            _rate_limited_json(self, "attend_period", _wait, window=ATTEND_PERIOD_RATE_LIMIT_SEC)
            return
        if team == "__all__":
            from analytics import attend_period_teams as APT
            _ids = APT.get_teams() if mode == "all" else \
                [t for t in APT.get_teams() if t in val]
            ds = APSRC.get_dataset("__all__", date, refresh=True, teams=_ids)
        else:
            ds = APSRC.get_dataset(team, date, refresh=True)
    if ds is None:
        self._json({"ok": True, "need_refresh": True, "dataset": None,
                    "team": team, "date": date, "source": "none",
                    "data_note": "暂无数据"})
        return
    self._json({"ok": True, "team": ds["team"], "date": ds["date"],
                "fetched_at": ds["fetched_at"], "source": ds["source"],
                "dataset": {"rider_detail": APSRC.to_rider_detail(ds),
                            "station_data": APSRC.to_station_data(ds),
                            "time_period": APSRC.to_time_period(ds)}})


def _get_ap_config(self, qs):
    month = (qs.get("month") or [""])[0] or None
    try:
        from analytics import period_config as PC
        self._json({"ok": True, **PC.load(month)})
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


def _get_ap_months(self, qs):
    try:
        from analytics import period_config as PC
        self._json({"ok": True, **PC.list_months()})
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


def _get_ap_teams(self, qs):
    try:
        from analytics import attend_period_teams as APT
        res = _fetch_all_teams()
        raw = res.get("teams") or res.get("fallback") or []
        # 可见站点集合直接取本次请求的 x-scope（由 compute 的 _GatewayHandler 提供）。
        # 原先靠 session.role + dataperm.allowed_team_ids 兜底查询，现统一收敛到 x-scope。
        _ids = self._visible_ids()
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
    try:
        from analytics import period_config as _PC
        month = data.get("month") or None
        periods = data.get("periods")
        saved = _PC.save(periods, month)
        self._json({"ok": True, **saved})
    except ValueError as e:
        self._json({"ok": False, "error": str(e)}, 400)
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, 400)


def _post_ap_teams(self, data):
    try:
        from analytics import attend_period_teams as APT
        ok, teams, msg = APT.set_teams(data.get("teams"))
        self._json({"ok": ok, "teams": teams, "error": (msg or None)})
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, 400)


# >>>ROUTES_MARKER<<<

# >>>ROUTES_MARKER<<<

# ---------------- 实时数据：站点概览（推配送单量 / 配送完成单） ----------------
# 计算逻辑已迁至 analytics/assessment/board.py；此处仅做站点权限闸门 + 转发。
def _get_assessment_station(self, qs):
    from analytics.assessment import board as RTB
    from analytics import cache as CACHE
    team = (qs.get("team") or [None])[0]
    if not team:
        self._json({"ok": False, "error": "缺少 team 参数"}, 400); return
    mode, val = self._enforce_team_scope(team)
    if mode == "deny":
        return
    try:
        date = CACHE.today_ymd()
        row = RTB.build_one(team, date)
        from analytics.assessment import result_store as RS
        RS.save_result("station", team, date, row)
        miss = bool(row.get("need_refresh"))
        self._json({
            "ok": True,
            "team": team,
            "teamName": row.get("team_name"),
            "start": date, "end": date, "basis": "day",
            "rows": [] if miss else [row],
            # 不能写死 ok：行里可能是 partial（违规明细不可用，运单指标仍有效）。
            "data_status": "no_data" if miss else (row.get("data_status") or "ok"),
            "data_note": row.get("data_note"),
            "need_refresh": miss,
            # 更新时间：考核数据（违规明细 + 运单明细两份全站单文件）最近一次取数/落盘时间；
            # 前端据此展示「更新时间」，刷新页面（仅读盘重算）不跳动，真正重新取数后才更新。
            "fetched_at": RTB.latest_assessment_data_time(date),
        })
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "start": CACHE.today_ymd(), "end": CACHE.today_ymd(),
                    "data_status": "error", "need_refresh": False})


# ---------------- IM 电联看板（电联率 / IM 及时回复率，站点 + 骑手）----------------
# 计算逻辑在独立包 analytics/im_contact/（与 assessment 解耦，零 HTTP 读盘）；
# 此处仅做站点权限闸门 + 转发。落盘数据由 Nest ImContactFetchService 写入
# backend/data/im-contact-实时.json（全站单文件，含日期区间）。
def _get_im_contact(self, qs):
    from analytics.im_contact import board as ICB
    team = (qs.get("team") or [None])[0]
    if not team:
        self._json({"ok": False, "error": "缺少 team 参数"}, 400); return
    mode, val = self._enforce_team_scope(team)
    if mode == "deny":
        return
    try:
        from analytics.im_contact import source as ICS
        st = ICS.fetch_status() or {}
        row = ICB.build_one(team, st.get("start"), st.get("end"))
        miss = bool(row.get("need_refresh"))
        self._json({
            "ok": True,
            "team": team,
            "teamName": row.get("team_name"),
            "start": st.get("start"),
            "end": st.get("end"),
            "basis": "range",
            # 取数时间：落盘文件的 fetched_at（Nest 写入时刻）
            "fetched_at": st.get("fetched_at"),
            "rows": [] if miss else [row],
            "data_status": "no_data" if miss else (row.get("data_status") or "ok"),
            "data_note": row.get("data_note"),
            "need_refresh": miss,
        })
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "data_status": "error", "need_refresh": False})


# ---------------- 配送超时看板（站点超时汇总 + 订单明细）----------------
# 计算逻辑在独立包 analytics/delivery_timeout/timeout.py（与 assessment 解耦）；
# 此处仅做站点权限闸门 + 转发。
def _get_delivery_timeout(self, qs):
    from analytics.delivery_timeout import timeout as RTO
    from analytics import cache as CACHE
    team = (qs.get("team") or [None])[0]
    if not team:
        self._json({"ok": False, "error": "缺少 team 参数"}, 400); return
    mode, val = self._enforce_team_scope(team)
    if mode == "deny":
        return
    try:
        date = CACHE.today_ymd()
        row = RTO.build_one(team, date)
        from analytics.assessment import result_store as RS
        RS.save_result("timeout", team, date, row)
        miss = bool(row.get("need_refresh"))
        self._json({
            "ok": True,
            "team": team,
            "teamName": row.get("team_name"),
            "start": date, "end": date, "basis": "day",
            # 取数时间：原始运单明细最近一次落盘时间（北京时间），即「拉取数据」的时刻
            "fetched_at": CACHE.latest_cache_time(team, date),
            "rows": [] if miss else [row],
            "data_status": "no_data" if miss else (row.get("data_status") or "ok"),
            "data_note": row.get("data_note"),
            "need_refresh": miss,
        })
    except Exception as e:
        self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "team": team, "start": CACHE.today_ymd(), "end": CACHE.today_ymd(),
                    "data_status": "error", "need_refresh": False})


def _get_ov_site_orders(self, qs):
    """数据大屏 —— 站点维度「接单量 / 配送完成量」。

    归属口径：骑手接单时间（acceptAtLast）的北京时间自然日，跨午夜归接单当天；
    数据来自本地运单缓存 backend/data/raw/orders_<team>_<date>.json（口径单一来源 order_rules）。
    默认区间：end（默认今天）往前 7 天。
    """
    import datetime as _dt
    from analytics import cache as CACHE
    from analytics import site_orders as SO
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
    from analytics import cache as CACHE
    date = (qs.get("date") or [""])[0].strip() or CACHE.today_ymd()
    month = (qs.get("month") or [""])[0].strip() or None
    try:
        from analytics import station_report as SR
        payload = SR.build_all(self._scoped_universe(_configured_teams()), date, date, month)
    except Exception as e:
        payload = {"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                   "start": date, "end": date, "rows": []}
    payload["date"] = date
    self._json(payload)


def _get_ov_assessment(self, qs):
    """考核结算大屏 —— 跨源聚合（运力达标 / 大网质量 / 时段出勤 / 历史对比 / 红黄灯）。

    只读 backend/data/raw 三源缓存（与「标准达成」「时段出勤」同源，零口径漂移），
    时段出勤复用 attend_period_source 的进程内数据集缓存（用户未点查询则留空提示）。
    支持 ?date=YYYY-MM-DD（默认今天）与 ?refresh=1（清模块缓存重算）。
    """
    from analytics import cache as CACHE
    date = (qs.get("date") or [""])[0].strip() or CACHE.today_ymd()
    refresh = (qs.get("refresh") or [""])[0].strip() in ("1", "true", "yes")
    try:
        from analytics import assessment_overview as AO
        payload = AO.build_assessment(date, self._scoped_universe(_configured_teams()), refresh=refresh)
    except Exception as e:
        payload = {"ok": False, "error": "%s: %s" % (type(e).__name__, e), "date": date}
    self._json(payload)


GET_ROUTES = {
    "/api/standard/achievement": _get_std_achievement,
    "/api/standard/riders": _get_std_riders,
    "/api/standard/station-report": _get_std_station_report,
    "/api/attend-period/valid": _get_ap_valid,
    "/api/attend-period/rider-detail": _get_ap_rider_detail,
    "/api/attend-period/station-data": _get_ap_station_data,
    "/api/attend-period/dataset": _get_ap_dataset,
    "/api/attend-period/config": _get_ap_config,
    "/api/attend-period/months": _get_ap_months,
    "/api/attend-period/teams": _get_ap_teams,
    "/api/overview/site-orders": _get_ov_site_orders,
    "/api/overview/standard": _get_ov_standard,
    "/api/overview/assessment": _get_ov_assessment,
    "/api/assessment/station":    _get_assessment_station,
    "/api/delivery-timeout/data": _get_delivery_timeout,
    "/api/im-contact/data":       _get_im_contact,
}

POST_ROUTES = {
    "/api/attend-period/config": _post_ap_config,
    "/api/attend-period/teams": _post_ap_teams,
}
