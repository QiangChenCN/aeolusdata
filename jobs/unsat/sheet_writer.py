#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""P2 在线表格读写：探测 D 列首空行 → 整块写入 D:R → 回填 A/B/C 反馈。

表格布局（已实测）：
  A=原因分析  B=改善措施  C=改善动作(培训图/视频)
  D:R = 明细区，15 列，与风神 CSV 字段顺序 1:1

注意：--node 必须传**完整 URL**（16 位 dentryKey 会被拒绝）。

自检：
  python -m jobs.unsat.sheet_writer            # 只探测首空行
  python -m jobs.unsat.sheet_writer --write    # 真实写入昨日明细
"""
import os
import sys
import json
import subprocess

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # jobs/
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "common"))

from . import config
from .store import log, connect, init_db, set_sheet_row

# dws CLI 命令前缀：优先复用 ding_common 已验证的解析（独立 dws / PATH / WorkBuddy 捆绑回退），
# 取不到时再回退环境变量。打包到服务端时可整体替换为 OpenAPI 实现。
try:
    import ding_common
    def _dws_cmd():
        return ding_common.resolve_dws_cmd()
except Exception:      # 服务端无 ding_common 时
    def _dws_cmd():
        return [os.environ.get("DING_NODE_BIN", ""), os.environ.get("DING_DWS_JS", "")]

_PROBE_MAX = 500   # 单次探测行数上限


def _dws(args, check=True):
    cmd = _dws_cmd() + list(args) + ["--format", "json"]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if check and r.returncode != 0:
        out = (r.stdout or "") + (r.stderr or "")
        # 表格地址无效/无权限：dws 只回一句 can not find file by url=...，
        # 既不说是地址写错还是文件没了，也不给修法，直接甩出来很难排查。
        # 这里识别出来翻成人话（2026-09-08：旧表失效时排查了很久才定位）。
        if "can not find file by url" in out:
            raise RuntimeError(
                "在线表打不开（地址为 %s）\n"
                "→ 多半是「文档地址」填错，或该表已被删除 / 当前账号无访问权限。\n"
                "→ 修法：打开钉钉在线表，复制浏览器地址栏的整条链接，\n"
                "  填到工作台任务配置的「文档地址」里再跑。"
                % config.SHEET_URL)
        raise RuntimeError("dws 失败(%s): %s | %s"
                           % (r.returncode, (r.stdout or "")[:400], (r.stderr or "")[:400]))
    return json.loads((r.stdout or "{}").strip() or "{}")


def read_range(a1):
    """读取区域，返回二维 list（按行）。"""
    j = _dws(["sheet", "csv-get", "--node", config.SHEET_URL,
              "--sheet-id", config.SHEET_ID, "--range", a1])
    if not j.get("success"):
        raise RuntimeError("读取失败: %s" % j.get("message"))
    csv_text = j.get("csv", "")
    rows = []
    for line in csv_text.split("\n"):
        line = line.strip()
        if not line:
            continue
        # 形如 "[row=1] a,b,c"
        if line.startswith("[row="):
            line = line.split("]", 1)[1]
        if line.startswith(","):
            line = line[1:]
        rows.append(next(iter([line])) if False else _split_csv_line(line))
    return rows


def _split_csv_line(line):
    """极简 CSV 行切分（处理引号包裹）。"""
    out, cur, in_q = [], "", False
    for ch in line:
        if ch == '"':
            in_q = not in_q
        elif ch == "," and not in_q:
            out.append(cur.strip())
            cur = ""
        else:
            cur += ch
    out.append(cur.strip())
    return out


def find_first_empty_row(start_row=2):
    """探测 D 列第一个可用（空）行。返回行号。"""
    end = start_row + _PROBE_MAX
    rows = read_range("D%d:D%d" % (start_row, end))
    for i, r in enumerate(rows):
        cell = r[0] if r else ""
        if not cell:
            return start_row + i
    raise RuntimeError("D 列 %d~%d 行均未找到空行，请增大探测范围" % (start_row, end))


def existing_violation_nos(start_row=2, end_row=None):
    """读取表格中已存在的违规编号集合，用于写入前去重。

    调度任务重复触发（或人工补跑）时，若不校验会把同一批明细写两遍。
    """
    end = end_row or (start_row + _PROBE_MAX)
    try:
        rows = read_range("D%d:D%d" % (start_row, end))
    except Exception as e:
        log.warning("读取已有违规编号失败，跳过去重: %s", e)
        return set()
    return {r[0] for r in rows if r and r[0]}


def _as_cells(matrix):
    """二维字符串矩阵 → range update 要求的 typed object 形态。

    实测：range update 不接受原始字符串，每格必须是
    {"type":"text","text":"..."}。
    统一按 text 写入还有个好处：运单号/骑手ID/团队ID 等长数字不会被
    自动转成数值而丢精度或变科学计数法。
    """
    return [[{"type": "text", "text": "" if v is None else str(v)} for v in row]
            for row in matrix]


def write_details(matrix, start_row):
    """把二维矩阵写入 D{start_row}:R{start_row+n-1}，整块一次写入。"""
    if not matrix:
        return 0
    end_row = start_row + len(matrix) - 1
    rng = "D%d:R%d" % (start_row, end_row)
    _dws(["sheet", "range", "update", "--node", config.SHEET_URL,
          "--sheet-id", config.SHEET_ID, "--range", rng,
          "--values", json.dumps(_as_cells(matrix), ensure_ascii=False), "--yes"])
    log.info("已写入明细 %d 行 → %s", len(matrix), rng)
    return end_row


def write_feedback(row, reason=None, action=None, media=None):
    """回填反馈区：A=原因分析, B=改善措施, C=改善动作(素材)。

    media: [{"type":"image"/"video","url":"..."}] → C 列写为可点击链接文本
    """
    if reason is not None:
        _dws(["sheet", "range", "update", "--node", config.SHEET_URL,
              "--sheet-id", config.SHEET_ID, "--range", "A%d" % row,
              "--values", json.dumps(_as_cells([[reason]]), ensure_ascii=False), "--yes"])
    if action is not None:
        _dws(["sheet", "range", "update", "--node", config.SHEET_URL,
              "--sheet-id", config.SHEET_ID, "--range", "B%d" % row,
              "--values", json.dumps(_as_cells([[action]]), ensure_ascii=False), "--yes"])
    if media:
        txt = " ".join(("[%s](%s)" % (m.get("type", "素材"), m.get("url", "")))
                       for m in media if m.get("url"))
        _dws(["sheet", "range", "update", "--node", config.SHEET_URL,
              "--sheet-id", config.SHEET_ID, "--range", "C%d" % row,
              "--values", json.dumps(_as_cells([[txt]]), ensure_ascii=False), "--yes"])
    log.info("已回填第 %d 行反馈（原因/措施/素材）", row)


def run(rows, stat_date, do_write=False, dedupe=True):
    """完整流程：去重 → 探测首空行 → 写明细 → 回填 sheet_row 到库。

    dedupe=True 时会剔除表格中已存在的违规编号，保证调度重复触发也幂等。
    """
    from .fetcher import to_matrix
    if dedupe:
        exist = existing_violation_nos()
        before = len(rows)
        rows = [r for r in rows if r.get("违规编号", "") not in exist]
        if before != len(rows):
            log.info("去重：跳过表格中已存在的 %d 条，剩余 %d 条",
                     before - len(rows), len(rows))
    if not rows:
        log.info("无新明细需要写入。")
        return None, []
    matrix = to_matrix(rows)
    empty_row = find_first_empty_row()
    log.info("D 列首个可用行: 第 %d 行（待写 %d 行）", empty_row, len(matrix))
    if not do_write:
        log.info("(--write 未指定) 仅探测，未写入")
        return empty_row, []
    write_details(matrix, empty_row)
    init_db()
    for i, r in enumerate(rows):
        set_sheet_row(r.get("违规编号", ""), empty_row + i)
    log.info("已回填 %d 条运单的表格行号", len(rows))
    return empty_row, matrix


if __name__ == "__main__":
    do_write = "--write" in sys.argv
    if do_write:
        from .fetcher import fetch
        ds = None
        if "--date" in sys.argv:
            ds = sys.argv[sys.argv.index("--date") + 1]
        rows, date_str, _ = fetch(ds)
        if not rows:
            print("无符合条件的数据，跳过写表。")
            sys.exit(0)
        start, matrix = run(rows, date_str, do_write=True)
        if start is None:
            print("无新明细需要写入（表格中已存在）。")
        else:
            print("已写入：起始行 %d，共 %d 行" % (start, len(matrix)))
    else:
        print("D 列首个可用行:", find_first_empty_row())
