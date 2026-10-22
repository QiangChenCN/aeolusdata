#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""架构边界回归（P0 护栏）。

本项目是「多看板」架构，且同一个指标允许存在多套算法（如「有效单」在各看板口径不同）。
真正的风险是**跨看板直接引用内部实现**：一旦共享，改一处就会波及多个看板（历史事故：
把共享的 order_rules.is_valid_order 当全局唯一口径改掉，三个看板同时失真）。

本用例把 Python 作用域的架构检查脚本 `services/compute/scripts/check-arch.mjs` 纳入
pytest，使「新增跨看板耦合」在测试里就红：
  · R4 Python 看板私有包（analytics/domains/<name>/）之间禁止互引
  · R5 被 ≥2 个看板引用的 Python 模块必须登记为共享契约

注：后端（R1/R6）与前端（R2/R3）的边界由根目录 `npm run check:arch` 另外两个脚本
分别覆盖；本测试只负责 Python 计算层。

存量债务登记在 `services/compute/scripts/arch-baseline.json`（棘轮）：存量不阻断，新增必失败。
"""
import json
import os
import shutil
import subprocess

import pytest


def _repo_root():
    d = os.path.dirname(os.path.abspath(__file__))
    # 仓库根：含 .git 或根 package.json（目录名无关）
    while d and d != os.path.dirname(d) and not (
        os.path.exists(os.path.join(d, ".git"))
        or os.path.exists(os.path.join(d, "package.json"))
    ):
        d = os.path.dirname(d)
    return d


def test_architecture_boundaries():
    root = _repo_root()
    script = os.path.join(root, 'services', 'compute', 'scripts', 'check-arch.mjs')
    if not os.path.exists(script):
        pytest.skip(f'未找到架构检查脚本：{script}')
    if not shutil.which('node'):
        pytest.skip('未安装 node，跳过架构边界检查（前端/后端 CI 侧请单独执行 npm run check:arch）')

    proc = subprocess.run(
        ['node', script, '--json'],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert proc.returncode in (0, 1), f'架构检查异常退出（{proc.returncode}）：{proc.stderr[:800]}'
    try:
        data = json.loads(proc.stdout)
    except Exception as e:  # 脚本输出异常时给出可读诊断
        raise AssertionError(f'架构检查输出无法解析：{e}\n{proc.stdout[:800]}\n{proc.stderr[:800]}')

    violations = data.get('violations') or []
    if violations:
        lines = ['检测到「新增」跨看板耦合（存量见 services/compute/scripts/arch-baseline.json）：']
        for v in violations[:20]:
            lines.append(f"  [{v['rule']}] {v['from']} → {v['import']}")
        raise AssertionError('\n'.join(lines))
