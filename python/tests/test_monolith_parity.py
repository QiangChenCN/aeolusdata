# -*- coding: utf-8 -*-
"""单体(server.py) vs NestJS 行为对等性回归。

【当前状态：已不可运行，保留作历史记录】
8917 单体的 HTTP 服务外壳（server.py 的 class Handler / _serve_static_get /
main / __main__）已随迁移完成移除 —— 单体无法再启动，因此本文件**跑不起来**：
默认 skip；即便设 AEOLUS_PARITY=1，也会因两端登录失败而 skip。

补：`server.py` 本体也已删除（其计算子集按依赖闭包迁入
`compute_api/handlers.py`，工作台职责归 NestJS）。本文件被引用到的
GET_ROUTES / POST_ROUTES 已改为从 `compute_api.handlers` 取，仅保证
模块可解析；比对能力本身不再具备（8917 永久下线）。

保留它的理由：
  · 记录了迁移期的比对口径、禁发清单与已登记差异，有参考价值
  · 若将来要重新启用单体做比对，可从版本历史取回 server.py 的 HTTP 外壳

确认不再需要后可整体删除 —— 注意**本文件尚未纳入版本控制（untracked），
删除即不可恢复**，建议先提交或另存。

为什么需要它
------------
迁移期最危险的不是「路由 404」，而是**路由在、返回 200、但行为不对**。
本文件之前靠临时脚本抓到过这些（现已修复）：

  · /api/data-perms   Nest 返回嵌套 org，前端按扁平字段读 → 整页拿不到数据
  · /api/admin/roles  缺 all_perms → 权限勾选框全空
  · /api/state        缺 current_lines / last / queued_ids → 日志与上次运行静默缺失
  · /api/download     Nest 返回 JSON，前端直接跳转期望纯文本
  · runLog 不回读磁盘 → 重启后历史日志一律取不到

这些**单侧测试和路由扫描都测不出来** —— 两侧各自都能通过自己的检查，
只有把它们放在一起比对才暴露。

怎么跑
------
依赖单体在 8917、Nest 在 8787 同时运行，因此**默认 skip**（CI 不依赖单体）：

    AEOLUS_PARITY=1 .venv/Scripts/python.exe -m pytest tests/test_monolith_parity.py -q

可选环境变量：
    AEOLUS_PARITY_NEST / AEOLUS_PARITY_MONO   覆盖两端基址
    AEOLUS_PARITY_USER / AEOLUS_PARITY_PASS   覆盖管理员凭据

已知差异怎么处置
----------------
必须**显式登记在下面的 ACCEPTED_* 表里并写明理由**，而不是静默放过 ——
登记表是本测试的一部分，新增条目应当被评审。任何**未登记**的新差异都会让测试变红。

范围
----
GET：全量比对（36 条，跳过 SSE）。

POST：用「空载荷 {}」探测**校验拒绝行为** —— 期待两端都拒绝（400/ok:false）。
若某一端接受了空载荷，本身就是危险信号（可能把配置清空），会被比对判为差异。
因为 POST 天然有副作用，加了三重保护：
  1) NEVER_SEND：外部副作用且不可撤销（启动刷新 / 跑任务 / 停止 / 触发提醒）一律不发
  2) 状态快照：比对前后对所有可写状态文件取哈希，一旦变化即判定该端点不可自动比对
  3) 自动还原：变化了就把文件从备份还原，避免留下被写坏的配置
"""
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
import json
import time
import shutil
import hashlib
import tempfile
import urllib.request
import urllib.error
import urllib.parse

import pytest
NEST = os.environ.get("AEOLUS_PARITY_NEST", "http://127.0.0.1:8787")
MONO = os.environ.get("AEOLUS_PARITY_MONO", "http://127.0.0.1:8917")
USER = os.environ.get("AEOLUS_PARITY_USER", "admin")
PASS = os.environ.get("AEOLUS_PARITY_PASS", "admin123")

pytestmark = pytest.mark.skipif(
    os.environ.get("AEOLUS_PARITY") != "1",
    reason="需要单体(8917)与 Nest(8787)同时运行；设 AEOLUS_PARITY=1 启用")

# ---------------------------------------------------------------- 已知差异登记表
# 时间戳 / 运行时长等每次请求都不同，不参与取值比对
VOLATILE = {
    "server_time", "generated_at", "fetched_at", "elapsed_sec", "checked_at",
    "timestamp", "now", "updated_at", "started_at", "age_hours", "expires_in",
    "ts", "mtime", "last_seen",
}
# SSE 长连接，不适用一次性比对
SKIP_ROUTES = {"/api/events"}
# 只比字段集合、不比内容：两套进程各自维护运行记录，内容天然不同
CONTENT_EXEMPT = {"/api/state": {"history", "last"}}
# 允许 Nest 缺某些字段（写明理由）
ACCEPTED_MISSING_FIELDS = {
    # 前端只读 policy.min_length / max_length 等，从不读 defaults
    "/api/policy": {"defaults"},
}
# 允许某些标量字段取值不同（写明理由）
ACCEPTED_VALUE_DIFF = {
    # Nest 尚未回填缓存时间，属缓存元数据，前端不消费
    "/api/standard/achievement": {"cache_time"},
}
# 允许状态码落在集合内的差异（写明理由）
ACCEPTED_STATUS = {
    # 缺 path 参数时 Nest 200 / 单体 400；前端总是带 path 调用，不消费该分支
    "/api/sheet": {200, 400},
}

# ---------------------------------------------------------------- POST 防护
# 外部副作用且不可撤销：**绝不发送**（发一次就是真跑一次刷新/任务）
POST_NEVER_SEND = {
    # —— 外部副作用、不可撤销 ——
    "/api/standard/refresh-all": "会启动真实全量刷新（耗时数分钟、消耗接口额度）",
    "/api/run": "会真实启动任务",
    "/api/stop": "无参即生效，会停掉当前任务",
    "/api/cron/trigger": "会真实触发提醒任务",
}
# 可写状态文件：POST 探测前后比对哈希，变了就说明该端点会真写入
STATE_FILES = [
    "backend/data/.data_perms.json", "backend/data/.pwpolicy.json",
    "backend/data/.roles.json", "backend/data/.users.json", "backend/data/org_tree.json",
    "analytics/attend_period_teams.json",
    "python/dashboard/standard/standard_grade_settings.json",
    "backend/data/cron.db",
]
# 可用「文件复制」安全还原的：只有 JSON 配置。
#
# SQLite（cron.db）**绝不能**用文件复制还原：Nest 与单体两个进程常态持有它，
# 且运行在 WAL 模式。实测后果：替换活库 -> disk I/O error 数据库损坏，
# 并把单体进程一起拖崩（RemoteDisconnected）。
# SQLite 的清理一律走 API 删除；万一有残留，只报错、不还原。
STATE_RESTORABLE = [f for f in STATE_FILES if f.endswith(".json")]
# Nest 的 @Post 默认返回 201；单体对成功返回 200、对校验失败返回 400。
# 这是**系统性**差异（与当初给 /api/auth/signin 加 @HttpCode(200) 同源）。
# 前端除登录外都按 body.ok 判定（api.js:182 是唯一比较 status===200 处，已修正），
# 故仅在「两端 ok 一致」时接受状态码差异；一端接受一端拒绝仍会报错。
POST_STATUS_NOTE = "Nest @Post 默认 201 vs 单体 200/400；前端按 body.ok 判定，无功能影响"


# ---------------------------------------------------------------- HTTP 辅助
def _open(base, path, token=None, head=False, timeout=45, method="GET", body=None):
    """Nest 用 X-Token 头；单体用 ?token= 查询参数。"""
    p, headers, data = path, {}, None
    if token:
        if head:
            headers["X-Token"] = token
        else:
            p += ("&" if "?" in path else "?") + "token=" + urllib.parse.quote(token)
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + p, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "ignore"), \
                resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore"), \
            e.headers.get("Content-Type", "")
    except Exception as e:                      # 超时等
        return 0, "", type(e).__name__


def _post(base, path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, resp.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")


def _login():
    sn, bn = _post(NEST, "/api/auth/signin", {"username": USER, "password": PASS})
    sm, bm = _post(MONO, "/api/auth/login", {"username": USER, "password": PASS})
    if sn != 200 or sm != 200:
        pytest.skip("两端登录失败（Nest=%s 单体=%s）：确认 8787 / 8917 都在运行"
                    % (sn, sm))
    return json.loads(bn)["token"], json.loads(bm)["token"]


def _diff(path, nest, mono):
    """返回差异描述列表；空列表表示一致。nest/mono = (status, body, ctype)。"""
    issues = []
    sn, bn, cn = nest
    sm, bm, cm = mono

    if sn != sm and not (path in ACCEPTED_STATUS and {sn, sm} <= ACCEPTED_STATUS[path]):
        issues.append("状态码不同 Nest=%s 单体=%s" % (sn, sm))

    jn, is_json_n = _parse(bn)
    jm, is_json_m = _parse(bm)
    if is_json_n != is_json_m:
        issues.append("响应格式不同 Nest=%s 单体=%s" % (cn or "-", cm or "-"))
        return issues
    if not is_json_n:
        # 非 JSON（如 /api/download 的纯文本）：比状态码与正文
        if bn != bm:
            issues.append("正文不同 Nest=%r 单体=%r" % (bn[:60], bm[:60]))
        return issues

    if not (isinstance(jn, dict) and isinstance(jm, dict)):
        if type(jn) is not type(jm) or jn != jm:
            issues.append("响应体不同 Nest=%s 单体=%s" % (
                json.dumps(jn, ensure_ascii=False)[:60],
                json.dumps(jm, ensure_ascii=False)[:60]))
        return issues

    exempt = CONTENT_EXEMPT.get(path, set())
    allowed_missing = ACCEPTED_MISSING_FIELDS.get(path, set())
    allowed_values = ACCEPTED_VALUE_DIFF.get(path, set())

    kn, km = set(jn), set(jm)
    missing = sorted((km - kn) - allowed_missing)
    extra = sorted(kn - km)
    if missing:
        issues.append("Nest 缺字段 %s" % ",".join(missing))
    if extra:
        issues.append("Nest 多字段 %s" % ",".join(extra))

    for k in sorted(kn & km):
        if k in exempt or k in VOLATILE or k in allowed_values:
            continue
        va, vb = jn[k], jm[k]
        if isinstance(va, (dict, list)) or isinstance(vb, (dict, list)):
            continue
        if va != vb:
            issues.append("值不同 %s: Nest=%s 单体=%s" % (k, str(va)[:50], str(vb)[:50]))

    if ("rows" not in exempt and isinstance(jn.get("rows"), list)
            and isinstance(jm.get("rows"), list)
            and len(jn["rows"]) != len(jm["rows"])):
        issues.append("rows 条数不同 %d vs %d" % (len(jn["rows"]), len(jm["rows"])))

    # 内容豁免字段仍要比「键集合」（例如 last 应覆盖同样的任务）
    for k in exempt:
        if isinstance(jn.get(k), dict) and isinstance(jm.get(k), dict):
            if sorted(jn[k]) != sorted(jm[k]):
                issues.append("%s 键集合不同" % k)
    return issues


def _parse(body):
    try:
        return json.loads(body), True
    except Exception:
        return None, False


# ---------------------------------------------------------------- 用例
# ---------------------------------------------------------------- 状态防护
def _state_hashes():
    out = {}
    for rel in STATE_FILES:
        p = os.path.join(ROOT, rel)
        try:
            with open(p, "rb") as f:
                out[rel] = hashlib.sha256(f.read()).hexdigest()
        except (FileNotFoundError, IsADirectoryError, PermissionError):
            out[rel] = None
    return out


def _backup_state(dest):
    for rel in STATE_RESTORABLE:
        src = os.path.join(ROOT, rel)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(dest, rel.replace("/", "__")))


def _restore_state(dest):
    """只还原 JSON 配置 —— 见 STATE_RESTORABLE 注释：SQLite 不能用文件复制还原。"""
    for rel in STATE_RESTORABLE:
        b = os.path.join(dest, rel.replace("/", "__"))
        if os.path.isfile(b):
            shutil.copy2(b, os.path.join(ROOT, rel))


def test_post_routes_parity():
    """POST：用空载荷 {} 探测校验拒绝行为 —— 期待两端都拒绝。

    若某端接受了空载荷（ok:true），本身就是危险信号：说明它可能把配置清空。
    状态文件在探测前后取哈希，一旦有写入即自动还原并 fail。
    """
    from compute_api import handlers as server  # 延迟导入：默认 skip 时不触发 server.py 的模块级副作用

    tok_n, tok_m = _login()
    backup = tempfile.mkdtemp(prefix="parity_state_")
    _backup_state(backup)
    before = _state_hashes()

    problems, skipped, accepted, status_only = [], [], [], []
    for p in sorted(server.POST_ROUTES):
        if p in POST_NEVER_SEND:
            skipped.append("%s（%s）" % (p, POST_NEVER_SEND[p]))
            continue
        nest = _open(NEST, p, tok_n, head=True, method="POST", body={})
        mono = _open(MONO, p, tok_m, head=False, method="POST", body={})
        jn, is_json_n = _parse(nest[1])
        jm, is_json_m = _parse(mono[1])
        if is_json_n != is_json_m:
            problems.append("%s -> 响应格式不同" % p)
            continue
        if isinstance(jn, dict) and isinstance(jm, dict):
            ok_n, ok_m = bool(jn.get("ok")), bool(jm.get("ok"))
            if ok_n != ok_m:
                # 安全关键：一端接受、一端拒绝 —— 绝不能放过
                problems.append("%s -> ok 不同 Nest=%s(%s) 单体=%s(%s)" % (
                    p, ok_n, nest[0], ok_m, mono[0]))
            elif ok_n:
                # 两端都接受了空载荷：可能是无副作用的空操作，也可能真写入（由状态快照兜底）
                accepted.append(p)
            elif nest[0] != mono[0]:
                # 两端都拒绝，只是状态码不同 —— 见下方 POST_STATUS_NOTE，登记接受
                status_only.append("%s (Nest=%s 单体=%s)" % (p, nest[0], mono[0]))

    after = _state_hashes()
    changed = [k for k in STATE_FILES if before.get(k) != after.get(k)]
    if changed:
        _restore_state(backup)
        shutil.rmtree(backup, ignore_errors=True)
        pytest.fail("POST 探测造成了状态写入，这些端点不可自动比对（文件已自动还原）："
                    + ", ".join(changed))

    shutil.rmtree(backup, ignore_errors=True)
    assert not problems, ("POST 与单体存在未登记的差异：\n" + "\n".join(problems)
                          + "\n（未发送：）" + "; ".join(skipped))
    # 仅供排查时查看：两端都接受空载荷 / 仅状态码不同（已登记接受）
    print("\n[POST] 两端都接受空载荷: %s" % (", ".join(accepted) or "无"))
    print("[POST] 仅状态码不同(已登记): %s" % ("; ".join(status_only) or "无"))
    print("[POST] 未发送: %s" % "; ".join(skipped))


def _entity_snapshot():
    """语义级状态快照：用户 {username: role} + 数据权限规则键集合。

    这里**不能用字节哈希**：两端写盘格式本来就不一样（会做字段归一化），
    一次创建/删除后字节必然变化，但语义应当完全复原。
    字节哈希只用于「不该写」的场景（见 POST 空载荷探测）。
    """
    out = {"users": {}, "rules": []}
    try:
        with open(os.path.join(ROOT, "backend", "data", ".users.json"), encoding="utf-8") as f:
            j = json.load(f)
        arr = j.get("users") if isinstance(j, dict) else j
        out["users"] = {u.get("username"): u.get("role")
                        for u in (arr or []) if isinstance(u, dict) and u.get("username")}
    except Exception:
        pass
    try:
        with open(os.path.join(ROOT, "backend", "data", ".data_perms.json"), encoding="utf-8") as f:
            dp = json.load(f)
        rules = (dp or {}).get("rules") or {}
        out["rules"] = sorted(rules.keys())
    except Exception:
        pass
    return out


def _ok_of(body):
    j, is_json = _parse(body)
    return bool(is_json and isinstance(j, dict) and j.get("ok"))


def _post_json(base, path, token, head, payload):
    st, body, _ = _open(base, path, token, head=head, method="POST", body=payload)
    return st, body


def _users_of(body):
    """GET /api/admin/users -> {username: role}"""
    j, is_json = _parse(body)
    out = {}
    if is_json and isinstance(j, dict):
        for u in j.get("users") or []:
            if isinstance(u, dict) and u.get("username"):
                out[u["username"]] = u.get("role")
    return out


def _rules_of(body):
    """GET /api/data-perms -> {username: rule}"""
    j, is_json = _parse(body)
    if is_json and isinstance(j, dict):
        r = j.get("rules")
        return r if isinstance(r, dict) else {}
    return {}


def test_write_endpoints_parity():
    """高频写端点的**真实写入行为**比对（POST 空载荷探测覆盖不到这一层）。

    做法：用一次性临时用户走完整生命周期 —— 创建 → 两端读回 → 改角色 → 两端读回
    → 设数据权限 → 两端读回 → 删除。任一步两端读到的状态不一致即失败。

    安全：两端共用同一份状态文件（.users.json / .data_perms.json …），因此
      · 开头备份 + 取哈希
      · 结尾无论成败都清理临时实体
      · 最后断言状态文件哈希回到原值 —— **证明没留下任何残留**
        不一致则自动还原并 fail。
    """
    tok_n, tok_m = _login()
    backup = tempfile.mkdtemp(prefix="parity_write_")
    _backup_state(backup)
    before = _entity_snapshot()

    uname = "parity_tmp_%d" % int(time.time())
    problems = []
    try:
        # 1) 经 Nest 创建用户
        st, body = _post_json(NEST, "/api/admin/user", tok_n, True,
                              {"username": uname, "password": "Tmp12345678",
                               "role": "viewer"})
        if not _ok_of(body):
            # 不用 return：那会跳过 finally 后面的断言，让失败静默通过
            problems.append("Nest 创建用户失败 status=%s %s" % (st, body[:100]))

        def both_roles(tag):
            rn = _users_of(_open(NEST, "/api/admin/users", tok_n, head=True)[1]).get(uname)
            rm = _users_of(_open(MONO, "/api/admin/users", tok_m, head=False)[1]).get(uname)
            if rn != rm:
                problems.append("%s 两端读到的角色不同 Nest=%s 单体=%s" % (tag, rn, rm))
            return rn, rm

        r = both_roles("创建后")
        if "viewer" not in r:
            problems.append("创建后角色不是 viewer：%s" % (r,))

        # 2) 经单体改角色（反向验证：另一端的写入也要被两端一致读到）
        st, body = _post_json(MONO, "/api/admin/user/update", tok_m, False,
                              {"username": uname, "role": "lead"})
        if not _ok_of(body):
            problems.append("单体改角色失败 status=%s %s" % (st, body[:100]))
        r = both_roles("改角色后")
        if "lead" not in r:
            problems.append("改角色后不是 lead：%s" % (r,))

        # 3) 经 Nest 设数据权限，两端读回应一致
        team = "917521136"
        _post_json(NEST, "/api/data-perms", tok_n, True,
                   {"username": uname, "scope": "teams", "teams": [team]})
        rn = _rules_of(_open(NEST, "/api/data-perms", tok_n, head=True)[1]).get(uname)
        rm = _rules_of(_open(MONO, "/api/data-perms", tok_m, head=False)[1]).get(uname)
        if (rn or {}).get("scope") != (rm or {}).get("scope") or \
                [str(x) for x in ((rn or {}).get("teams") or [])] != \
                [str(x) for x in ((rm or {}).get("teams") or [])]:
            problems.append("数据权限两端读回不同 Nest=%s 单体=%s" % (
                json.dumps(rn, ensure_ascii=False)[:80],
                json.dumps(rm, ensure_ascii=False)[:80]))
        elif (rn or {}).get("scope") != "teams":
            problems.append("数据权限未生效：%s" % json.dumps(rn, ensure_ascii=False)[:80])

    finally:
        # 清理：两端都试一遍删除（幂等），规则也要删，避免留下临时实体
        for base, tok, head in ((NEST, tok_n, True), (MONO, tok_m, False)):
            try:
                _post_json(base, "/api/data-perms/delete", tok, head, {"username": uname})
            except Exception:
                pass
            try:
                _post_json(base, "/api/admin/user/delete", tok, head, {"username": uname})
            except Exception:
                pass

    after = _entity_snapshot()
    residue = []
    if after["users"] != before["users"]:
        residue.append("用户集合/角色未复原（多出或缺少：%s）" % sorted(
            set(after["users"]) ^ set(before["users"])))
    if after["rules"] != before["rules"]:
        residue.append("数据权限规则集合未复原（多出或缺少：%s）" % sorted(
            set(after["rules"]) ^ set(before["rules"])))
    # 前后 diff 看不见「更早一次失败跑」留下的残留，这里再绝对查一次
    stale = sorted([u for u in after["users"] if str(u).startswith("parity_tmp")]
                   + [u for u in after["rules"] if str(u).startswith("parity_tmp")])
    if stale:
        residue.append("仍有 parity_tmp 残留（可能来自更早失败的跑）：%s" % stale)
    if residue:
        _restore_state(backup)
        shutil.rmtree(backup, ignore_errors=True)
        pytest.fail("写端点比对后有残留（已自动还原）：" + "；".join(residue))
    shutil.rmtree(backup, ignore_errors=True)
    assert not problems, "写端点与单体行为不一致：\n" + "\n".join(problems)


def _cron_of(body):
    """GET /api/cron -> {'lists': {id: name}, 'items': {id: title}}"""
    j, is_json = _parse(body)
    out = {"lists": {}, "items": {}}
    if is_json and isinstance(j, dict):
        cron = j.get("cron") or {}
        for li in (cron.get("lists") or []):
            if isinstance(li, dict) and li.get("id"):
                out["lists"][str(li["id"])] = li.get("name")
        for it in (cron.get("items") or []):
            if isinstance(it, dict) and it.get("id"):
                out["items"][str(it["id"])] = it.get("title")
    return out


def _cron_snapshot():
    """语义级：直接读 cron.db 的 list{id:name} 与 item{id:title}。

    不能用字节哈希 —— SQLite 只要写过一次文件就变，即使行已完全复原。
    """
    import sqlite3

    out = {"lists": {}, "items": {}}
    p = os.path.join(PY_HOME, "workbench", "data", "cron.db")
    if not os.path.isfile(p):
        return out
    try:
        con = sqlite3.connect(p)
        try:
            for lid, name in con.execute("SELECT id, name FROM cron_list"):
                out["lists"][str(lid)] = name
            for iid, title in con.execute("SELECT id, title FROM cron_item"):
                out["items"][str(iid)] = title
        finally:
            con.close()
    except Exception:
        pass
    return out


def test_cron_write_endpoints_parity():
    """/api/cron/* 的真实写入行为比对（POST 空载荷探测覆盖不到这一层）。

    走完整生命周期：建列表 → 两端读回 → 在该列表下建事项 → 两端读回 →
    改标题 → 两端读回 → 清理。任一步两端读到的状态不一致即失败。

    清理顺序有讲究：**列表非空时不允许删除**（两端都是这个约束），必须先删事项。
    残留检测用 cron.db 的语义快照（SQLite 字节哈希不适用）。
    """
    tok_n, tok_m = _login()
    backup = tempfile.mkdtemp(prefix="parity_cron_")
    _backup_state(backup)
    before = _cron_snapshot()

    problems, list_id, item_id = [], None, None
    try:
        st, body = _post_json(NEST, "/api/cron/lists", tok_n, True,
                              {"op": "create", "name": "parity_tmp_list",
                               "icon": "list-checks", "color": "#FF5000"})
        j, _ = _parse(body)
        list_id = (j or {}).get("list", {}).get("id") if isinstance(j, dict) else None
        if not list_id:
            problems.append("Nest 建列表失败 status=%s %s" % (st, body[:100]))

        def both_cron(tag):
            tn = _cron_of(_open(NEST, "/api/cron", tok_n, head=True)[1])
            tm = _cron_of(_open(MONO, "/api/cron", tok_m, head=False)[1])
            if tn["lists"].get(list_id) != tm["lists"].get(list_id):
                problems.append("%s 列表名两端不同 Nest=%s 单体=%s" % (
                    tag, tn["lists"].get(list_id), tm["lists"].get(list_id)))
            if set(tn["items"]) != set(tm["items"]):
                problems.append("%s 事项集合两端不同 Nest=%s 单体=%s" % (
                    tag, sorted(tn["items"]), sorted(tm["items"])))
            return tn, tm

        if list_id:
            tn, _ = both_cron("建列表后")
            if tn["lists"].get(list_id) != "parity_tmp_list":
                problems.append("建列表后名称不对：%s" % tn["lists"].get(list_id))

            # 反向：经单体在该列表下建事项
            st, body = _post_json(MONO, "/api/cron/items", tok_m, False,
                                  {"op": "create", "title": "parity_tmp_item",
                                   "list_id": list_id, "note": "", "remind_at": ""})
            j, _ = _parse(body)
            item_id = (j or {}).get("item", {}).get("id") if isinstance(j, dict) else None
            if not item_id:
                problems.append("单体建事项失败 status=%s %s" % (st, body[:100]))

            if item_id:
                tn, _ = both_cron("建事项后")
                if tn["items"].get(item_id) != "parity_tmp_item":
                    problems.append("建事项后标题不对：%s" % tn["items"].get(item_id))

                _post_json(NEST, "/api/cron/items", tok_n, True,
                           {"op": "update", "id": item_id, "title": "parity_tmp_item_2"})
                tn, tm = both_cron("改标题后")
                if tn["items"].get(item_id) != "parity_tmp_item_2" or \
                        tm["items"].get(item_id) != "parity_tmp_item_2":
                    problems.append("改标题后两端不一致 Nest=%s 单体=%s" % (
                        tn["items"].get(item_id), tm["items"].get(item_id)))
    finally:
        # 必须先删事项：列表非空时删除会被拒绝
        for base, tok, head in ((NEST, tok_n, True), (MONO, tok_m, False)):
            if item_id:
                try:
                    _post_json(base, "/api/cron/items", tok, head,
                               {"op": "delete", "id": item_id})
                except Exception:
                    pass
            if list_id:
                try:
                    _post_json(base, "/api/cron/lists", tok, head,
                               {"op": "delete", "id": list_id})
                except Exception:
                    pass

    after = _cron_snapshot()
    residue = []
    if after["lists"] != before["lists"]:
        residue.append("列表集合未复原（多出或缺少：%s）"
                       % sorted(set(after["lists"]) ^ set(before["lists"])))
    if after["items"] != before["items"]:
        residue.append("事项集合未复原（多出或缺少：%s）"
                       % sorted(set(after["items"]) ^ set(before["items"])))
    # 前后 diff 看不见「更早一次失败跑」留下的残留，这里再绝对查一次
    stale = sorted([v for v in after["lists"].values() if str(v).startswith("parity_tmp")]
                   + [v for v in after["items"].values() if str(v).startswith("parity_tmp")])
    if stale:
        residue.append("仍有 parity_tmp 残留（可能来自更早失败的跑）：%s" % stale)
    if residue:
        _restore_state(backup)
        shutil.rmtree(backup, ignore_errors=True)
        pytest.fail("cron 写比对后有残留（已自动还原）：" + "；".join(residue))
    shutil.rmtree(backup, ignore_errors=True)
    assert not problems, "cron 写端点与单体不一致：\n" + "\n".join(problems)


def test_remaining_post_endpoints_parity():
    """补上空载荷探测覆盖不到的剩余 POST 端点。

    两类手法，都是为了**只走校验/写入路径而不改变状态**：

    1) 回写当前值：先 GET 读出配置，再把同样的值 POST 回去。
       会完整走一遍校验 → 序列化 → 落盘 → 响应，但内容不变（文件哈希不动）。
       适用于 /api/policy、/api/standard/teams-config、/api/standard/thresholds。
    2) 必然被拒的无效 id：task_id / item_id 不存在，两端都应在产生副作用前拒绝。
       适用于 /api/run、/api/cron/trigger、/api/groups/forget。
       /api/stop 只在确认无任务运行（/api/state 的 current 为空）时才发。

    /api/standard/refresh-all 不在本用例内：它没有入参校验，任何载荷都会真跑一次
    全量刷新，无法安全地自动比对（功能已在 Nest 生产路径上多次实测）。
    """
    tok_n, tok_m = _login()
    backup = tempfile.mkdtemp(prefix="parity_rest_")
    _backup_state(backup)
    before = _state_hashes()

    problems = []

    def probe(path, payload, note):
        """两端各发一次，比较 ok 与状态码。"""
        st_n, body_n = _post_json(NEST, path, tok_n, True, payload)
        st_m, body_m = _post_json(MONO, path, tok_m, False, payload)
        ok_n, ok_m = _ok_of(body_n), _ok_of(body_m)
        if ok_n != ok_m:
            problems.append("%s(%s) ok 不同 Nest=%s(%s) 单体=%s(%s)" % (
                path, note, ok_n, st_n, ok_m, st_m))
        elif st_n != st_m:
            # 两端判定一致，仅状态码不同（Nest @Post 默认 201）：登记接受
            problems.append("%s(%s) 状态码不同 Nest=%s 单体=%s —— 见 POST_STATUS_NOTE" % (
                path, note, st_n, st_m))
        return ok_n, ok_m

    def current(path, key):
        j, _ = _parse(_open(NEST, path, tok_n, head=True)[1])
        return (j or {}).get(key) if isinstance(j, dict) else None

    try:
        # 1) 回写当前值
        pol = current("/api/policy", "policy")
        if isinstance(pol, dict):
            probe("/api/policy", dict(pol), "回写当前策略")

        teams = current("/api/standard/teams-config", "teams")
        if teams is not None:
            probe("/api/standard/teams-config", {"teams": teams}, "回写当前参与站点")

        # 注：/api/standard/thresholds 不做回写 —— 它会刷新 updated_at，
        # 文件哈希必然变化，与「回写不改变状态」的前提冲突（实测被状态防护拦下）。
        # 该端点已在 POST_NEVER_SEND 里标注「空载荷即写配置」。

        # 2) 必然被拒的无效 id
        probe("/api/run", {"items": [{"task_id": "__no_such_task__"}]}, "不存在的任务")
        probe("/api/cron/trigger", {"item_id": "__no_such_item__"}, "不存在的事项")
        probe("/api/groups/forget", {"group": "__no_such_group__"}, "不存在的分组")

        # 3) stop：仅在无任务运行时才发（否则会真停掉任务）
        st, body = _open(NEST, "/api/state", tok_n, head=True)[:2]
        j, _ = _parse(body)
        running = bool((j or {}).get("current")) if isinstance(j, dict) else True
        cur_m = _parse(_open(MONO, "/api/state", tok_m, head=False)[1])[0] or {}
        running = running or bool(cur_m.get("current"))
        if running:
            print("\n[POST] 有任务在运行，跳过 /api/stop 探测")
        else:
            probe("/api/stop", {}, "无任务运行时的停止")

        # 4) todo/import 空载荷（不导入任何内容）
        probe("/api/cron/import", {"lists": [], "items": []}, "空导入")

    finally:
        after = _state_hashes()
        changed = [k for k in STATE_FILES if before.get(k) != after.get(k)]
        if changed:
            _restore_state(backup)
            shutil.rmtree(backup, ignore_errors=True)
            pytest.fail("剩余 POST 探测造成了状态写入（已还原）：" + ", ".join(changed))
        shutil.rmtree(backup, ignore_errors=True)

    # 状态码差异按 POST_STATUS_NOTE 登记接受；其余（ok 不一致）才算真问题
    real = [p for p in problems if "POST_STATUS_NOTE" not in p]
    assert not real, "剩余 POST 端点与单体不一致：\n" + "\n".join(real)
    if problems:
        print("\n[POST] 仅状态码不同(已登记): %s" % "; ".join(problems))


def test_get_routes_parity():
    """逐条比对 GET 路由：状态码 / 字段集合 / 取值 / rows 条数。"""
    from compute_api import handlers as server  # 延迟导入：默认 skip 时不要触发 server.py 的模块级副作用

    tok_n, tok_m = _login()
    problems = []
    for p in sorted(server.GET_ROUTES):
        if p in SKIP_ROUTES:
            continue
        nest = _open(NEST, p, tok_n, head=True)
        mono = _open(MONO, p, tok_m, head=False)
        for issue in _diff(p, nest, mono):
            problems.append("%s -> %s" % (p, issue))

    assert not problems, "与单体存在未登记的差异：\n" + "\n".join(problems)
