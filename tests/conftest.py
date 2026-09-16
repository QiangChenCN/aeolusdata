"""pytest 公共夹具：确保项目根（common/、core/ 所在）在 sys.path，使测试可直接 import。

P0 安全网的一部分：让 `common`、`core`、`dashboard` 等顶层包在测试中被发现，
无需手动设置 PYTHONPATH。

注意：不在此处全局替换 dws_run —— 各测试通过 `monkeypatch subprocess.run` 隔离外部进程，
保留 dws_run 真实实现以便对其行为做特性测试。
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
