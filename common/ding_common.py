#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""钉钉相关脚本的公共模块：统一路径、dws CLI 封装、重试、群/站长配置。

被 attendance.py / appeal_reminder.py / find_group.py / send_task_board.py 引用，消除重复定义。
（机器相关的绝对路径在此集中，#6 待改为环境变量读入。）
"""
import os
import sys
import json
import glob
import shutil
import subprocess
import time
import logging

log = logging.getLogger("ding_common")

# ---------- 机器相关路径：环境变量 / .env / 默认值 三级解析 ----------
# 换机或重装后只需设置环境变量（或项目根 .env），无需改代码。
# 真实环境变量优先于 .env；两者皆无则回退硬编码默认值（保持原行为）。
_ROOT = os.path.dirname(os.path.abspath(__file__))


def _load_dotenv(path=os.path.join(_ROOT, ".env")):
    """轻量 .env 解析（stdlib only）：仅填充未设置的环境变量，不覆盖已有 env。"""
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
        log.warning("读取 .env 失败，已忽略: %s", path)


_load_dotenv()


def get_path(env_key, default):
    """返回路径：优先环境变量 env_key，否则 .env（已在导入时载入），否则 default。"""
    return os.environ.get(env_key, default)


def _resolve_node():
    """返回可用的 node 可执行文件路径（仅作为 WorkBuddy 捆绑 dws.js 的回退）。

    优先级：环境变量 DING_NODE_BIN → PATH 里的 node → WorkBuddy 托管版本目录。
    """
    env_node = os.environ.get("DING_NODE_BIN")
    if env_node and os.path.isfile(env_node):
        return env_node

    which = shutil.which("node")
    if which:
        return which

    versions_dir = "C:/Users/ChenQiang/.workbuddy/binaries/node/versions"
    candidates = sorted(glob.glob(os.path.join(versions_dir, "*/node.exe")))
    if candidates:
        return candidates[-1]

    return os.path.join(versions_dir, "22.22.2-2/node.exe")


def resolve_dws_cmd():
    """返回调用 dws 的命令前缀（列表）。

    dws 是钉钉官方开源 CLI（DingTalk-Real-AI/dingtalk-workspace-cli），可独立安装运行，
    不再依赖 WorkBuddy。解析优先级：
      1) 环境变量 DING_DWS_BIN 指向的独立 dws 可执行文件（如 `npm i -g dingtalk-workspace-cli`）
      2) PATH 里的 `dws`
      3) 回退：WorkBuddy 捆绑的 node + dws.js（兼容旧装机的 Windows 环境）
    """
    env_dws = os.environ.get("DING_DWS_BIN")
    if env_dws and os.path.isfile(env_dws):
        return [env_dws]

    which_dws = shutil.which("dws")
    if which_dws:
        return [which_dws]

    # 回退：旧环境用 WorkBuddy 捆绑的 node 跑 dws.js
    node = _resolve_node()
    dws_js = get_path(
        "DING_DWS_JS",
        "C:/Users/ChenQiang/.workbuddy/binaries/node/cli-connector-packages/node_modules/dingtalk-workspace-cli/bin/dws.js",
    )
    return [node, dws_js]


NODE = _resolve_node()   # 仅回退用，供旧调用方兼容
DWS  = get_path("DING_DWS_JS",
                "C:/Users/ChenQiang/.workbuddy/binaries/node/cli-connector-packages/node_modules/dingtalk-workspace-cli/bin/dws.js")  # 兼容旧调用方；新代码请用 resolve_dws_cmd()
# 中文字体（Windows 默认黑体路径；非 Windows 或字体位置不同请设 DING_FONT_PATH）
FONT_PATH = get_path("DING_FONT_PATH", "C:/Windows/Fonts/simhei.ttf")

# ---------- 目标群 ----------
GROUP_ID = "cidOW1oUVyj85JVYxQh8EyzGg=="   # 站点日常管理通知群（东莞德佑）

# ---------- 发送时禁止 @ 的人员（用户要求）----------
# 仍保留在 MANAGER_OPENID 中（其他用途可用），仅从所有 @ 名单中剔除。
# - 裴笑天：2026-08-18 要求发群不 @
# - 陈强：2026-08-20 要求发群不 @
DO_NOT_AT = {"裴笑天", "陈强"}

# ---------- 站长 openDingTalkId（唯一来源，单点维护）----------
# 「房志才」(钉钉显示名) /「房铭瑞」/「房瑞铭」为同一人，共用一个 id。
# 历史：风神侧本写作「房铭瑞」，2026-09-01 起任务执行人改为「房瑞铭」（用户确认系改名，非他人）。
MANAGER_OPENID = {
    "印立澳": "DPfqe5kgpkHx7AXNrf7BrKGrxqcvKvxSd",
    "黄志兵": "DPfqe5kgpkHwYiSpjMUkVyV61DO1Mrjbsy",
    "陈冬冬": "DPfqe5kgpkHzNdAcGHhJxfeqUVOX9yXkT",
    "黄山山": "DPfqe5kgpkHyd91NTC90G2IiSxB0RkiivpA",
    "薛再":   "DPfqe5kgpkHyYiisIOCs5WscmzrIDCGJDd",
    "朱星林": "DPfqe5kgpkHzIRNj5mq36BbDKbd0yzdGv",
    "房志才": "DPfqe5kgpkHxKyooghHBVTfeWdOFyxXfd",  # 钉钉显示名
    "房铭瑞": "DPfqe5kgpkHxKyooghHBVTfeWdOFyxXfd",  # 风神旧写法
    "房瑞铭": "DPfqe5kgpkHxKyooghHBVTfeWdOFyxXfd",  # 2026-09-01 起改名后的写法
    # 以下为任务执行人解析补充（非站点站长，部分任务执行人）
    "陈强":   "DPfqe5kgpkHxba3uvPNyVEysCiiDE1gleG",  # 数据运营（AI搜问解析 2026-08-18）
    "裴笑天": "DPfqe5kgpkHxkxs0mCRvvELW9k9ApiSgRH",  # 安全员（AI搜问解析 2026-08-18）— DO_NOT_AT：发群不 @
    # 注：赵启英 在通讯录/AI搜问均搜不到（可能属其他组织），暂无法 @，发消息时跳过
}

# 去重保序的全部站长 id（供「@全部站长」场景，如 attendance.py 的 send 节点）；已剔除 DO_NOT_AT
ALL_MANAGER_IDS = list(dict.fromkeys(
    v for k, v in MANAGER_OPENID.items() if k not in DO_NOT_AT
))


def resolve_openids(names):
    """姓名集合 → (resolved[(name, openid)], missing[姓名])，自动跳过 DO_NOT_AT。

    所有发送脚本统一走这里做「姓名→@id」映射，确保 DO_NOT_AT 在单一处生效，
    不必在每个脚本各写一遍排除逻辑。
    """
    resolved, missing = [], set()
    for n in sorted(names):
        if not n or n in DO_NOT_AT:
            continue
        if n in MANAGER_OPENID:
            resolved.append((n, MANAGER_OPENID[n]))
        else:
            missing.add(n)
    return resolved, missing


# ---------- 站点映射 & 站长（单一来源，所有脚本统一引用）----------
# 团队名称(风神/CSV) -> 站点简称
TEAM_TO_STATION = {
    "东莞市黄江镇站-UB": "黄江",
    "东莞市长安万科站-UB": "万科",
    "东莞市大岭山大学城站-UB": "大岭山大学城",
}
# 站点简称 -> 站长姓名列表
STATION_MANAGERS = {
    "黄江": ["印立澳", "黄志兵"],
    "万科": ["陈冬冬", "黄山山", "薛再"],
    "大岭山大学城": ["房铭瑞", "朱星林"],
}

# ---------- 统一日志初始化（FileHandler + StreamHandler）----------
def setup_logging(name, log_path, level=logging.INFO):
    """创建一个同时输出到文件和控制台的 logger（重复调用安全）。"""
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
    logger.setLevel(level)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    fh = logging.FileHandler(log_path, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    logger.addHandler(fh)
    logger.addHandler(sh)
    return logger


# ---------- dws CLI 封装 ----------
def dws(args, raise_on_error=True):
    """调用 dingtalk-workspace-cli (dws)，返回 (stdout, stderr, code)。

    命令前缀由 resolve_dws_cmd() 解析（独立 dws / PATH / WorkBuddy 捆绑回退），
    不再写死 WorkBuddy 路径。raise_on_error=True 时，非零退出码抛 RuntimeError。
    """
    cmd = resolve_dws_cmd() + list(args) + ["--format", "json"]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if raise_on_error and r.returncode != 0:
        raise RuntimeError(
            "dws 返回非零退出码 %s: %s | %s"
            % (r.returncode, (r.stdout or "")[:300], (r.stderr or "")[:300])
        )
    return r.stdout, r.stderr, r.returncode


def dws_json(args):
    """调用 dws 并把 stdout 解析为 JSON（find_group 内部用）。

    非零退出或返回非 JSON 均抛 RuntimeError。
    """
    out, err, code = dws(args, raise_on_error=True)
    out = (out or "").strip()
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        raise RuntimeError("dws 返回非 JSON: " + out[:600])


# ---------- 失败重试 ----------
def with_retry(times=3, delay=5, backoff=2, label="操作"):
    """失败自动重试：最多 times 次，每次间隔 delay 秒并按 backoff 倍率递增；全部失败后抛原异常。"""
    def deco(fn):
        def wrapper(*a, **k):
            last = None
            d = delay
            for i in range(1, times + 1):
                try:
                    return fn(*a, **k)
                except Exception as e:
                    last = e
                    log.warning("%s 第 %d/%d 次失败: %s", label, i, times, e)
                    if i < times:
                        time.sleep(d)
                        d *= backoff
            log.error("%s 重试 %d 次后仍失败: %s", label, times, last)
            raise last
        return wrapper
    return deco


def dws_run(args, times=3, delay=4, backoff=2, label="钉钉发送"):
    """带重试的 dws 发送：非零退出即抛 RuntimeError；返回 (stdout, stderr, code)。"""
    return with_retry(times, delay, backoff, label)(_dws_once)(args)


def _dws_once(args):
    out, err, code = dws(args, raise_on_error=True)
    return out, err, code
