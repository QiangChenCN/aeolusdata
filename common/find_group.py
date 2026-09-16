#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""按群名（关键词）查询钉钉群 openConversationId。

匹配方式：纯字符匹配度（不归一化、不去 emoji/空白、不转小写、无口语别名表）。
  - 群名里含有你说的关键词 → 100%
  - 例如你说「发送到 测试 群」，只要存在一个名为「测试」的群，匹配度就是 100%
数据源：全量群列表(chat-list-all) ∪ chat-search ∪ groups.json 登记的隐藏群号(chat-get-by-id 动态解析)，按字符匹配度打分选群。
注意：部分群（如「🤖机器人测试」）不出现在 chat-list-all/chat-search 里，需用 +chat-get-by-id 按群号拉取。
这些"隐藏群号"放在同目录 groups.json（纯数据，不写死在代码里），格式：{"known_group_numbers": [168960000221]}。

用法：
  python find_group.py                      # 列出我加入的全部群（name + id）
  python find_group.py 站点                  # 按关键词「站点」模糊搜群
  python find_group.py 站点 --exact          # 仅返回群名完全相等的结果
  python find_group.py 站点 --json           # 输出 JSON（供脚本解析）
  python find_group.py 站点 --id-only        # 只打印 openConversationId（便于管道）

作为模块被 attendance.py / appeal_reminder.py / find_group 类脚本调用：
  from find_group import resolve_group_id
  gid, title = resolve_group_id("站点日常管理通知群")   # 返回 (id, 群名)
"""
import os
import sys
import json

# dws 封装见 ding_common（统一路径 + JSON 解析）
from ding_common import dws_json

# 隐藏群号配置文件（纯数据，不写死在代码里）。chat-list-all/chat-search 漏掉的群
# （如「🤖机器人测试」）在此登记数字群号，运行时用 +chat-get-by-id 动态解析群名+cid。
# 新增隐藏群只需改这个 JSON，不必动 .py。
GROUP_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "groups.json")


def load_known_group_numbers():
    if not os.path.exists(GROUP_CONFIG_PATH):
        return []
    try:
        cfg = json.load(open(GROUP_CONFIG_PATH, encoding="utf-8"))
        nums = cfg.get("known_group_numbers", []) or []
        return [int(n) for n in nums]
    except Exception:
        return []


# dws 封装见 ding_common.dws_json（统一调用 + JSON 解析）


def _result_block(payload):
    """兼容 +chat-search（result.groups）与 +chat-list-all（顶层 groups）。"""
    if isinstance(payload, dict):
        if isinstance(payload.get("result"), dict):
            return payload["result"]
        if "groups" in payload:
            return payload
    return {}


def _groups_from_payload(payload):
    groups = _result_block(payload).get("groups", []) or []
    # 归一化：chat-search 返回 title，chat-list-all 返回 name；统一成 title
    for g in groups:
        if not g.get("title"):
            g["title"] = g.get("name") or ""
    return groups


def _pager(payload):
    """返回 (has_more, cursor)。"""
    blk = _result_block(payload)
    cur = blk.get("nextCursor") or blk.get("cursor")
    return bool(blk.get("hasMore")), cur


def search_groups(query, limit=20):
    """按关键词模糊搜索群，自动翻页拉全。"""
    groups = []
    cursor = None
    while True:
        args = ["chat", "+chat-search", "--query", query, "--limit", str(limit)]
        if cursor:
            args += ["--cursor", str(cursor)]
        payload = dws_json(args)
        groups.extend(_groups_from_payload(payload))
        has_more, cursor = _pager(payload)
        if not has_more or not cursor:
            break
    return groups


def list_all_groups():
    """列出我加入的全部群（分页拉全）。"""
    groups = []
    cursor = None
    while True:
        args = ["chat", "+chat-list-all"]
        if cursor:
            args += ["--cursor", str(cursor)]
        payload = dws_json(args)
        groups.extend(_groups_from_payload(payload))
        has_more, cursor = _pager(payload)
        if not has_more or not cursor:
            break
    return groups


def get_group_by_number(num):
    """按群号(数字)用 +chat-get-by-id 获取群信息，返回 {title, openConversationId, groupId, memberCount}。

    用于把 chat-list-all / chat-search 漏掉的群（如「🤖机器人测试」）纳入候选池。
    群名与 ID 均为运行时动态获取，不写死。
    """
    payload = dws_json(["chat", "+chat-get-by-id", "--group-id", str(num)])
    info = (payload.get("result") or {}).get("groupInfo") or {}
    if not info or not info.get("openConversationId"):
        return None
    return {
        "title": info.get("title") or "",
        "openConversationId": info.get("openConversationId"),
        "groupId": info.get("groupId"),
        "memberCount": info.get("memberCount"),
    }


def score_match(q, t):
    """纯字符匹配度，0~100，不做归一化（不转小写、不去 emoji/空白）。

    - 精确相等 (q == t)                                  : 100
    - q 是 t 的子串（如「测试」⊆「站点日常管理...」）       : 100
    - t 是 q 的子串（如「测试」⊆「测试群」）               : 100
    - 否则按字符交集/并集占比给分                           : 0~<100
    """
    if not q or not t:
        return 0
    if q == t:
        return 100
    if q in t:                                  # 查询词被群名完全包含（如「测试」⊆「站点…测试」）
        return 100
    if t in q:                                  # 群名被查询词完全包含（如「测试」⊆「🤖机器人测试」）
        return int(100 * len(t) / len(q))       # 按长度比例给分，明显低于精确相等
    qs, ts = set(q), set(t)
    inter = qs & ts
    if not inter:
        return 0
    union = qs | ts
    return int(100 * len(inter) / len(union))


def resolve_group_id(name, exact=False):
    """按群名（原始字符，不归一化）解析 openConversationId，不写死任何 ID。

    候选池 = 全量群列表(chat-list-all) ∪ chat-search 结果（去重）。
    匹配：纯字符匹配度打分（见 score_match）；最佳分=100 且唯一，或最佳分≥70 且明显
    领先第二名则自动返回；否则抛错列出候选群，避免发错群。
    返回 (openConversationId, 群名)。
    """
    q = (name or "").strip()
    if not q:
        raise SystemExit("群名不能为空")

    # 候选池：全量列表为主（chat-search 有时搜不到特殊词的群），search 结果补并集；
    # 再用已知群号(chat-get-by-id)硬补充——覆盖 chat-list-all 漏掉的群。
    pool = {}
    for g in list_all_groups():
        if g.get("openConversationId"):
            pool[g["openConversationId"]] = g
    try:
        for g in search_groups(name):
            if g.get("openConversationId"):
                pool.setdefault(g["openConversationId"], g)
    except Exception:
        pass
    for num in load_known_group_numbers():
        try:
            g = get_group_by_number(num)
            if g and g.get("openConversationId"):
                pool.setdefault(g["openConversationId"], g)  # 列表里已有则不动
        except Exception:
            pass
    groups = list(pool.values())
    if not groups:
        raise SystemExit("未获取到任何群列表，请确认钉钉连接器已连接")

    scored = []
    for g in groups:
        title = g.get("title") or g.get("name") or ""
        if not title:
            continue
        s = score_match(q, title)
        if s >= 60:
            scored.append((s, g, title))
    if not scored:
        raise SystemExit("未找到与「%s」匹配的群；可运行 find_group.py（不带参数）查看全部群名" % name)

    scored.sort(key=lambda x: -x[0])
    best_s, best_g, best_title = scored[0]
    second_s = scored[1][0] if len(scored) > 1 else 0
    top100 = [x for x in scored if x[0] == 100]
    exact_hits = [x for x in scored if x[0] == 100 and x[2].strip() == q]

    if exact:
        # 精确模式：仅当群名原始字符完全相等才返回
        if exact_hits:
            return exact_hits[0][1]["openConversationId"], exact_hits[0][2]
        raise SystemExit("未找到群名精确等于「%s」的群" % name)

    # 精确相等优先：「测试」查询优先命中名为「测试」的群，而非含「测试」的「🤖机器人测试」群
    if len(exact_hits) == 1:
        return exact_hits[0][1]["openConversationId"], exact_hits[0][2]
    # 唯一候选直接返回（无论分数，只要 ≥60）
    if len(scored) == 1:
        return best_g["openConversationId"], best_title
    # 自动返回条件：满分且唯一，或最佳分≥70 且明显领先第二名
    if len(top100) == 1:
        return top100[0][1]["openConversationId"], top100[0][2]
    if best_s >= 70 and (best_s - second_s) >= 10:
        return best_g["openConversationId"], best_title

    # 多候选 / 接近：列出让用户消歧
    lines = "\n".join("  - %s  (%s)  匹配分%.0f" % (title, g["openConversationId"], s)
                      for s, g, title in scored[:8])
    raise SystemExit("群名「%s」匹配到多个群（或匹配不明确），请给更精确的关键词：\n%s" % (name, lines))


def main():
    args = sys.argv[1:]
    as_json = "--json" in args
    id_only = "--id-only" in args
    exact = "--exact" in args
    for f in ("--json", "--id-only", "--exact"):
        while f in args:
            args.remove(f)
    keyword = args[0] if args else None

    if keyword:
        groups = search_groups(keyword)
        if exact:
            groups = [g for g in groups if g.get("title", "").strip() == keyword]
        else:
            # 原始字符子串匹配（不转小写、不归一化）
            filtered = [g for g in groups if keyword in (g.get("title") or "")]
            groups = filtered or groups
    else:
        groups = list_all_groups()
        # 把已知群号也并入（动态解析，覆盖列表接口漏掉的群）
        for num in load_known_group_numbers():
            try:
                g = get_group_by_number(num)
                if g and g.get("openConversationId"):
                    if not any(x.get("openConversationId") == g["openConversationId"] for x in groups):
                        groups.append(g)
            except Exception:
                pass

    if not groups:
        print("未找到匹配的群" + ("" if keyword is None else "（关键词：%s）" % keyword))
        return

    if as_json:
        print(json.dumps(groups, ensure_ascii=False, indent=2))
        return
    if id_only:
        for g in groups:
            print(g.get("openConversationId"))
        return

    print("找到 %d 个群：" % len(groups))
    for g in groups:
        extra = ""
        if g.get("memberCount") is not None:
            extra = "  成员%d" % g["memberCount"]
        print("  %-42s %s%s" % (g.get("title"), g.get("openConversationId"), extra))


if __name__ == "__main__":
    main()
