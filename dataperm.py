# -*- coding: utf-8 -*-
"""数据权限（行级隔离）核心 —— 纯标准库，配套 auth.py 的 RBAC。

背景：本系统报表天然以「站点 / team」为隔离边界——标准达成、骑手维度、站点报表、
时段出勤、数据大屏均按 team 取数，'__all__' 表示合并全部站点。因此本模块以 team
为数据权限的隔离键，规则表达为「某用户可访问哪些站点」。

存储：.data_perms.json
  {
    "version": 1,
    "rules": {
      "<username>": {"scope": "all"|"business_lines"|"cities"|"teams",
                     "business_lines": ["即时配送事业部", ...],
                     "cities": ["东莞市", ...], "teams": ["917521130", ...],
                     "inherit_new": false}
    }
  }
  · scope="all"            -> 可看全部站点（含 __all__ 合并视图）
  · scope="business_lines" -> 仅所选业务线（事业部）下的城市与站点
  · scope="cities"         -> 仅所选城市下的站点
  · scope="teams"          -> 仅 teams 列表内的站点
  · inherit_new            -> 授权节点向上一级继承（城市→同业务线其他城市、站点→同城市兄弟站点），
                              使后续新增的同层节点自动可见
  · 用户无规则              -> 默认 scope="all"（向后兼容：不配置即不限制，避免误锁）
  · 角色 admin              -> 永远全量（硬编码，绕开规则，便于救急/不锁死自己）

组织层级（org_tree.json）：business_line（业务线/事业部） -> city（城市） -> team（站点）；
授权可落在任一层级，resolve_allowed 统一向下展开到站点（enforcement 仍以 team 为隔离键）。

与 RBAC 的关系（纵深防御）：
  · RBAC 管「能不能看报表」（功能权限，权限点 view / file:read ...）
  · 本模块管「能看哪些站点的数据」（数据权限）
  两者正交——即使某人拥有 view 权限，其可见站点仍受本模块约束。
"""
import os
import json
import threading

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_PERMS_FILE = os.path.join(ROOT, ".data_perms.json")
DEFAULT_SCOPE = "all"            # 无规则时的默认作用域（向后兼容，不限制）
_LOCK = threading.Lock()

# ---------------- 组织树（business_line -> city -> team 层级） ----------------
# 隔离维度的「单一事实源」：站点归到城市，城市归到业务线/事业部；授权可落在任意层级，
# 向下展开到站点（enforcement 仍以 team 为隔离键）。新节点挂到某上级即自动继承其授权
# （ReBAC 式关系继承）。default_new_site 为新站点默认策略，默认 exclude（最小权限：
# 未归类站点对受限用户不可见，直到被所在城市/业务线显式授予）。
ORG_FILE = os.path.join(ROOT, "org_tree.json")

def load_org():
    try:
        with open(ORG_FILE, "r", encoding="utf-8") as f:
            obj = json.load(f)
    except FileNotFoundError:
        return {"cities": {}, "default_new_site": "exclude"}
    if not isinstance(obj, dict):
        return {"cities": {}, "default_new_site": "exclude"}
    obj.setdefault("cities", {})
    obj.setdefault("business_lines", {})
    obj.setdefault("default_new_site", "exclude")
    return obj

def _save_org(obj):
    """原子写组织树：先 .tmp 再 rename（与 teams_config / _save 一致）。"""
    tmp = ORG_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, ORG_FILE)

def cities():
    """返回城市名列表（排序）。"""
    return sorted(load_org().get("cities", {}).keys())

def _city_teams(info):
    """城市项统一为 team id 列表（兼容 {teams:[...]} 与 [...] 两种存储）。"""
    if isinstance(info, dict):
        info = info.get("teams") or []
    return [str(x) for x in (info or []) if str(x).strip()]

def teams_of_city(city):
    return set(_city_teams(load_org().get("cities", {}).get(city)))

def all_teams():
    s = set()
    for info in load_org().get("cities", {}).values():
        s |= set(_city_teams(info))
    return s

def city_of(team):
    t = str(team)
    for c, info in load_org().get("cities", {}).items():
        if t in _city_teams(info):
            return c
    return None

def get_default_new_site():
    return load_org().get("default_new_site", "exclude")

# ---------------- 业务线（business_line -> city 层级） ----------------
# 业务线/事业部 是站点之上的组织层（业务线 -> 城市 -> 站点）。授权可落在任意层级，
# 向下展开到站点。这样「按业务线配置权限」与「按城市/站点」复用同一套规则/UI/审计/闸门。
def business_lines():
    """返回业务线名列表（排序）。"""
    return sorted(load_org().get("business_lines", {}).keys())

def _bl_cities(info):
    """业务线项统一为 city 名列表（兼容 {cities:[...]} 与 [...] 两种存储）。"""
    if isinstance(info, dict):
        info = info.get("cities") or []
    return [str(x).strip() for x in (info or []) if str(x).strip()]

def cities_of_business_line(bl):
    return set(_bl_cities(load_org().get("business_lines", {}).get(bl)))

def business_line_of(city):
    c = str(city)
    for bl, info in load_org().get("business_lines", {}).items():
        if c in set(_bl_cities(info)):
            return bl
    return None

def teams_of_business_line(bl):
    s = set()
    for c in cities_of_business_line(bl):
        s |= teams_of_city(c)
    return s

def business_line_of_team(team):
    c = city_of(team)
    return business_line_of(c) if c else None

def set_org(cities_map, default_new_site=None, business_lines_map=None):
    """保存组织树。

    cities_map: {城市: [站点id...]}；business_lines_map: {业务线: [城市名...]}。
    default_new_site 可空，仅当为 include/exclude 时更新。原子写。"""
    norm_cities = {}
    for c, ts in (cities_map or {}).items():
        c = str(c).strip()
        if not c:
            continue
        norm_cities[c] = [str(x) for x in ts if str(x).strip()]
    norm_bl = {}
    for bl, cs in (business_lines_map or {}).items():
        bl = str(bl).strip()
        if not bl:
            continue
        norm_bl[bl] = [str(x).strip() for x in cs if str(x).strip()]
    obj = load_org()
    obj["cities"] = norm_cities
    obj["business_lines"] = norm_bl
    if default_new_site in ("include", "exclude"):
        obj["default_new_site"] = default_new_site
    _save_org(obj)
    return True, ""


def _load():
    try:
        with open(DATA_PERMS_FILE, "r", encoding="utf-8") as f:
            obj = json.load(f)
    except FileNotFoundError:
        return {"version": 1, "rules": {}}
    if not isinstance(obj, dict):
        return {"version": 1, "rules": {}}
    obj.setdefault("version", 1)
    if not isinstance(obj.get("rules"), dict):
        obj["rules"] = {}
    return obj


def _save(obj):
    """原子写：先 .tmp 再 rename，避免半截文件被读到（与 teams_config 一致）。"""
    tmp = DATA_PERMS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, DATA_PERMS_FILE)
    try:
        os.chmod(DATA_PERMS_FILE, 0o600)
    except OSError:
        pass


def get_rule(username):
    """返回某用户的规则 dict；无规则返回默认全量。补齐全字段，兼容旧规则。"""
    obj = _load()
    r = obj["rules"].get(username)
    if not r:
        return {"scope": DEFAULT_SCOPE, "teams": [], "cities": [],
                "business_lines": [], "inherit_new": False}
    r = dict(r)
    r.setdefault("scope", DEFAULT_SCOPE)
    r.setdefault("teams", [])
    r.setdefault("cities", [])
    r.setdefault("business_lines", [])
    r.setdefault("inherit_new", False)
    return r


def set_rule(username, scope, teams=None, cities=None, business_lines=None, inherit_new=None, dimension="team"):
    """保存/更新某用户的数据权限规则。返回 (ok, msg)。

    scope（按隔离层级由粗到细）：
      · all            -> 看全部站点（含合并视图）
      · business_lines -> 按业务线授权（business_lines 列表，自动展开其下城市与站点）
      · cities         -> 按城市授权（cities 列表，自动展开其下站点）
      · teams          -> 指定站点（teams 列表）
    inherit_new：授权节点向上一级「继承」——选中的城市顺带其所在业务线的其他城市、
    选中的站点顺带同城市兄弟站点，使后续新增的同层节点自动可见。
    向后兼容：旧调用 set_rule(u, scope, teams) 仍可用（teams 位置参数）。
    """
    if scope not in ("all", "teams", "cities", "business_lines"):
        return False, "scope 只能是 all / teams / cities / business_lines"
    business_lines = [str(b).strip() for b in (business_lines or []) if str(b).strip()]
    cities = [str(c).strip() for c in (cities or []) if str(c).strip()]
    teams = [str(t).strip() for t in (teams or []) if str(t).strip()]
    base = {"scope": scope, "teams": [], "cities": [],
            "business_lines": [], "inherit_new": bool(inherit_new)}
    obj = _load()
    with _LOCK:
        if scope == "all":
            obj["rules"][username] = dict(base)
        elif scope == "business_lines":
            if not business_lines:
                return False, "scope=business_lines 时至少选择一个业务线"
            rule = dict(base); rule["business_lines"] = business_lines
            obj["rules"][username] = rule
        elif scope == "cities":
            if not cities:
                return False, "scope=cities 时至少选择一个城市"
            rule = dict(base); rule["cities"] = cities
            obj["rules"][username] = rule
        else:  # teams
            if not teams:
                return False, "scope=teams 时至少选择一个站点"
            rule = dict(base); rule["teams"] = teams
            obj["rules"][username] = rule
        _save(obj)
    return True, ""


def delete_rule(username):
    """删除某用户规则（恢复为默认全量）。返回 (ok, msg)。"""
    obj = _load()
    with _LOCK:
        if username in obj["rules"]:
            obj["rules"].pop(username)
            _save(obj)
    return True, ""


def list_rules():
    """返回全部规则（{username: {scope, teams}}）。供管理界面只读展示。"""
    return _load()["rules"]


def resolve_allowed(username, role, dimension="team"):
    """返回某维度下被允许的取值集合；None 表示不限制（看全部）。

    dimension="team"          -> 被允许的 team id 集合（enforcement 用，向下展开到站点）
    dimension="business_line" -> 被允许的业务线名集合（供 UI 过滤等）

    · 角色 admin 永远 None（救急通道，不会被数据权限锁死）。
    · 无规则 -> 取决于 DEFAULT_SCOPE（默认 all）。
    · 各作用域均向下展开到目标维度：business_lines -> cities -> teams。
    · inherit_new：选中城市的同业务线其他城市、选中站点的同城市兄弟站点一并纳入，
      使后续新增的同层节点自动可见。
    """
    if dimension == "business_line":
        return _resolve_business_lines(username, role)
    if role == "admin":
        return None
    obj = _load()
    rule = obj["rules"].get(username)
    if not rule or rule.get("scope") == "all":
        return None
    ids = set()
    for bl in (rule.get("business_lines") or []):
        ids |= teams_of_business_line(bl)
    for c in (rule.get("cities") or []):
        ids |= teams_of_city(c)
    for t in (rule.get("teams") or []):
        ids.add(str(t))
    if rule.get("inherit_new"):
        for c in (rule.get("cities") or []):
            bl = business_line_of(c)
            if bl:
                ids |= teams_of_business_line(bl)   # 同业务线其他城市（新增城市自动可见）
        for t in (rule.get("teams") or []):
            c = city_of(t)
            if c:
                ids |= teams_of_city(c)             # 同城市兄弟站点（新增站点自动可见）
    return ids

def _resolve_business_lines(username, role):
    """返回被允许的业务线名集合；None 表示不限制。"""
    if role == "admin":
        return None
    obj = _load()
    rule = obj["rules"].get(username)
    if not rule or rule.get("scope") == "all":
        return None
    ids = set()
    for bl in (rule.get("business_lines") or []):
        ids.add(bl)
    for c in (rule.get("cities") or []):
        bl = business_line_of(c)
        if bl:
            ids.add(bl)
    for t in (rule.get("teams") or []):
        bl = business_line_of_team(t)
        if bl:
            ids.add(bl)
    if rule.get("inherit_new"):
        for c in (rule.get("cities") or []):
            bl = business_line_of(c)
            if bl:
                ids.add(bl)
        for t in (rule.get("teams") or []):
            c = city_of(t)
            bl = business_line_of(c) if c else None
            if bl:
                ids.add(bl)
    return ids

def allowed_team_ids(username, role):
    """兼容别名：沿用旧调用点（server 的 _enforce_team_scope / _scoped_universe）。"""
    return resolve_allowed(username, role, "team")


def in_scope(username, role, team_id):
    """单点判定：team_id 是否在用户可见范围内。"""
    ids = allowed_team_ids(username, role)
    if ids is None:
        return True
    return str(team_id) in ids


def filter_teams(username, role, teams):
    """ teams: [(id, name), ...] 或 [id, ...]。
    返回被允许的子集（保持原结构与顺序）。admin/无限制 -> 原样；空 -> 空。"""
    ids = allowed_team_ids(username, role)
    if ids is None:
        return list(teams)
    out = []
    for t in teams:
        tid = t[0] if isinstance(t, (list, tuple)) else t
        if str(tid) in ids:
            out.append(t)
    return out
