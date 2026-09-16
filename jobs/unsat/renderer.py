#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""P3 出图：不满意单明细美化图（按站点分组 + 反馈要求）。

主色沿用淘宝闪购橙 #FF5000，布局语言与 report_render 一致。
"""
import os
import sys
import html
import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # jobs/
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "common"))

from . import config

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    Image = None


def _font(size):
    try:
        return ImageFont.truetype(config.FONT_PATH, size)
    except Exception:
        return ImageFont.load_default()


BRAND = (255, 80, 0)
BRAND_TINT = (255, 240, 234)
WHITE = (255, 255, 255)
SURFACE = (250, 250, 250)
DIVIDER = (235, 235, 235)
TEXT = (33, 33, 33)
TEXT_SUB = (110, 110, 110)


def _fit(d, text, max_w, font, min_size=9):
    if d.textlength(text, font=font) <= max_w:
        return font
    sz = font.size
    while sz > min_size:
        sz -= 1
        f = _font(sz)
        if d.textlength(text, font=f) <= max_w:
            return f
    return _font(min_size)


def render(rows, date_str, out_path=None, title="不满意单明细"):
    """rows: 已筛选的明细 dict 列表（含 站点/违规时间/运单号/骑手名称/违规分类/违规类型/违规原因）"""
    if Image is None:
        raise RuntimeError("未安装 Pillow，无法渲染图片")
    out_path = out_path or config.IMG_PATH

    cols = [("站点", 100), ("违规时间", 150), ("运单号", 175), ("骑手", 80),
            ("违规分类", 85), ("违规类型", 150), ("违规原因", 300)]
    pad_x, pad_y = 28, 18
    row_h, header_h, title_h, group_h, footer_h = 62, 48, 70, 44, 78
    table_w = sum(w for _, w in cols)
    img_w = table_w + pad_x * 2

    # 按站点分组
    groups = {}
    for r in rows:
        groups.setdefault(r.get("站点", "未匹配"), []).append(r)
    n_group_rows = len(groups)

    img_h = (pad_y * 2 + title_h + header_h
             + len(rows) * row_h + n_group_rows * group_h + footer_h)
    img = Image.new("RGB", (img_w, img_h), WHITE)
    d = ImageDraw.Draw(img)

    title_f, sub_f, head_f, cell_f, grp_f, foot_f = (_font(27), _font(15), _font(15),
                                                     _font(14), _font(16), _font(14))

    # 标题条
    d.rectangle([0, 0, img_w, title_h], fill=BRAND)
    d.text((pad_x, 15), title, font=title_f, fill=WHITE)
    stat = "统计日期：%s    非超时 · 非不成立 共 %d 条 / %d 个站点" % (
        date_str, len(rows), n_group_rows)
    d.text((pad_x, 46), stat, font=sub_f, fill=WHITE)

    # 表头
    y = pad_y + title_h
    d.rectangle([pad_x, y, img_w - pad_x, y + header_h], fill=BRAND_TINT)
    d.rectangle([pad_x, y + header_h - 2, img_w - pad_x, y + header_h], fill=BRAND)
    x = pad_x
    for name, w in cols:
        d.text((x + 10, y + (header_h - 18) // 2), name, font=head_f, fill=TEXT)
        x += w
    y += header_h

    # 数据行（按站点分组）
    idx = 0
    for station in sorted(groups):
        d.rectangle([pad_x, y, img_w - pad_x, y + group_h], fill=SURFACE)
        n = len(groups[station])
        d.text((pad_x + 10, y + 12), "%s（%d 条）" % (station, n), font=grp_f, fill=BRAND)
        y += group_h
        for r in groups[station]:
            bg = WHITE if idx % 2 == 0 else SURFACE
            d.rectangle([pad_x, y, img_w - pad_x, y + row_h], fill=bg)
            vals = [r.get("站点", ""), r.get("违规时间", ""), r.get("运单号", ""),
                    r.get("骑手名称", ""), r.get("违规分类", ""),
                    r.get("违规类型", ""), r.get("违规原因", "")]
            x = pad_x
            for (name, w), v in zip(cols, vals):
                f = _fit(d, str(v), w - 20, cell_f)
                d.text((x + 10, y + (row_h - 18) // 2), str(v), font=f, fill=TEXT)
                x += w
            d.line([pad_x, y + row_h, img_w - pad_x, y + row_h], fill=DIVIDER)
            y += row_h
            idx += 1

    # 页脚：反馈要求
    tip1 = "请各站点站长于 24:00 前完成反馈（@本机器人 + 运单号）："
    tip2 = "① 原因分析（A列）  ② 改善措施（B列）  ③ 培训图片/视频（C列）"
    tip3 = "三要素齐全方视为合格，未合格将每小时提醒一次。"
    d.rectangle([pad_x, y + 8, img_w - pad_x, y + footer_h], fill=BRAND_TINT)
    d.text((pad_x + 10, y + 16), tip1, font=foot_f, fill=TEXT)
    d.text((pad_x + 10, y + 38), tip2, font=foot_f, fill=BRAND)
    d.text((pad_x + 10, y + 58), tip3, font=_font(13), fill=TEXT_SUB)

    img.save(out_path)
    return out_path


def markdown_table(rows, date_str):
    """纯文本降级方案（图片渲染失败时使用）。"""
    head = "| 站点 | 违规时间 | 运单号 | 骑手 | 违规分类 | 违规类型 | 违规原因 |\n" + \
           "|" + "|".join(["---"] * 7) + "|"
    body = [head]
    for r in sorted(rows, key=lambda x: x.get("站点", "")):
        body.append("| %s | %s | %s | %s | %s | %s | %s |" % (
            r.get("站点", ""), r.get("违规时间", ""), r.get("运单号", ""),
            r.get("骑手名称", ""), r.get("违规分类", ""),
            r.get("违规类型", ""), r.get("违规原因", "")))
    return "## 不满意单明细（%s）\n**共 %d 条**\n\n%s" % (
        date_str, len(rows), "\n".join(body))


if __name__ == "__main__":
    print("renderer 自检需配合 fetcher 使用")
