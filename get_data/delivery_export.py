#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""运单明细导出取数 —— 单一来源（异步导出，替代分页 queryTracking）。

本文件只做一件事：通过 Aeolus 运单数据页的异步导出能力，一次性拉取
时间窗内**全站**运单明细，返回结构化 dict 列表。

为什么不用分页 queryTracking
---------------------------
分页拉全量（约 125 页）会撞服务端按分钟请求数的配额墙，触发「请求太频繁」
限流（实测一次刷新被拒 12 次、耗时翻倍）。运单数据页自带「导出」按钮，
本质是 Aeolus 的异步导出机制：触发 → 服务端异步生成 xlsx → 返回签名下载链接。
全程纯 HTTP，与 violation.py 的 download/1.0 同构（下载免 cookie）。

三段式异步导出（均为纯 HTTP）
-----------------------------
  1. exportTracking/2.0     触发导出（body 同 queryTracking 查询条件，无 teamId=全站，返回 data:true）
  2. queryExportTask/2.0    轮询导出任务列表（**双 agencyTrackingFs 前缀**，单形式 404）
                             任务对象：{id(自增taskId), fileName(秒级时间戳_运单.xlsx),
                                      exportTime(ms), status(0导出中/1成功), remark, fileHash}
  3. queryTaskUrl/2.0       用 taskId 取 OSS 签名 fileUrl（字符串，约1h有效期）
  4. 下载 fileUrl（无 cookie，免鉴权）

归属算法（避免「下载中心多任务」混淆）
-------------------------------------
  触发前先 list_tasks 记 max_id；触发后轮询到 id>max_id 且 status=1 即认领。
  taskId 服务端自增唯一，历史任务 id 均 <= max_id 被自动排除，无歧义。
  （标准达成一次刷新只触发一个全站导出，不存在并发，认领必然唯一。）

字段映射
--------
  xlsx 中文表头 → **双写英文键**（保留中文原名 + 同时写英文键），
  对齐 queryTracking 返回值，使下游 fetch_orders_grouped / order_rules /
  rider_dimension / achievement 零改动。
  重点覆盖 order_rules 依赖的键：teamId / trackingId / knightId /
  acceptAtLast(骑手接单时间) / trackingCreatedAt / stateDesc(运单状态) /
  isReverse(是否逆向单) / isReassign(是否发生改派) / isCheat(欺诈是否成立) /
  isAbnormalReport(是否异常报备)。

设计约定（见永久记忆 get_data 约定）
-----------------------------------
- 每个 get_data 模块 = 一个数据来源，只负责「打接口取数」（此处是「导出取数」整体）。
- 查询参数（时间窗 start_ms/end_ms、cookie）由调用方传入；本文件不负责选日期、落盘、
  自动重登、限流退避或格式化（这些归调用方 orders_fetch / refresh_all）。
- cookie 可选，不传则自动 ensure_cookies() 登录。
"""
import datetime
import io
import json
import time
import urllib.request
import urllib.error

from aeolus_sdk import login as L
import openpyxl

# 注意前缀差异（前端 base path 多拼了一次 agencyTrackingFs，实测已验证）：
#   exportTracking  → 单 agencyTrackingFs（双形式 404）
#   queryExportTask → 双 agencyTrackingFs（单形式 404）
#   queryTaskUrl    → 双 agencyTrackingFs（单形式 404）
EXPORT_URL = "https://httpizza.ele.me/xtop/xtop.merchant.agencyTrackingFs.exportTracking/2.0"
TASK_URL = "https://httpizza.ele.me/xtop/xtop.merchant.agencyTrackingFs.agencyTrackingFs.queryExportTask/2.0"
URL_URL = "https://httpizza.ele.me/xtop/xtop.merchant.agencyTrackingFs.agencyTrackingFs.queryTaskUrl/2.0"
HEADERS_BASE = {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "origin": "https://aeolus.ele.me",
    "referer": "https://aeolus.ele.me/",
}
BJ = datetime.timezone(datetime.timedelta(hours=8))
POLL_INTERVAL = 3.0
DEFAULT_POLL_TIMEOUT = 180.0

# 中文表头 → 英文键（对齐 queryTracking 返回值；重点覆盖 order_rules 依赖的键）
CN2EN = {
    "商id": "merchantId",
    "商名称": "merchantName",
    "站点id": "teamId",
    "站点名称": "teamName",
    "商圈id": "zoneId",
    "商圈名称": "zoneName",
    "运单id": "trackingId",
    "订单号": "orderNo",
    "骑手id": "knightId",
    "骑手名称": "knightName",
    "平台商家id": "platformMerchantId",
    "平台商家名称": "platformMerchantName",
    "商家订单流水号": "merchantOrderSerial",
    "运单类型": "trackingType",
    "运单状态": "stateDesc",   # order_rules 用 '状态描述'/'stateDesc' 命中
    "配送标品": "deliveryStandard",
    "订单来源": "orderSource",
    "订单距离(km)": "orderDistanceKm",
    "订单金额(元)": "orderAmount",
    "订单重量(kg)": "orderWeightKg",
    "用户下单时间": "userOrderAt",
    "用户支付时间": "userPayAt",
    "运单创建时间": "trackingCreatedAt",
    "团队接单时间": "teamAcceptAt",
    "骑手接单时间": "acceptAtLast",
    "骑手到店时间": "riderArriveAt",
    "实际出餐时间": "actualMealReadyAt",
    "骑手取餐时间": "pickupAt",
    "骑手送达时间": "deliverAt",
    "运单完成时间": "trackingFinishAt",
    "用户期望时间": "userExpectAt",
    "骑手考核时间": "riderAssessAt",
    "运单取消时间": "trackingCancelAt",
    "平台期望时间": "platformExpectAt",
    "是否超平台期望时间": "isOverPlatformExpect",
    "超平台期望送达时长": "overPlatformExpectDuration",
    "是否超用户T": "isOverUserT",
    "是否超骑手T": "isOverRiderT",
    "配送时长": "deliveryDuration",
    "天气等级": "weatherLevel",
    "天气": "weather",
    "欺诈是否成立": "isCheat",
    "违规取餐是否成立": "isViolatePickup",
    "违规到店是否成立": "isViolateArrive",
    "违规送达是否成立": "isViolateDeliver",
    "是否逆向单": "isReverse",
    "是否发生转单": "isTransfer",
    "是否发生改派": "isReassign",
    "索赔是否成立": "isClaim",
    "索赔原因": "claimReason",
    "是否异常报备": "isAbnormalReport",
    "异常报备项": "abnormalReportItem",
    "是否异常标记": "isAbnormalMark",
    "异常标记项": "abnormalMarkItem",
    "虚假报备是否成立": "isFalseReport",
    "虚假报备项": "falseReportItem",
    "虚假标记是否成立": "isFalseMark",
    "虚假标记项": "falseMarkItem",
    "取消发起方": "cancelInitiator",
    "取消发起原因": "cancelReason",
    "取消责任方": "cancelResponsible",
    "用户投诉是否成立": "isUserComplaint",
    "用户投诉内容": "userComplaintContent",
    "用户投诉责任方": "userComplaintResponsible",
    "商户投诉是否成立": "isMerchantComplaint",
    "商户投诉内容": "merchantComplaintContent",
    "商户投诉责任方": "merchantComplaintResponsible",
    "用户评价责任方": "userEvalResponsible",
    "用户评价等级": "userEvalLevel",
    "商户评价责任方": "merchantEvalResponsible",
    "商户评价等级": "merchantEvalLevel",
    "是否高笔单": "isHighValue",
    "是否二呼单": "isSecondCall",
}


# 中文布尔列：导出用「是/否」，order_rules 的 _is_truthy_flag 只认 0/false/空，
# 需在此标准化为 Python 布尔，否则「否」会被误判为真值而错误剔除有效单。
BOOL_EN = {
    "isCheat", "isReverse", "isReassign", "isTransfer", "isAbnormalReport",
    "isAbnormalMark", "isViolatePickup", "isViolateArrive", "isViolateDeliver",
    "isClaim", "isFalseReport", "isFalseMark", "isOverPlatformExpect",
    "isOverUserT", "isOverRiderT", "isHighValue", "isSecondCall",
}
# 时间列：导出是「YYYY-MM-DD HH:MM:SS」(北京时间) 字符串，order_rules.accept_ms
# 期望毫秒时间戳整数。需在此转毫秒，否则日期归属全部失效。
TIME_EN = {
    "trackingCreatedAt", "teamAcceptAt", "acceptAtLast", "riderArriveAt",
    "actualMealReadyAt", "pickupAt", "deliverAt", "trackingFinishAt",
    "userOrderAt", "userPayAt", "trackingCancelAt", "userExpectAt",
    "riderAssessAt", "platformExpectAt",
}


def _to_ms(v):
    """字符串时间 → 毫秒时间戳（北京时间）。非时间值原样返回。"""
    if isinstance(v, (int, float)):
        return int(v)
    if not isinstance(v, str):
        return v
    s = v.strip()
    if not s:
        return v
    if s.isdigit():
        return int(s)
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M:%S"):
        try:
            dt = datetime.datetime.strptime(s, fmt).replace(tzinfo=BJ)
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    return v


class AuthError(Exception):
    """会话失效（单点登录被顶号 / cookie 过期）。"""


def build_export_body(start_ms, end_ms):
    """组装导出查询条件（与 queryTracking 同构，无 teamId=全站）。"""
    return {"params": {"request": {
        "trackingFinishStart": start_ms,
        "trackingFinishEnd": end_ms,
        "merchantConsumerDistanceStart": "0",
        "merchantConsumerDistanceEnd": "999999",
        "payAmountStart": "0",
        "payAmountEnd": "999999",
        "weightStart": "0",
        "weightEnd": "999999",
        "trackingStateKey": "all",
        "trackingLabelKey": "all",
        "trackingFinishTimePeriodList": ["0-86400"],
    }}}


def _post(url, payload, cookie):
    h = dict(HEADERS_BASE)
    if cookie:
        h["cookie"] = cookie
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode())


def trigger_export(body, cookie=None):
    """触发导出，返回 True 表示已受理（data:true）。"""
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    j = _post(EXPORT_URL, body, cookie)
    res = j.get("result")
    if res is None:
        raise AuthError("导出触发 result is null（会话被顶号）")
    code = str(res.get("code"))
    if code != "200":
        raise RuntimeError(f"导出触发失败 code={code} msg={res.get('msg')}")
    return bool(res.get("data"))


def list_tasks(cookie=None, body=None):
    """查询导出任务列表（该用户最近 N 条）。返回 list[dict]。"""
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    if body is None:
        body = {"activeTabKey": "1"}
    j = _post(TASK_URL, {"params": {"request": body}}, cookie)
    res = j.get("result")
    if res is None:
        raise AuthError("任务列表 result is null（会话被顶号）")
    data = res.get("data") or {}
    tasks = data if isinstance(data, list) else (
        data.get("list") or data.get("records") or data.get("data") or [])
    return tasks


def task_url(task_id, cookie=None):
    """用 taskId 取下载 URL（OSS 签名字符串，约1h有效期）。"""
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    j = _post(URL_URL, {"params": {"request": {"taskId": task_id}}}, cookie)
    res = j.get("result")
    if res is None:
        raise AuthError("任务URL result is null（会话被顶号）")
    url = res.get("data")
    if not isinstance(url, str) or not url.startswith("http"):
        raise RuntimeError(f"任务URL无效 taskId={task_id} data={url}")
    return url


def download(url):
    """下载文件（无 cookie，免鉴权，同 violation.download/1.0）。返回 bytes。"""
    req = urllib.request.Request(url, headers={"user-agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def parse_xlsx_bytes(data):
    """xlsx bytes → dict 列表（中文表头**双写**英文键）。"""
    # 注意：read_only=True 对该 xlsx 有兼容问题（只读到 1 行），用普通模式。
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return []
    headers = [str(h).strip() if h is not None else "" for h in rows[0]]
    out = []
    for r in rows[1:]:
        d = {}
        for i, h in enumerate(headers):
            if i >= len(r):
                break
            v = r[i]
            if v is None or v == "":
                continue
            en = CN2EN.get(h)
            # 中文布尔「是/否」统一转 Python 布尔（中英文键都转）：
            # 否则 order_rules 双键兼容会把中文「否」误判为真值，错误剔除有效单。
            if isinstance(v, str) and v.strip() in ("是", "否"):
                b = (v.strip() == "是")
                d[h] = b
                if en:
                    d[en] = b
                continue
            d[h] = v                      # 保留中文原名
            if en:
                d[en] = _to_ms(v) if en in TIME_EN else v   # 英文键（时间列转毫秒）
        if d:
            out.append(d)
    return out


def export_orders(start_ms, end_ms, cookie=None, poll_timeout=DEFAULT_POLL_TIMEOUT):
    """完整链路：触发 → 轮询认领 → 拿URL → 下载 → 解析，返回 dict 列表。

    失败（会话失效 / 任务超时 / 网络）抛异常，交由调用方回落到分页 fetch_orders。
    """
    if cookie is None:
        cookie, _ = L.ensure_cookies()
    # 1) 记录当前最大 taskId，用于认领本次导出（历史任务 id<=max_id 自动排除）
    try:
        max_id = max((int(t["id"]) for t in list_tasks(cookie) if t.get("id")), default=0)
    except Exception:
        max_id = 0
    # 2) 触发导出
    body = build_export_body(start_ms, end_ms)
    if not trigger_export(body, cookie):
        raise RuntimeError("导出触发未受理（data 非 true）")
    # 3) 轮询认领 id>max_id 且 status=1 的任务
    deadline = time.time() + float(poll_timeout)
    my_id = None
    while time.time() < deadline:
        for t in list_tasks(cookie):
            if int(t.get("id", 0)) > max_id and int(t.get("status", 0)) == 1:
                my_id = int(t["id"])
                break
        if my_id:
            break
        time.sleep(POLL_INTERVAL)
    if not my_id:
        raise RuntimeError("导出任务超时未完成（%ss）" % int(poll_timeout))
    # 4) 拿 URL → 下载 → 解析
    url = task_url(my_id, cookie)
    data = download(url)
    return parse_xlsx_bytes(data)


__all__ = ["export_orders", "build_export_body", "trigger_export",
           "list_tasks", "task_url", "download", "parse_xlsx_bytes", "CN2EN",
           "AuthError", "DEFAULT_POLL_TIMEOUT"]
