"""pytest 公共夹具：确保项目根（common/、core/ 所在）在 sys.path，使测试可直接 import。

P0 安全网的一部分：让 `common`、`core`、`dashboard` 等顶层包在测试中被发现，
无需手动设置 PYTHONPATH。

注意：不在此处全局替换 dws_run —— 各测试通过 `monkeypatch subprocess.run` 隔离外部进程，
保留 dws_run 真实实现以便对其行为做特性测试。
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
