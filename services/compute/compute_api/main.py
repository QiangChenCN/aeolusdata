"""
AeolusData 独立计算服务（§6「Python 生态独占端点」的 FastAPI 落地）。

设计要点：
- 本服务**不做鉴权**：NestJS 是唯一的鉴权网关（RBAC + 数据权限），它把已经算好的
  数据权限范围通过请求头 `x-scope` 下发，本服务只负责「用 Python 算」。
- 复用项目既有 Python 模块（sources.*（转发层）/ analytics.* + common.nest_client）。
- 计算 handler 库是同包的 `handlers.py`（原根目录 `server.py` 的计算子集：
  命名空间 handler + Cookie 探针 / 站点缓存 / 路径守卫 / 表格解析 / 频控）。
  历史：曾 `import server as _monolith` 桥接根目录单体；该单体已删除，
  其计算子集已按依赖闭包精确迁入本包，故本服务已彻底脱离 server.py。
- 端点路径与 Nest 代理转发的 `req.url` 严格对齐（含 /api 前缀），响应体形状与 server.py
  保持一致（扁平 JSON：{ok, ...}），Nest 侧会原样透传给前端。

启动（在 python/ 目录下）：
  # 生产/常驻（多 worker，绕过 GIL 扛并发）：
  .venv\Scripts\python.exe -m gunicorn -k uvicorn.workers.UvicornWorker -w 4 \
      --bind 127.0.0.1:8900 compute_api.main:app
  # 开发/单进程调试（等价旧 uvicorn 单 worker）：
  .venv\Scripts\python.exe -m uvicorn compute_api.main:app --host 127.0.0.1 --port 8900
"""
import os

# >>> python-home bootstrap (added by layout migration) >>>
import os as _os
import sys as _sys

def _find_python_home():
    d = _os.path.dirname(_os.path.abspath(__file__))
    # 计算服务代码根：同时含 analytics/ 与 compute_api/ 子目录
    while d and not (
        _os.path.isdir(_os.path.join(d, "analytics"))
        and _os.path.isdir(_os.path.join(d, "compute_api"))
    ):
        d = _os.path.dirname(d)
    return d

def _find_repo_root():
    d = _os.path.dirname(_os.path.abspath(__file__))
    # 仓库根：含 .git 或根 package.json
    while d and d != _os.path.dirname(d) and not (
        _os.path.exists(_os.path.join(d, ".git"))
        or _os.path.exists(_os.path.join(d, "package.json"))
    ):
        d = _os.path.dirname(d)
    return d

PY_HOME = _find_python_home()
ROOT = _find_repo_root()
_ROOT = ROOT
if PY_HOME and PY_HOME not in _sys.path:
    _sys.path.insert(0, PY_HOME)
# <<< python-home bootstrap <<<


import sys
import json
import time
from pathlib import Path

# ---- 把项目根加入 sys.path ----
# 只加 ROOT：sources / analytics / common / workbench / tools 都是 ROOT 下的顶层包，
# 经 ROOT 即可正确解析。
# 注意：切勿把 `analytics` 或 `sources` 目录单独加进 sys.path —— 那会让同一个包被解析成
# 两个不同的模块对象（模块级状态各存一份、isinstance 判定失败）。
# （历史坑：旧结构有根 get_data/ 与 dashboard/get_data/ 两个同名包，sys.path 顺序会让裸
#   import 命中嵌套那个、拿到不完整的成员。2026-09-24 已把嵌套门面合并进 sources/ 并改名，
#  同名包冲突不复存在 —— 请勿再把任何包目录单独塞进 sys.path 把它变回来。）
ROOT = str(Path(__file__).resolve().parent.parent)  # e:/Code/aeolusdata
for _d in [
    ROOT,
    os.path.join(PY_HOME, "workbench"),
    os.path.join(PY_HOME, "common"),
    os.path.join(PY_HOME, "tools"),
]:
    if _d not in sys.path:
        sys.path.insert(0, _d)

# 计算 handler 库：同包内的 handlers.py（原根目录 server.py 的计算子集）。
# 本目录也放进 sys.path，以兼容 `python compute_api/main.py` 这类启动方式。
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
import handlers as _h  # noqa: E402  （需在 sys.path 就绪后导入）
import common.nest_client as nest_client  # noqa: E402  （会话令牌透传给 Nest 鉴权）

# ---- OpenTelemetry 插桩（默认关闭；OTEL_ENABLED=true 时才真正 import opentelemetry）----
# 放在 sys.path 就绪之后，用 `import otel`（与 handlers 同风格）定位 compute_api/otel.py。
import otel as _otel
_otel.setup_tracing()

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.concurrency import run_in_threadpool

app = FastAPI(title="AeolusData Compute Service", version="0.1.0")

# OTel：在路由定义后挂接（仍早于请求处理）；OTEL_ENABLED=false 时为 no-op。
_otel.instrument_app(app)

# 本服务只接受来自 Nest 的环回调用；CORS 放开仅兜底，不依赖它。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "service": "compute", "time": int(time.time())}


# 注：`/api/cookies/status` 与 `/api/teams` 已于 2026-09-23 迁为 NestJS 原生端点
# （`backend/src/modules/status/` 与 `backend/src/modules/teams/`）—— 二者都是「取数 / 登录态」，
# 不属于大数据计算，按分工原则归 Nest。本服务不再提供这两个端点。


@app.get("/api/sheet")
def sheet(path: str = ""):
    """把 xlsx/xls 解析成 {sheets:[{name, headers, rows}]}（与 server.py 同语义）。"""
    if not path:
        return {"ok": False, "error": "缺少 path"}
    target = _h._safe_resolve(path)
    if target is None:
        return {"ok": False, "error": "非法路径或受限文件"}
    if not os.path.isfile(target):
        return {"ok": False, "error": "文件不存在"}
    try:
        data, err = _h.sheet_to_json(target)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "解析失败：%s" % e}
    if err:
        return {"ok": False, "error": err}
    return {"ok": True, "file": os.path.basename(target), **data}


# /api/groups 已由 NestJS 的 GroupsModule 原生实现（不再经本服务，也不依赖 group_picker）。
# 本服务只保留「只算、不鉴权」的计算端点。


# ---------------------------------------------------------------------------
# 命名空间计算端点（standard / attend-period / overview …）统一经 handlers.py 派发表转发。
#
# 设计：本服务不重抄这些端点逻辑，而是复用 handlers.GET_ROUTES / POST_ROUTES 派发表 +
# 各 handler 函数（它们最终调用 analytics.* 纯计算）。这样返回结构与迁移前
# 100% 一致（已用源码逐字符比对校验），且本服务仍是「只算、不鉴权」——
# 数据权限由传入的 x-scope 经以下两处落地：
#   1) _GatewayHandler._enforce_team_scope / _scoped_universe  —— 用 x-scope 决定 all/scoped/one；
#   2) _GatewayHandler._visible_ids()                          —— 用 x-scope 给出「本次可见站点
#      id 集合」，供直接需要集合的处理器（_get_ap_teams）使用。
# Nest 是唯一鉴权网关，它已按 RBAC + 数据权限算好 x-scope 下发。
#
# 原先这里用猴子补丁把 core.dataperm.allowed_team_ids 在 role=="gateway" 时重定向到 x-scope
# （经线程局部 _SCOPE 传递）。那条兜底路径连同 core/dataperm.py 已删除：本进程不再读
# .data_perms.json，可见性一律由 x-scope 决定 —— 少一层间接，也消除「Python 与 Nest 两份
# 数据权限规则不一致」的可能。
# ---------------------------------------------------------------------------


class _GatewayHandler:
    """handlers.py 中 handler 的轻量替身：捕获 _json 输出，并按 x-scope 实现数据权限裁决。

    仅实现命名空间处理器实际用到的 self 能力：_json / _enforce_team_scope /
    _scoped_universe / session / client_address。其余 handler 用不到。
    """

    def __init__(self, scope, user):
        self._scope = "*" if scope in ("*", None) else scope
        self._user = user
        # 身份仅用于归属/日志（如 targets 的 updated_by、selection 的按用户存储）；
        # 权限一律由 x-scope 裁决，不依赖 role（role 恒为 gateway，不代表任何权限含义）。
        self.session = {"role": "gateway", "user": user or "gateway"}
        self.client_address = ("127.0.0.1", 0)
        self._result = None  # (status_code, obj)

    def _json(self, obj, code=200):
        self._result = (code, obj)

    def _enforce_team_scope(self, requested_team):
        scope = self._scope
        if scope == "*":
            return ("all", None) if requested_team == "__all__" else ("one", requested_team)
        ids = set(str(i) for i in scope)
        if requested_team == "__all__":
            return ("scoped", ids)
        if str(requested_team) in ids:
            return ("one", requested_team)
        self._json({"ok": False, "error": "无权访问该站点数据", "code": "DATA_SCOPE_DENIED"}, 403)
        return ("deny", None)

    def _scoped_universe(self, universe):
        scope = self._scope
        if scope == "*":
            return list(universe)
        ids = set(str(i) for i in scope)
        return [t for t in universe if str(t[0]) in ids]

    def _visible_ids(self):
        """本次请求可见的站点 id 集合；None 表示不受限（x-scope=*）。

        供需要「可见 id 集合」的处理器使用（_get_ap_teams）。
        返回值语义与原先的 dataperm.allowed_team_ids 一致：None = 全可见，否则为 id 集合。
        """
        if self._scope == "*":
            return None
        return set(str(i) for i in self._scope)


def _parse_scope(header_val):
    if not header_val or header_val in ("*", ""):
        return "*"
    try:
        v = json.loads(header_val)
        return v if isinstance(v, list) else "*"
    except Exception:
        return "*"


@app.post("/api/cache/invalidate")
async def cache_invalidate(req: Request):
    """NestJS 写原始层后回调：失效本进程的**结果缓存**。

    背景：取数已迁到 NestJS，它会直接写 apps/api/runtime/raw/{kind}_{team}_{date}.json；
    而 Python 的进程内结果缓存（cache._RESULT_CACHE）只在**自己**调 save_raw 时才失效。
    不通知的话，Nest 刷新完 Python 仍返回旧聚合结果 —— 表现为「刷新了但看板数字没变」，
    且全程不报错（2026-09-23 排查过：同类缓存未失效的问题定位成本极高）。

    这条端点不能被删除，它是「Nest 写盘」与「Python 重算」之间唯一的显式接缝。
    Nest 侧已把调用下沉为**写入后的默认行为**（RawCacheService.saveRaw 的 notify 默认
    true），唯一豁免是 /api/cache/raw —— 那份 payload 由 Python 自己发出、已同进程失效。

    本端点保持「Python 只算、不鉴权」（仅环回调用，服务只监听 127.0.0.1）。
    """
    try:
        data = await req.json()
    except Exception:
        data = {}
    try:
        from analytics.core import cache as CACHE
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": "cache 模块导入失败：%s" % e}, 500)

    if data.get("all"):
        CACHE.clear_results()
        return {"ok": True, "cleared": "all"}

    teams = data.get("teams") or ([data["team"]] if data.get("team") else [])
    date = str(data.get("date") or "").strip()
    if not teams or not date:
        return JSONResponse({"ok": False, "error": "缺少 teams 或 date"}, 400)
    for t in teams:
        CACHE.invalidate_results(str(t), date)
    return {"ok": True, "invalidated": {"teams": [str(t) for t in teams], "date": date}}


# ---------------------------------------------------------------------------
# 全量刷新的「计算步」端点（供 NestJS 编排层调用）
#
# 分工（ADR：「Python 只做大数据计算」）：全量刷新的**编排**（阶段调度 / 状态机 / 日志 /
# 频控 / 数据权限收敛 / 单飞）已迁 NestJS（`backend/src/modules/fetch/refresh-runner.service.ts`
# + `refresh.controller.ts`）。这里只保留**计算**本身 ——
# 取数（`sources/*` 现为转发层）与落盘（`cache.save_raw` 转发 Nest）都不在这里。
#
# 原先这里还写结果层缓存（`analytics/cache/{rider,ach}_*.json`）：迁移时核实
# 全仓**无任何读取方**（Python 无 `CACHE.load(` 调用，前端与 Nest 也不读），是 write-only
# 死物，已随 `cache.save()` 一并删除 —— 于是「落盘格式」不再有 Python 侧的分支。
#
# 三个端点的「失败」语义与迁移前 `analytics/refresh_all.py` 逐字一致。
# ---------------------------------------------------------------------------


async def _json_body(req):
    try:
        return await req.json()
    except Exception:  # noqa: BLE001
        return {}


def _refresh_failed(res):
    """结果 dict 是否算失败（compute 内部异常会返回 source=error 的空结构）。

    与迁移前 `refresh_all._failed` 逐字一致 —— 这几条判定都对应过真实事故，别改。
    """
    if not isinstance(res, dict):
        return True, "返回结构异常"
    if res.get("source") == "error" or res.get("error"):
        return True, str(res.get("error") or "未知错误")
    if res.get("need_refresh"):
        return True, "落盘数据缺失（拉取未写入）"
    return False, ""


@app.post("/api/compute/rider-dimension")
async def compute_rider_dimension(req: Request):
    """单站骑手维度：拉考勤（经 Nest）+ 复用运单 → 返回骑手结果。

    不再写结果层缓存（已删除，无读取方）；原始层落盘由 `cache.save_raw` 转发 Nest。

    返回 `order_counts`（`order_stats.valid_by_date`）供下一步站点维度复用，
    与迁移前 `refresh_all._run` 里的 `rd.get("order_stats", {}).get("valid_by_date")` 一致。
    """
    data = await _json_body(req)
    team = str(data.get("team") or "").strip()
    start = str(data.get("start") or "").strip()
    end = str(data.get("end") or start).strip()
    if not team or not start:
        return JSONResponse({"ok": False, "error": "缺少 team 或 start"}, 400)

    def _do():
        from analytics.domains.standard import rider_dimension as RD
        rd = RD.compute(team, time_code=data.get("time_code"), start=start, end=end,
                        month=data.get("month"),
                        reuse_orders=bool(data.get("reuse_orders")))
        bad, why = _refresh_failed(rd)
        if bad:
            return {"ok": False, "error": "骑手维度：%s" % why,
                    "source": rd.get("source") if isinstance(rd, dict) else None}
        return {"ok": True, "error": None, "source": rd.get("source"),
                "rows": len(rd.get("rows") or []),
                "order_counts": (rd.get("order_stats") or {}).get("valid_by_date")}

    return await run_in_threadpool(_do)


@app.post("/api/compute/achievement")
async def compute_achievement(req: Request):
    """单站站点维度：拉排班（经 Nest）+ 复用运单/考勤 → 返回站点结果。

    不再写结果层缓存（已删除，无读取方）；原始层落盘由 `cache.save_raw` 转发 Nest。
    """
    data = await _json_body(req)
    team = str(data.get("team") or "").strip()
    start = str(data.get("start") or "").strip()
    end = str(data.get("end") or start).strip()
    if not team or not start:
        return JSONResponse({"ok": False, "error": "缺少 team 或 start"}, 400)

    def _do():
        from analytics.domains.standard import achievement as AC
        ac = AC.compute(team, start, end,
                        reuse_orders=bool(data.get("reuse_orders")),
                        reuse_att=bool(data.get("reuse_att", True)),
                        reuse_order_counts=data.get("reuse_order_counts"))
        bad, why = _refresh_failed(ac)
        if bad:
            return {"ok": False, "error": "站点维度：%s" % why,
                    "source": ac.get("source") if isinstance(ac, dict) else None}
        return {"ok": True, "error": None, "source": ac.get("source")}

    return await run_in_threadpool(_do)


@app.api_route("/api/{full_path:path}", methods=["GET", "POST", "OPTIONS"])
async def _namespace_catch_all(request: Request):
    if request.method == "OPTIONS":
        return Response(
            status_code=204,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "*",
            },
        )

    raw_path = request.url.path  # 如 /api/standard/station-report
    scope = _parse_scope(request.headers.get("x-scope"))
    user = request.headers.get("x-user") or ""

    if request.method == "POST":
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            data = {}
        table = _h.POST_ROUTES
        args = (data,)
    else:
        # handler 期望 parse_qs 风格的「键→[值]」字典（取 [0]）。
        qs = {k: request.query_params.getlist(k) for k in request.query_params}
        table = _h.GET_ROUTES
        args = (qs,)

    fn = table.get(raw_path)
    if fn is None:
        return JSONResponse(
            {"ok": False, "error": "not found", "path": raw_path}, status_code=404
        )

    h = _GatewayHandler(scope, user)

    # 把前端已登录的会话令牌（X-Token）透传给 Nest —— 即便 machine 令牌缺失/不一致，
    # 只要前端已登录，Nest 的 AccessGuard 也会经由「有效会话」放行取数。
    def _run(fn_, h_, args_, token_):
        nest_client.set_session_token(token_)
        fn_(h_, *args_)

    try:
        await run_in_threadpool(_run, fn, h, args, request.headers.get("x-token"))
    except Exception as e:  # noqa: BLE001
        return JSONResponse(
            {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, status_code=500
        )

    if h._result is None:
        return JSONResponse({"ok": False, "error": "no response"}, status_code=500)
    code, obj = h._result
    return JSONResponse(obj, status_code=code)


if __name__ == "__main__":
    import uvicorn

    # 直接 `python -m compute_api.main` 跑的是单进程调试态；生产请用 gunicorn 多 worker（见顶部注释）。
    uvicorn.run(app, host="127.0.0.1", port=8900, workers=4)
