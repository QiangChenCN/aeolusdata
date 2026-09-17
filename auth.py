# -*- coding: utf-8 -*-
"""RBAC 权限核心（纯标准库，无第三方依赖）。

职责：
  · 用户库 .users.json（用户名 / scrypt 口令哈希 / 角色 / 禁用 / 锁定 / 密码历史）
  · 会话：登录签发随机 token，内存表存 {user, role, ip, exp, fp}，TTL 12h
  · 角色→权限：默认三角色（admin / operator / viewer），可配置 + 支持继承（.roles.json）
  · 密码策略：长度/复杂度/过期/防复用/泄露筛查/锁定（.pwpolicy.json，管理员可调）
  · 路由→权限映射（GET_ROUTE_PERMS / POST_ROUTE_PERMS）
  · 敏感操作审计日志 .audit.jsonl（追加写，含用户/IP/角色/结果）

设计要点：
  · 口令哈希用 hashlib.scrypt（标准库），免装 bcrypt/passlib。
  · 首次运行无用户库时，ensure_bootstrap() 建默认管理员 admin，
    密码取环境变量 WB_ADMIN_PASSWORD，否则默认 admin123（启动告警提示修改）。
  · 审计只记指纹（token 的 sha256 前 12 位），不落盘明文 token。

行业实践参考（本模块落地的原则）：
  · NIST SP 800-63B（2025-08 第 4 版）：取消强制复杂度与定期改密，长度优先
    （默认 ≥8，建议 ≥12）；筛查常见泄露口令；允许粘贴；限制失败次数并锁定。
  · RBAC 最小权限 + 职责分离：管理类权限（账号/角色/策略）与操作类权限显式分离；
    角色支持继承（子角色自动获得父角色全部权限），便于分层授权。
"""
import os
import json
import re
import time
import secrets
import hashlib
import threading
from datetime import datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
USERS_FILE = os.path.join(ROOT, ".users.json")
AUDIT_FILE = os.path.join(ROOT, ".audit.jsonl")
ROLES_FILE = os.path.join(ROOT, ".roles.json")
PW_POLICY_FILE = os.path.join(ROOT, ".pwpolicy.json")
SESSION_TTL = 12 * 3600  # 会话有效期（秒）

# ---------------- 权限目录（前端角色权限分配界面用） ----------------
# (权限点, 展示名, 分组)。分组便于在「角色权限」界面按业务归类成复选框组。
PERM_CATALOG = [
    ("view",        "查看看板",     "只读"),
    ("file:read",   "读取文件/下载", "数据"),
    ("task:run",    "执行任务",     "操作"),
    ("data:refresh","刷新数据",     "操作"),
    ("todo:write",  "编辑提醒事项",  "操作"),
    ("groups:write","管理分组",     "操作"),
    ("config:write","修改系统配置",  "配置"),
    ("admin:users", "账号管理",     "管理"),
    ("admin:roles", "角色权限管理",  "管理"),
    ("admin:policy", "密码策略管理", "管理"),
    ("admin:data-perm", "数据权限管理", "管理"),
]
ALL_PERMS = set(p[0] for p in PERM_CATALOG)

# ---------------- 角色种子（首次运行写入 .roles.json，之后以文件为准） ----------------
# all=True 表示拥有全部权限（内置 admin）；parents 表示继承的父角色。
ROLES_SEED = {
    "admin":    {"perms": [], "parents": [], "builtin": True, "locked": True, "all": True},
    "operator": {"perms": ["view", "file:read", "task:run", "data:refresh",
                           "todo:write", "groups:write", "config:write"],
                 "parents": ["viewer"], "builtin": True, "locked": False, "all": False},
    "viewer":   {"perms": ["view"], "parents": [], "builtin": True, "locked": False, "all": False},
}
VALID_ROLES = set(ROLES_SEED.keys())  # 仅用于兜底/默认值，真实校验以文件为准

# ---------------- 密码策略默认值 ----------------
PW_POLICY_DEFAULT = {
    "min_length": 8,        # 最小长度（NIST：长度优先，复杂度可选）
    "max_length": 64,       # 最大长度（防 DoS）
    "require_upper": False, # 强制大写（默认关，符合 NIST 不强制复杂度）
    "require_lower": False, # 强制小写
    "require_digit": False, # 强制数字
    "require_symbol": False,# 强制符号
    "max_age_days": 0,      # 密码最长有效期（0=不过期，NIST 反对强制定期改密）
    "prevent_reuse": 0,     # 禁止复用最近 N 次密码（0=不限制）
    "breach_check": False,  # 筛查常见泄露口令（离线常见口令库，粗粒度）
    "lockout_attempts": 5,  # 连续失败锁定阈值（0=不锁定）
    "lockout_minutes": 15,  # 锁定时长（分钟）
    "allow_paste": True,    # 允许粘贴（默认开，NIST 反对禁止粘贴）
}

# 常见泄露口令（离线粗粒度筛查，覆盖 TOP 高频弱口令；breach_check 开启时生效）
_COMMON_PASSWORDS = set("""
password 123456 12345678 123456789 12345 1234567 qwerty abc123
password1 111111 123123 admin 1234567890 letmein welcome monkey
dragon sunshine princess football baseball master jordan harley
ranger iamgod trustno1 shadow superman batman 654321 pokemon
iloveyou 1234 aaaaaa passw0rd qwerty123 1q2w3e4r azerty
admin123 root 123qwe qwertyuiop 666666 888888 000000 photoshop
starwars whatever hello facebook sunshine 1qaz2wsx 1q2w3e
changeme password123 abcd1234 a123456 123abc q1w2e3r4t5
""".split())

_lock = threading.Lock()
SESSIONS = {}  # token -> {user, role, ip, exp, fp}


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ---------------- 口令哈希（scrypt） ----------------
def _hash_pw(pw, salt=None):
    if salt is None:
        salt = secrets.token_bytes(16)
    key = hashlib.scrypt(pw.encode("utf-8"), salt=salt,
                         n=16384, r=8, p=1, dklen=64)
    return salt.hex() + "$" + key.hex()


def _verify_pw(pw, stored):
    try:
        salt_hex, key_hex = stored.split("$", 1)
        salt = bytes.fromhex(salt_hex)
        key = bytes.fromhex(key_hex)
    except Exception:
        return False
    cand = hashlib.scrypt(pw.encode("utf-8"), salt=salt,
                          n=16384, r=8, p=1, dklen=64)
    return secrets.compare_digest(cand, key)


# ---------------- 用户库 ----------------
def _load_users():
    try:
        with open(USERS_FILE, "r", encoding="utf-8") as f:
            return json.load(f).get("users", [])
    except FileNotFoundError:
        return None  # 信号：用户库尚不存在


def _save_users(users):
    with open(USERS_FILE, "w", encoding="utf-8") as f:
        json.dump({"users": users}, f, ensure_ascii=False, indent=2)
    try:
        os.chmod(USERS_FILE, 0o600)
    except OSError:
        pass


def ensure_bootstrap():
    """首次运行无用户库 → 建默认管理员；同时种子角色/策略文件。"""
    users = _load_users()
    if users is None:
        pw = os.environ.get("WB_ADMIN_PASSWORD") or "admin123"
        users = [{
            "username": "admin",
            "pw_hash": _hash_pw(pw),
            "role": "admin",
            "disabled": False,
            "created_at": _now(),
            "failed_attempts": 0,
            "locked_until": 0,
            "pw_history": [],
            "must_change": not bool(os.environ.get("WB_ADMIN_PASSWORD")),
        }]
        _save_users(users)
        if not os.environ.get("WB_ADMIN_PASSWORD"):
            print("=" * 60)
            print(" [!] 已创建默认管理员账号：admin / admin123")
            print("     请尽快登录后在「系统设置 → 个人」中修改密码（切勿公网暴露默认口令）")
            print("=" * 60)
    # 角色/策略文件若缺失则种子
    if not os.path.exists(ROLES_FILE):
        _save_roles({k: dict(v) for k, v in ROLES_SEED.items()})
    if not os.path.exists(PW_POLICY_FILE):
        _save_policy(dict(PW_POLICY_DEFAULT))
    return users


# ---------------- 角色（可配置 + 继承） ----------------
def _save_roles(roles):
    out = {}
    for name, r in roles.items():
        out[name] = {
            "perms": sorted(r.get("perms", [])),
            "parents": list(r.get("parents", [])),
            "builtin": bool(r.get("builtin", False)),
            "locked": bool(r.get("locked", False)),
            "all": bool(r.get("all", False)),
        }
    with open(ROLES_FILE, "w", encoding="utf-8") as f:
        json.dump({"roles": out}, f, ensure_ascii=False, indent=2)
    try:
        os.chmod(ROLES_FILE, 0o600)
    except OSError:
        pass


def load_roles():
    try:
        with open(ROLES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f).get("roles", {})
    except FileNotFoundError:
        data = {k: dict(v) for k, v in ROLES_SEED.items()}
        _save_roles(data)
    # 始终补齐内置角色（防止文件被删字段）
    for name, seed in ROLES_SEED.items():
        if name not in data:
            data[name] = dict(seed)
    return data


def effective_perms(role):
    """解析角色的有效权限 = 自身权限 ∪ 全部（传递）父角色权限。含环检测。"""
    roles = load_roles()
    r = roles.get(role)
    if not r:
        return set()
    if r.get("all"):
        return set(ALL_PERMS)
    out = set()
    expanded = set()
    stack = [role]
    while stack:
        nm = stack.pop()
        if nm in expanded:
            continue
        expanded.add(nm)
        rr = roles.get(nm)
        if not rr:
            continue
        for p in rr.get("perms", []):
            out.add(p)
        for par in rr.get("parents", []):
            if par not in expanded:
                stack.append(par)
    return out


def has_perm(role, perm):
    """perm == 'self' 表示「已登录即可」（个人改密等），由调用方在鉴权通过后放行。"""
    if perm == "self":
        return True
    # admin 角色名兜底，即使角色文件缺失也拥有全部权限
    if role == "admin":
        return True
    roles = load_roles()
    r = roles.get(role)
    if r and r.get("all"):
        return True
    return perm in effective_perms(role)


def list_roles():
    """返回角色列表（含有效权限/显式权限/父角色/是否内置/是否锁定）。"""
    roles = load_roles()
    out = []
    for name, r in roles.items():
        out.append({
            "name": name,
            "perms": sorted(effective_perms(name)),
            "explicit_perms": sorted(r.get("perms", [])),
            "parents": list(r.get("parents", [])),
            "builtin": bool(r.get("builtin")),
            "locked": bool(r.get("locked")),
            "all": bool(r.get("all")),
        })
    return out


def _role_children(name, roles=None):
    """返回以 name 为父角色的所有子角色名（用于删除保护）。"""
    roles = roles or load_roles()
    return [n for n, r in roles.items() if name in r.get("parents", [])]


def _would_cycle(name, parents, roles=None):
    """若把 parents 设为 name 的父角色会形成环，返回 True。"""
    roles = roles or load_roles()
    stack = list(parents)
    seen = set()
    while stack:
        p = stack.pop()
        if p == name:
            return True
        if p in seen:
            continue
        seen.add(p)
        pr = roles.get(p)
        if pr:
            stack.extend(pr.get("parents", []))
    return False


def create_role(name, perms, parents):
    name = (name or "").strip()
    if not name:
        raise ValueError("角色名不能为空")
    if re.search(r"[\s/\\]", name):
        raise ValueError("角色名不能含空格或 / \\")
    roles = load_roles()
    if name in roles:
        raise ValueError("角色已存在：%s" % name)
    perms = [p for p in (perms or []) if p in ALL_PERMS]
    parents = [p for p in (parents or []) if p in roles and p != name]
    if _would_cycle(name, parents, roles):
        raise ValueError("角色继承会形成环，已拒绝")
    roles[name] = {"perms": perms, "parents": parents,
                   "builtin": False, "locked": False, "all": False}
    _save_roles(roles)
    return True


def update_role(name, perms=None, parents=None):
    roles = load_roles()
    r = roles.get(name)
    if not r:
        raise ValueError("角色不存在：%s" % name)
    if r.get("locked"):
        raise ValueError("内置角色「%s」已锁定，不可修改" % name)
    if perms is not None:
        perms = [p for p in perms if p in ALL_PERMS]
        if r.get("all") and perms:
            raise ValueError("全权限角色不可缩减权限点")
        r["perms"] = perms
    if parents is not None:
        parents = [p for p in parents if p in roles and p != name]
        if _would_cycle(name, parents, roles):
            raise ValueError("角色继承会形成环，已拒绝")
        r["parents"] = parents
    roles[name] = r
    _save_roles(roles)
    return True


def delete_role(name):
    roles = load_roles()
    r = roles.get(name)
    if not r:
        raise ValueError("角色不存在：%s" % name)
    if r.get("builtin") or r.get("locked"):
        raise ValueError("内置/锁定角色「%s」不可删除" % name)
    if _role_children(name, roles):
        raise ValueError("角色「%s」仍被其它角色继承，请先解除继承" % name)
    # 不允许删除仍被账号使用的角色
    users = _load_users() or []
    if any(u.get("role") == name for u in users):
        raise ValueError("仍有账号使用角色「%s」，请先迁移这些账号" % name)
    roles.pop(name, None)
    _save_roles(roles)
    return True


# ---------------- 密码策略 ----------------
def _save_policy(pol):
    with open(PW_POLICY_FILE, "w", encoding="utf-8") as f:
        json.dump(pol, f, ensure_ascii=False, indent=2)
    try:
        os.chmod(PW_POLICY_FILE, 0o600)
    except OSError:
        pass


def get_policy():
    try:
        with open(PW_POLICY_FILE, "r", encoding="utf-8") as f:
            pol = json.load(f)
    except FileNotFoundError:
        pol = dict(PW_POLICY_DEFAULT)
        _save_policy(pol)
    # 补齐缺失字段，防止文件被手改缺键
    for k, v in PW_POLICY_DEFAULT.items():
        pol.setdefault(k, v)
    return pol


def set_policy(patch):
    """更新密码策略的若干字段（仅允许白名单字段）。"""
    pol = get_policy()
    allowed = set(PW_POLICY_DEFAULT.keys())
    for k, v in (patch or {}).items():
        if k not in allowed:
            raise ValueError("未知策略字段：%s" % k)
        pol[k] = v
    # 类型/范围校验
    for k in ("min_length", "max_length", "lockout_attempts", "lockout_minutes", "prevent_reuse"):
        if k in patch:
            pol[k] = max(0, int(patch[k]))
    if pol["min_length"] > pol["max_length"]:
        raise ValueError("最小长度不能大于最大长度")
    _save_policy(pol)
    return pol


def validate_password(pw, policy=None):
    """返回 (ok, reason)。"""
    if policy is None:
        policy = get_policy()
    pw = pw or ""
    n = len(pw)
    if n < policy.get("min_length", 8):
        return False, "密码长度至少 %d 位" % policy["min_length"]
    if n > policy.get("max_length", 64):
        return False, "密码长度不能超过 %d 位" % policy["max_length"]
    if policy.get("require_upper") and not re.search(r"[A-Z]", pw):
        return False, "需包含大写字母"
    if policy.get("require_lower") and not re.search(r"[a-z]", pw):
        return False, "需包含小写字母"
    if policy.get("require_digit") and not re.search(r"\d", pw):
        return False, "需包含数字"
    if policy.get("require_symbol") and not re.search(r"[^A-Za-z0-9]", pw):
        return False, "需包含符号（非字母数字）"
    if policy.get("breach_check") and pw.lower() in _COMMON_PASSWORDS:
        return False, "该密码过于常见，已被泄露库收录，请更换"
    return True, ""


def _reuse_blocked(u, new_hash, policy):
    k = policy.get("prevent_reuse", 0)
    if not k:
        return False
    hist = u.get("pw_history", [])
    return new_hash in hist[-k:]


def _record_pw(u, new_hash, policy):
    k = policy.get("prevent_reuse", 0)
    hist = u.get("pw_history", []) + [new_hash]
    if k:
        u["pw_history"] = hist[-(k + 1):]  # 多留 1 条用于比较
    else:
        u["pw_history"] = hist[-1:]        # 仍保留最近 1 条（便于未来开启防复用）
    u["failed_attempts"] = 0
    u["locked_until"] = 0
    u["must_change"] = False


# ---------------- 会话 ----------------
def login(username, password, ip):
    """校验凭据，成功返回 (token, role)，失败返回 None（并记失败审计）。"""
    users = _load_users() or []
    u = next((x for x in users if x.get("username") == username), None)
    if not u:
        audit("login", False, username, ip, "no such user")
        return None
    now = time.time()
    if u.get("locked_until", 0) > now:
        audit("login", False, username, ip, "locked")
        return None
    if u.get("disabled"):
        audit("login", False, username, ip, "disabled")
        return None
    if not _verify_pw(password, u.get("pw_hash", "")):
        u["failed_attempts"] = u.get("failed_attempts", 0) + 1
        pol = get_policy()
        att = pol.get("lockout_attempts", 5)
        if att > 0 and u["failed_attempts"] >= att:
            u["locked_until"] = now + pol.get("lockout_minutes", 15) * 60
            audit("login", False, username, ip,
                  "locked after %d attempts" % u["failed_attempts"])
        _save_users(users)
        audit("login", False, username, ip, "bad password")
        return None
    # 成功：清空失败计数
    u["failed_attempts"] = 0
    u["locked_until"] = 0
    _save_users(users)
    token = secrets.token_hex(24)
    _purge_expired()
    SESSIONS[token] = {
        "user": username,
        "role": u["role"],
        "ip": ip,
        "exp": time.time() + SESSION_TTL,
        "fp": hashlib.sha256(token.encode("utf-8")).hexdigest()[:12],
    }
    audit("login", True, username, ip, u["role"])
    return token, u["role"]


def logout(token):
    with _lock:
        s = SESSIONS.pop(token, None)
    if s:
        audit("logout", True, s["user"], s["ip"], s["role"])


def get_session(token):
    if not token:
        return None
    s = SESSIONS.get(token)
    if not s:
        return None
    if s["exp"] < time.time():
        SESSIONS.pop(token, None)
        return None
    return s


def _purge_expired():
    now = time.time()
    expired = [t for t, s in SESSIONS.items() if s["exp"] < now]
    for t in expired:
        SESSIONS.pop(t, None)


# ---------------- 账号管理 ----------------
def add_user(username, password, role):
    username = (username or "").strip()
    if not username:
        raise ValueError("用户名不能为空")
    if re.search(r"[\s/\\]", username):
        raise ValueError("用户名不能含空格或 / \\")
    roles = load_roles()
    if role not in roles:
        raise ValueError("无效角色：%s" % role)
    ok, reason = validate_password(password)
    if not ok:
        raise ValueError(reason)
    users = _load_users() or []
    if any(u.get("username") == username for u in users):
        raise ValueError("用户已存在：%s" % username)
    users.append({
        "username": username,
        "pw_hash": _hash_pw(password),
        "role": role,
        "disabled": False,
        "created_at": _now(),
        "failed_attempts": 0,
        "locked_until": 0,
        "pw_history": [],
        "must_change": False,
    })
    _save_users(users)
    audit("user:add", True, username, "-", role)
    return True


def set_disabled(username, disabled):
    users = _load_users() or []
    for u in users:
        if u.get("username") == username:
            u["disabled"] = bool(disabled)
            _save_users(users)
            audit("user:disable" if disabled else "user:enable",
                  True, username, "-", u.get("role"))
            return True
    return False


def update_user(username, role=None, disabled=None):
    users = _load_users() or []
    u = next((x for x in users if x.get("username") == username), None)
    if not u:
        raise ValueError("用户不存在：%s" % username)
    if role is not None:
        roles = load_roles()
        if role not in roles:
            raise ValueError("无效角色：%s" % role)
        u["role"] = role
    if disabled is not None:
        u["disabled"] = bool(disabled)
    _save_users(users)
    audit("user:update", True, username, "-", u.get("role"))
    return True


def delete_user(username, current_user=None):
    users = _load_users() or []
    if not any(u.get("username") == username for u in users):
        raise ValueError("用户不存在：%s" % username)
    if current_user and username == current_user:
        raise ValueError("不能删除当前登录的账号")
    # 最后一个管理员不可删除（防锁死）
    admins = [u for u in users if u.get("role") == "admin" and not u.get("disabled")]
    if username in [a.get("username") for a in admins] and len(admins) <= 1:
        raise ValueError("至少需保留一个启用的管理员账号")
    users = [u for u in users if u.get("username") != username]
    _save_users(users)
    audit("user:delete", True, username, "-", "-")
    return True


def reset_password(username, password):
    """管理员重置密码（无需原密码），须符合策略并防复用。"""
    users = _load_users() or []
    u = next((x for x in users if x.get("username") == username), None)
    if not u:
        raise ValueError("用户不存在：%s" % username)
    ok, reason = validate_password(password)
    if not ok:
        raise ValueError(reason)
    pol = get_policy()
    new_hash = _hash_pw(password)
    if _reuse_blocked(u, new_hash, pol):
        raise ValueError("新密码不能与最近 %d 次使用过的密码相同" % pol["prevent_reuse"])
    u["pw_hash"] = new_hash
    _record_pw(u, new_hash, pol)
    _save_users(users)
    audit("user:reset-pw", True, username, "-", u.get("role"))
    return True


def change_password(username, old_password, new_password):
    """本人改密：校验原密码 + 策略 + 防复用。"""
    users = _load_users() or []
    u = next((x for x in users if x.get("username") == username), None)
    if not u:
        raise ValueError("用户不存在：%s" % username)
    if not _verify_pw(old_password, u.get("pw_hash", "")):
        u["failed_attempts"] = u.get("failed_attempts", 0) + 1
        _save_users(users)
        raise ValueError("原密码错误")
    ok, reason = validate_password(new_password)
    if not ok:
        raise ValueError(reason)
    pol = get_policy()
    new_hash = _hash_pw(new_password)
    # 注意：scrypt 每次哈希带随机盐，不能直接比较哈希串；用 _verify_pw 比对明文
    if _verify_pw(new_password, u.get("pw_hash", "")):
        raise ValueError("新密码不能与原密码相同")
    if _reuse_blocked(u, new_hash, pol):
        raise ValueError("新密码不能与最近 %d 次使用过的密码相同" % pol["prevent_reuse"])
    u["pw_hash"] = new_hash
    _record_pw(u, new_hash, pol)
    _save_users(users)
    audit("user:change-pw", True, username, "-", u.get("role"))
    return True


def list_users():
    """返回原始用户列表（含 pw_hash，仅供 CLI/后端内部）。"""
    return _load_users() or []


def list_users_safe():
    """返回脱敏后的用户列表（不含口令哈希），供前端账号管理展示。"""
    users = _load_users() or []
    now = time.time()
    out = []
    for u in users:
        out.append({
            "username": u.get("username"),
            "role": u.get("role"),
            "disabled": bool(u.get("disabled")),
            "locked": u.get("locked_until", 0) > now,
            "created_at": u.get("created_at"),
            "must_change": bool(u.get("must_change")),
        })
    return out


# ---------------- 路由 → 权限 ----------------
# GET 未列出的路由默认视为 "view"（只读看板）。
GET_ROUTE_PERMS = {
    "/api/file":     "file:read",
    "/api/files":    "file:read",
    "/api/download": "file:read",
    "/api/sheet":    "file:read",
    # 管理类（仅管理员）
    "/api/admin/users": "admin:users",
    "/api/admin/roles": "admin:roles",
    "/api/policy":      "admin:policy",
    "/api/data-perms":  "admin:data-perm",
}
# POST 未列出的路由默认视为 "view"。
POST_ROUTE_PERMS = {
    "/api/run":                   "task:run",
    "/api/stop":                  "task:run",
    "/api/cancel":                "task:run",
    "/api/standard/refresh-all":  "data:refresh",
    "/api/standard/teams-config": "config:write",
    "/api/standard/grade-standards": "config:write",
    "/api/standard/thresholds":   "config:write",
    "/api/attend-period/config":  "config:write",
    "/api/attend-period/teams":   "config:write",
    "/api/lan/set":               "config:write",
    "/api/todo/lists":            "todo:write",
    "/api/todo/items":            "todo:write",
    "/api/todo/trigger":          "todo:write",
    "/api/todo/import":           "todo:write",
    "/api/groups/used":           "groups:write",
    "/api/groups/forget":         "groups:write",
    # 账号管理（仅管理员）
    "/api/admin/user":        "admin:users",
    "/api/admin/user/update": "admin:users",
    "/api/admin/user/reset-pw": "admin:users",
    "/api/admin/user/delete": "admin:users",
    # 角色管理（仅管理员）
    "/api/admin/role":        "admin:roles",
    "/api/admin/role/update": "admin:roles",
    "/api/admin/role/delete": "admin:roles",
    # 密码策略（仅管理员）
    "/api/policy":            "admin:policy",
    # 数据权限（仅管理员）
    "/api/data-perms":        "admin:data-perm",
}
# 需要记审计的权限点（含写操作与文件读取）。
SENSITIVE_AUDIT = set(POST_ROUTE_PERMS.values()) | {"file:read", "admin:users",
                                                    "admin:roles", "admin:policy"}


# ---------------- 审计 ----------------
def audit(action, ok, user, ip, role_or_note, method="", path=""):
    """追加写审计日志（一行一事件）。"""
    rec = {
        "ts": _now(),
        "action": action,
        "ok": bool(ok),
        "user": user or "-",
        "ip": ip or "-",
        "role": role_or_note or "-",
        "method": method,
        "path": path,
    }
    line = json.dumps(rec, ensure_ascii=False)
    try:
        with _lock:
            with open(AUDIT_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception:
        pass
