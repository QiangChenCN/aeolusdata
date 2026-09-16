#!/usr/bin/env python3
"""运单原始层抓取（JSONL 落盘 + 断点续传 + 自动重登）。

本模块是 jobs/delivery 流水线专属的「编排 + 落盘」逻辑，依赖 get_data.delivery
做纯 HTTP 取数。get_data.delivery 只负责打接口；这里负责按天切片、JSONL 落盘、
断点续传、自动重登、限流退避——这些是任务编排，不该污染 get_data。
"""
import os
import sys
import json
import time
import random
import datetime

# raw_fetch.py 在 jobs/delivery/ 下：把项目根加进 sys.path（get_data / aeolus_sdk 在项目根）
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from aeolus_sdk import login as L
from get_data.delivery import query, PAGE_SIZE, BJ, AuthError

# 原始层 JSONL 落盘位置（与历史产物兼容）
RAW_DIR = os.path.join(_ROOT, "jobs", "delivery", "out", "delivery_raw")

# ===================== 限速 / 退避常量 =====================
# 前提（2026-09-09 定）：运单明细接口未公开 QPS 上限，按保守假设设计——
#   观测到「固定 0.5s 连打 67 页」被判「请求太频繁」，而「整月逐天随机间隔」
#   从未被限流，故推定服务端是**滑动窗口限流 + 对固定节拍敏感**，
#   保守按阈值 1~2 QPS 设计：稳态均值 ≤1.5 QPS，瞬时不超过 ~3.3 QPS。
#
# 设计原则：
#   · 随机化优先于加长等待——固定节拍最容易被识别，随机化在同等均值下更安全。
#   · 下限决定瞬时突发上限，上限决定平均吞吐；两端都收窄比单纯拉长更划算。
#   · 批次边界（段间 / 天间）出现次数少，加长几乎不增加总耗时，收益却最大。

# 1) 翻页间隔 page_sleep：均匀随机 [0.3, 0.9]，均值 0.60s
#    下限 0.3（原 0.1）是关键：均匀分布下原下限会频繁出现「连续几页几乎无间隔」
#    的突发（67 页里必然命中几次），这正是被限流的诱因；提到 0.3 后瞬时上限 3.3 QPS。
#    上限 1.0→0.9（2026-09-09 与 dashboard/standard/orders_fetch.py 同步）：
#    实测「压缩间隔提速」不成立——服务端阈值很低，触发限流的退避代价
#    （2s 起步）远大于省下的间隔，故只做微调，提速另靠减少请求数。
SLEEP_MIN = 0.3
SLEEP_MAX = 0.9
# 2)+3) 段间 / 天间 coarse_sleep：共用同一函数与区间，均匀随机 [0.8, 2.2]，均值 1.5s
#    两者在服务端都是「批次边界」，语义相同，故统一（跨天另有落盘写 meta 的自然停顿）。
#    下限 0.8 明显高于页间隔均值 0.60，保证即使抽到下界也是一次「可辨识的停顿」；
#    次数少（4 段仅 3 次 / 整月 30 次），对总耗时影响 <10s，收益远大于成本。
SLEEP_COARSE_MIN = 0.8
SLEEP_COARSE_MAX = 2.2
# 4) 失败退避抖动 BACKOFF_JITTER：乘性比例抖动 [1.0, 1.5]，即「等满基准 + 最多 50% 上浮」
#    原 (0.7, 1.3) 的**下界 <1.0 会削弱退避**——部分重试早于基准时刻发出，等于没等够。
#    退避的目的是给服务端恢复窗口，故改为保底基准、只向上抖动（AWS Equal Jitter 的保守变体）。
#    用乘性而非加性：退避基准随 attempt 指数增长(1s→2s→4s→8s)，乘性抖动保持相对错开程度，
#    上界 1.5 足够打散多实例同步重试（惊群）。退避只在失败路径触发，正常流程零影响。
BACKOFF_JITTER = (1.0, 1.5)
PAGE_INDEX_CAP = 190          # current*50 需 <10000，留余量
SEG_SPLIT_THRESHOLD = 9000    # 单日超过此量则按时段切片
FULL_DAY = "0-86400"
SEGMENTS_4 = ["0-21600", "21600-43200", "43200-64800", "64800-86400"]


def log(msg):
    ts = datetime.datetime.now(BJ).strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def rand_sleep(lo, hi):
    """[lo, hi] 区间内均匀随机 sleep，返回实际秒数。"""
    if hi < lo:
        lo, hi = hi, lo
    s = random.uniform(lo, hi)
    time.sleep(s)
    return s


def backoff_sleep(base):
    """失败退避：先等满 base 秒，再额外乘 1.0~1.5 的上浮抖动（BACKOFF_JITTER）。

    只向上抖动、不提前：下界 1.0 保证服务端至少拿到完整的恢复窗口；
    上界 1.5 把多个实例的重试时刻错开，避免同步重试造成惊群。
    """
    return rand_sleep(base * BACKOFF_JITTER[0], base * BACKOFF_JITTER[1])


def day_bounds(d: datetime.date):
    s = datetime.datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=BJ)
    e = datetime.datetime(d.year, d.month, d.day, 23, 59, 59, tzinfo=BJ)
    return int(s.timestamp() * 1000), int(e.timestamp() * 1000)


def page_sleep(sleep_max=None):
    """页间间隔：[SLEEP_MIN, sleep_max] 均匀随机，返回实际 sleep 秒数。

    默认上限 SLEEP_MAX=1.0 → 均值 0.65s ≈ 1.54 QPS。
    下限 SLEEP_MIN=0.3 是防突发的关键（均匀分布下原 0.1 下限会连续抽到近乎无间隔）。
    """
    hi = SLEEP_MAX if sleep_max is None else float(sleep_max)
    return rand_sleep(SLEEP_MIN, hi)


def coarse_sleep():
    """时段间 / 天间的粗粒度间隔：[SLEEP_COARSE_MIN, SLEEP_COARSE_MAX] 均匀随机，均值 1.5s。

    两者共用：在服务端都是「批次边界」，且跨天另有落盘写 meta 的自然停顿。
    出现次数少（4 段 3 次 / 整月 30 次），加长对总耗时影响 <10s。
    """
    return rand_sleep(SLEEP_COARSE_MIN, SLEEP_COARSE_MAX)


class Session:
    """封装 cookie，遇 AuthError 自动重登（最多 5 次）。"""

    def __init__(self):
        self.cookie, st = L.ensure_cookies()
        self.relogin = 0
        log(f"登录态: {st}")

    def call(self, *a, **kw):
        while True:
            try:
                return query(*a, cookie=self.cookie, **kw)
            except AuthError as e:
                if self.relogin >= 5:
                    raise RuntimeError(f"会话连续失效 5 次: {e}")
                self.relogin += 1
                log(f"会话失效({e})，重新登录 第{self.relogin}次")
                self.cookie = L.get_cookies()
                L.save_cookies(self.cookie)
                backoff_sleep(2)   # 等新会话在服务端生效，抖动避免与其它实例同步


def fetch_segment(sess, s_ms, e_ms, period, sleep):
    rows = []
    _, total = sess.call(s_ms, e_ms, 1, PAGE_SIZE, period)
    if total == 0:
        return [], 0
    pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
    if pages > PAGE_INDEX_CAP:
        log(f"  !! 时段 {period} total={total} 超页码上限，需更细切片")
    for cur in range(1, min(pages, PAGE_INDEX_CAP) + 1):
        page, total = sess.call(s_ms, e_ms, cur, PAGE_SIZE, period)
        if not page:
            break
        rows.extend(page)
        if cur % 20 == 0 or cur == pages:
            log(f"  {period} 第{cur}/{pages}页 累计{len(rows)}/{total}")
        page_sleep(sleep)
    return rows, total


def fetch_day(sess, d: datetime.date, sleep=1.0, force=False):
    """抓单日全部运单明细，落 JSONL（断点续传：已完成标记则跳过）。"""
    os.makedirs(RAW_DIR, exist_ok=True)
    key = d.strftime("%Y-%m-%d")
    out = os.path.join(RAW_DIR, f"{key}.jsonl")
    meta_p = os.path.join(RAW_DIR, f"{key}.meta.json")
    if not force and os.path.exists(meta_p):
        m = json.load(open(meta_p, encoding="utf-8"))
        if m.get("ok"):
            log(f"{key} 已完成({m.get('fetched')}条)，跳过")
            return m
    s_ms, e_ms = day_bounds(d)
    _, total = sess.call(s_ms, e_ms, 1, 1, FULL_DAY)
    log(f"{key} 接口 total={total}")
    segs = SEGMENTS_4 if total > SEG_SPLIT_THRESHOLD else [FULL_DAY]
    if len(segs) > 1:
        log(f"{key} 单量超 {SEG_SPLIT_THRESHOLD}，按 4 时段切片抓取")
    all_rows, seg_totals = [], {}
    for seg in segs:
        rows, st = fetch_segment(sess, s_ms, e_ms, seg, sleep)
        seg_totals[seg] = st
        all_rows.extend(rows)
        coarse_sleep()          # 时段之间
    # 去重（切片边界可能重复）
    seen, dedup = set(), []
    for r in all_rows:
        tid = r.get("trackingId")
        if tid in seen:
            continue
        seen.add(tid)
        dedup.append(r)
    with open(out, "w", encoding="utf-8") as f:
        for r in dedup:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    meta = {
        "date": key, "total": total, "fetched": len(dedup),
        "raw_rows": len(all_rows), "segments": seg_totals,
        "ok": len(dedup) >= total * 0.995,
        "fetched_at": datetime.datetime.now(BJ).isoformat(timespec="seconds"),
    }
    json.dump(meta, open(meta_p, "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    flag = "OK" if meta["ok"] else "!! 缺量"
    log(f"{key} {flag} 落盘 {len(dedup)}/{total} -> {out}")
    return meta


__all__ = [
    "RAW_DIR", "BJ", "SLEEP_MIN", "SLEEP_MAX",
    "log", "coarse_sleep", "Session", "fetch_segment", "fetch_day",
]
