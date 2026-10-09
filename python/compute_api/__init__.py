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

"""AeolusData 独立计算服务包。

- `main.py`     FastAPI 应用（只算、不鉴权；鉴权与数据权限裁决在 NestJS）。
- `handlers.py` 计算 handler 库：命名空间端点（standard / attend-period / overview /
  realtime）的派发表与实现，原根目录 `server.py` 的计算子集。
"""
