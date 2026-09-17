#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""配置中心：所有可变项集中于此，敏感凭据走环境变量（不进代码 / 不进版本库）。

优先级：真实环境变量 > 项目根 .env > 默认值
"""
import os

# 包已迁到 jobs/unsat/ 下：项目根是三级上（jobs/unsat -> jobs -> 根）
_BASE = os.path.dirname(os.path.abspath(__file__))                              # jobs/unsat
_ROOT = os.path.dirname(os.path.dirname(_BASE))                                  # 项目根
OUT_DIR = os.path.join(_BASE, "out")                                             # 产物统一进 out/


def _load_dotenv(path=os.path.join(_ROOT, ".env")):
    """轻量 .env 解析（stdlib only）：仅填充未设置的环境变量。"""
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:
        pass


_load_dotenv()


def env(key, default=""):
    return os.environ.get(key, default)


# ---------- 在线表格 ----------
# 注意：--node 只接受 32 位 dentryUuid 或【完整 URL】。
# 表格链接里的 AVy0mGPotLlLEXAk 是 16 位 dentryKey，直接传会报 nodeId 格式不合法。
#
# 地址不写死：每次用「上次填写的地址」作默认，避免每月换表就要改代码。
#   优先级 = 本次 --sheet-url（顺带记住） > .env 的 UNSAT_SHEET_URL > 上次记住的 > 内置兜底
#   也就是说：.env 显式配了就以它为准；没配就跟着上次走。
_FALLBACK_SHEET_URL = ("https://alidocs.dingtalk.com/spreadsheetv2/AVy0mGPotLlLEXAk/edit"
                       "?dentryKey=AVy0mGPotLlLEXAk")
_LAST_URL_FILE = os.path.join(_BASE, "out", "unsat_data", "last_sheet_url.txt")


def load_last_sheet_url():
    """读上次填写的在线表地址；没有或读不动都返回 None（不抛，缺了只是回落到兜底）。"""
    try:
        with open(_LAST_URL_FILE, encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def save_last_sheet_url(url):
    """把本次填写的地址记下来，下次默认沿用。

    写失败不致命——最多是下次还得重填，所以只提示不中断任务。
    """
    u = (url or "").strip()
    if not u:
        return False
    try:
        os.makedirs(os.path.dirname(_LAST_URL_FILE), exist_ok=True)
        with open(_LAST_URL_FILE, "w", encoding="utf-8") as f:
            f.write(u)
        return True
    except OSError as e:
        print("⚠ 在线表地址没能记住（下次仍需重填）：%s" % e)
        return False


# SHEET_URL_SOURCE 记录地址从哪来，供日志说清「这次用的是哪个、为什么」：
#   env      = .env 里配的 UNSAT_SHEET_URL（显式固化，优先级最高）
#   last     = 上次运行时填写、被记住的地址
#   fallback = 内置兜底（首次使用 / 清过记录时才会落到这）
_ENV_SHEET_URL = env("UNSAT_SHEET_URL")
_LAST_SHEET_URL = load_last_sheet_url()
if _ENV_SHEET_URL:
    SHEET_URL, SHEET_URL_SOURCE = _ENV_SHEET_URL, "env"
elif _LAST_SHEET_URL:
    SHEET_URL, SHEET_URL_SOURCE = _LAST_SHEET_URL, "last"
else:
    SHEET_URL, SHEET_URL_SOURCE = _FALLBACK_SHEET_URL, "fallback"
SHEET_ID = env("UNSAT_SHEET_ID", "s1")


def set_sheet_url(url):
    """运行时覆盖在线表地址（供 --sheet-url / 工作台「文档地址」参数使用）。

    返回 True 表示已覆盖；传入空值表示「不覆盖」，沿用当前值。
    传入的地址会顺带记住，下次运行自动沿用（见 load_last_sheet_url）。

    校验放这里而不是等 dws 报错：dws 对坏地址只回一句
    `can not find file by url=...`，不说是格式问题还是文件没了，排查很费劲。
    """
    u = (url or "").strip()
    if not u:
        return False
    if not (u.startswith("http://") or u.startswith("https://")):
        raise ValueError(
            "文档地址必须是完整 URL（http:// 或 https:// 开头），当前填的是：%r\n"
            "正确取法：打开钉钉在线表 → 复制浏览器地址栏的整条链接。\n"
            "注意：链接里 16 位的 dentryKey 不能单独填，必须填整条 URL。" % u)
    global SHEET_URL
    SHEET_URL = u
    save_last_sheet_url(u)   # 记住，下次默认沿用
    return True

# 明细区：D 列起，到 R 列止，共 15 列，与风神违规处罚 CSV 字段顺序 1:1 对应
DETAIL_START_COL = "D"
DETAIL_END_COL = "R"
DETAIL_COLUMNS = [
    "违规编号", "违规来源", "违规时间", "运单号", "骑手ID", "骑手名称",
    "团队ID", "团队名称", "商ID", "商名称", "违规分类", "违规类型",
    "处罚", "违规状态", "违规原因",
]  # 15 列，顺序必须与 CSV 一致

# 反馈区列（A/B/C）
COL_原因分析 = "A"
COL_改善措施 = "B"
COL_改善动作 = "C"   # 培训图片/视频

# ---------- 钉钉（统一引用 ding_common 单一来源，杜绝多份真相）----------
# 目标群 / 站点映射 / 站长 openid / 禁 @ 名单 全部来自 ding_common，
# 改名（如房瑞铭）、剔除 DO_NOT_AT 等变更只在一处维护，unsat 自动跟随。
from ding_common import (
    GROUP_ID, TEAM_TO_STATION, STATION_MANAGERS,
    MANAGER_OPENID, DO_NOT_AT,
)

# ---------- 大模型（云端 API，OpenAI 兼容协议）----------
LLM_API_KEY = env("UNSAT_LLM_API_KEY", "")
LLM_BASE_URL = env("UNSAT_LLM_BASE_URL", "https://api.deepseek.com/v1")
LLM_MODEL = env("UNSAT_LLM_MODEL", "deepseek-chat")
LLM_TIMEOUT = int(env("UNSAT_LLM_TIMEOUT", "30"))

# ---------- 调度 ----------
FETCH_HOUR = int(env("UNSAT_FETCH_HOUR", "11"))       # 每日拉数时刻
FETCH_MINUTE = int(env("UNSAT_FETCH_MINUTE", "0"))
REMIND_START_HOUR = int(env("UNSAT_REMIND_START", "12"))  # 提醒起始（含）
REMIND_END_HOUR = int(env("UNSAT_REMIND_END", "23"))      # 提醒截止（含），即 24:00 前

# ---------- 路径 ----------
DATA_DIR = os.path.join(OUT_DIR, "unsat_data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "unsat.db")
IMG_PATH = os.path.join(DATA_DIR, "unsat_detail.png")
CSV_PATH = os.path.join(DATA_DIR, "violations.csv")
LOG_PATH = os.path.join(DATA_DIR, "unsat.log")

# 中文字体：UNSAT_FONT_PATH 显式指定优先；否则复用 ding_common 的跨平台自动探测
# （旧默认 Windows 黑体路径在 Linux 上必失败 → 渲染中文变方块）
from ding_common import FONT_PATH as _DING_FONT_PATH
_FONT_ENV = env("UNSAT_FONT_PATH", "")
FONT_PATH = _FONT_ENV if _FONT_ENV and os.path.isfile(_FONT_ENV) else _DING_FONT_PATH

# 主色：淘宝闪购橙
BRAND_COLOR = "#FF5000"
