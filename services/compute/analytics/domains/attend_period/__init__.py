#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""时段出勤看板 —— 时段出勤率 / 明细 / 全站合并（看板私有）。

成员：attend_period（主计算）、attend_period_source（数据源与进程内数据集）、
attend_period_station（站点维度）、attend_period_all（全部站点合并）、
attend_period_teams（参与站点名单，含同名 json 配置）。

只依赖 `analytics/core/`；不得引用其它看板的域包。
"""
