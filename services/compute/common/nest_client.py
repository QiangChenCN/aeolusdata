# -*- coding: utf-8 -*-
"""Python 侧调用 NestJS 的共享 HTTP 客户端（两类用途）。

一、钉钉协议（`apps/api/src/modules/dingtalk`）
    官方 dws CLI、群解析、在线表读写、消息发送全部由 Nest 实现；Python 不 spawn dws、
    不拼命令行、不解析群 ID —— 需要群发 / 写表时把「群名 + 文本」交给 Nest。

二、取数回调（`apps/api/src/modules/fetch`，ADR 修订 1）
    打风神接口的**取数**已整体迁到 Nest（分页 / 反爬节奏 / 限流退避 / 会话重登）。
    Python 的 `sources/*` 现在是转发层：用 `post_json` 把参数交给 Nest 的 `/api/fetch/*`，
    再把原始数据结构交回上层计算。`sources/_http.py` 在此之上加了「会话失效 → AuthError」
    的判定；重登已归 Nest 独占，Python 不再触发重登。

两者的错误口径不同，故有两套封装：
  · `_post` / `_get`（钉钉）：面向「成功即用」的业务调用，HTTP ≥400 或 ok=false 直接抛。
  · `post_json` / `get_json`（取数）：**不抛 HTTP 错误**，把响应体原样交回调用方判定
    （需要区分「会话失效 → 重登」与「服务错误 → 上报」）。
"""
import json
import os

from analytics.core.paths import ROOT, PY_HOME, _ROOT  # noqa: E402,F401 <<<


import urllib.error
import urllib.parse
import urllib.request


def nest_base():
    """NestJS 基址：`NEST_BASE` → `DING_NEST_BASE` → loopback（两服务同机时无需配置）。"""
    for key in ("NEST_BASE", "DING_NEST_BASE"):
        v = (os.environ.get(key) or "").strip()
        if v:
            return v.rstrip("/")
    return "http://127.0.0.1:8787"


# 兼容既有引用（原先只有这一个基址常量）。
DING_NEST_BASE = nest_base()


def _backend_auth_token():
    """机器令牌兜底：未显式设置 NEST_AUTH_TOKEN 时，复用后端（Nest）的 AUTH_TOKEN。

    与 Nest 侧 task-runner 的回退口径一致（未配置 NEST_AUTH_TOKEN 时用 AUTH_TOKEN 兜底），
    避免 compute_api 单独启动时因缺令牌被 AccessGuard 判 401、导致所有「取数」接口静默失败。
    """
    t = (os.environ.get("NEST_AUTH_TOKEN") or "").strip()
    if t:
        return t
    # 尝试从仓库根 .env 读取 AUTH_TOKEN（与 Nest 共用同一机器令牌；单一配置来源）。
    env_path = os.path.join(ROOT, ".env")
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("AUTH_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return ""


# 会话令牌（前端已登录的 X-Token）：由 compute_api 网关在每次请求时写入（进程级，所有线程可读）。
# 之所以用进程级变量而非线程局部：analytics 的并发考勤拉取会在内部再开 ThreadPoolExecutor，
# 线程局部无法传播到内层工作线程，会导致那些线程不带令牌而被 Nest 401 拒绝。
# 该令牌仅用于让 Nest 的 AccessGuard 放行「有效会话」，不携带数据权限（取数走 Nest 共享风神 cookie），
# 故并发请求间偶发读到彼此的有效令牌不会造成鉴权失败。
_SESSION_TOKEN = {"value": None}


def set_session_token(t):
    _SESSION_TOKEN["value"] = str(t) if t else None


def _session_token():
    return _SESSION_TOKEN["value"] or None


def _headers():
    h = {"Content-Type": "application/json"}
    st = _session_token()
    if st:
        h["X-Token"] = st
    mt = _backend_auth_token()
    if mt:
        h["Authorization"] = "Bearer " + mt
    return h


def _read(req, path, timeout):
    """发请求拿 (http_status, text)。

    **不抛 HTTPError** —— 4xx/5xx 也把正文读回来，交由调用方判定；只有「连不上」才抛。
    """
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception:
            raise RuntimeError("NestJS 调用失败 %s HTTP %s" % (path, e.code))
    except urllib.error.URLError as e:
        raise RuntimeError("无法连接 NestJS (%s): %s" % (nest_base(), e.reason))


# ---------------------------------------------------------------- 一、钉钉（成功即用）
def _post(path, payload=None):
    url = nest_base() + path
    data = json.dumps(payload or {}).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=_headers(), method="POST")
    return _do(req, path)


def _get(path, params=None):
    url = nest_base() + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=_headers(), method="GET")
    return _do(req, path)


def _do(req, path):
    code, body = _read(req, path, 120)
    if code >= 400:
        raise RuntimeError("NestJS 调用失败 %s %s: %s" % (path, code, body[:300]))
    return _unwrap(json.loads(body))


def _unwrap(j):
    if isinstance(j, dict) and j.get("ok") is False:
        raise RuntimeError("NestJS 返回失败: " + str(j.get("error") or j.get("message")))
    return j.get("data") if isinstance(j, dict) else j


def send_message(group, text, at_open_dingtalk_ids=None, dry_run=False):
    p = {"group": group, "text": text, "dryRun": bool(dry_run)}
    if at_open_dingtalk_ids:
        p["atOpenDingTalkIds"] = list(at_open_dingtalk_ids)
    return _post("/api/ding/send-message", p)


def send_file(group, file, dry_run=False):
    p = {"group": group, "file": file, "dryRun": bool(dry_run)}
    return _post("/api/ding/send-file", p)


def list_groups():
    return _get("/api/ding/groups")


def search_groups(q, limit=20):
    return _get("/api/ding/search-groups", {"q": q, "limit": str(limit)})


def get_group_by_number(n):
    return _get("/api/ding/group", {"number": str(n)})


def resolve_group(name):
    r = _get("/api/ding/resolve-group", {"name": name})
    return r.get("openConversationId"), r.get("title")


def sheet_read(node, sheet_id, range_):
    return _post("/api/ding/sheet/read", {"node": node, "sheetId": sheet_id, "range": range_})


def sheet_update(node, sheet_id, range_, values, dry_run=False):
    return _post(
        "/api/ding/sheet/update",
        {
            "node": node,
            "sheetId": sheet_id,
            "range": range_,
            "values": values,
            "dryRun": bool(dry_run),
        },
    )


# ---------------------------------------------------------------- 二、取数回调（交回判定）
def _json_or_error(code, body):
    try:
        return json.loads(body)
    except Exception:
        return {"ok": False, "code": str(code),
                "error": "NestJS 返回非 JSON: %s" % body[:200]}


def post_json(path, payload=None, timeout=120):
    """POST JSON 到 Nest，返回**完整响应体**（形如 `{ok, ...}` / `{ok:false, code, error}`）。

    刻意不抛 HTTP 错误：取数回调需要拿 `code` 判定「会话失效」还是「服务错误」。
    """
    url = nest_base() + path
    data = json.dumps(payload or {}).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=_headers(), method="POST")
    return _json_or_error(*_read(req, path, timeout))


def get_json(path, params=None, timeout=120):
    """GET 并返回完整响应体（同 `post_json` 的错误口径）。"""
    url = nest_base() + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=_headers(), method="GET")
    return _json_or_error(*_read(req, path, timeout))
