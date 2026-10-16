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
"""考核看板 —— 后端计算与配置（独立看板，取数 / 计算代码自管，不与其他看板共用）。

计算层全部集中到本包；取数层在 Nest（`backend/src/modules/assessment/`，违规处罚明细
自有取数，全站合并落盘到 backend/data/违规处罚明细-实时.json（覆盖写））。基础库 cache / order_rules / teams_config 保留共用。

子模块：
  · board.py        站点概览指标计算（推配送单量 / 配送完成单 / T8超时单 / T8准时率 + 违规派生）
  · compound.py     复合超时（配送时长构成）
  · violations.py   违规处罚明细读侧 + 口径统计（仅读自有命名空间，零 HTTP）
  · result_store.py 计算结果持久化（backend/data/results/，文件名加 assessment_ 前缀，已彻底迁出 assessment/ 命名空间）
  · config.py       所选站点持久化 + 考核目标配置（阈值种子 / 校验 / 读写）
"""
