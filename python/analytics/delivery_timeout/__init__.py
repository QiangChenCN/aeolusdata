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
"""配送超时看板 —— 计算层（独立看板，逻辑自管，不与其他看板耦合）。

子模块：
  · timeout.py  站点维度配送时效统计（汇总 + 骑手下钻 + 订单明细）

共享基础设施（与考核看板同源，但不耦合其命名空间）：
  · analytics.order_rules    完成态 / 超时 / 取值 / 接单时间归属
  · analytics.assessment.compound / delivery_source / violations / board
    （复合超时 / 运单来源 / 违规处罚 / 完成单计数 —— 属于 analytics 公共分析库，非 assessment 专属）
"""
