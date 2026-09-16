#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""get_data.rider_equipment —— 骑手装备点亮明细 取数模块（单一数据接口来源）。

数据接口：Quark/Aeolus FBI 平台报表（reportId=860325，骑手装备点亮提醒）。
本模块只做一件事：按调用方传入的日期窗口，拉取「骑手装备点亮明细」二维表并返回。
  · 日期 / 站点 等参数全部由调用方传入（默认 T-1），本模块不内置任何站点/日期选择逻辑。
  · 凭证（风神 SSO → DA_TOKEN 兑换 → 缓存）委托 quark_sdk.quark_creds，本模块不复现。
  · 筛选 / 渲染 / 落盘 / 发送等加工逻辑由上层任务脚本（jobs/equipment）负责，不在此处。

对外核心函数：
  - fetch_report_view(start_date, end_date, as_of=None, ...) -> dict
      一站式取数，返回标准化 dict：
        {
          "ok": bool,
          "code": "ok" | "no_aol_cookie" | "da_unavailable" | "no_quark_cookie" |
                  "permission_denied" | "data_error" | "html_redirect",
          "rows": [[...], ...],
          "headers": ["guid_x", ...],
          "labels": {"guid_x": "中文列名", ...},
          "raw": "<WidgetAction 原始响应体>",
          "cookie_used": "manual" | "auto_da",
          "da_source": "cache" | "fresh" | "manual",
          "attempts": N,
          "warning": "...",
          "elapsed_sec": float,
        }

  - fetch(cookie, report_token, secure, meta_time, start, end, as_of)  —— 单页 POST WidgetAction，返回原始 body
  - parse_rows(raw) / summarize(raw) / schema_hint(...)              —— 解析 / 摘要工具
  - build_payload(...)                                              —— 构造 params JSON
  - named_headers(headers, labels) / export_csv(...)                —— 上层 CSV 复用

设计原则（与 get_data 其它模块对齐）：
  · 任何场景都通过 fetch_report_view() 拿结果，不直接调 Quark 原始接口。
  · 模块内异常一律以 dict 返回（含 ok=False），不抛异常打断上层流水线。
"""
import os
import sys
import csv
import json
import time
import urllib.request
import urllib.parse
from datetime import date, timedelta

# get_data/ 比项目根深一层，自引导把项目根注入 sys.path，再 import quark_sdk。
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
try:
    import venv_guard  # noqa: F401
except Exception:
    pass

# 凭证 / 连接辅助统一委托 quark_sdk.quark_creds（不在此处复现 DA 兑换 / 探针 / 缓存）。
from quark_sdk import quark_creds as C


# ============================================================
# 端点与常量（取数专属；凭证相关端点见 quark_creds）
# ============================================================
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0"
)
URL = (
    "https://quark.alibaba.com/fbi/.json"
    "?action=report/WidgetAction&event_submit_doGetWidgetData=true"
    "&componentName=fbi-common-table&_widgetId=mmds9k0ty_f1vr3j&_ts_=mszj2wz8"
)
HEADERS = {
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
    "bx-v": "2.5.37",
    "content-type": "application/x-www-form-urlencoded",
    "origin": "https://quark.alibaba.com",
    "priority": "u=1, i",
    "referer": (
        "https://quark.alibaba.com/dashboard/view/report.htm?id=860325"
        "&DA_APP_NAME=lpd_meepo_ws"
    ),
    "sec-ch-ua": '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-fetch-storage-access": "active",
    "user-agent": UA,
}

# 报表数据集 / 字段 GUID（860325 = 骑手装备点亮提醒）
FIELD_GUIDS = [
    "mmnfu9wys_tq2q5i", "mmnfua0qb_cmud56", "mmnfua2z0_eblg08", "mmnfua55j_iuvf9w",
    "mmsra17uw_p3tunm", "mmsra1cb8_56lord", "mmsra1a0z_unun6x", "mmnfua9uu_bqesvu",
    "mmnfua77k_ebhal1", "mmnfuacb4_z3od2g", "mmnfuaehv_cbpd8o", "mmnfuahwi_pon8s0",
    "mmnfuakka_ge7lod", "mmssok5yk_j861s4", "mmsr9wn6u_07b34l", "mmnfuatyz_71s8d8",
    "mmnfuavkc_931ftd", "mmsr8ao6r_yn6267", "mmnfub79f_5xh68d", "mmnfub8ut_qacogy",
    "mmnfube57_nxdxvv", "mmnfubg2e_axyrus", "mmnfubakc_1a8zaw",
]
DATASET_GUID = 72835376

# 默认日期窗口：T-1（昨天）
_T1 = (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
DEFAULT_START = _T1
DEFAULT_END = _T1
DEFAULT_AS_OF = _T1


# ============================================================
# 报表 POST 主接口（取数）
# ============================================================
def build_payload(report_token, secure, start=DEFAULT_START, end=DEFAULT_END,
                  as_of=DEFAULT_AS_OF, meta_time=None):
    """构造与 curl 等价的 params JSON。"""
    if meta_time is None:
        meta_time = as_of + " 14:23:33"
    return {
        "widgetId": "mmds9k0ty_f1vr3j",
        "queryId": "mmds9k3qv_ghzq3p",
        "dataType": "unifiedTable",
        "configs": [
            {"datasetGuid": DATASET_GUID, "type": "datasetId"},
            {"datasetGuid": DATASET_GUID, "type": "count", "config": {"needCount": True}},
            {"datasetGuid": DATASET_GUID, "type": "field", "config": {"guids": FIELD_GUIDS}},
            {"datasetGuid": DATASET_GUID, "type": "condition",
             "config": {"id": "mmssgewhx_gje4m4", "name": "en-mmssgewhx_pgoffv",
                        "value": {"start": start, "end": end}, "valueType": "dateTimeRange"}},
            {"datasetGuid": DATASET_GUID, "type": "condition",
             "config": {"id": "mmssoknlt_3jm2vf", "name": "en-mmssoknlt_of1zox",
                        "value": ["否", "是"], "valueType": "multiSelect"}},
            {"datasetGuid": DATASET_GUID, "type": "condition",
             "config": {"id": "mmsran1s0_f04dn1", "name": "en-mmsran1s0_wvzzr6",
                        "value": [], "valueType": "multiSelect"}},
            {"datasetGuid": DATASET_GUID, "type": "condition",
             "config": {"id": "mmds9kgv3_iwguc9", "name": "en-mmds9kgv3_6kqowg",
                        "value": [], "valueType": "multiSelect"}},
            {"datasetGuid": DATASET_GUID, "type": "condition",
             "config": {"id": "mmds9kqmb_kom0zo", "name": "en-mmds9kqmb_wdlpv4",
                        "value": "", "valueType": "text"}},
            {"datasetGuid": DATASET_GUID, "type": "condition",
             "config": {"id": "mmds9kvu4_u86chn", "name": "en-mmds9kvu4_82uzf3",
                        "value": as_of, "valueType": "dateTimePicker"}},
            {"datasetGuid": DATASET_GUID, "type": "condition",
             "config": {"id": "mmdsev418_hwdnol", "name": "en-mmdsev418_lqk1yu",
                        "value": "", "valueType": "text"}},
            {"datasetGuid": DATASET_GUID, "type": "condition",
             "config": {"id": "mmdsevrn4_j6w16q", "name": "en-mmds9k0ty_8a3z2x",
                        "value": [], "valueType": "multiSelect"}},
        ],
        "reportIdToken": report_token,
        "secureParams": secure,
        "metaTime": meta_time,
        "needDebugInfo": False,
        "reportId": 860325,
    }


def fetch(cookie, report_token, secure, meta_time=None,
          start=DEFAULT_START, end=DEFAULT_END, as_of=DEFAULT_AS_OF):
    """POST WidgetAction，返回原始响应 body。"""
    if not cookie:
        raise RuntimeError("缺少 Quark cookie：请设置 QUARK_COOKIE 环境变量，或写入 quark_cookie.txt")
    if not report_token or not secure:
        raise RuntimeError("缺少 reportIdToken / secureParams")
    payload = build_payload(report_token, secure, start, end, as_of, meta_time=meta_time)
    body = urllib.parse.urlencode({"params": json.dumps(payload, ensure_ascii=False)}).encode("utf-8")
    req = urllib.request.Request(URL, data=body, headers=dict(HEADERS, cookie=cookie), method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "replace")


# ============================================================
# 响应解析 & 摘要
# ============================================================
def summarize(raw):
    """把响应 body 解 JSON 打印顶层/数据/首行样例，便于排查。"""
    try:
        j = json.loads(raw)
    except Exception:
        return "(响应非 JSON，长度 %d)" % len(raw)
    lines = []
    lines.append("顶层 keys: %s" % ", ".join(list(j.keys())[:20]))
    if isinstance(j.get("success"), bool):
        lines.append("success: %s" % j["success"])
    if "message" in j:
        lines.append("message: %s" % j["message"])
    data = j.get("data") or j.get("result") or {}
    if isinstance(data, dict):
        if "total" in data:
            lines.append("total: %s" % data["total"])
        rows = data.get("data") or data.get("rows") or data.get("list")
        if isinstance(rows, list):
            lines.append("行数: %d" % len(rows))
            if rows:
                lines.append("首行样例: %s" % json.dumps(rows[0], ensure_ascii=False)[:300])
    elif isinstance(data, list):
        lines.append("行数: %d" % len(data))
    return "\n".join(lines)


def parse_rows(raw):
    """从响应里抽出二维表。返回 (headers, rows, label_map)。

    headers：字符串列表（每列的 guid）
    rows   ：[[value, ...], ...]  二维表
    label_map：{guid: 中文名}
    """
    j = json.loads(raw)
    val = (j.get("data") or {}).get("value") or {}
    cols = val.get("columns") or []
    headers = []
    label_map = {}
    for c in cols:
        cell = (c.get("cells") or [{}])[0]
        p = cell.get("props", {}) or {}
        guid = p.get("guid") or ""
        label = p.get("label") or p.get("title") or p.get("name") or guid
        headers.append(guid)
        if guid:
            label_map[guid] = label
    rows_raw = val.get("values") or []
    rows = []
    for r in rows_raw:
        if isinstance(r, list):
            rows.append([(cell.get("v") if isinstance(cell, dict) else cell) for cell in r])
        elif isinstance(r, dict):
            rows.append([r.get(h) for h in headers])
    return headers, rows, label_map


def schema_hint(headers, rows, label_map=None):
    """打印「官方中文名 -> 首行样例值」，排查用。"""
    if not headers or not rows:
        return
    label_map = label_map or {}
    print("==== 列 schema（官方中文名 -> 首行样例值）====", flush=True)
    first = rows[0]
    for h, v in zip(headers, first):
        name = label_map.get(h, h)
        print("  %-16s | %s" % (name, ("" if v is None else v)), flush=True)


# ============================================================
# 一站式接口：取数（委托 quark_creds 做凭证，本模块只编排取数）
# ============================================================
def fetch_report_view(base=".",
                      start_date=None, end_date=None, as_of=None,
                      max_attempts=3,
                      token_override=None, secure_override=None, meta_time_override=None,
                      force_refresh_da=False, da_ttl=None,
                      verbose=True):
    """一站式：登录风神 → 取 DA cookie（缓存优先）→ 拉三件套 → 打 WidgetAction → 解析二维表。

    返回 dict，结构见模块顶部 docstring。失败时 ok=False + code + warning。

    DA cookie 有效性判定：
      缓存命中 → 探活（doGetSite，约 0.3s）→ 通过则复用，不通过则重兑。
      取数阶段仍有兜底：若 WidgetAction 也返回 HTML 登录页 → 清缓存 → 强制重兑 → 重试。

    参数：
      base                  —— 项目根目录（Quark 系凭据固定落在 quark_sdk/，不依赖 base）。默认 "."。
      start_date / end_date —— 日期窗口；None 用 T-1。
      as_of                 —— 报表统计日期；None 用 T-1。
      max_attempts          —— 自动重试上限（首 attempt=1）。
      token/secure/meta_time —— 排查用，覆盖自动兑换三件套（仅在手动提供 QUARK_COOKIE 模式下有用）。
      force_refresh_da      —— 忽略 DA cookie 缓存，强制重新兑换（排查用）。
      da_ttl                —— 缓存保险丝（秒）；超过则不看缓存直接重兑。None = 不设上限。
      verbose               —— 是否打印 [tokens] / [da-cache] 等日志。
    """
    t0 = time.time()
    start = start_date or DEFAULT_START
    end = end_date or DEFAULT_END
    as_of = as_of or DEFAULT_AS_OF

    manual_cookie = C.load_quark_cookie(base)
    delay = 5
    attempts = 0
    last_warning = ""

    for attempt in range(1, max_attempts + 1):
        attempts = attempt
        try:
            # 重试不再强踢 Aeolus 登录（会顶掉浏览器会话、绕开 login.py 共享锁、加剧 SSO 乒乓）。
            # 仅在显式要求强刷时才 force；首轮 ensure_cookies 已校验过 Aeolus 有效性。
            aeo_cookie = C.load_aeo_cookie(base, force=force_refresh_da)
            if not aeo_cookie:
                last_warning = "无法取得 Aeolus cookie，跳过自动兑换"
                return _report_err("no_aol_cookie", last_warning,
                                   attempts=attempts, t0=t0, raw=None,
                                   rows=[], headers=[], labels={})

            # 1) Quark 凭证：手动 cookie > 缓存复用（探活通过）> 重新兑换
            da_cookie = da_jar = None
            da_source = ""
            need_probe = True
            if manual_cookie:
                da_cookie = manual_cookie
                da_jar = os.path.join(base, C.DEFAULT_COOKIE_PATHS["quark_da_jar"])
                da_source = "manual"
                if verbose:
                    print("[cookie] 使用手动提供的 Quark DA cookie"
                          "（QUARK_COOKIE / quark_cookie.txt）", flush=True)
            else:
                try:
                    da_cookie, da_jar, da_source = C.ensure_da_cookie(
                        base, aeo_cookie,
                        force=(force_refresh_da or attempt > 1),
                        verbose=verbose,
                        max_age_sec=da_ttl,
                    )
                    if da_source == "cache":
                        need_probe = False      # ensure_da_cookie 内已探过活
                    else:
                        need_probe = False      # 刚兑出来的，不必再探
                        if verbose:
                            print("[cookie] 已通过纯 HTTP 兑换 Quark DA_TOKEN（已写入缓存）", flush=True)
                except Exception as e:
                    last_warning = "DA_TOKEN 兑换失败：%s" % e
                    return _report_err("da_unavailable", last_warning,
                                       attempts=attempts, t0=t0, raw=None,
                                       rows=[], headers=[], labels={})

            cookie = da_cookie

            # 2) DA 健康探针（缓存分支已在 ensure_da_cookie 内探过；刚兑出来的不重复打）
            if need_probe and not C.probe_da_health(cookie, verbose=verbose):
                raise RuntimeError("DA cookie 健康探针未通过（可能被 SSO 顶号）")

            # 3) 三件套 token（CLI 覆盖 → 自动提取）
            if token_override and secure_override:
                report_token = token_override
                secure = secure_override
                meta_time = meta_time_override or (as_of + " 14:23:33")
                if verbose:
                    print("[tokens] 使用命令行 --token/--secure 覆盖", flush=True)
            else:
                tok, sec, gmt = C.auto_fetch_tokens(aeo_cookie, da_jar, verbose=verbose)
                report_token = tok
                secure = sec
                meta_time = meta_time_override or gmt

            # 3) POST WidgetAction —— 这一步同时是 DA cookie 有效性的唯一真判据
            raw = fetch(cookie, report_token=report_token, secure=secure,
                        meta_time=meta_time, start=start, end=end, as_of=as_of)
            stripped = raw.lstrip()
            if stripped.startswith("<!DOCTYPE") or stripped.startswith("<html"):
                # 被踢回登录页 = 这个 DA cookie 已废（实测：伪造 cookie 也走这条路）。
                # 缓存来源就清掉缓存，下一 attempt 因 force=True 会强制重兑。
                if da_source == "cache":
                    C.clear_da_cache(base)
                    if verbose:
                        print("[da-cache] 取数被踢回登录页，缓存已作废 → 下轮强制重兑", flush=True)
                raise RuntimeError("DA cookie 失效（WidgetAction 返回 HTML 登录页）")

            # 4) 解析二维表
            try:
                headers, rows, labels = parse_rows(raw)
            except Exception as e:
                last_warning = "响应解析失败：%s" % e
                return _report_err("data_error", last_warning,
                                   attempts=attempts, t0=t0, raw=raw,
                                   rows=[], headers=[], labels={})

            return {
                "ok": True,
                "code": "ok",
                "rows": rows,
                "headers": headers,
                "labels": labels,
                "raw": raw,
                "cookie_used": "manual" if manual_cookie else "auto_da",
                "da_source": da_source,   # cache / fresh / manual
                "attempts": attempt,
                "warning": "",
                "elapsed_sec": round(time.time() - t0, 2),
            }

        except Exception as e:
            last_warning = "第 %d/%d 次失败：%s" % (attempt, max_attempts, e)
            if verbose:
                print("[retry] %s" % last_warning, flush=True)
            if manual_cookie and not (token_override and secure_override):
                if verbose:
                    print("[cookie] 手动 QUARK_COOKIE 模式下自动提取失败，请检查 Aeolus 登录或改用 --token/--secure 覆盖。", flush=True)
                return _report_err(
                    "permission_denied" if "PERM" in str(e).upper() or "permission" in str(e).lower()
                    else "data_error",
                    last_warning,
                    attempts=attempts, t0=t0, raw=None,
                    rows=[], headers=[], labels={},
                )
            if attempt >= max_attempts:
                if verbose:
                    print("[retry] 已达最大重试次数，放弃。", flush=True)
                return _report_err("data_error", last_warning,
                                   attempts=attempts, t0=t0, raw=None,
                                   rows=[], headers=[], labels={})
            if verbose:
                print("[retry] %d 秒后强制重新登录 Aeolus 并重试..." % delay, flush=True)
            time.sleep(delay)
            delay *= 2

    # 理论上不会到这里；兜底
    return _report_err("data_error", last_warning or "未知失败",
                       attempts=attempts, t0=t0, raw=None,
                       rows=[], headers=[], labels={})


def _report_err(code, warning, attempts, t0, raw, rows, headers, labels):
    """失败结构统一封装。"""
    return {
        "ok": False,
        "code": code,
        "rows": rows,
        "headers": headers,
        "labels": labels,
        "raw": raw,
        "cookie_used": "",
        "da_source": "",
        "attempts": attempts,
        "warning": warning,
        "elapsed_sec": round(time.time() - t0, 2),
    }


# ============================================================
# 可选工具：把 headers/labels 转成中文列名（上层 CSV 复用）
# ============================================================
def named_headers(headers, labels):
    """把 guid headers 转中文列名，无映射回退 guid。"""
    return [labels.get(h, h) for h in headers]


def export_csv(named_headers_, rows, path):
    """写 UTF-8 BOM CSV（Excel 中文兼容）。"""
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(named_headers_)
        for r in rows:
            w.writerow(["" if v is None else v for v in r])
    print("[save] csv -> %s (%d 行)" % (path, len(rows)), flush=True)


__all__ = [
    # 一站式
    "fetch_report_view",
    # 取数 / 解析
    "build_payload", "fetch",
    "summarize", "parse_rows", "schema_hint",
    "named_headers", "export_csv",
    # 常量（上层脚本可能直接读）
    "DEFAULT_START", "DEFAULT_END", "DEFAULT_AS_OF",
    "URL", "HEADERS",
    "FIELD_GUIDS", "DATASET_GUID",
]


if __name__ == "__main__":
    # 自测入口（在项目根目录执行）：
    #   python -m get_data.rider_equipment           # 查看 DA 缓存状态 + 网关连通性
    #   python -m get_data.rider_equipment --clear   # 清空 DA 缓存（下次强制重兑）
    #   python -m get_data.rider_equipment --full     # 跑完整取数自检（含真实有效性判定）
    _HERE = os.path.dirname(os.path.abspath(__file__))   # get_data/rider_equipment.py
    # Quark 系凭据固定落在 quark_sdk/（见 quark_creds.DEFAULT_COOKIE_PATHS），proj_root 仅用于定位包。
    proj_root = os.path.dirname(os.path.dirname(_HERE))
    args = sys.argv[1:]

    if "--clear" in args:
        print("已清空 DA 缓存，下次取数会重新兑换"
              if C.clear_da_cache(proj_root) else "本来就没有 DA 缓存")
        raise SystemExit(0)

    if "--full" not in args:
        # 默认只看缓存状态 + 网关连通性，不打取数请求
        cache = C.load_da_cache(proj_root)
        if cache:
            age = cache["age_sec"]
            print("[da-cache] 存在缓存（%s 前），source 待取数时判定"
                  % ("%.1f 小时" % (age / 3600.0) if age is not None else "时间未知"))
        else:
            print("[da-cache] 无缓存")
        try:
            C.probe_da_health("x", verbose=True)
        except Exception as e:
            print("[health] 探测异常: %s" % e)
        raise SystemExit(0)

    # --full：跑一次真实取数
    r = fetch_report_view(base=proj_root, verbose=True)
    print("ok=%s code=%s rows=%d da_source=%s"
          % (r["ok"], r["code"], len(r["rows"]), r.get("da_source")))
    if r["ok"]:
        schema_hint(r["headers"], r["rows"], r["labels"])
    else:
        print("warning:", r.get("warning"))
