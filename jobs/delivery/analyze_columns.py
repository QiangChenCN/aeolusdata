#!/usr/bin/env python3
"""统计运单 99 字段的实际取值特征 -> column_profile.json（建表类型/长度依据）。

优先读 delivery_raw/*.jsonl（保留原始 JSON 类型，能识别 int/list/dict），
无原始数据时回退读 CSV（表头为中文，反查英文列名）。

用法:
  python analyze_columns.py                 # 读 delivery_raw 全部 jsonl
  python analyze_columns.py --csv xx.csv    # 回退用 CSV
"""
import argparse
import csv
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from delivery_columns import FIELD_ORDER, FIELD_CN

ROOT = os.path.dirname(os.path.abspath(__file__))
# 原始 jsonl 由 fetch_delivery_raw.py 产出在 jobs/delivery/out/delivery_raw/
RAW_DIR = os.path.join(ROOT, "out", "delivery_raw")


def to_cell(v):
    """与 load_delivery_db.to_cell 保持一致的入库字符串形态。"""
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        return v
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def read_jsonl(files):
    for p in files:
        for line in open(p, encoding="utf-8"):
            if line.strip():
                yield json.loads(line)


def read_csv(path):
    cn2en = {v: k for k, v in FIELD_CN.items()}
    with open(path, encoding="utf-8-sig") as f:
        for d in csv.DictReader(f):
            yield {cn2en.get(k, k): v for k, v in d.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv")
    a = ap.parse_args()

    files = sorted(glob.glob(os.path.join(RAW_DIR, "*.jsonl")))
    if a.csv:
        src, it = a.csv, read_csv(a.csv)
    elif files:
        src, it = f"{len(files)} 个 jsonl", read_jsonl(files)
    else:
        print("无数据源：delivery_raw 为空且未指定 --csv")
        return

    n = 0
    types = {c: set() for c in FIELD_ORDER}
    maxlen = {c: 0 for c in FIELD_ORDER}
    nonnull = {c: 0 for c in FIELD_ORDER}
    distinct = {c: set() for c in FIELD_ORDER}
    unmapped = set()
    for rec in it:
        n += 1
        unmapped |= {k for k in rec if k not in FIELD_CN}
        for c in FIELD_ORDER:
            v = rec.get(c)
            types[c].add(type(v).__name__)
            s = to_cell(v)
            if s not in (None, ""):
                nonnull[c] += 1
                maxlen[c] = max(maxlen[c], len(s))
                if len(distinct[c]) < 5000:
                    distinct[c].add(s)

    prof = []
    for c in FIELD_ORDER:
        t = types[c] - {"NoneType"}
        kind = "/".join(sorted(t)) or "empty"
        prof.append({
            "col": c, "cn": FIELD_CN.get(c, c), "json_type": kind,
            "maxlen": maxlen[c], "distinct": len(distinct[c]),
            "nonnull_pct": round(nonnull[c] * 100 / n) if n else 0,
        })
    json.dump(prof, open(os.path.join(ROOT, "column_profile.json"), "w",
                         encoding="utf-8"), ensure_ascii=False, indent=1)

    print(f"样本: {src}  {n} 行\n")
    print(f"{'字段':<32}{'JSON类型':<14}{'最长':<6}{'去重':<8}{'非空%':<6} 中文名")
    for p in prof:
        print(f"{p['col']:<32}{p['json_type']:<14}{p['maxlen']:<6}"
              f"{p['distinct']:<8}{p['nonnull_pct']:<6} {p['cn']}")
    comp = [p for p in prof if p["json_type"] in ("list", "dict", "list/dict")]
    print(f"\n=== 复合类型字段(入库存 JSON 字符串) {len(comp)} 个 ===")
    for p in comp:
        print(f"  {p['col']:<32}{p['json_type']:<8}最长{p['maxlen']:<5}{p['cn']}")
    if unmapped:
        print(f"\n!! 未映射新字段（需补进 delivery_columns.py）: {sorted(unmapped)}")
    print(f"\n已写出 column_profile.json（{len(prof)} 列）")


if __name__ == "__main__":
    main()
