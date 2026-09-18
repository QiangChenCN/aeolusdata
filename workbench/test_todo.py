#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""工作内容模块 · 边界情况测试

跑法：python workbench/test_todo.py
（用临时库，不碰用户的真实待办数据）

覆盖的是需求里点名的那几个点：迁移、重复规则、重启恢复、
失败重试、以及「同一时刻不重复触发」的并发与幂等。
"""
import os
import sys
import shutil
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import todo_store as S          # noqa: E402
import todo_sched as SC         # noqa: E402


def hm(offset_min=0):
    return (datetime.now() + timedelta(minutes=offset_min)).strftime("%Y-%m-%dT%H:%M")


class FakeMgr(object):
    """RunManager 的替身：只实现调度器用到的三个方法，跑什么由测试决定。"""

    def __init__(self, tasks=None):
        self.tasks = tasks if tasks is not None else {"t1": {"id": "t1"}}
        self.results = {}          # run_id -> {"status", "exit_code"}
        self.enqueued = []         # [(run_id, task_id)]
        self.events = []
        self.next_result = {"status": "running", "exit_code": None}
        self._n = 0

    def link_state(self, tid):
        if not tid:
            return "missing"
        t = self.tasks.get(tid)
        if not t:
            return "missing"
        if t.get("hidden") or t.get("disabled"):
            return "disabled"
        return "ok"

    def enqueue(self, items):
        self._n += 1
        rid = "run%d" % self._n
        self.enqueued.append((rid, items[0]["task_id"]))
        self.results[rid] = dict(self.next_result)
        return [rid]

    def run_status(self, rid):
        return self.results.get(rid)

    def emit(self, evt):
        self.events.append(evt)

    # --- 测试辅助 ---
    def finish(self, run_id, status="success", exit_code=0):
        self.results[run_id] = {"status": status, "exit_code": exit_code}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="todo_test_")
        S.use_path(os.path.join(self.tmp, "todo.db"))
        S.init_db()

    def tearDown(self):
        S.use_path(os.path.join(self.tmp, "todo.db"))
        conn = getattr(S._local, "conn", None)
        if conn:
            try:
                conn.close()
            except Exception:
                pass
        S._local.conn = None
        shutil.rmtree(self.tmp, ignore_errors=True)

    def new_item(self, **kw):
        kw.setdefault("title", "测试事项")
        kw.setdefault("list_id", "l_work")
        kw.setdefault("task_id", "t1")
        kw.setdefault("auto_run", 1)
        kw.setdefault("remind_at", hm(-1))
        return S.create_item(**kw)


# ---------------------------------------------------------------- 迁移
class TestMigration(Base):
    def test_init_is_idempotent(self):
        old, new = S.init_db()          # 第二次跑
        self.assertEqual(old, 1)
        self.assertEqual(new, 1)

    def test_schema_and_indexes(self):
        info = S.db_info()
        self.assertEqual(info["schema_version"], 1)
        for t in ("todo_list", "todo_item", "todo_run"):
            self.assertIn(t, info["tables"])
        self.assertIn("idx_item_due", info["indexes"])      # 调度扫描
        self.assertIn("idx_item_list_status", info["indexes"])
        self.assertEqual(info["counts"]["todo_list"], 3)    # 默认三个列表

    def test_future_migration_step_applies(self):
        """模拟发新版：追加一条 v2 迁移，老库应能平滑升级。"""
        S.MIGRATIONS.append((2, ["ALTER TABLE todo_item ADD COLUMN foo TEXT"]))
        try:
            S.init_db()
            self.assertEqual(S.db_info()["schema_version"], 2)
            conn = S.connect()
            cols = [r["name"] for r in conn.execute("PRAGMA table_info(todo_item)")]
            self.assertIn("foo", cols)
        finally:
            S.MIGRATIONS.pop()


# ---------------------------------------------------------------- 重复规则
class TestRepeat(Base):
    def _next(self, t, n, by, anchor, now, end=""):
        return S.compute_next_due({"type": t, "interval": n, "by": by, "end": end},
                                  anchor, datetime.strptime(now, "%Y-%m-%dT%H:%M"))

    def test_daily(self):
        self.assertEqual(str(self._next("daily", 1, "", "2026-09-01T09:00", "2026-09-06T11:00")),
                         "2026-09-07 09:00:00")

    def test_every_3_days(self):
        got = self._next("daily", 3, "", "2026-09-01T09:00", "2026-09-06T11:00")
        self.assertEqual(str(got), "2026-09-07 09:00:00")   # 9/1 → 9/4 → 9/7

    def test_weekly_picks_scheduled_weekday(self):
        got = self._next("weekly", 1, "1,3", "2026-09-01T09:00", "2026-09-06T11:00")
        self.assertIn(got.isoweekday(), (1, 3))             # 周一或周三
        self.assertGreater(got, datetime(2026, 9, 6, 11, 0))

    def test_biweekly_respects_interval(self):
        # 锚点 2026-09-02（周三）；每 2 周 → 9/16 已过则跳到 9/30
        got = self._next("weekly", 2, "3", "2026-09-02T09:00", "2026-09-16T11:00")
        self.assertEqual(got.isoweekday(), 3)
        self.assertEqual(str(got.date()), "2026-09-30")

    def test_monthly_clamps_to_last_day(self):
        got = self._next("monthly", 1, "31", "2026-01-31T09:00", "2026-01-31T10:00")
        self.assertEqual(str(got), "2026-02-28 09:00:00")   # 2026 非闰年

    def test_monthly_last_day(self):
        got = self._next("monthly", 1, "L", "2026-01-31T09:00", "2026-02-01T00:00")
        self.assertEqual(str(got), "2026-02-28 09:00:00")

    def test_custom_hourly(self):
        got = self._next("custom", 6, "", "2026-09-06T08:00", "2026-09-06T11:00")
        self.assertEqual(str(got), "2026-09-06 14:00:00")

    def test_repeat_end_stops(self):
        self.assertIsNone(self._next("daily", 1, "", "2026-09-01T09:00",
                                     "2026-09-08T11:00", end="2026-09-07"))

    def test_none_returns_none(self):
        self.assertIsNone(self._next("none", 1, "", "2026-09-01T09:00", "2026-09-06T11:00"))

    def test_normalize_clamps_dirty_input(self):
        self.assertEqual(S.normalize_rule({"type": "monthly", "by": "99"}),
                         ("monthly", 1, "31", ""))
        self.assertEqual(S.normalize_rule({"type": "weekly", "by": "1,1,9,3"}),
                         ("weekly", 1, "1,3", ""))
        self.assertEqual(S.normalize_rule("garbage"), ("none", 1, "", ""))

    def test_toggle_repeating_item_rolls_forward(self):
        """勾掉一条每天重复的事项：不进已完成，而是滚到下一次。"""
        it = self.new_item(remind_at=hm(-10), repeat={"type": "daily", "interval": 1})
        after = S.set_done(it["id"], True)
        self.assertEqual(after["status"], "open")           # 没进已完成
        self.assertGreater(after["remind_at"], it["remind_at"])
        self.assertEqual(after["done_count"], 1)

    def test_toggle_one_shot_goes_done(self):
        it = self.new_item(repeat={"type": "none"})
        after = S.set_done(it["id"], True)
        self.assertEqual(after["status"], "done")

    def test_describe(self):
        self.assertEqual(S.describe_rule({"type": "daily", "interval": 1}), "每天")
        self.assertEqual(S.describe_rule({"type": "weekly", "interval": 1, "by": "1,3"}),
                         "每周一、周三")
        self.assertEqual(S.describe_rule({"type": "custom", "interval": 2}), "每 2 小时")


# ---------------------------------------------------------------- 幂等
class TestIdempotency(Base):
    def test_same_due_cannot_be_claimed_twice(self):
        it = self.new_item()
        S.claim_run(it["id"], "2026-09-06T09:00", "run1")
        with self.assertRaises(sqlite3.IntegrityError):
            S.claim_run(it["id"], "2026-09-06T09:00", "run2")   # 数据库挡住
        self.assertEqual(len(S.item_runs(it["id"])), 1)

    def test_different_due_can_be_claimed(self):
        it = self.new_item()
        S.claim_run(it["id"], "2026-09-06T09:00", "run1")
        S.claim_run(it["id"], "2026-09-07T09:00", "run2")
        self.assertEqual(len(S.item_runs(it["id"])), 2)

    def test_open_run_blocks_second_dispatch(self):
        it = self.new_item()
        S.claim_run(it["id"], "2026-09-06T09:00", "run1")
        self.assertIsNotNone(S.open_run_of(it["id"]))       # 调度器据此跳过


# ---------------------------------------------------------------- 调度
class TestScheduler(Base):
    def setUp(self):
        super(TestScheduler, self).setUp()
        self.mgr = FakeMgr()
        self.sched = SC.TodoScheduler(self.mgr)             # 不起线程，手动 tick

    def test_fires_due_item_once(self):
        it = self.new_item(remind_at=hm(-1))
        self.sched.tick_once()
        self.assertEqual(len(self.mgr.enqueued), 1)
        self.assertEqual(self.mgr.enqueued[0][1], "t1")

        self.sched.tick_once()                              # 再 tick 不应重复触发
        self.assertEqual(len(self.mgr.enqueued), 1)

    def test_success_settles_and_advances(self):
        it = S.create_item(title="每天跑", list_id="l_work", task_id="t1",
                           auto_run=1, remind_at=hm(-1),
                           repeat={"type": "daily", "interval": 1})
        self.sched.tick_once()
        rid = self.mgr.enqueued[0][0]
        self.mgr.finish(rid, "success")
        self.sched.tick_once()
        runs = S.item_runs(it["id"])
        self.assertEqual(runs[0]["status"], "success")
        self.assertGreater(S.get_item(it["id"])["remind_at"], it["remind_at"])

    def test_one_shot_marks_done_after_success(self):
        it = self.new_item(remind_at=hm(-1), repeat={"type": "none"})
        self.sched.tick_once()
        self.mgr.finish(self.mgr.enqueued[0][0], "success")
        self.sched.tick_once()
        self.assertEqual(S.get_item(it["id"])["status"], "done")

    def test_retries_then_gives_up(self):
        it = self.new_item(remind_at=hm(-1), repeat={"type": "none"})
        self.sched.tick_once()
        rid = self.mgr.enqueued[0][0]

        self.mgr.finish(rid, "failed", 1)
        self.sched.tick_once()
        r = S.find_run(it["id"], it["remind_at"])
        self.assertEqual(r["status"], "retrying")
        self.assertEqual(r["attempt"], 2)

        # 把重试时刻拨到过去，模拟到点
        S.connect().execute("UPDATE todo_run SET retry_at='2000-01-01 00:00:00' WHERE id=?", (r["id"],))
        S.connect().commit()
        self.sched.tick_once()
        self.assertEqual(len(self.mgr.enqueued), 2)         # 第 2 次派发
        self.mgr.finish(self.mgr.enqueued[1][0], "failed", 1)
        self.sched.tick_once()

        S.connect().execute("UPDATE todo_run SET retry_at='2000-01-01 00:00:00' WHERE fire_key=?",
                            (S.fire_key(it["id"], it["remind_at"]),))
        S.connect().commit()
        self.sched.tick_once()
        self.assertEqual(len(self.mgr.enqueued), 3)         # 第 3 次（上限）
        self.mgr.finish(self.mgr.enqueued[2][0], "failed", 1)
        self.sched.tick_once()

        r = S.find_run(it["id"], it["remind_at"])
        self.assertEqual(r["status"], "failed")             # 用尽次数，不再重试
        self.assertEqual(r["attempt"], S.MAX_ATTEMPTS)
        self.assertEqual(len(self.mgr.enqueued), 3)

    def test_manual_stop_is_not_retried(self):
        it = self.new_item(remind_at=hm(-1), repeat={"type": "none"})
        self.sched.tick_once()
        self.mgr.finish(self.mgr.enqueued[0][0], "stopped")
        self.sched.tick_once()
        r = S.find_run(it["id"], it["remind_at"])
        self.assertEqual(r["status"], "failed")             # 尊重用户意图，不重试

    def test_beyond_grace_is_missed_not_fired(self):
        it = self.new_item(remind_at=hm(-180))              # 3 小时前到期
        self.sched.tick_once()
        self.assertEqual(len(self.mgr.enqueued), 0)         # 不补跑
        r = S.find_run(it["id"], it["remind_at"])
        self.assertEqual(r["status"], "missed")

    def test_within_grace_is_caught_up(self):
        it = self.new_item(remind_at=hm(-5))                # 5 分钟前，属于短暂无服务
        self.sched.tick_once()
        self.assertEqual(len(self.mgr.enqueued), 1)         # 补跑

    def test_missing_task_is_skipped(self):
        it = self.new_item(task_id="gone", remind_at=hm(-1))
        self.sched.tick_once()
        self.assertEqual(len(self.mgr.enqueued), 0)
        r = S.find_run(it["id"], it["remind_at"])
        self.assertEqual(r["status"], "skipped")
        self.assertIn("已不存在", r["message"])
        self.assertEqual(S.get_item(it["id"])["task_id"], "gone")   # 不自动解绑

    def test_disabled_task_is_skipped(self):
        self.mgr.tasks["t1"]["disabled"] = True
        it = self.new_item(remind_at=hm(-1))
        self.sched.tick_once()
        self.assertEqual(len(self.mgr.enqueued), 0)
        self.assertEqual(S.find_run(it["id"], it["remind_at"])["status"], "skipped")

    def test_no_autorun_means_no_fire(self):
        self.new_item(auto_run=0, remind_at=hm(-1))
        self.sched.tick_once()
        self.assertEqual(len(self.mgr.enqueued), 0)


# ---------------------------------------------------------------- 重启恢复
class TestRecovery(Base):
    def setUp(self):
        super(TestRecovery, self).setUp()
        self.mgr = FakeMgr()
        self.sched = SC.TodoScheduler(self.mgr)

    def test_orphan_within_grace_is_retried(self):
        it = self.new_item(remind_at=hm(-3))
        S.claim_run(it["id"], it["remind_at"], "run_old")   # 模拟崩溃时留下的 running
        self.sched._recover_orphans()
        r = S.find_run(it["id"], it["remind_at"])
        self.assertEqual(r["status"], "retrying")
        self.assertEqual(r["attempt"], 2)

    def test_orphan_beyond_grace_is_closed(self):
        it = self.new_item(remind_at=hm(-300))
        S.claim_run(it["id"], it["remind_at"], "run_old")
        self.sched._recover_orphans()
        r = S.find_run(it["id"], it["remind_at"])
        self.assertEqual(r["status"], "failed")
        self.assertIn("重启", r["message"])


# ---------------------------------------------------------------- 手动触发
class TestManualTrigger(Base):
    def setUp(self):
        super(TestManualTrigger, self).setUp()
        self.mgr = FakeMgr()
        self.sched = SC.TodoScheduler(self.mgr)

    def test_trigger_ok(self):
        it = self.new_item(auto_run=0)                      # 没开自动执行也能手动跑
        ok, msg = self.sched.trigger_now(it["id"])
        self.assertTrue(ok, msg)
        self.assertEqual(len(self.mgr.enqueued), 1)

    def test_double_click_in_same_minute_is_deduped(self):
        """跑完之后同一分钟内再点：靠 fire_key 的分钟键挡住重复触发。"""
        it = self.new_item(auto_run=0, repeat={"type": "daily", "interval": 1})
        self.sched.trigger_now(it["id"])
        self.mgr.finish(self.mgr.enqueued[0][0], "success")   # 让它正常结束
        self.sched.tick_once()
        ok, msg = self.sched.trigger_now(it["id"])
        self.assertFalse(ok)
        self.assertIn("已经触发过", msg)

    def test_blocked_while_running(self):
        it = self.new_item(auto_run=0)
        self.sched.trigger_now(it["id"])
        ok, msg = self.sched.trigger_now(it["id"])
        self.assertFalse(ok)
        self.assertIn("还没结束", msg)

    def test_no_task_linked(self):
        it = self.new_item(task_id="", auto_run=0)
        ok, msg = self.sched.trigger_now(it["id"])
        self.assertFalse(ok)
        self.assertIn("没有关联任务", msg)

    def test_manual_does_not_consume_scheduled_slot(self):
        """手动跑用的 fire_key 与定时不同，本轮定时触发不受影响。"""
        it = self.new_item(remind_at=hm(-1))
        self.sched.trigger_now(it["id"])
        runs = S.item_runs(it["id"])
        self.assertTrue(all(r["due_at"].startswith("manual:") for r in runs))
        self.assertIsNone(S.find_run(it["id"], it["remind_at"]))


# ---------------------------------------------------------------- 关联
class TestLink(Base):
    def test_link_then_unlink_keeps_item(self):
        it = self.new_item(task_id="t1", auto_run=1)
        self.assertEqual(S.get_item(it["id"])["task_id"], "t1")
        S.unlink_task(it["id"])
        after = S.get_item(it["id"])
        self.assertEqual(after["task_id"], "")
        self.assertEqual(after["auto_run"], 0)              # 解绑顺带关自动执行
        self.assertIsNotNone(after)                         # 事项还在

    def test_deleting_item_cleans_runs(self):
        it = self.new_item()
        S.claim_run(it["id"], "2026-09-06T09:00", "run1")
        S.delete_item(it["id"])
        self.assertEqual(len(S.item_runs(it["id"])), 0)


# ---------------------------------------------------------------- 导入
class TestImport(Base):
    def test_import_legacy_localstorage(self):
        payload = {
            "lists": [{"id": "l_work", "name": "工作", "icon": "list-checks", "color": "#FF5000"}],
            "items": [{"id": "i_1", "listId": "l_work", "title": "老事项",
                       "note": "", "done": False, "flag": True,
                       "remindAt": "2026-09-07T09:00", "createdAt": "2026-09-01T10:00:00"}],
        }
        n = S.import_payload(payload)
        self.assertEqual(n[1], 1)
        items = S.list_items()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "老事项")
        self.assertEqual(items[0]["flag"], 1)

    def test_import_is_idempotent(self):
        payload = {"lists": [], "items": [
            {"id": "i_1", "listId": "l_work", "title": "老事项", "done": False}]}
        S.import_payload(payload)
        S.import_payload(payload)
        self.assertEqual(len(S.list_items()), 1)             # 同 id 不会重复插入


if __name__ == "__main__":
    unittest.main(verbosity=2)
