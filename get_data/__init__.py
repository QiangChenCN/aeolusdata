"""get_data —— 所有「HTTP 获取数据」方法的统一归属地（单一来源）。

本包只放「纯 HTTP 取数」的实现（复用风神/Quark 等 SSO cookie，不依赖浏览器/CDP），
供各任务脚本（jobs/*）与标准达成工作区（dashboard/standard/*）调用。

★ 硬性约定（详见工作区永久记忆 MEMORY.md「get_data 取数约定」）：
- 每个模块 = 一个接口，只做「打接口取数」一件事，返回接口原始数据（dict / list[dict]）。
- 查询参数（日期 / 站点 / page / period …）由调用方传入；模块内部不做选日期、选站点、自动决定时间窗。
- cookie 现已改为「可选」：各模块统一 `from aeolus_sdk import login as L`，
  调用时若未传 cookie 则自动 `L.ensure_cookies()` 登录（风神 SSO）；传了就用调用方给的。
  Quark 系模块（rider_equipment）走 quark_sdk.creds 自动兑换 DA_TOKEN，不在此列。
- 允许模块内 ensure_cookies() 自动登录；仍禁止「会话失效后自动重登循环（AuthError 重试）」，
  那部分归调用方 / dashboard/standard 的 Session 封装。
- 禁止在模块内做：统计 / 筛选 / 格式化、落盘写文件、CLI 解析、分页以外的编排。
- 这些加工逻辑归调用方（jobs/* 或 dashboard/standard/*）。

目前成员：
- attendance : 实时考勤取数（xtop.fs.special.realtimeattendance.listAttendance/1.0）
              暴露 fetch_team(team_id, time_code, cookie=None)；统计/筛选在 jobs/attendance 内。
- teams      : 站点发现（选站点）取数（xtop.lpd.intelligentConfig.getTeamsAll/1.0）
              暴露 fetch_teams(cookie=None)；选站逻辑归调用方。
- delivery   : 运单明细取数（xtop.agencyTrackingFs.queryTracking/2.0）
              暴露 query(单页) / fetch(分页拉全量，cookie=None)；落盘/断点续传/重登在 jobs/delivery/raw_fetch.py。
- violation  : 风控处罚 CSV 取数（xtop.lpd.quality.control.violation...download/1.0）
              暴露 download_csv(start_ms, end_ms, cookie=None) -> (text, file_url)；
              被 jobs/appeal 与 jobs/unsat 共用（同一端点，单一来源）；日期窗口/落盘/筛选归调用方。
- board      : 站长任务看板取数（xtop.ryze.fs.agency.team.task.listByPage/1.0）
              暴露 fetch(status="started", page_size=100, cookie=None) -> list[dict]；筛已开始/剩余时间/渲染归 jobs/board。
- rush       : dispatcher 急单取数（skyeye.paging + shippingOrderQuery.list/detail 三连调）
              暴露 fetch_team(team_id, station, cookie=None) -> dict；merge/写盘归 jobs/rush。
- orange_storm: 橙色风暴 QC 抽检取数（alsc-lpd-omp-inspection-prod/qc/fs/judgement/queryQcList）
              暴露 fetch_all(start_ms, end_ms, cookie=None, page_size=200) -> (rows, total)；flatten/写盘归 jobs/orange_storm。
- ruledoc    : 骑士规则中心取数（xtop.robot.admin.ruleInfoViewFs.queryRuleInfo/1.0）
              暴露 query_rule(rule_id, is_history, cookie=None) -> data + RuleQueryError；渲染/写盘归 jobs/ruledoc。
- schedule_statistics: 排班目标取数（xtop.fs.special.schedule.listScheduleStatistics/1.0）
              暴露 query(team_id, start_date, end_date, cookie=None) -> rows + AuthError；
              Session 自动重登 / flatten 归 dashboard/standard/schedule_statistics.py。
- rider_equipment: 骑手装备点亮明细取数（Quark/FBI 报表）
              暴露 fetch_report_view(...)；凭证/DA_TOKEN 兑换委托 quark_sdk.creds 自动完成。

后续其它 HTTP 取数按同样约定迁进本包，实现「取数逻辑单一来源、调用方只做编排」。
"""
