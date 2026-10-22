#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""共享契约层（core）—— 被 ≥2 个看板共同依赖、且语义上必须统一的基础模块。

**改这里的任何一个模块，都会同时影响所有看板。** 因此约定：

  · 只放「口径必须一致」的东西：时间/日期口径、原始层读写、运单字段取值、站点目录、
    等级标准、时段配置；
  · 不放任何单个看板的业务算法 —— 同一个指标在不同看板允许有不同算法，
    那种算法属于 `analytics/domains/<看板>/`；
  · 修改前先确认调用方清单（`grep -rn "analytics.core.<模块>" python`）。

当前成员：
  · cache.py          原始层读写 + 进程内结果缓存（所有看板的输入/输出端口）
  · order_rules.py    运单字段取值 / 完成态 / 超时判定（口径单一来源）
  · teams_config.py   参与站点名单
  · period_config.py  时段定义
  · grade_standards.py 等级标准（阈值/封顶）
"""
