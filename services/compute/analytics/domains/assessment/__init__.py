from analytics.core.paths import ROOT, PY_HOME, _ROOT  # noqa: E402,F401 <<<


#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""考核看板 —— 后端计算与配置（独立看板，取数 / 计算代码自管，不与其他看板共用）。

计算层全部集中到本包；取数层在 Nest（`apps/api/src/modules/assessment/`，违规处罚明细
自有取数，入库 PG 表 delivery_realtime / violation_realtime / violation）。基础库 cache / order_rules / teams_config 保留共用。

子模块（即本包的**公开面**，见下面 `__all__`）：
  · board.py        站点概览指标计算（推配送单量 / 配送完成单 / T8超时单 / T8准时率 + 违规派生）
  · compound.py     复合超时（配送时长构成）
  · violations.py   违规处罚明细读侧 + 口径统计（仅读自有命名空间，零 HTTP）
  · config.py       所选站点持久化 + 考核目标配置（阈值种子 / 校验 / 读写）
  · period.py       时段出勤（跨格加权）
  · delivery_source.py / visit_source.py  本看板自有的运单 / 拜访数据源

跨看板边界（由 services/compute/scripts/check-arch.mjs 的 R4 强制）：
  其它看板不得引用本包内部模块。目前存在的两条引用已登记为**待还技术债**
  （见 services/compute/scripts/arch-baseline.json）：
    · delivery_timeout → compound / violations
    · 本包 → im_contact.source（历史区间需要电联率 / IM 回复率）
  偿还方向：把「确实共享」的部分下沉为共享层，让两个看板各自显式声明用哪套参数，
  而不是共享同一份会变的业务口径。

注：result_store 是中性落盘工具（结果目录已是中性的 apps/api/runtime/results/），已下沉为 analytics/core/result_store.py。
引用方统一改为 `from analytics.core import result_store`（仅改 import 路径、未动逻辑）。
"""

__all__ = [
    'board', 'compound', 'violations', 'config', 'period',
    'delivery_source', 'visit_source',
]

# 显式导入公开子模块，使 `from analytics.domains.assessment import board` 等在任何导入时序下
# 都能直接取到包属性。否则依赖 Python 的惰性子模块解析，在循环导入时序下会报
# "cannot import name 'board' from 'analytics.domains.assessment'"。
# 注意：board 必须排在 period 之前（period 反向依赖 board）；assessment_overview 故意不在此处
# 惰性导入（它跨域依赖 standard / attend_period，避免包导入阶段引入跨域环）。
from . import (  # noqa: E402,F401
    board, compound, violations, config, period,
    delivery_source, visit_source,
)
