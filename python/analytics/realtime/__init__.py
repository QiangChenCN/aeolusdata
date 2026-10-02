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

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""实时数据看板 —— 后端计算与配置。

把实时数据看板相关的全部后端逻辑（站点概览指标计算、用户所选站点、考核目标
配置 / 校验 / 种子）集中到本包，server.py 仅保留 HTTP 路由与鉴权。

子模块：
  · board.py   站点概览指标计算（推配送单量 / 配送完成单 / T8超时单 / T8准时率）
  · config.py  所选站点持久化 + 考核目标配置（阈值种子 / 校验 / 读写）
"""
