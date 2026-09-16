#!/usr/bin/env python3
"""骑士规则中心取数 —— 单一来源。

本文件只做一件事：调用风神规则接口
`xtop.robot.admin.ruleInfoViewFs.queryRuleInfo/1.0` 查询单条规则快照。

设计约定（见工作区永久记忆 get_data 约定）：
- 每个 get_data 模块 = 一个接口，只负责「打接口取数」
- 所有查询参数（rule_id / is_history / cookie）均由调用方传入；本文件不做渲染/选版本
- 禁止在模块内做：HTML 渲染 / 字段展平 / 自动重登 / 落盘 / CLI
- 「套用前台模板渲染、写 HTML/MD」归调用方（jobs/ruledoc/gen_rule_doc.py）

对外能力：
- query_rule(rule_id, is_history, cookie=None) -> data   返回 result.data（规则快照 dict）
- RuleQueryError                                 业务错误结构化异常（规则不存在 / 已下线等）
"""
import json
import urllib.request
import urllib.error

from aeolus_sdk import login as L

API = "https://httpizza.ele.me/xtop/xtop.robot.admin.ruleInfoViewFs.queryRuleInfo/1.0"


class RuleQueryError(RuntimeError):
    """风神规则接口业务错误的结构化异常。

    把 rule_id / is_history / 内层业务码 / API message 全部带上，
    不再只把整坨响应 JSON 塞进 str，方便上层判断与展示。
    """
    def __init__(self, rule_id, is_history, inner_code, message, raw):
        self.rule_id = rule_id
        self.is_history = is_history
        self.inner_code = inner_code
        self.api_message = message or ""
        self.raw = raw
        mode = "历史版本" if is_history else "现行有效版本"
        head = "规则 %s（%s）查询失败：%s" % (rule_id, mode, message or "未知业务错误")
        hint = ""
        if "规则不存在" in (message or "") and not is_history:
            hint = " —— 该规则可能已从现行版本下架，请把版本改回「历史版本(全量)」再试"
        elif "规则不存在" in (message or "") and is_history:
            hint = " —— 历史快照里也找不到该 rule ID，请核对输入"
        super().__init__(head + hint)


def query_rule(rule_id, is_history, cookie=None):
    """查询单条规则快照，返回 result.data（dict）。

    cookie 可选，不传则自动 ensure_cookies() 登录。
    业务错误（规则不存在 / 已下线 / 缺字段）抛 RuleQueryError；网络/HTTP 异常原样上抛。
    不含自动重登 / 渲染 / 落盘；会话失效由调用方捕获后重登重试。
    """
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    payload = {"params": {"request": {"isHistory": is_history, "id": rule_id}}}
    req = urllib.request.Request(API, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json", "Cookie": cookie})
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError("规则接口 HTTP %s（rule_id=%s）：%s"
                           % (e.code, rule_id, e.read().decode("utf-8", "replace")[:300])) from e
    except urllib.error.URLError as e:
        raise RuntimeError("规则接口网络异常（rule_id=%s）：%s" % (rule_id, e.reason)) from e
    except (json.JSONDecodeError, ValueError) as e:
        raise RuntimeError("规则接口响应不是合法 JSON（rule_id=%s）：%s"
                           % (rule_id, e)) from e

    outer_code = resp.get("code")
    if outer_code is not None and outer_code != 200:
        raise RuntimeError("规则接口外层 code=%s（rule_id=%s）：%s"
                           % (outer_code, rule_id, json.dumps(resp, ensure_ascii=False)[:300]))

    inner = resp.get("result") or {}
    inner_code = inner.get("code")
    if inner_code is None:
        raise RuntimeError("规则接口响应缺 result.code（rule_id=%s）：%s"
                           % (rule_id, json.dumps(resp, ensure_ascii=False)[:300]))
    if inner_code != 200:
        raise RuleQueryError(rule_id, is_history, inner_code, inner.get("message"), resp)
    data = inner.get("data")
    if not data:
        raise RuleQueryError(rule_id, is_history, inner_code, inner.get("message") or "result.data 为空", resp)
    return data


__all__ = ["API", "RuleQueryError", "query_rule"]
