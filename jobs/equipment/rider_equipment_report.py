# -*- coding: utf-8 -*-
"""骑手装备点亮异常报表

从 rider_equipment.csv（官方列名导出）中：
1. 筛选「应季制服是否点亮 / 应季头盔是否点亮 / 整体餐箱是否点亮」
   中任一「未点亮」的行（未点亮 = 值非 "1"，即 0 / 空 / None）。
2. 展示列：日期, 骑手ID, 骑手姓名, 站点ID, 站点名称 + 上述三列点亮状态。
3. 生成表格图片，未点亮单元格填充警示色（浅红），文字保持清晰可读。

用法：
  python rider_equipment_report.py            # 读取 CSV，生成图片
  python rider_equipment_report.py --no-img   # 仅打印筛选结果（不画图）
"""
import csv
import os
import sys
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))      # jobs/equipment
OUT_DIR = os.path.join(HERE, "out")                    # 产物统一进 out/
os.makedirs(OUT_DIR, exist_ok=True)
CSV_PATH = os.path.join(OUT_DIR, "rider_equipment.csv")
IMG_PATH = os.path.join(OUT_DIR, "rider_equipment_warning.png")
FILTERED_CSV = os.path.join(OUT_DIR, "rider_equipment_unlit.csv")

# (展示列名, 源CSV列名, 是否点亮状态列)
DISPLAY_COLS = [
    ("日期", "日期", False),
    ("骑手ID", "骑士id", False),
    ("骑手姓名", "骑士姓名", False),
    ("站点ID", "站点id", False),
    ("站点名称", "站点名称", False),
    ("入职天数", "入职天数", False),
    ("应季制服是否点亮", "应季制服是否点亮", True),
    ("应季头盔是否点亮", "应季头盔是否点亮", True),
    ("整体餐箱是否点亮", "整体餐箱是否点亮", True),
]
LIT_COL_SRC = [src for _, src, is_lit in DISPLAY_COLS if is_lit]


def is_lit(v):
    """点亮 = 值为 '1'；0 / 空 / None / 其它 均视为未点亮。"""
    return str(v).strip() == "1"


def format_date(v):
    v = str(v).strip()
    if len(v) == 8 and v.isdigit():
        return "%s-%s-%s" % (v[:4], v[4:6], v[6:8])
    return v


def load_and_filter():
    with open(CSV_PATH, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames
        rows = list(reader)

    kept = []
    for row in rows:
        if any(not is_lit(row.get(c, "")) for c in LIT_COL_SRC):
            kept.append(row)

    # 按站点ID升序排列（空/非数字沉底）
    def _sid_key(row):
        v = str(row.get("站点id", "")).strip()
        try:
            return (0, int(v))
        except ValueError:
            return (1, v)
    kept.sort(key=_sid_key)
    return header, rows, kept


def build_display(kept):
    """把筛选行转成展示用的二维表（含表头）。"""
    out = []
    for row in kept:
        cells = []
        for disp, src, is_lit_col in DISPLAY_COLS:
            val = row.get(src, "")
            if disp == "日期":
                cells.append(format_date(val))
            elif is_lit_col:
                cells.append("1" if is_lit(val) else "0")
            else:
                cells.append(val)
        out.append(cells)
    return out


# ---------------- 图片渲染 ----------------
def find_font(size):
    candidates = [
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simsun.ttc",
    ]
    from PIL import ImageFont
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def render_image(display_rows, total_rows, date_str):
    """统一渲染（单一事实来源：report_render）。"""
    import report_render
    return report_render.render_equipment(display_rows, total_rows, date_str, out_path=IMG_PATH)

def main():
    no_img = "--no-img" in sys.argv
    header, all_rows, kept = load_and_filter()
    date_str = ""
    if kept:
        date_str = format_date(kept[0].get("日期", ""))

    display = build_display(kept)

    # 导出筛选后的 CSV（便于二次核对）
    with open(FILTERED_CSV, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow([d for d, _, _ in DISPLAY_COLS])
        for r in display:
            w.writerow(r)

    print("总数据行: %d" % len(all_rows))
    print("未点亮（任一）行数: %d" % len(kept))
    print("已导出筛选 CSV: %s" % FILTERED_CSV)
    if not no_img:
        if display:
            path = render_image(display, len(all_rows), date_str)
            print("已生成表格图片: %s" % path)
        else:
            print("无未点亮记录，跳过图片生成。")


if __name__ == "__main__":
    main()
