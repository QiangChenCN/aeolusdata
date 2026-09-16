# -*- coding: utf-8 -*-
"""路由层回归测试：验证 do_GET/do_POST 的路由表分发（P1 重构后）。

不启动真实 HTTP server，只用 SimpleNamespace 模拟 Handler 实例，
断言分发器正确查表、404 兜底、静态短路、handler 可被调用。
"""
import os
import sys
import types

import pytest
from unittest.mock import MagicMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import server


def _make_handler(path="/api/x", auth_ok=True, static_ok=False):
    h = types.SimpleNamespace()
    h.path = path
    h.client_address = ("127.0.0.1", 1234)
    h.headers = {"Content-Type": "application/json", "Content-Length": "0"}
    h._check_auth = lambda: auth_ok
    h._serve_static_get = lambda self, p: static_ok
    h._body = lambda: {}
    h._json = MagicMock()
    h._send = MagicMock()
    return h


def test_route_tables_complete():
    assert len(server.GET_ROUTES) == 29
    assert len(server.POST_ROUTES) == 16
    # 每个 handler 都应是可调用对象
    for fn in list(server.GET_ROUTES.values()) + list(server.POST_ROUTES.values()):
        assert callable(fn)


def test_get_unknown_returns_404():
    h = _make_handler("/api/does-not-exist")
    server.Handler.do_GET(h)
    h._json.assert_called_once()
    assert h._json.call_args[0][0]["error"] == "not found"


def test_get_static_short_circuits():
    h = _make_handler("/")
    h._serve_static_get = lambda self, p: True  # 静态已处理
    server.Handler.do_GET(h)
    h._json.assert_not_called()  # 不应进入 api 分支


def test_get_state_dispatches_and_returns_ok():
    h = _make_handler("/api/state")
    server.Handler.do_GET(h)
    h._json.assert_called_once()
    assert h._json.call_args[0][0]["ok"] is True


def test_get_lan_set_is_method_not_allowed():
    h = _make_handler("/api/lan/set")
    server.Handler.do_GET(h)
    h._json.assert_called_once()
    assert h._json.call_args[0][0]["error"] == "method not allowed"


def test_post_unknown_returns_404():
    h = _make_handler("/api/nope")
    server.Handler.do_POST(h)
    h._json.assert_called_once()
    assert h._json.call_args[0][0]["error"] == "not found"


def test_post_run_empty_items_rejected():
    h = _make_handler("/api/run")
    h._body = lambda: {"items": []}
    server.Handler.do_POST(h)
    h._json.assert_called_once()
    assert h._json.call_args[0][0]["ok"] is False


def test_post_non_json_rejected():
    h = _make_handler("/api/run")
    h.headers = {"Content-Type": "text/plain", "Content-Length": "5"}
    server.Handler.do_POST(h)
    h._json.assert_called_once()
    assert h._json.call_args[0][0]["error"] == "仅接受 application/json 请求体"
