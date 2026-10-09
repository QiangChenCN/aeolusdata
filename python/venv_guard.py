"""自动把脚本切换到项目 .venv 解释器运行。

放在任何「可运行」脚本的最顶部（在其他 import 之前）：
    import venv_guard  # 自动切换至项目 .venv

效果：
- 若当前解释器已经在 .venv 内，直接放行，不做任何事。
- 若当前不是 venv（例如用系统 python 直接 `python xxx.py` / `python -m pkg.mod`），
  且 python/.venv 存在，则自动用 .venv 的 python 重新执行本脚本，
  从而保证「本空间所有 python 脚本全部使用这个虚拟环境」。

无需手动激活；也不依赖调用方的 cwd（venv 路径基于本文件位置推算）。
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

_HERE = os.path.dirname(os.path.abspath(__file__))       # python/ 目录（本文件所在处）
_COMMON = os.path.join(_HERE, "common")                 # 公共模块目录（nest_client）

# Python 把「脚本所在目录」放进 sys.path[0]，于是深层子目录里的脚本
# `import nest_client ...` 会找不到（它在 common/）。
# 这里统一把项目根与 common/ 补回 sys.path —— 所有脚本只需在最顶部 import venv_guard，
# 无论被放到多深的子目录都能 import 根目录 / common/ 下的公共模块。
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
if _COMMON not in sys.path:
    sys.path.insert(0, _COMMON)


def _venv_dir():
    # 2026-09-24：venv 已从项目根移入 python/ 下，与本文件同级。
    # （旧实现是 dirname(_HERE)/.venv = 项目根；移动后必须改指本目录，否则找不到解释器。）
    return os.path.join(_HERE, ".venv")


def _venv_python():
    venv = _venv_dir()
    cand = os.path.join(venv, "Scripts", "python.exe") if os.name == "nt" \
        else os.path.join(venv, "bin", "python")
    return cand if os.path.isfile(cand) else None


def _ensure_venv():
    # 已在 venv 内，无需处理
    if os.path.normpath(sys.prefix) == os.path.normpath(_venv_dir()):
        return
    py = _venv_python()
    if not py:
        # .venv 不存在：退回当前解释器（由调用方保证环境正确）
        return

    main = sys.modules.get("__main__")
    pkg = getattr(main, "__package__", None)
    if pkg:  # 以 `python -m pkg.mod` 方式运行 → 保持 -m 形式重投
        mod = pkg + "." + os.path.splitext(os.path.basename(main.__file__))[0]
        cmd = [py, "-m", mod]
    else:  # 以 `python script.py` 方式运行 → 直接重投脚本文件
        script = sys.argv[0]
        if not os.path.isfile(script):
            # 非文件型启动（如 `python -c` / `python -i`），无法重投，退回当前解释器
            return
        cmd = [py, os.path.abspath(script)]
    cmd += sys.argv[1:]
    os.execv(py, cmd)


_ensure_venv()
