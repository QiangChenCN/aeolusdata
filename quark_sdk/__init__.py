# quark_sdk —— Quark（阿里内部报表平台）凭证与连接辅助全家桶。
#
# 取数逻辑已迁出到 get_data/rider_equipment.py（骑手装备点亮明细），本包现仅承载：
#   · quark_creds.py    —— Quark 凭证/连接层（DA cookie 兑换+缓存+健康探针+报表三件套 token 提取）
#   · quark_da_auth.py  —— 仅负责 DA_TOKEN 纯 HTTP 兑换 + 写 curl jar（被 quark_creds 调用）
#   + Quark 系凭据（quark_da_cache.json / quark_da_cookies.txt）
#
# 与 aeolus_sdk（风神 SSO 登录地基）分层一致：
#   · aeolus_sdk/        —— 风神 SSO 登录（login.py），作为被复用的地基
#   · quark_sdk/         —— Quark 凭证/连接层（被 get_data.rider_equipment 取数时调用）
#   · get_data/          —— 各业务接口取数（含 rider_equipment 骑手装备点亮明细）
#
# quark_creds 通过同包相对导入 `from .quark_da_auth import acquire_da_token` 调用鉴权子模块；
# SSO cookie 由 aeolus_sdk.login 提供（venv_guard 已把项目根注入 sys.path，可直接 import）。
from . import quark_creds
from . import quark_da_auth

__all__ = ["quark_creds", "quark_da_auth"]
