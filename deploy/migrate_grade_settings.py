#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""服务器就地迁移：把旧代「月份×站点 5 档」配置迁移为新 schema_version=2 的
standard_grade_settings.json。

旧文件（服务器 /opt/aeolusdata/python/dashboard/standard/ 下）：
  - grade_standards.json    大致结构 months[月][站点] = {order[5], duration_h[5], threshold_pct, cap_pct, enabled}
  - threshold_config.json   可能含全局默认门槛/封顶（结构未知，脚本会探测并打印）

新文件：
  standard_grade_settings.json = {schema_version:2, default:{levels,threshold_pct,cap_pct},
                                  months:{月:{站点:{levels:[5],threshold_pct,cap_pct}}}}

用法（在服务器上）：
  cd /opt/aeolusdata
  python3 deploy/migrate_grade_settings.py          # 预览（不写盘）
  python3 deploy/migrate_grade_settings.py --apply  # 真正迁移（先自动备份旧文件为 .bak）
"""
import os
import sys
import json
import shutil
import argparse
import datetime as _dt

STD_DIR = "/opt/aeolusdata/python/dashboard/standard"
OLD_GRADE = os.path.join(STD_DIR, "grade_standards.json")
OLD_THRESH = os.path.join(STD_DIR, "threshold_config.json")
NEW_FILE = os.path.join(STD_DIR, "standard_grade_settings.json")

DEFAULT_LEVELS = [
    {"level": 1, "orders": 18, "hours": 6},
    {"level": 2, "orders": 21, "hours": 6},
    {"level": 3, "orders": 26, "hours": 6},
    {"level": 4, "orders": 32, "hours": 7},
    {"level": 5, "orders": 39, "hours": 8},
]
DEFAULT_THRESHOLD = 80.0
DEFAULT_CAP = 100.0


def _num(v, default=0):
    try:
        return float(v)
    except (ValueError, TypeError):
        return default


def _site_levels(order, duration_h):
    """order[5] / duration_h[5] → levels[{level,orders,hours}]×5。"""
    arr_o = order if isinstance(order, list) else []
    arr_d = duration_h if isinstance(duration_h, list) else []
    out = []
    for i in range(5):
        o = _num(arr_o[i]) if i < len(arr_o) else DEFAULT_LEVELS[i]["orders"]
        d = _num(arr_d[i]) if i < len(arr_d) else DEFAULT_LEVELS[i]["hours"]
        out.append({"level": i + 1, "orders": int(o), "hours": round(float(d), 2)})
    return out


def load(path):
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[WARN] 读取 {path} 失败: {e}", file=sys.stderr)
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正写盘（否则仅预览）")
    args = ap.parse_args()

    # 1) 已是新格式 → 无需迁移（避免重复迁移覆盖服务器上用户已保存的设置）
    if os.path.exists(NEW_FILE):
        print(f"[SKIP] 新格式文件已存在，无需迁移：{NEW_FILE}")
        return

    # 2) 旧文件不存在 → 无从迁移（可能已迁移过，或从未使用旧格式）
    if not os.path.exists(OLD_GRADE):
        print(f"[INFO] 旧文件不存在，无需迁移：{OLD_GRADE}")
        return

    old_grade = load(OLD_GRADE)
    old_thresh = load(OLD_THRESH)

    if old_thresh is not None:
        print(f"[INFO] 探测到 threshold_config.json，顶层键: {list(old_thresh.keys()) if isinstance(old_thresh, dict) else type(old_thresh)}")
        # 尝试提取全局默认门槛/封顶（多种可能结构，仅打印供人核对）
        for cand in ("threshold_pct", "cap_pct", "threshold", "cap", "default"):
            if isinstance(old_thresh, dict) and cand in old_thresh:
                print(f"        threshold_config.json['{cand}'] = {old_thresh[cand]}")

    if not isinstance(old_grade, dict) or not isinstance(old_grade.get("months"), dict):
        # 区分"格式不符"的具体情形，直接把可用于适配的信息打出来
        print("[ERROR] 旧 grade_standards.json 缺少 months 字段或格式不符，无法自动迁移。")
        if isinstance(old_grade, dict):
            print(f"        顶层键: {list(old_grade.keys())}")
            print(f"        内容样本: {json.dumps(old_grade, ensure_ascii=False)[:800]}")
        else:
            print(f"        解析结果类型: {type(old_grade)}（读取失败，或不是 JSON 对象）")
        print("        请把上面的输出发我，我按实际结构适配脚本。")
        sys.exit(2)

    months_old = old_grade["months"]
    new_months = {}
    default_tmpl = None
    converted = 0
    skipped = 0

    for month, sites in months_old.items():
        if not isinstance(sites, dict):
            continue
        new_months[month] = {}
        for tid, cfg in sites.items():
            if not isinstance(cfg, dict):
                continue
            if cfg.get("enabled") is False:
                skipped += 1
                continue
            order = cfg.get("order")
            duration_h = cfg.get("duration_h")
            if not isinstance(order, list) or len(order) < 5 or not isinstance(duration_h, list) or len(duration_h) < 5:
                # 尝试兼容 levels[{orders,hours}] 写法
                if isinstance(cfg.get("levels"), list) and len(cfg["levels"]) >= 5:
                    levels = _site_levels(
                        [l.get("orders", 0) for l in cfg["levels"]],
                        [l.get("hours", 0) for l in cfg["levels"]],
                    )
                else:
                    skipped += 1
                    continue
            else:
                levels = _site_levels(order, duration_h)
            tp = _num(cfg.get("threshold_pct"), DEFAULT_THRESHOLD)
            cp = _num(cfg.get("cap_pct"), DEFAULT_CAP)
            new_months[month][str(tid)] = {
                "levels": levels,
                "threshold_pct": tp,
                "cap_pct": cp,
                "use_default": False,
            }
            converted += 1
            if default_tmpl is None:
                default_tmpl = {"levels": [dict(l) for l in levels], "threshold_pct": tp, "cap_pct": cp}

    if default_tmpl is None:
        default_tmpl = {"levels": [dict(l) for l in DEFAULT_LEVELS], "threshold_pct": DEFAULT_THRESHOLD, "cap_pct": DEFAULT_CAP}

    out = {
        "schema_version": 2,
        "updated_at": _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=8))).isoformat(timespec="seconds"),
        "updated_by": "migrate-script",
        "default": default_tmpl,
        "months": new_months,
    }

    print(f"[SUMMARY] 月份数={len(new_months)}  迁移站点数={converted}  跳过(未启用/<5档)={skipped}")
    print(json.dumps(out, ensure_ascii=False, indent=2)[:2000] + ("\n... (截断预览)" if len(json.dumps(out)) > 2000 else ""))

    if not args.apply:
        print("\n[PREVIEW] 未写盘。确认无误后加 --apply 执行（会自动备份旧文件为 .bak）。")
        return

    # 备份旧文件
    for p in (OLD_GRADE, OLD_THRESH):
        if os.path.exists(p):
            shutil.copy2(p, p + ".bak")
            print(f"[BACKUP] {p} -> {p}.bak")
    with open(NEW_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"[DONE] 已写入 {NEW_FILE}")
    # 删除已被新格式取代的旧文件（.bak 保留可回滚）
    for p in (OLD_GRADE, OLD_THRESH):
        if os.path.exists(p):
            os.remove(p)
            print(f"[REMOVE] 删除旧文件 {p}（回滚用 .bak）")


if __name__ == "__main__":
    main()
