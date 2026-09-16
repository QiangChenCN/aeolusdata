#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标准达成看板 —— 「参与站点」配置（系统设置 → 参与站点）。

用途：决定「获取 / 刷新数据」与「生成数据」覆盖哪些站点。
以前端点只认前端传来的单个 team（默认万科），现在全量刷新按本配置
逐个站点拉三源并生成结果，看板可切「全部站点」查看合并数据。

存储：dashboard/standard/teams_config.json  {"teams": ["917521130", ...]}
默认：三个常管 -UB 站（黄江镇 / 长安万科 / 大岭山大学城）。

本模块只做「读写配置」，不含取数 / 业务逻辑；写文件用原子写（先 .tmp 再 rename），
与 grade_standards 一致，避免半截文件被读。
"""
import os
import json
import threading

_HERE = os.path.dirname(os.path.abspath(__file__))
_PATH = os.path.join(_HERE, "teams_config.json")
_LOCK = threading.Lock()

# 默认参与站点（用户日常看板的三个 -UB 站）
DEFAULT_TEAMS = ["917521130", "917521136", "917521139"]


def _atomic_write(obj):
    tmp = _PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, _PATH)


def get_teams():
    """返回参与站点 id 列表（list[str]）。文件缺失 / 空 → 返回默认值（不落盘）。"""
    try:
        with open(_PATH, "r", encoding="utf-8") as f:
            obj = json.load(f)
    except Exception:
        return list(DEFAULT_TEAMS)
    ids = (obj or {}).get("teams")
    if not isinstance(ids, list):
        return list(DEFAULT_TEAMS)
    out = [str(x).strip() for x in ids if str(x).strip()]
    return out or list(DEFAULT_TEAMS)


def set_teams(ids):
    """保存参与站点 id 列表。返回 (ok, teams, msg)。

    校验：必须是非空字符串列表；去重但**保留顺序**（顺序即刷新顺序）。
    """
    if not isinstance(ids, list) or not ids:
        return False, get_teams(), "参与站点不能为空"
    clean, seen = [], set()
    for x in ids:
        s = str(x).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        clean.append(s)
    if not clean:
        return False, get_teams(), "参与站点不能为空"
    with _LOCK:
        try:
            _atomic_write({"teams": clean})
        except Exception as e:
            return False, get_teams(), "写入失败：%s: %s" % (type(e).__name__, e)
    return True, clean, ""


if __name__ == "__main__":
    print(json.dumps({"teams": get_teams()}, ensure_ascii=False))
