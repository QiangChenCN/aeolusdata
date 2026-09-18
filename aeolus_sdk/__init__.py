"""aeolus_sdk —— 风神(Aeolus) SSO 登录（本项目的【唯一】客户端 SSO 凭据模块）。

  · aeolus_sdk.login    风神 SSO 登录（AEO_COOKIE 来源）。详见 login.py

Quark 报表取数已迁出到 get_data（get_data.rider_equipment.fetch_report_view 骑手装备点亮明细），
aeolus_sdk 现仅承担「风神 SSO 登录」这一地基职责，供 quark_sdk / get_data 等上层复用。

设计原则：任何场景都通过 aeolus_sdk.login 拿到 cookie，
不得各写一套登录、也不得把登录态写进公共记忆 / 共享文件。
风神是单点登录：浏览器在线会把脚本会话顶掉，因此「用的时候现登现用」最稳。
"""
from . import login
from . import xlock

__all__ = ["login", "xlock"]
