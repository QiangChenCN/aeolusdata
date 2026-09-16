# -*- coding: utf-8 -*-
"""aeolus_sdk.xlock —— 跨进程文件锁（同一台机器上多个独立 Python 进程并发重登时的互斥）。

为什么需要：
  风神是单点登录，全项目只有「一套」有效 cookie。多个进程（server 常驻 + 手动跑任务 / 定时任务）
  可能同时发现 cookie 失效，同时去重登、互相顶号、甚至把 cookie.txt 写坏。
  进程内已有 threading.Lock（aeolus_sdk.login._shared_lock）管线程并发，但跨进程无力——
  这里用 OS 级咨询锁补齐：
    · Linux / macOS：fcntl.flock（ Advisory lock，进程退出自动释放）
    · Windows：msvcrt.locking（阻塞锁，进程退出自动释放）
  用法：
    with xp_lock(cookie_file):
        # 临界区：先复查有效性，失效才真正重登/兑换并写盘
        ...
  注意：这是「咨询锁」，依赖各参与进程都走同一把锁文件才有效；不走的进程不受约束。
  锁文件路径 = 传入路径 + ".lock"，调用方直接传被保护的 cookie/缓存文件路径即可。
"""
import os

try:
    import fcntl
    _IMPL = "fcntl"
except Exception:  # Windows 无 fcntl
    import msvcrt
    _IMPL = "msvcrt"


class _CrossProcessLock:
    def __init__(self, lock_path):
        self.lock_path = lock_path
        self._fh = None

    def __enter__(self):
        d = os.path.dirname(os.path.abspath(self.lock_path))
        if d and not os.path.isdir(d):
            os.makedirs(d, exist_ok=True)
        # "w" 打开即清空；锁文件内容无关紧要，只用其 inode 当互斥锚点
        self._fh = open(self.lock_path, "w")
        if _IMPL == "fcntl":
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX)
        else:
            msvcrt.locking(self._fh.fileno(), msvcrt.LK_LOCK, 1)
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if self._fh is not None:
                if _IMPL == "fcntl":
                    fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
                else:
                    msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
                self._fh.close()
        except Exception:
            pass
        self._fh = None
        return False


def xp_lock(lock_path):
    """返回一个跨进程互斥锁上下文管理器。

    lock_path 传被保护的 cookie / 缓存文件路径即可，内部自动追加 ".lock" 作为锁文件。
    进入临界区时会阻塞，直到拿到锁；退出（含异常）自动释放。
    """
    return _CrossProcessLock(lock_path + ".lock")
