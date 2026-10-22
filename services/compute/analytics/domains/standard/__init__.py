#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标准达成看板 —— 站点维度 / 骑手维度的达成计算（看板私有）。

成员：achievement（站点达成）、rider_dimension（骑手维度）、station_report（站点报表）、
site_orders（站点接单/完成量）、multi_team（多站并行的取数-计算编排）、
rider_period_detail（骑手时段明细）。

只依赖 `analytics/core/`（cache / order_rules / grade_standards / teams_config）；
不得引用其它看板的域包。
"""
