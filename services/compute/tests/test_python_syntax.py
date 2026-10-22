#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全量语法编译冒烟：任何 .py 文件出现语法错误都必须在这里红。

为什么需要这条：服务是常驻进程（gunicorn + 4 worker），语法错误不会在编辑时暴露，
而是在**重启后 worker boot 失败**才显现 —— 表现为「重启了但端口没起来」，排查成本高。
（2026-10-21 事故：抽取 handler 到看板私有包时留下孤立的 `except` 块，
check:arch 与构建都通过，只有计算服务起不来才发现。）

本用例只做 `compile()`，不执行模块（无副作用、秒级完成）。
"""
import os

import sys


def _python_home():
    d = os.path.dirname(os.path.abspath(__file__))
    while d and os.path.basename(d) != 'python':
        d = os.path.dirname(d)
    return d


def test_all_python_files_compile():
    home = _python_home()
    roots = [
        os.path.join(home, 'analytics'),
        os.path.join(home, 'compute_api'),
        os.path.join(home, 'common'),
        os.path.join(home, 'tools'),
    ]
    checked = 0
    broken = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in ('__pycache__', '.venv', 'venv')]
            for fn in filenames:
                if not fn.endswith('.py'):
                    continue
                p = os.path.join(dirpath, fn)
                checked += 1
                try:
                    # 内存编译（不落 .pyc）：compile() 只做语法/字节码检查，无导入副作用
                    with open(p, 'r', encoding='utf-8') as fh:
                        compile(fh.read(), p, 'exec')
                except SyntaxError as e:
                    broken.append(f'{os.path.relpath(p, home)}: {e}')
                except ValueError as e:  # 源含 null 字节等
                    broken.append(f'{os.path.relpath(p, home)}: {e}')
    assert checked > 0, '未扫描到任何 Python 文件（roots 配置有误？）'
    assert not broken, '存在语法错误的文件：\n' + '\n'.join(broken[:20])
    print(f'\n[语法冒烟] 已编译 {checked} 个 Python 文件，全部通过', file=sys.stderr)
