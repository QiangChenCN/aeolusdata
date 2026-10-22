#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""实时数据看板 —— 配置层（仅所选站点）。

原散落在 server.py 的实时看板配置逻辑统一迁至此：
  · 所选站点  .assessment_selection.json（按账号持久化，多端同步）
考核目标（三档阈值 / 权重 / 计分方式）已并入「服务质量设置」，
  见 analytics/service_quality.py（按月份，唯一来源，写入由 Nest 负责）。

本模块只做「文件读写 + 校验 + 种子」，不含 HTTP / 鉴权 / 数据权限，
那些留在 server.py 的路由处理器里。
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


import json
SEL_FILE = os.path.join(_ROOT, ".assessment_selection.json")
# 一次性迁移：旧文件名为 .realtime_selection.json（realtime 包改名前），存在则复制为新文件
OLD_SEL_FILE = os.path.join(_ROOT, ".realtime_selection.json")


# ===================== 所选站点 =====================
def _migrate_sel_if_needed():
    """旧 .realtime_selection.json 存在而新文件缺失时，复制为新文件（保留用户已选站点）。"""
    if not os.path.exists(SEL_FILE) and os.path.exists(OLD_SEL_FILE):
        try:
            import shutil
            shutil.copyfile(OLD_SEL_FILE, SEL_FILE)
        except OSError:
            pass


def load_assessment_sel():
    """返回 {username: [team_id, ...]}；文件缺失/损坏返回 {}。"""
    _migrate_sel_if_needed()
    try:
        with open(SEL_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


def save_assessment_sel(obj):
    """原子写所选站点（tmp + fsync + replace，权限 0o600）。"""
    tmp = SEL_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush(); os.fsync(f.fileno())
    os.replace(tmp, SEL_FILE)
    try:
        os.chmod(SEL_FILE, 0o600)
    except OSError:
        pass
