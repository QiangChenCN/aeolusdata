"""跨语言路径契约（monorepo 标准落地）。

取代各模块顶部重复的 `_find_repo_root` / `_find_python_home` bootstrap。
- 仓库根：env `AEOLUS_REPO_ROOT` 优先；兜底只认 `.git`（子包 apps/api 自身带
  package.json，若用 package.json 兜底会误停在 apps/api，算错仓库根）。
- 子目录位置统一从仓库根 `config/paths.json` 读取，杜绝散落硬编码。

兼容导出 `ROOT` / `PY_HOME` / `_ROOT` 供现有代码逐步迁移；
新增 `dirs.*` 函数供新代码按语义取目录。
"""
import os as _os
import json as _json
import sys as _sys

_REPO_ROOT_ENV = "AEOLUS_REPO_ROOT"


def _find_python_home():
    d = _os.path.dirname(_os.path.abspath(__file__))
    while d and not (
        _os.path.isdir(_os.path.join(d, "analytics"))
        and _os.path.isdir(_os.path.join(d, "compute_api"))
    ):
        d = _os.path.dirname(d)
    return d


def _find_repo_root():
    # 兼容现有 PROJECT_ROOT（api 侧现用）；AEOLUS_REPO_ROOT 为新的统一契约变量。
    env = _os.environ.get(_REPO_ROOT_ENV) or _os.environ.get("PROJECT_ROOT")
    if env:
        return env
    d = _os.path.dirname(_os.path.abspath(__file__))
    while d and d != _os.path.dirname(d):
        if _os.path.exists(_os.path.join(d, ".git")):
            return d
        d = _os.path.dirname(d)
    return _os.path.dirname(_os.path.abspath(__file__))


PY_HOME = _find_python_home()
ROOT = _find_repo_root()
_ROOT = ROOT
if PY_HOME and PY_HOME not in _sys.path:
    _sys.path.insert(0, PY_HOME)


def _load_contract():
    with open(_os.path.join(ROOT, "config", "paths.json"), "r", encoding="utf-8") as f:
        return _json.load(f)


_CONTRACT = _load_contract()
_DIRS = _CONTRACT["dirs"]


def repo_root():
    return ROOT


def python_home():
    return PY_HOME


def _abs(rel):
    return _os.path.join(ROOT, rel)


def apps_api_runtime_dir(sub=None):
    base = _abs(_DIRS["appsApiRuntime"])
    return _os.path.join(base, sub) if sub else base


def compute_standard_dir(sub=None):
    base = _abs(_DIRS["computeStandard"])
    return _os.path.join(base, sub) if sub else base


def shared_cache_dir(sub=None):
    base = _abs(_DIRS["sharedCache"])
    return _os.path.join(base, sub) if sub else base


def apps_api_config_dir(sub=None):
    base = _abs(_DIRS["appsApiConfig"])
    return _os.path.join(base, sub) if sub else base


def apps_web_dist_dir(sub=None):
    base = _abs(_DIRS["appsWebDist"])
    return _os.path.join(base, sub) if sub else base


import types as _types

# 与 apps/api/src/config/paths.ts 的 `dirs.*` 对齐，便于两端调用风格一致。
dirs = _types.SimpleNamespace(
    runtime=apps_api_runtime_dir,
    config=apps_api_config_dir,
    appsWebDist=apps_web_dist_dir,
    computeStandard=compute_standard_dir,
    sharedCache=shared_cache_dir,
)
