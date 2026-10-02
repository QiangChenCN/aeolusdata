"""analytics —— 看板**聚合计算**包（纯计算，不做取数、不做渲染）。

2026-09-24 由原 `dashboard` 包改名并拍平：
  · 原名 `dashboard` 名不副实 —— 它早就不渲染看板了（前端是独立的 `web/`），
    这里只把 Nest 取来的原始数据聚合成指标，故改名 `analytics`；
  · 原 `dashboard/standard/` 这层嵌套被取消，模块直接落在本层（同级即可表达）；
  · 取数入口一律走 `sources`（原 get_data），本包不关心数据怎么来。

目录约定（与 Nest 的约定成对，勿单边改动）：
  原始数据在 **项目根** `dashboard/data/{kind}_{team}_{date}.json` —— 那是 Nest
  `RawCacheService` 的唯一写入位置；本包只读不写（`cache.load_raw`）。
  注意名字相近但不是一回事：本包叫 analytics，数据目录仍叫 dashboard/data。

子包：
  · realtime/ —— 实时看板（运单/违规的近实时聚合）
"""
