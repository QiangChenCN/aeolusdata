#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""工作内容 · 定时调度器

到点把「关联了任务 + 开了自动执行」的事项丢进 RunManager 的队列里跑。

为什么要自己写而不用 apscheduler：需要的是「同一事项同一时刻只触发一次」
这种跟业务数据强耦合的幂等语义，靠内存态的 job store 做不到 —— 进程一重启
内存里的 job 就没了，而我们的去重是落在数据库 UNIQUE 约束上的。

边界情况处理
============
1) 重启恢复
   启动第一件事是把上次遗留的 running 记录收尾（进程被杀，子进程结果没人收）：
   还在补跑宽限期内 → 转成重试，让它自然补上；
   超过宽限期       → 判失败并推进，避免重启瞬间把积压的几十次全补跑一遍。
   那些压根没触发过的到期项，由常规扫描按同样的宽限期规则处理。

2) 补跑宽限期（CATCHUP_GRACE_SEC = 15 分钟）
   到期时刻距现在 15 分钟内 → 正常补跑（重启、机器睡醒等短暂无服务）；
   超过 15 分钟             → 记为 missed 跳过。
   取舍：宁可漏一次，也不要在周一早上九点重启时把上周五到现在的活儿全部倒出来。

3) 失败重试
   最多 3 次（1 次正式 + 2 次重试），退避 60s / 300s。
   重试复用同一条执行记录、attempt 递增，不新开 fire_key —— 否则
   「同一时刻只触发一次」的语义会被重试本身破坏。
   3 次都不成 → 判失败，推进到下一周期，不让一个坏任务把后续全堵死。

4) 去重（三层）
   · 内存：同一事项有未结束的执行时直接跳过（调度与手动互斥）；
   · 逻辑：fire_key 已存在说明本轮处理过了；
   · 数据库：todo_run.fire_key 的 UNIQUE 约束，并发插入只有一个能成功，
     另一个拿 IntegrityError 安静放弃。前两层只是降概率，这层才是保证。

5) 关联任务失效
   任务中心的注册表是 tasks.json，随时可能被删或被禁用。到期时若发现任务
   不在了，写一条 skipped 记录（占位，防止每 tick 重试）并广播提示，
   但**不自动解绑、不删事项** —— 用户的待办数据不因为外部变化而被动消失，
   由用户自己决定是改关联还是删掉。
"""
import json
import time
import sqlite3
import threading
from datetime import datetime, timedelta

# 两种被导入的方式都要能活：
#   · python server.py  → sys.path[0] 就是 server，走绝对导入
#   · from server import ...   → 命名空间包，走相对导入
try:
    from . import todo_store as store
except ImportError:                                   # pragma: no cover
    import todo_store as store


class TodoScheduler(threading.Thread):
    TICK_SEC = 5            # 扫描间隔；提醒精度是分钟，5 秒足够且不空转
    PRUNE_EVERY = 3600      # 每小时清一次过期执行记录

    def __init__(self, mgr, tick=None):
        super().__init__(daemon=True)
        self.mgr = mgr
        self.tick = tick or self.TICK_SEC
        self.stop_evt = threading.Event()
        self._last_prune = 0.0
        self._log = []

    # ------------------------------------------------------------ 生命周期
    def run(self):
        self._recover_orphans()
        while not self.stop_evt.is_set():
            try:
                self.tick_once()
            except Exception as e:
                # 调度线程挂了整个工作台就瞎了，吞掉异常但留痕
                self._note("调度异常：%s" % e)
            self.stop_evt.wait(self.tick)

    def stop(self):
        self.stop_evt.set()

    def _note(self, msg):
        line = "[%s] %s" % (datetime.now().strftime("%H:%M:%S"), msg)
        self._log.append(line)
        self._log = self._log[-200:]
        print("[todo-sched] %s" % msg, flush=True)

    def _emit(self, event, item_id=None, message="", extra=None):
        """借 RunManager 的 SSE 通道把变化推给前端，页面不用轮询。"""
        try:
            payload = {"type": "todo", "event": event,
                       "item_id": item_id, "message": message}
            if extra:
                payload.update(extra)
            self.mgr.emit(payload)
        except Exception:
            pass

    # ------------------------------------------------------------ 主循环
    def tick_once(self):
        now = datetime.now()
        self._fire_due(now)
        self._dispatch_retries(now)
        self._poll_running()
        if time.time() - self._last_prune > self.PRUNE_EVERY:
            try:
                store.prune_runs()
            except Exception:
                pass
            self._last_prune = time.time()

    # ------------------------------------------------------------ 到点触发
    def _fire_due(self, now):
        now_str = now.strftime("%Y-%m-%dT%H:%M")
        for item in store.due_items(now_str):
            self._maybe_fire(item, now)

    def _maybe_fire(self, item, now):
        iid, due = item["id"], item["remind_at"]

        # 关联任务还在不在（tasks.json 是外部数据，随时可能没了这个任务）
        st = self.mgr.link_state(item.get("task_id"))
        if st != "ok":
            store.mark_skipped(iid, due, "关联任务%s，已跳过本次"
                               % ("已不存在" if st == "missing" else "已禁用"))
            self._emit("skipped", iid, "关联任务%s，本次未执行"
                       % ("已不存在" if st == "missing" else "已禁用"))
            return

        if store.find_run(iid, due):
            return                                   # 本轮已处理过
        if store.open_run_of(iid):
            return                                   # 上一次还没跑完，不叠

        due_dt = store._parse_dt(due)
        if due_dt is None:
            return
        late = (now - due_dt).total_seconds()
        if late > store.CATCHUP_GRACE_SEC:
            # 服务没在运行期间错过的：记一笔就跳过，不做补跑风暴
            store.mark_missed(iid, due, "服务未运行，已跳过本次（超出 %d 分钟补跑宽限）"
                              % (store.CATCHUP_GRACE_SEC // 60))
            self._settle(iid, success=False)
            self._emit("missed", iid, "到点未执行：服务当时未运行，已跳过")
            return

        self._dispatch(item, due, attempt=1)

    def _dispatch(self, item, due, attempt=1):
        """真正入队。claim 的 UNIQUE 约束负责挡住并发重复。"""
        try:
            args = json.loads(item.get("task_args") or "{}")
        except Exception:
            args = {}
        run_ids = self.mgr.enqueue([{"task_id": item["task_id"], "args": args}])
        if not run_ids:
            store.mark_skipped(item["id"], due, "任务入队失败（任务可能已被移除）")
            return None
        try:
            store.claim_run(item["id"], due, run_ids[0], attempt=attempt)
        except sqlite3.IntegrityError:
            return None                              # 被别的线程抢先了，安静放弃
        self._note("触发「%s」→ 任务 %s（第 %d 次）" % (item["title"], item["task_id"], attempt))
        self._emit("fired", item["id"], "已触发：%s" % item["title"],
                   {"run_id": run_ids[0]})
        return run_ids[0]

    # ------------------------------------------------------------ 重试
    def _dispatch_retries(self, now):
        for r in store.retry_due():
            item = store.get_item(r["item_id"])
            if not item or not item.get("task_id"):
                store.finish_run(r["item_id"], r["due_at"], store.RUN_FAILED, "事项或关联任务已不存在")
                continue
            st = self.mgr.link_state(item["task_id"])
            if st != "ok":
                store.finish_run(r["item_id"], r["due_at"], store.RUN_SKIPPED,
                                 "重试时关联任务%s" % ("已不存在" if st == "missing" else "已禁用"))
                self._settle(r["item_id"], success=False)
                continue
            run_ids = self.mgr.enqueue([{"task_id": item["task_id"],
                                         "args": _safe_args(item)}])
            if not run_ids:
                continue                              # 入队失败，下个 tick 再试
            store.mark_dispatched(r["item_id"], r["due_at"], run_ids[0], r["attempt"])
            self._note("重试「%s」第 %d 次" % (item["title"], r["attempt"]))
            self._emit("retried", item["id"], "第 %d 次重试：%s" % (r["attempt"], item["title"]),
                       {"run_id": run_ids[0]})

    # ------------------------------------------------------------ 结果回收
    def _poll_running(self):
        for r in store.open_runs():
            if r["status"] == store.RUN_RETRYING:
                continue                              # 由 _dispatch_retries 管
            st = self.mgr.run_status(r["run_id"])
            if st is None:
                continue                              # 还没派到 / 已丢失，等下一轮
            status = st.get("status")
            if status in ("queued", "running"):
                continue
            if status == "success":
                store.finish_run(r["item_id"], r["due_at"], store.RUN_SUCCESS, "执行成功")
                store.settle_success(r["item_id"])
                self._note("「%s」执行成功" % (store.get_item(r["item_id"]) or {}).get("title", r["item_id"]))
                self._emit("succeeded", r["item_id"], "执行成功")
                continue

            # 失败 / 超时 / 被终止
            if status == "stopped":
                store.finish_run(r["item_id"], r["due_at"], store.RUN_FAILED,
                                 "已被手动终止，不再自动重试")
                self._settle(r["item_id"], success=False)
                self._emit("failed", r["item_id"], "执行被手动终止")
                continue

            if r["attempt"] < store.MAX_ATTEMPTS:
                store.schedule_retry(r["item_id"], r["due_at"], r["attempt"] + 1,
                                     "第 %d 次失败（退出码 %s），%d 秒后重试"
                                     % (r["attempt"], st.get("exit_code"),
                                        store.retry_delay_for(r["attempt"])))
                self._emit("retrying", r["item_id"],
                           "执行失败，%d 秒后第 %d 次重试"
                           % (store.retry_delay_for(r["attempt"]), r["attempt"] + 1))
            else:
                store.finish_run(r["item_id"], r["due_at"], store.RUN_FAILED,
                                 "已重试 %d 次仍失败（退出码 %s）" % (store.MAX_ATTEMPTS - 1,
                                                                      st.get("exit_code")))
                self._settle(r["item_id"], success=False)
                self._emit("failed", r["item_id"], "重试 %d 次仍失败，已跳过本次"
                           % (store.MAX_ATTEMPTS - 1))

    def _settle(self, iid, success):
        """一次执行彻底结束后的收尾：重复项滚到下一次，一次性项按成败处理。"""
        try:
            if success:
                store.settle_success(iid)
            else:
                store.advance_after_run(iid)
        except Exception as e:
            self._note("推进事项失败：%s" % e)

    # ------------------------------------------------------------ 启动恢复
    def _recover_orphans(self):
        """进程上次被杀时留在 running 的记录：能补就补，太旧就判失败推进。"""
        now = datetime.now()
        for r in store.open_runs():
            item = store.get_item(r["item_id"])
            title = (item or {}).get("title", r["item_id"])
            if item and item.get("task_id") and self.mgr.link_state(item["task_id"]) == "ok":
                due_dt = store._parse_dt(r["due_at"])
                late = (now - due_dt).total_seconds() if due_dt else 10 ** 9
                if r["attempt"] < store.MAX_ATTEMPTS and late <= store.CATCHUP_GRACE_SEC:
                    store.schedule_retry(r["item_id"], r["due_at"], r["attempt"] + 1,
                                         "服务重启，补跑第 %d 次" % (r["attempt"] + 1))
                    self._note("重启恢复：补跑「%s」第 %d 次" % (title, r["attempt"] + 1))
                    continue
            store.finish_run(r["item_id"], r["due_at"], store.RUN_FAILED,
                             "服务重启，上次执行中断")
            self._settle(r["item_id"], success=False)
            self._note("重启恢复：中断的执行已收尾 —— %s" % title)
        self._emit("recovered", None, "调度器已启动，待执行项已恢复")

    # ------------------------------------------------------------ 手动触发
    def trigger_now(self, item_id):
        """手动立即执行一次。返回 (ok, 说明)。

        用 "manual:<分钟>" 当 fire_key 的到期值：既跟定时触发的键区分开
        （手动跑不会吃掉本轮的定时触发），又能挡住同一分钟里的连点。
        """
        item = store.get_item(item_id)
        if not item:
            return (False, "事项不存在")
        if not item.get("task_id"):
            return (False, "这个事项没有关联任务")
        st = self.mgr.link_state(item["task_id"])
        if st != "ok":
            return (False, "关联任务%s，无法执行" % ("已不存在" if st == "missing" else "已禁用"))
        if store.open_run_of(item_id):
            return (False, "上一次执行还没结束，稍等再试")

        due = "manual:" + datetime.now().strftime("%Y-%m-%dT%H:%M")
        if store.find_run(item_id, due):
            return (False, "刚刚已经触发过了，一分钟后再试")

        run_id = self._dispatch(item, due, attempt=1)
        if not run_id:
            return (False, "入队失败，请重试")
        return (True, "已触发执行")


def _safe_args(item):
    try:
        return json.loads(item.get("task_args") or "{}")
    except Exception:
        return {}


def start(mgr):
    """在 server.py 里调用：初始化库 + 起线程。"""
    store.init_db()
    sched = TodoScheduler(mgr)
    sched.start()
    return sched
