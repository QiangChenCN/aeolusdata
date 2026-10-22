#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""看板域层（domains）—— 一个目录 = 一个看板，逻辑自管、互不共享。

与 `analytics/core/` 的分工：
  · core     = 共享契约（改一处影响所有看板，改动需知会全部使用方）
  · domains  = 看板私有（随便重构，只要不改自己的公开面就不影响别人）

跨看板引用规则（由 `services/compute/scripts/check-arch.mjs` 的 R4 强制）：
  `domains/<A>` 不得引用 `domains/<B>` —— 同一个指标在不同看板允许有不同算法，
  一旦互引就会变成「改 A 的口径连累 B」。既有的例外登记在
  `services/compute/scripts/arch-baseline.json`，属待还技术债。
"""
