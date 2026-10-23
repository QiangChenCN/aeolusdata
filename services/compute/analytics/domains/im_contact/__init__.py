"""IM 电联看板（独立看板，2026-10-17 新建）。

数据源：Quark/Aeolus FBI 报表 473269「电联 & IM 回复」（透视表，行维度到骑手）。
  · 取数 + 累计落库在 Nest `apps/api/src/modules/im-contact/`：默认取 T-1 所在月整月，
    按 送达日期+骑手id 去重 upsert 到 SQLite `apps/api/runtime/db/im_contact.db`
    （跨月累计历史），同时每月导出可读备份 `apps/api/runtime/IM电联明细.YYYY-MM.json`；
    本包只读库计算，零 HTTP。
  · 与考核看板（analytics/assessment）**不共用任何业务代码**：字段口径、聚合逻辑
    均在本目录独立实现；仅复用基础设施 `analytics.core.cache`（进程内结果缓存 / 今日日期）。

口径（与报表一致，比率一律由单量重算、不跨行平均）：
  · 送达电联率   = 剔除后有效电联单量 / 剔除后接单量 × 100
  · IM及时回复率 = IM及时回复单量 / IM咨询单量 × 100

公开面（`__all__`）：
  · board.py   区间聚合（供 compute_api 的 /api/im-contact/data 调用）
  · source.py  IM 库读取（本看板私有数据源）

跨看板边界（services/compute/scripts/check-arch.mjs 的 R4）：其它看板不得引用本包内部模块。
现存的一条反向依赖已登记为待还技术债（services/compute/scripts/arch-baseline.json）：
  analytics.domains.assessment.board / period → analytics.domains.im_contact.source
  （考核看板历史区间需要电联率 / IM 回复率）
偿还方向：把 IM 指标的读取下沉为共享数据服务，两侧都改读共享层。
"""

__all__ = ['board']
