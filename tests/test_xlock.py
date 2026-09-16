# -*- coding: utf-8 -*-
"""跨进程文件锁回归测试（cookie 跨进程锁）。

验证 aeolus_sdk.xlock.xp_lock：
  - 作为上下文管理器可正常进入/退出，锁文件 = path + ".lock"
  - 未持锁时真正串行化并发写者（同进程内多线程模拟跨进程争抢，不挂死）
  - save_cookies 公共入口已自动加锁，裸写路径也受互斥保护
"""
import os
import sys
import time
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from aeolus_sdk.xlock import xp_lock
import aeolus_sdk.login as L


def test_xp_lock_context_manager_creates_lockfile(tmp_path):
    target = tmp_path / "cookie.txt"
    target.write_text("initial")
    with xp_lock(str(target)):
        pass  # 进入并正常退出
    # 锁文件应已生成（路径 = target + ".lock"）
    assert (tmp_path / "cookie.txt.lock").is_file()


def test_xp_lock_serializes_concurrent_writers(tmp_path):
    """两个并发写者必须串行：waiter 拿到锁的顺序一定在 holder 释放之后。"""
    target = tmp_path / "cookie.txt"
    target.write_text("initial")
    order = []

    def holder():
        with xp_lock(str(target)):
            order.append("holder")
            time.sleep(0.3)  # 持有期间 waiter 应被阻塞

    def waiter():
        with xp_lock(str(target)):
            order.append("waiter")

    t1 = threading.Thread(target=holder)
    t1.start()
    time.sleep(0.05)
    t2 = threading.Thread(target=waiter)
    t2.start()
    t1.join(timeout=5)
    t2.join(timeout=5)
    assert order == ["holder", "waiter"], "waiter 应在 holder 释放后才拿到锁"


def test_save_cookies_is_lock_guarded(tmp_path):
    """公共 save_cookies 走 xp_lock；写盘后内容正确且锁文件已建立。"""
    cookie_file = tmp_path / "cookie.txt"
    L.save_cookies("abc123", path=str(cookie_file))
    assert cookie_file.read_text(encoding="utf-8").strip() == "abc123"
    # 锁文件在退出时应已创建（ctx manager 内 open 过 .lock）
    assert (tmp_path / "cookie.txt.lock").is_file()
