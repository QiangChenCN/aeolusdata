"""IM 电联看板（独立看板，2026-10-17 新建）。

数据源：Quark/Aeolus FBI 报表 473269「电联 & IM 回复」（透视表，行维度到骑手）。
  · 取数 + 落盘在 Nest `backend/src/modules/im-contact/`（全站单文件覆盖写
    `backend/data/im-contact-实时.json`），本包只读盘计算，零 HTTP。
  · 与考核看板（analytics/assessment）**不共用任何业务代码**：字段口径、聚合逻辑
    均在本目录独立实现；仅复用基础设施 `analytics.cache`（进程内结果缓存 / 今日日期）。

口径（与报表一致，比率一律由单量重算、不跨行平均）：
  · 送达电联率   = 剔除后有效电联单量 / 剔除后接单量 × 100
  · IM及时回复率 = IM及时回复单量 / IM咨询单量 × 100
"""
