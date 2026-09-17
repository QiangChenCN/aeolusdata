#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""任务「目标群」选择器后端：最近使用 + 按匹配度搜索群。

给工作台的 Combobox 供数：
  - recent()         最近使用过的群（本地文件，零延迟，聚焦即出）
  - search(q)        按关键词搜群，按匹配度降序；本地缓存命中则不打 dws
  - note_used(...)   任务跑过/选中后登记，下次排在最前

设计要点
--------
1. **全量群列表进内存缓存**（TTL 10 分钟）。钉钉群列表不常变，但 dws 调用要几百毫秒~数秒，
   每次敲一个字都打接口会卡死输入框。缓存命中时搜索是纯内存过滤，毫秒级返回。
2. **复用 find_group.score_match 打分**，保证与命令行 `find_group.py 关键词` 的匹配口径一致，
   不会出现"界面搜得到、脚本解析不到"的错位。
3. **最近使用是独立数据源**，不依赖 dws。即使连接器断开，聚焦输入框仍能列出上次用过的群。
4. **known_group_numbers 兜底**：chat-list-all 会漏掉部分群（如「🤖机器人测试」），
   用 groups.json 登记的群号走 +chat-get-by-id 动态补进来。

存储：server/data/recent_groups.json（纯数据，已 gitignore）
"""
import os
import json
import time
import threading

import find_group

# ------------------------------------------------------------------ 路径与常量
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
RECENT_PATH = os.path.join(DATA_DIR, "recent_groups.json")

CACHE_TTL = 600          # 全量群列表缓存秒数
RECENT_MAX = 20          # 最近使用最多保留条数
SEARCH_LIMIT = 20        # 单次搜索最多返回条数
SCORE_FLOOR = 30         # 低于此匹配分不进结果（避免"打个字就列出全公司群"）

_lock = threading.RLock()
_cache = {"ts": 0.0, "groups": [], "loading": False}


# ------------------------------------------------------------------ 最近使用
def _read_recent():
    if not os.path.exists(RECENT_PATH):
        return []
    try:
        with open(RECENT_PATH, encoding="utf-8") as f:
            data = json.load(f)
        items = data.get("items", []) if isinstance(data, dict) else data
        return [x for x in items if isinstance(x, dict) and x.get("id")]
    except Exception:
        return []


def _write_recent(items):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = RECENT_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"items": items}, f, ensure_ascii=False, indent=2)
        os.replace(tmp, RECENT_PATH)
    except Exception:
        pass


def recent(limit=10):
    """最近使用过的群（按最近使用时间倒序）。

    标题回填：历史记录里的 title 可能缺失、或被误写成群号（早期 note_used 曾以 gid 兜底），
    这里用全量缓存把真名找回来；仍取不到名字的条目**直接跳过**——绝不让群号出现在界面上。
    """
    items = _read_recent()
    items.sort(key=lambda x: -(x.get("used_at") or 0))
    pool = {g["id"]: g["title"] for g in peek_groups()}
    out = []
    for x in items:
        gid = x.get("id")
        if not gid:
            continue
        t = (x.get("title") or "").strip()
        if (not t) or t == gid:
            t = (pool.get(gid) or "").strip()
        if not t:
            continue
        out.append(_out({"id": gid, "title": t}, recent=True))
        if len(out) >= limit:
            break
    return out


def note_used(gid, title=""):
    """登记一次使用。同群只保留一条，提到队首；超出上限丢弃最旧的。

    title 为空、或恰好等于群号时，存空串而非群号——避免把 id 当成群名持久化，
    真名留待 recent() 用全量缓存回填。
    """
    gid = (gid or "").strip()
    if not gid:
        return False
    t = (title or "").strip()
    if t == gid:
        t = ""
    with _lock:
        items = _read_recent()
        items = [x for x in items if x.get("id") != gid]
        items.insert(0, {
            "id": gid,
            "title": t,
            "used_at": int(time.time()),
        })
        _write_recent(items[:RECENT_MAX])
    return True


def forget(gid):
    """从最近使用里移除（群解散后清理用）。"""
    with _lock:
        items = [x for x in _read_recent() if x.get("id") != gid]
        _write_recent(items)
    return True


# ------------------------------------------------------------------ 全量列表缓存
def all_groups(force=False):
    """全量群列表（带内存缓存）。首次或缓存过期才打 dws。"""
    now = time.time()
    with _lock:
        if not force and _cache["groups"] and (now - _cache["ts"]) < CACHE_TTL:
            return list(_cache["groups"])

    groups = {}
    try:
        for g in find_group.list_all_groups():
            cid = g.get("openConversationId")
            if cid:
                groups[cid] = {"id": cid,
                               "title": g.get("title") or g.get("name") or "",
                               "memberCount": g.get("memberCount")}
    except Exception:
        pass

    # 已知隐藏群号补进来（chat-list-all 会漏掉的群）
    for num in find_group.load_known_group_numbers():
        try:
            g = find_group.get_group_by_number(num)
            if g and g.get("openConversationId"):
                cid = g["openConversationId"]
                groups.setdefault(cid, {"id": cid, "title": g.get("title") or "",
                                        "memberCount": g.get("memberCount")})
        except Exception:
            pass

    result = [g for g in groups.values() if g.get("title")]
    with _lock:
        if result or force:          # 拉空了不覆盖旧缓存，避免接口抖动把候选清空
            _cache["groups"] = result
            _cache["ts"] = now
        return list(_cache["groups"])


def peek_groups():
    """只看内存缓存；为空就返回 []，**绝不打 dws**。

    给不能阻塞的场合用（如任务入队时补群名）——宁可这次拿不到名字，
    也不让"运行"按钮卡在几秒的群列表拉取上。
    """
    with _lock:
        return list(_cache["groups"])


def invalidate():
    """丢弃缓存（群列表有变时调用）。"""
    with _lock:
        _cache["ts"] = 0
        _cache["groups"] = []


# ------------------------------------------------------------------ 搜索
def _dedup(rows):
    seen, out = set(), []
    for r in rows:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        out.append(r)
    return out


def search(q, limit=SEARCH_LIMIT):
    """按关键词搜群，按匹配度降序。

    策略：
      1. 先拿全量缓存做内存过滤 + 打分（快）
      2. 缓存为空（首次 / 刚清过）才打 dws 拉全量
      3. 仍然搜不到时，再用 chat-search 兜底一次（覆盖新加的、缓存里没有的群）
    返回 [{id, title, score, memberCount, recent}]
    """
    q = (q or "").strip()
    if not q:
        return {"groups": recent(limit), "source": "recent", "query": ""}

    pool = all_groups()

    # 1) 内存过滤 + 打分
    scored = []
    for g in pool:
        s = find_group.score_match(q, g["title"])
        if s >= SCORE_FLOOR:
            scored.append((s, g))
    scored.sort(key=lambda x: (-x[0], len(x[1]["title"]), x[1]["title"]))

    # 2) 缓存空 → 强制拉一次全量再试
    if not pool:
        pool = all_groups(force=True)
        scored = []
        for g in pool:
            s = find_group.score_match(q, g["title"])
            if s >= SCORE_FLOOR:
                scored.append((s, g))
        scored.sort(key=lambda x: (-x[0], len(x[1]["title"]), x[1]["title"]))

    # 3) 仍无结果 → chat-search 兜底（新群 / 缓存没覆盖到的）
    source = "cache"
    if not scored:
        try:
            for g in find_group.search_groups(q):
                cid = g.get("openConversationId")
                title = g.get("title") or g.get("name") or ""
                if not cid or not title:
                    continue
                s = find_group.score_match(q, title)
                if s >= SCORE_FLOOR:
                    scored.append((s, {"id": cid, "title": title,
                                       "memberCount": g.get("memberCount")}))
            scored.sort(key=lambda x: (-x[0], len(x[1]["title"]), x[1]["title"]))
            source = "remote"
        except Exception:
            pass

    recent_ids = {x["id"] for x in _read_recent()}
    rows = [_out({"id": g["id"], "title": g["title"], "score": s,
                  "memberCount": g.get("memberCount")},
                 recent=(g["id"] in recent_ids))
            for s, g in scored[:limit]]
    return {"groups": rows, "source": source, "query": q}


def resolve(q_or_id):
    """把输入框里的值定成一个群。

    - 看起来像 openConversationId（cid 开头）→ 直接认，顺带补 title
    - 否则按群名走 find_group.resolve_group_id（含歧义抛错）
    返回 {id, title, exact}
    """
    v = (q_or_id or "").strip()
    if not v:
        raise ValueError("群不能为空")
    if v.startswith("cid"):
        title = ""
        for g in all_groups():
            if g["id"] == v:
                title = g["title"]
                break
        return {"id": v, "title": title or v, "exact": bool(title)}
    gid, title = find_group.resolve_group_id(v)
    return {"id": gid, "title": title, "exact": True}


# ------------------------------------------------------------------ 输出归一
def _out(item, recent=False):
    d = {
        "id": item.get("id", ""),
        "title": item.get("title") or "",      # 不以 id 兜底：界面只显示群名，群号仅作取值
        "score": item.get("score", 100 if recent else 0),
        "recent": bool(recent),
    }
    if item.get("memberCount") is not None:
        d["memberCount"] = item["memberCount"]
    return d


def by_id(gid):
    """按 openConversationId 精确反查群名（把已保存的 gid 回填成界面上的群名）。

    顺序：全量缓存 → 缓存空时才强制拉一次 → 最近使用里的真名。
    一律不返回 id 当 title——界面不得露出群号。
    返回 {groups:[{id,title}], source}
    """
    gid = (gid or "").strip()
    if not gid:
        return {"groups": [], "source": "none"}
    pools = [all_groups()]
    if not pools[0]:
        pools.append(all_groups(force=True))
    for pool in pools:
        for g in pool:
            if g.get("id") == gid and g.get("title"):
                return {"groups": [_out({"id": gid, "title": g["title"]})], "source": "cache"}
    for x in _read_recent():
        if x.get("id") == gid:
            t = (x.get("title") or "").strip()
            if t and t != gid:
                return {"groups": [_out({"id": gid, "title": t}, recent=True)], "source": "recent"}
    return {"groups": [], "source": "none"}


# ------------------------------------------------------------------ 自检
if __name__ == "__main__":
    import sys
    arg = " ".join(sys.argv[1:])
    if arg:
        r = search(arg)
        print("搜索「%s」 来源=%s 命中 %d 个" % (arg, r["source"], len(r["groups"])))
        for g in r["groups"]:
            print("  %-40s %s  匹配分%.0f%s" % (g["title"], g["id"], g["score"],
                                                "  [最近用过]" if g["recent"] else ""))
    else:
        print("最近使用的群：")
        for g in recent():
            print("  %-40s %s" % (g["title"], g["id"]))
