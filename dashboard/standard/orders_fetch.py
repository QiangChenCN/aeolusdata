#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标准达成看板 —— 运单明细抓取编排层（节奏 / 切片 / 自动重登）。

为什么单独一层
--------------
`get_data/delivery.py` 按项目约定只做「打接口取数」，其内置限流重试（retries=8）
按要求**一字不动**。而「页间隔节奏 / 时段切片 / 会话失效重登」属于调用方编排，
按 get_data 约定不能进 get_data，因此落在 dashboard/standard/ 下
（标准达成工作区专属，不污染主程序或其它模块）。

节奏口径（2026-09-09 定，与 jobs/delivery/raw_fetch.py 完全一致）
------------------------------------------------------------------
前提：接口未公开 QPS 上限。观测到「固定 0.5s 连打 67 页」被判「请求太频繁」，
      而「整月逐天随机间隔」从未被限流 → 推定服务端是滑动窗口限流且对固定节拍敏感，
      故保守按阈值 1~2 QPS 设计：稳态均值 ≤1.5 QPS，瞬时不超过 ~3.3 QPS。

  · 翻页间隔        page_sleep()      → **自适应 AIMD 节奏**（见下方「自适应节奏」段）：
        当前间隔 = _pace["cur"] ∈ [PACE_MIN, PACE_MAX]，叠 ±15% 抖动。成功一页加性减 0.05s
        （慢慢探快），被限流一次乘性 ×1.15（快速退让）；并带「碰撞学习」把动态下限抬到
        碰撞点 ×1.25，之后绝不再低于该已知安全值。首轮冷启动可能撞几次学习，之后
        下限持久化（cache/pace_state.json），后续刷新基本零限流。
  · 分段间隔        coarse_sleep()    → 均匀随机 0.8~2.2s，均值 1.5s（SLEEP_COARSE_*）
        段/天边界是服务端最可能做窗口统计的位置，且次数少，加长几乎不增加总耗时。
  · 失败 / 限流退避  backoff_sleep()  → min(base × 2^attempt, 30s) × 均匀随机 1.0~1.5
        指数增长 + 封顶 +「只向上」抖动：下界 1.0 保证服务端拿到完整恢复窗口，
        上界 1.5 打散多实例同步重试。最多 MAX_RETRIES(4) 次，超出即抛，不无限等待。
  · 会话失效重登    Session.call      → 最多 5 次，重登后走同一套指数退避（基数 2.0）

基础常量（SLEEP_MIN/MAX、coarse、backoff）保留为静态兜底，调参集中在本模块顶部常量区。

切片：单站单日 total 超过 SEG_SPLIT_THRESHOLD(8000) 时按 4 时段切片抓取，
      段之间走 coarse_sleep()，抓完按 trackingId 去重。

会话：AuthError（单点登录被顶号 / cookie 过期）自动重登，最多 5 次，
      每次重登后 backoff_sleep(2) 等新会话在服务端生效。

对外能力
--------
  Session                                     封装 cookie + AuthError 自动重登
  fetch_orders(sess, start_ms, end_ms, ...)   按上述节奏分页拉全量（含切片去重）
  page_sleep / coarse_sleep / backoff_sleep   节奏原语，供其它编排复用
"""
import os
import sys
import json
import time
import random
import datetime
import threading

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from get_data.delivery import query, PAGE_SIZE, BJ, AuthError
from aeolus_sdk import login as L

# ---- 节奏常量（全部集中在此，调参只动这一段）----------------------------
# 口径与 jobs/delivery/raw_fetch.py 对齐（同一个运单明细接口，必须一致）。
# 前提：接口未公开 QPS 上限，保守按「滑动窗口限流 1~2 QPS + 对固定节拍敏感」设计。

# 自适应节奏（AIMD，2026-09-09 实测后引入）
# ------------------------------------------------------------------------
# 实测结论：服务端是「配额型」限流，不是瞬时 QPS 型。
#   证据：22:52 那次全量刷新，252s 内发出 164 次请求，只有 121 次被接受
#         → 通过速率约 29 次/分钟；而 22:21 那次约 47 次/分钟（配额会漂移）。
# 在这种模型下，固定间隔怎么设都不对：
#   · 间隔压很小 → 大量请求被拒，每次被拒还要退避 2s 重试 → 总时间不降反升
#     （实测 0.3~1.0 时 37% 的页被拒，单页均值从 1.04s 劣化到 2.1s）
#   · 间隔调到刚好匹配配额 → 零被拒，总时间 = 请求数 / 配额（就是理论下限）
#   · 间隔再往大调 → 只会更慢，没有额外收益
# 配额随时间段漂移，固定值无法两头兼顾，故改用 AIMD（同 TCP 拥塞控制）：
#   成功一页 → 加性减小间隔（慢慢探快）；被限流 → 乘性增大间隔（立刻退让）。
# 效果是「环境好时自动压到极致，环境差时自动退到零限流」。
PACE_MIN = 0.30        # 绝对下限：环境极好时最快也只到这（防瞬时突发被识别）
PACE_MAX = 4.00        # 间隔上限：环境极差时退让到的天花板（≈15 次/分配额也能兜住）
PACE_INIT = 0.80       # 初始间隔（中性起点；若已学到下限则取两者较大者）
PACE_SUB = 0.05        # 每成功一页，间隔线性减小 0.05s（加性增：慢慢探快）
PACE_MUL = 1.15        # 每遇一次限流，间隔 ×1.15 再 +0.1s（温和退让）
#   注：原 1.8 是给「纯 AIMD、无下限记忆」设计的——撞了要狠狠退。
#   现在有碰撞学习：退得太狠会把「碰撞点」抬到远高于真实配额，
#   学到的下限就偏保守（仿真里 1.8 → 下限 2.53s，比理论最优 2.07s 慢 20%）。
#   温和退让 + 下限记忆，碰撞点更贴近真实配额（仿真 269s vs 理论 259s）。
PACE_JITTER = (0.85, 1.15)   # 在目标间隔上叠 ±15% 抖动，避免固定节拍被识别

# 碰撞学习（2026-09-09 晚，在 AIMD 之上加的第二层自适应）
# ------------------------------------------------------------------------
# 纯 AIMD 的毛病：下限是写死的 PACE_MIN。只要它比配额对应的间隔快，
# 收敛后就会不停「探快 → 撞墙 → 退避」。23:33 那次实测每 10~23 秒撞一次、
# 一次刷新撞 12 次（125 页中被拒 12 次）—— 就是这个循环。
# 修法：被限流时把**当时的间隔**记为碰撞点 c（此时 60/c > 配额，即 c 偏快），
#   把动态下限抬到  c × PACE_FLOOR_RATIO（RATIO>1 → 比碰撞点更慢，才是安全侧），
#   之后 AIMD 再怎么加性减小也不会低过它 → 不再反复撞同一堵墙。
#   抖动下限 uniform(0.85,1.15)，要保证「最快抖动请求」仍慢于碰撞点：
#       0.85 × RATIO ≥ 1.0  →  RATIO ≥ 1.176，故取 1.25（25% 安全裕量）。
#   下限**只升不降**（PACE_FLOOR_RECOVER=0）：命中即已知安全的下限，
#   持久化到 cache/pace_state.json，下次刷新直接沿用，冷启动只学一次。
PACE_FLOOR_RATIO = 1.25      # 碰撞点 → 下限：collision × 1.25（比碰撞点更慢 = 安全侧）
PACE_FLOOR_RECOVER = 0.0     # 下限只升不降：碰撞抬高、成功不回落，杜绝「探快→再撞」
PACE_STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "cache", "pace_state.json")

_pace = {"cur": PACE_INIT, "floor": PACE_MIN, "collisions": 0,
         "last_collision": None}


def _load_pace_floor():
    """读取上次学到的间隔下限（无记录 / 越界则回落到 PACE_MIN）。"""
    try:
        with open(PACE_STATE_FILE, encoding="utf-8") as f:
            v = float((json.load(f) or {}).get("floor") or 0)
        if PACE_MIN <= v <= PACE_MAX:
            return v
    except Exception:
        pass
    return PACE_MIN


def _save_pace_floor(v):
    """持久化动态下限（只在碰撞 / 抓取结束时写，避免每页一次 IO）。"""
    try:
        os.makedirs(os.path.dirname(PACE_STATE_FILE), exist_ok=True)
        with open(PACE_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump({"floor": round(float(v), 3),
                       "updated": datetime.datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S")},
                      f, ensure_ascii=False)
    except Exception:
        pass


def pace_reset():
    """新一次抓取开始前重置节奏：起点取「已学到的下限」与初始值的较大者。

    与旧版（一律从 PACE_INIT 起）的区别：跨刷新沿用上次撞出来的下限，
    开局就贴着配额跑，而不是每次都从零开始再撞一轮学习。
    """
    floor = _load_pace_floor()
    _pace["floor"] = floor
    _pace["collisions"] = 0
    _pace["last_collision"] = None
    _pace["cur"] = max(PACE_INIT, floor)
    if floor > PACE_MIN:
        log("沿用已学到的间隔下限 %.2fs（跨刷新记忆）" % floor)


def pace_reward():
    """成功一页：加性减小间隔（在**动态下限**处封底，不再用写死的 PACE_MIN）。

    动态下限只升不降（PACE_FLOOR_RECOVER=0）：一旦被限流学到的下限就是已知安全值，
    之后只会在碰撞时继续抬高，成功路径绝不回落，杜绝「探快 → 再撞」的反复。
    """
    _pace["cur"] = max(_pace["floor"], _pace["cur"] - PACE_SUB)


def pace_penalize():
    """被限流 / 请求失败：乘性增大间隔（封顶 PACE_MAX），并把动态下限抬到碰撞点下方。"""
    cur = _pace["cur"]
    _pace["collisions"] += 1
    _pace["last_collision"] = round(cur, 3)
    floor = min(PACE_MAX, max(_pace["floor"], cur * PACE_FLOOR_RATIO))
    _pace["floor"] = floor
    _pace["cur"] = min(PACE_MAX, cur * PACE_MUL + 0.1)
    _save_pace_floor(floor)
    log("撞到限流：间隔 %.2fs → 下限抬到 %.2fs，当前退到 %.2fs（本次第 %d 次）"
        % (cur, floor, _pace["cur"], _pace["collisions"]))


# 翻页间隔的静态兜底区间（仅当未启用自适应、或外部显式传 sleep_max 时用）
SLEEP_MIN = 0.30
SLEEP_MAX = 0.90
# 2) 分段间隔：相邻两个 segment 之间 sleep [SLEEP_COARSE_MIN, SLEEP_COARSE_MAX] 均匀随机
#    均值 1.5s。段边界是服务端最可能做窗口统计的位置，且次数少（4 段仅 3 次），
#    加长几乎不增加总耗时；下限 0.8 明显高于页间隔均值 0.60，保证是可辨识的停顿。
SLEEP_COARSE_MIN = 0.8
SLEEP_COARSE_MAX = 2.2

# 3) 指数退避（请求失败 / 触发限流时使用）：
#   wait = min(BACKOFF_BASE * BACKOFF_FACTOR ** attempt, BACKOFF_MAX_SLEEP)
#   实际 sleep = wait * uniform(BACKOFF_JITTER)
#   基数从 1.0 提到 2.0：限流的恢复窗口明显大于 1s（实测 20s 间隔才稳，
#   而 1.7 QPS 第 2 次就挂），首次退避给 2~3s 才够服务端把窗口腾出来。
BACKOFF_BASE = 2.0            # 首次退避基数（秒）
BACKOFF_FACTOR = 2.0          # 指数底数：2s → 4s → 8s → 16s …
BACKOFF_MAX_SLEEP = 30.0      # 单次退避等待上限，避免无限等待
# 4) 退避抖动：乘性比例抖动 [1.0, 1.5]，即「等满基准 + 最多 50% 上浮」。
#    下界必须 ≥1.0——原 (0.3, 0.7) / (0.7, 1.3) 的下界 <1.0 会让部分重试早于基准
#    时刻发出，等于削弱退避、给服务端恢复窗口不够。改为保底基准、只向上抖动。
#    用乘性而非加性：基准随 attempt 指数增长，乘性保持相对错开程度，上界 1.5
#    足够打散多实例同步重试（惊群）。退避只在失败路径触发，正常流程零影响。
BACKOFF_JITTER = (1.0, 1.5)
# 重试次数：因为已改为「编排层接管」（query 只打 1 次），次数给足一点，
# 配合指数退避 2/4/8/16s，最坏约 30s×1.25≈37s 后放弃，避免一次抖动拖死整个刷新。
MAX_RETRIES = 4               # 单次请求最大退避重试次数（超出即抛出）

# 会话失效重登
RELOGIN_MAX = 5               # 最大自动重登次数
RELOGIN_BACKOFF_BASE = 2.0    # 重登后退避基数（走同一套指数退避）

# 抓取切片
PAGE_INDEX_CAP = 190          # current*50 需 <10000，留余量
SEG_SPLIT_THRESHOLD = 8000    # 单站单日超过此量则按时段切片
FULL_DAY = "0-86400"
SEGMENTS_4 = ["0-21600", "21600-43200", "43200-64800", "64800-86400"]

# ---- 完整性校验（2026-09-18 加）------------------------------------------
# 为什么必须有这一步：运单导出是异步任务，**成功不等于完整**。
#   2026-09-17 实测：导出拿回 5793 行，同一时间窗接口 total=5820 —— 静默少 27 行，
#   全流程无任何报错。下游「标准达成」按单量判定 + 「今日有单」判定都依赖这批行，
#   少几行就表现为个别骑手少算一单（如孙源源 18 单被算成 17 单）。
# 因此导出后固定做一次「行数 vs 接口 total」对账：只要一次第 1 页请求就能拿到
#   total（同 dashboard/standard/site_orders 注释里提到的三个时间维度之一），
#   开销远小于因数据不全导致的排查成本。
VERIFY_EXPORT_TOTAL = True       # 导出后是否与接口 total 对数；关掉可省 1 次请求
TOTAL_SHORT_TOLERANCE = 0.0      # 「实拿行数 < total」的比例容忍
TOTAL_SHORT_TOLERANCE_MIN = 0    # 比例容忍之外再给的绝对行数豁免
FALLBACK_ON_TOTAL_SHORT = True   # 核对发现残缺时，回落到分页路径重取（宁慢勿错）


def log(msg):
    ts = datetime.datetime.now(BJ).strftime("%H:%M:%S")
    line = f"[{ts}] [orders] {msg}"
    print(line, flush=True)
    _append_log(line)


# ---- 抓取统计（2026-09-09 加）------------------------------------------
# 为什么要留计数：此前「被限流几次」只 print 到 stdout，而服务进程的 stdout
# 不落盘 → 一次刷新跑完就再也查不到，只能靠耗时猜。现在把计数留在模块级，
# 由编排层（refresh_all）在任务开始 reset、结束读取，随进度接口一并返回，
# 同时把日志按「一次刷新一个文件」落盘，事后可回查。
_STATS_LOCK = threading.Lock()
_STATS = {"requests": 0, "ok": 0, "throttle": 0, "failed": 0,
          "retries": 0, "relogin": 0}
_LOG_PATH = None


def stats_reset():
    """新一次刷新开始前清零，返回清零后的快照。"""
    with _STATS_LOCK:
        for k in _STATS:
            _STATS[k] = 0
        return dict(_STATS)


def stats_snapshot():
    with _STATS_LOCK:
        s = dict(_STATS)
    # 自适应节奏的实时状态：下限 / 当前间隔 / 本次碰撞次数（前端进度条展示）
    s["pace_floor"] = round(_pace["floor"], 3)
    s["pace_cur"] = round(_pace["cur"], 3)
    s["collisions"] = _pace["collisions"]
    return s


def _bump(key, n=1):
    with _STATS_LOCK:
        _STATS[key] = _STATS.get(key, 0) + n


def is_throttle(err):
    """异常是否属于服务端限流（FREQUENT / 请求太频繁）。

    判定来自 get_data/delivery.py：限流码含 FREQUENT 或 msg 含「频繁」，
    最终以 RuntimeError("重试 N 次仍失败: ...") 抛到编排层，所以看消息文本。
    """
    s = "%s: %s" % (type(err).__name__, err)
    u = s.upper()
    return ("FREQUENT" in u) or ("频繁" in s)


def set_log_path(path):
    """把后续日志同时追加写入文件（一次刷新一个文件）。"""
    global _LOG_PATH
    _LOG_PATH = path
    if path:
        try:
            d = os.path.dirname(path)
            if d:
                os.makedirs(d, exist_ok=True)
        except Exception:
            pass


def _append_log(line):
    if not _LOG_PATH:
        return
    try:
        with open(_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def rand_sleep(lo, hi):
    """[lo, hi] 区间内均匀随机 sleep，返回实际秒数。"""
    if hi < lo:
        lo, hi = hi, lo
    s = random.uniform(lo, hi)
    time.sleep(s)
    return s


def backoff_wait(base=BACKOFF_BASE, attempt=0):
    """指数退避等待时长（不含抖动）：min(base * factor**attempt, BACKOFF_MAX_SLEEP)。"""
    wait = float(base) * (BACKOFF_FACTOR ** max(0, int(attempt)))
    return min(wait, BACKOFF_MAX_SLEEP)


def backoff_sleep(base=BACKOFF_BASE, attempt=0):
    """指数退避：base × 2^attempt，封顶 BACKOFF_MAX_SLEEP，再乘 0.3~0.7 均匀抖动。

    attempt 从 0 开始（第 1 次重试传 0）。返回实际 sleep 秒数。
    """
    return rand_sleep(backoff_wait(base, attempt) * BACKOFF_JITTER[0],
                      backoff_wait(base, attempt) * BACKOFF_JITTER[1])


def page_sleep(sleep_max=None):
    """页间随机间隔 —— 取自适应节奏当前值，再叠 ±15% 抖动。

    sleep_max 可显式压低上限（调用方想更保守时用）；缺省走 AIMD 自适应值。
    """
    cur = _pace["cur"]
    if sleep_max is not None:
        cur = min(cur, float(sleep_max))
    return rand_sleep(cur * PACE_JITTER[0], cur * PACE_JITTER[1])


def coarse_sleep():
    """时段间 / 天间的粗粒度间隔 [0.5, 2.0]s。"""
    return rand_sleep(SLEEP_COARSE_MIN, SLEEP_COARSE_MAX)


class Session:
    """封装 cookie，遇 AuthError 自动重登（最多 5 次），每次退避 2s（带抖动）。"""

    def __init__(self, cookie=None):
        if cookie is None:
            cookie, st = L.ensure_cookies()
        else:
            st = "external"
        self.cookie = cookie
        self.relogin = 0
        log(f"登录态: {st}")

    def call(self, *a, **kw):
        """打一次接口：AuthError → 自动重登；其它失败（限流/网络）→ 指数退避重试。

        关键设计：**由编排层（本方法）接管重试节奏，而不是让 get_data 内部连冲**。
        get_data.delivery.query 遇到「请求太频繁」是 `continue` 立即重试（无间隔），
        2026-09-09 实测这种连冲会制造 2.8s/页的均值、最长 40.9s 的长尾 ——
        一次限流就可能耗掉几十秒。改为 query 只打 1 次（retries=1），
        失败交给这里按指数退避重试：既给服务端完整恢复窗口，也消除长尾。

        退避 = min(base × 2^attempt, BACKOFF_MAX_SLEEP) × uniform(BACKOFF_JITTER)，
        最多 MAX_RETRIES 次，超出即抛出（绝不无限等待）。
        """
        kw.setdefault("retries", 1)
        attempt = 0
        while True:
            try:
                _bump("requests")
                out = query(*a, cookie=self.cookie, **kw)
                pace_reward()          # 成功一页 → 间隔往小调（慢慢探快）
                _bump("ok")
                return out
            except AuthError as e:
                if self.relogin >= RELOGIN_MAX:
                    raise RuntimeError(f"会话连续失效 {RELOGIN_MAX} 次: {e}")
                self.relogin += 1
                _bump("relogin")
                log(f"会话失效({e})，重新登录 第{self.relogin}次")
                self.cookie = L.get_cookies()
                L.save_cookies(self.cookie)
                # 重登后等新会话在服务端生效；抖动避免与其它实例同步
                backoff_sleep(RELOGIN_BACKOFF_BASE, self.relogin - 1)
                attempt = 0          # 新会话，退避计数归零
            except Exception as e:
                pace_penalize()        # 被限流/失败 → 间隔往大调（乘性退让）
                if is_throttle(e):
                    _bump("throttle")
                else:
                    _bump("failed")
                if attempt >= MAX_RETRIES:
                    raise
                _bump("retries")
                wait = backoff_wait(BACKOFF_BASE, attempt)
                log(f"请求失败({type(e).__name__}: {e})，{wait:.1f}s 后第{attempt + 1}次重试")
                backoff_sleep(BACKOFF_BASE, attempt)
                attempt += 1


def _fetch_segment(sess, s_ms, e_ms, period, sleep_max=None, first=None, total=None,
                   time_field=None):
    """抓单个时段切片的全部页，页间 page_sleep。返回 (rows, total)。

    first / total 可选：调用方若已请求过第 1 页（探总数那次），把结果传进来复用，
    避免第 1 页被打两次 —— 在严格限流下每一次请求额度都很贵。
    time_field：时间筛选维度，透传给接口（见 get_data.delivery.TIME_FIELDS）。
    """
    rows = []
    if first is None or total is None:
        first, total = sess.call(s_ms, e_ms, 1, PAGE_SIZE, period, time_field=time_field)
    if not total or not first:
        return [], total or 0
    rows.extend(first)
    pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
    if pages > PAGE_INDEX_CAP:
        log(f"  !! 时段 {period} total={total} 超页码上限({PAGE_INDEX_CAP})，需更细切片")
    for cur in range(2, min(pages, PAGE_INDEX_CAP) + 1):
        page, total = sess.call(s_ms, e_ms, cur, PAGE_SIZE, period, time_field=time_field)
        if not page:
            break
        rows.extend(page)
        page_sleep(sleep_max)
    return rows, total


def _dedup(rows):
    """按 trackingId 去重（时段切片边界可能重复）。"""
    seen, out = set(), []
    for r in rows:
        tid = r.get("trackingId")
        if tid is None:
            out.append(r)
            continue
        if tid in seen:
            continue
        seen.add(tid)
        out.append(r)
    return out


def fetch_orders(sess, start_ms, end_ms, sleep_max=None, time_field=None):
    """按时段切片节奏拉取时间窗内全部运单明细，返回去重后的行列表。

    先取第 1 页拿 total：total>SEG_SPLIT_THRESHOLD 就拆 4 个时段分别抓，
    段间 coarse_sleep()；最后按 trackingId 去重（切片边界可能重复）。
    time_field 决定按哪个时间维度筛选（缺省 trackingFinish）。
    """
    pace_reset()          # 新一次抓取重置节奏，不继承上次的惩罚/加速状态
    first, total = sess.call(start_ms, end_ms, 1, PAGE_SIZE, FULL_DAY, time_field=time_field)
    log(f"接口 total={total}")
    if not total:
        return []
    segs = SEGMENTS_4 if total > SEG_SPLIT_THRESHOLD else [FULL_DAY]
    if len(segs) > 1:
        log(f"单量超 {SEG_SPLIT_THRESHOLD}，按 {len(segs)} 时段切片抓取")
        all_rows = []
        for seg in segs:
            rows, _ = _fetch_segment(sess, start_ms, end_ms, seg, sleep_max, time_field=time_field)
            all_rows.extend(rows)
            coarse_sleep()          # 时段之间
    else:
        # 单段：第 1 页（探总数那次）已拿到，直接续拉，不重复请求
        all_rows, _ = _fetch_segment(sess, start_ms, end_ms, FULL_DAY, sleep_max,
                                     first=first, total=total, time_field=time_field)
    dedup = _dedup(all_rows)
    log(f"抓取完成 {len(dedup)}/{total} 条")
    _save_pace_floor(_pace["floor"])      # 本次学到的下限存下来，下次刷新直接沿用
    return dedup


def _short_tolerance(total):
    """允许「实拿行数 < 接口 total」的差额容忍（换算成绝对行数）。"""
    return int(int(total or 0) * TOTAL_SHORT_TOLERANCE) + TOTAL_SHORT_TOLERANCE_MIN


def _verify_total(sess, s_ms, e_ms, time_field=None):
    """取一次第 1 页拿到接口 total，用于与已到手行数对账。返回 (total, rows_of_page1)。

    取不到（网络 / 会话 / 限流）返回 (None, [])，由调用方决定放行还是回落。
    """
    if not VERIFY_EXPORT_TOTAL:
        return None, []
    try:
        first, total = sess.call(s_ms, e_ms, 1, PAGE_SIZE, FULL_DAY, time_field=time_field)
    except Exception as e:
        log(f"  !! 完整性校验取 total 失败：{type(e).__name__}: {e}")
        return None, []
    return int(total or 0), first or []


def _fetch_all_rows(sess, start_ms, end_ms, sleep_max=None, time_field=None):
    """取全量运单行：导出优先（异步导出，零分页请求、无限流），失败/超时/空则回落分页。

    完整性保证（2026-09-18 加）：**导出成功 ≠ 数据完整**。实测导出会静默少给数据
    （同期接口 total=5820、导出只有 5793 行、无任何报错），下游按单量判定「标准达成 /
    今日有单」就会被系统性少计几单。所以导出后固定与接口 total 对一次账，
    差额超容忍就丢弃这份残缺结果、回落到分页重取 —— 宁可慢，也不能给下游一份缺数据
    （见本文件顶部「完整性校验」的调参说明）。

    导出路径见 get_data/delivery_export.py：异步触发 Aeolus 运单导出 → 轮询任务
    → 拿 OSS 签名 URL → 下载 xlsx → 解析为 dict（中文表头双写英文键，已对齐
    queryTracking 返回结构与 order_rules 口径）。一次请求拿全站运单，彻底绕开
    125 页分页的「请求太频繁」配额墙。
    """
    try:
        import get_data.delivery_export as DE
        log("尝试运单导出（异步导出，替代 125 页分页，零限流风险）...")
        rows = DE.export_orders(start_ms, end_ms, cookie=sess.cookie,
                               poll_timeout=DE.DEFAULT_POLL_TIMEOUT,
                               time_field=time_field)
        if rows:
            rows = _dedup(rows)          # 去重后再对数，total 也是按单口径
            log(f"导出成功：拿回 {len(rows)} 行（0 次分页请求）")
            total, _p1 = _verify_total(sess, start_ms, end_ms, time_field)
            if total is not None:
                gap = max(0, total - len(rows))
                log(f"完整性核对：导出 {len(rows)} 行 / 接口 total={total}，差 {gap} 行")
                tol = _short_tolerance(total)
                if gap and gap <= tol:
                    log(f"  差 {gap} 行在容忍范围内（≤{tol}），沿用导出结果")
                    return rows
                if gap and FALLBACK_ON_TOTAL_SHORT:
                    log(f"  !! 导出残缺（少 {gap} 行），回落到分页重取")
                    return fetch_orders(sess, start_ms, end_ms,
                                        sleep_max=sleep_max, time_field=time_field)
                if gap:
                    log(f"  !! 导出残缺（少 {gap} 行）但未开启回落，按残缺数据返回")
            return rows
        log("导出返回空，回落分页取数")
    except Exception as e:
        log(f"导出失败，回落分页取数：{type(e).__name__}: {e}")
    # 兜底：现有分页路径（带 AIMD 限流退避 + 自动重登）
    return fetch_orders(sess, start_ms, end_ms, sleep_max=sleep_max, time_field=time_field)


def fetch_orders_grouped(sess, start_ms, end_ms, sleep_max=None, time_field=None):
    """一次拉全量运单，按 teamId 分组返回 {team_id_str: [rows]}。

    关键事实（2026-09-09 实测）：运单明细接口 `queryTracking/2.0` 的请求体
    **没有站点参数** —— 它按当前登录账号的权限返回全部站点数据。实测同一天
    先后为 3 个站点各拉一次，三次结果都是同一批 ~5800 条、且都含全部 7 个站点的
    teamId（重复拉取纯属浪费，且把限流风险放大 3 倍）。

    因此全量刷新改为：只拉一次 → 按 teamId 分组 → 各站点各取自己那份落盘。
    这样 3 个站点的运单耗时与请求数都降到原来的 1/3。

    取数来源（2026-09-10 改）：优先走异步导出（get_data.delivery_export），
    失败/超时/空则回落分页（fetch_orders，带 AIMD 限流退避）。两种来源产出
    结构一致（dict 列表，teamId/trackingId 等英文键齐备），下游零改动。

    返回：{teamId: [rows]}；teamId 缺失的行归入键 "_unknown"（调用方可忽略）。
    """
    rows = _fetch_all_rows(sess, start_ms, end_ms, sleep_max, time_field=time_field)
    grouped = {}
    for r in rows:
        tid = r.get("teamId")
        key = str(tid).strip() if tid not in (None, "") else "_unknown"
        grouped.setdefault(key, []).append(r)
    log("按站点分组：" + "、".join(
        f"{k}={len(v)}" for k, v in sorted(grouped.items(), key=lambda x: -len(x[1]))))
    return grouped


__all__ = [
    "SLEEP_MIN", "SLEEP_MAX", "SLEEP_COARSE_MIN", "SLEEP_COARSE_MAX",
    "BACKOFF_BASE", "BACKOFF_FACTOR", "BACKOFF_MAX_SLEEP", "BACKOFF_JITTER",
    "MAX_RETRIES", "RELOGIN_MAX", "RELOGIN_BACKOFF_BASE",
    "PAGE_INDEX_CAP", "SEG_SPLIT_THRESHOLD",
    "VERIFY_EXPORT_TOTAL", "TOTAL_SHORT_TOLERANCE", "TOTAL_SHORT_TOLERANCE_MIN",
    "FALLBACK_ON_TOTAL_SHORT",
    "FULL_DAY", "SEGMENTS_4", "PAGE_SIZE", "BJ",
    "log", "rand_sleep", "backoff_wait", "backoff_sleep", "page_sleep",
    "coarse_sleep", "Session", "fetch_orders", "_fetch_all_rows",
    "fetch_orders_grouped", "_dedup",
    "pace_reset", "pace_reward", "pace_penalize", "_load_pace_floor",
    "stats_reset", "stats_snapshot", "is_throttle", "set_log_path",
]
