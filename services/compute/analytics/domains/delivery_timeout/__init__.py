#!/usr/bin/env python3
# -*- coding: utf-8 -*-
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


"""配送超时看板 —— 计算层（看板私有包：口径自管，不与其他看板共享业务算法）。

本包的**公开面**（其它看板若要引用，只允许从这里取，不得深引内部文件，
规则由 services/compute/scripts/check-arch.mjs 的 R4 强制）：

  · timeout.build_one(team_id, date)        站点配送超时统计（汇总 + 骑手下钻 + 订单明细）
  · handler.get_delivery_timeout(h, qs)     HTTP handler（compute_api 的路由表引用）
  · data_source.load_orders(team_id, date)  本看板自有的实时运单明细（PG，经 Nest 内部端点）

允许的共享依赖（已登记为共享契约，改动需知会全部使用方）：
  · analytics.core.cache / analytics.core.order_rules

**未结清的跨看板依赖**（已登记在 services/compute/scripts/arch-baseline.json，属待还技术债）：
  · analytics.domains.assessment.compound   —— 复合超时口径
  · analytics.domains.assessment.violations —— 提前点送达扣减
  · analytics.domains.assessment.result_store —— 结果落盘（中性工具，位置放错了，建议提为共享层）
  这三项意味着「考核改口径会带着本看板变」，与看板独立原则冲突，计划按基线里的方案迁走。
"""

__all__ = ['timeout', 'handler', 'data_source']
