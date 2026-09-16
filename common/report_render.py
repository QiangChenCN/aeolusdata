# -*- coding: utf-8 -*-
"""风神数据处理 · 统一报表渲染（单一事实来源）

所有 Pillow 报表图片都在这里渲染，统一使用 theme_colors 的配色与一套布局语言：
  - 顶部品牌色标题条（白字），副标题用白字降透明度
  - 表头 BRAND_TINT 浅底 + 2px 品牌底线
  - 斑马纹 WHITE / SURFACE（统一中性浅灰，不再用粉色）
  - 行用极细 DIVIDER 横线分割，去掉重黑框
  - 状态/关键值用语义色 + 圆角药丸(pill)，更克制高级
  - 站点汇总用中性卡片，关键数字品牌色强调

生产脚本直接 `from report_render import <fn> as render_image` 即可，调用签名保持不变。
"""
import os
import datetime
import theme_colors as C
from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(os.path.abspath(__file__))
IMG_ABSENT = os.path.join(BASE, "attendance_absent.png")
IMG_APPEAL = os.path.join(BASE, "violation_detail.png")
IMG_EQUIP = os.path.join(BASE, "rider_equipment_warning.png")
IMG_TASKS = os.path.join(BASE, "task_started.png")
IMG_ONLINE = os.path.join(BASE, "realtime_online.png")  # 实时在线汇总图（与 attendance_absent 区分，避免静默覆盖）

# 中文字体默认路径（统一解析，避免多处硬编码第二真相；ding_common 用同一约定）
try:
    from ding_common import FONT_PATH as _FONT_DEFAULT
except Exception:
    _FONT_DEFAULT = os.environ.get("DING_FONT_PATH") or "C:/Windows/Fonts/simhei.ttf"


# ───────────── 通用工具 ─────────────
def _font(size, bold=False):
    p = os.environ.get("DING_FONT_PATH") or "C:/Windows/Fonts/simhei.ttf"
    try:
        return ImageFont.truetype(p, size)
    except Exception:
        return ImageFont.load_default()


def fit_font(d, text, max_w, base_font, min_size=8):
    """返回能让 text 在 max_w 内单行放下的字号。"""
    if d.textlength(text, font=base_font) <= max_w:
        return base_font
    sz = base_font.size
    p = _FONT_DEFAULT
    while sz > min_size:
        sz -= 1
        f = ImageFont.truetype(p, sz)
        if d.textlength(text, font=f) <= max_w:
            return f
    return ImageFont.truetype(p, min_size)


def _pill(d, cx, cy, text, font, bg_rgb, fg_rgb, pad_x=12, radius=8):
    """在 (cx,cy) 居中绘制一个圆角药丸。"""
    bbox = d.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    w = tw + pad_x * 2
    h = max(th + 10, 24)
    x0 = int(cx - w / 2)
    y0 = int(cy - h / 2)
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=radius, fill=bg_rgb)
    d.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), text, font=font, fill=fg_rgb)
    return w, h


def _centered_text(d, cx, cy, text, font, fill):
    """在 (cx,cy) 居中绘制文字（基于字形真实包围盒）。"""
    b = d.textbbox((0, 0), text, font=font)
    tw = b[2] - b[0]
    th = b[3] - b[1]
    d.text((cx - tw / 2 - b[0], cy - th / 2 - b[1]), text, font=font, fill=fill)


def _fmt_rate(online, sched):
    if not sched:
        return "0"
    r = round(online * 100 / sched, 2)
    if r == int(r):
        return str(int(r))
    return ("%.2f" % r).rstrip("0").rstrip(".")


def _bj_now():
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))


def _mask_mobile(m):
    """手机号脱敏：保留前 3 后 4，中间掩码，避免公开图床泄露隐私。"""
    if not m or len(m) < 7:
        return m
    return m[:3] + "****" + m[-4:]


# ───────────── 1. 实时考勤 · 有排班未出勤 ─────────────
def render_attendance_absent(rows, query_code, query_name, team_id, total_riders, out_path=None):
    out_path = out_path or IMG_ONLINE
    F = _font
    time_str = _bj_now().strftime("%Y-%m-%d %H:%M")
    cols = [("序号", 50), ("骑手姓名", 100), ("手机号", 120), ("排班时段", 200),
            ("出勤状态", 96), ("全天在线", 90), ("全天单量", 80), ("目标时长", 90), ("目标单量", 80)]
    title_f, sub_f, head_f, cell_f = F(28), F(14), F(15), F(14)
    pad_x, pad_y = 28, 18
    row_h, header_h, title_h, footer_h = 48, 44, 66, 44
    table_w = sum(w for _, w in cols)
    img_w = table_w + pad_x * 2
    n_rows = max(len(rows), 1)
    img_h = pad_y * 2 + title_h + header_h + n_rows * row_h + footer_h
    img = Image.new("RGB", (img_w, img_h), C.WHITE_RGB)
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, img_w, title_h], fill=C.BRAND_RGB)
    d.text((pad_x, 16), "实时考勤 · 有排班未出勤", font=title_f, fill=C.WHITE_RGB)
    d.text((pad_x, 46),
           "时段：%s（%s）  ·  团队 %s  ·  %s  ·  未出勤 %d / 全队 %d"
           % (query_name, query_code, team_id, time_str, len(rows), total_riders),
           font=sub_f, fill=(255, 255, 255))

    y = pad_y * 2 + title_h
    d.rectangle([pad_x, y, img_w - pad_x, y + header_h], fill=C.BRAND_TINT_RGB)
    x = pad_x
    for name, w in cols:
        d.text((x + 10, y + (header_h - 18) // 2), name, font=head_f, fill=C.TEXT_PRIMARY_RGB)
        x += w
    d.line([(pad_x, y + header_h), (img_w - pad_x, y + header_h)], fill=C.BRAND_RGB, width=2)
    y += header_h

    if rows:
        for i, r in enumerate(rows):
            bg = C.WHITE_RGB if i % 2 == 0 else C.SURFACE_RGB
            d.rectangle([pad_x, y, img_w - pad_x, y + row_h], fill=bg)
            d.line([(pad_x, y + row_h), (img_w - pad_x, y + row_h)], fill=C.DIVIDER_RGB, width=1)
            values = [str(i + 1), r["knightName"], _mask_mobile(r["mobile"]), r["schedule"], r["workStatus"],
                      r["fullDayOnline"], str(r["fullDayOrders"]), r["slotTarget"], str(r["slotOrderTarget"])]
            x = pad_x
            for (name, w), val in zip(cols, values):
                if name == "出勤状态":
                    bad = r["workStatus"] in ("离线", "小休")
                    _pill(d, x + w / 2, y + row_h / 2, val, cell_f,
                          C.DANGER_TINT_RGB if bad else C.SUCCESS_TINT_RGB,
                          C.DANGER_RGB if bad else C.SUCCESS_RGB)
                else:
                    font = fit_font(d, val, w - 20, cell_f)
                    ty = y + (row_h - font.size) // 2
                    d.text((x + 10, ty), val, font=font, fill=C.TEXT_REGULAR_RGB)
                x += w
            y += row_h
    else:
        d.text((pad_x + 10, y + 12), "✓ 当前时段所有有排班骑手均已出勤",
               font=F(16), fill=C.SUCCESS_RGB)
        y += row_h

    d.text((pad_x, y + 12), "说明：仅显示有当前时段排班但在线时长为 0 的骑手",
           font=sub_f, fill=C.TEXT_TERTIARY_RGB)
    img.save(out_path)
    return out_path


# ───────────── 2. 实时在线（多站点汇总 + 明细） ─────────────
def render_all_teams(all_rows, query_name, range_str, team_items, stats, out_path=None):
    out_path = out_path or IMG_ABSENT
    F = _font
    time_str = _bj_now().strftime("%Y-%m-%d %H:%M")
    cols = [("骑手姓名", 95), ("站点", 165), ("状态", 80), ("配送中单量", 85),
            ("当前时段完成单量", 130), ("当前时段有效在线时长", 150),
            ("全天完成单量", 95), ("全天有效在线时长", 130)]
    title_f, sub_f, site_f, stat_f, head_f, cell_f = F(28), F(14), F(15), F(13), F(14), F(13)
    pad_x, pad_y = 28, 18
    row_h, header_h, title_h, footer_h = 46, 44, 66, 40
    card_h, card_gap = 44, 12
    table_w = sum(w for _, w in cols)
    img_w = table_w + pad_x * 2
    n_rows = max(len(all_rows), 1)
    # 站点卡片 + 1 张三站合计卡片
    cards_h = (len(team_items) + 1) * (card_h + card_gap) - card_gap if team_items else card_h + card_gap
    img_h = pad_y * 2 + title_h + cards_h + 12 + header_h + n_rows * row_h + footer_h
    img = Image.new("RGB", (img_w, img_h), C.WHITE_RGB)
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, img_w, title_h], fill=C.BRAND_RGB)
    d.text((pad_x, 16), "实时在线", font=title_f, fill=C.WHITE_RGB)
    d.text((pad_x, 46), "时段：%s（%s）  ·  %s" % (query_name, range_str, time_str),
           font=sub_f, fill=(255, 255, 255))

    # 站点汇总卡片
    y = pad_y * 2 + title_h
    tot = [0, 0, 0, 0, 0, 0]  # 三站合计：排班/在线/下线/小休/下线背单/小休背单
    for team_id, name in team_items:
        sched, online, offline, rest, off_deliv, rest_deliv = stats.get(team_id, (0, 0, 0, 0, 0, 0))
        tot[0] += sched; tot[1] += online; tot[2] += offline
        tot[3] += rest; tot[4] += off_deliv; tot[5] += rest_deliv
        rate = _fmt_rate(online, sched)
        d.rounded_rectangle([pad_x, y, img_w - pad_x, y + card_h], radius=10, fill=C.SURFACE_RGB)
        d.text((pad_x + 14, y + (card_h - 18) // 2), name, font=site_f, fill=C.TEXT_PRIMARY_RGB)
        parts = [("排班 ", C.TEXT_SECONDARY), (str(sched), C.TEXT_PRIMARY),
                 ("   在线 ", C.TEXT_SECONDARY), (str(online), C.TEXT_PRIMARY),
                 ("   在线率 ", C.TEXT_SECONDARY), (rate + "%", C.BRAND),
                 ("   小休 ", C.TEXT_SECONDARY), (str(rest), C.TEXT_PRIMARY)]
        x = pad_x + 14 + d.textlength(name, font=site_f) + 18
        for txt, col in parts:
            d.text((x, y + (card_h - 16) // 2), txt, font=stat_f, fill=col)
            x += d.textlength(txt, font=stat_f)
        y += card_h + card_gap

    # 三站合计卡片（品牌色强调）
    t_sched, t_online, t_offline, t_rest, t_off_deliv, t_rest_deliv = tot
    t_rate = _fmt_rate(t_online, t_sched)
    d.rounded_rectangle([pad_x, y, img_w - pad_x, y + card_h], radius=10,
                        fill=C.BRAND_TINT_RGB, outline=C.BRAND_RGB, width=1)
    d.text((pad_x + 14, y + (card_h - 18) // 2), "三站合计", font=site_f, fill=C.BRAND_RGB)
    parts = [("排班 ", C.TEXT_SECONDARY), (str(t_sched), C.TEXT_PRIMARY),
             ("   在线 ", C.TEXT_SECONDARY), (str(t_online), C.TEXT_PRIMARY),
             ("   在线率 ", C.TEXT_SECONDARY), (t_rate + "%", C.BRAND),
             ("   小休 ", C.TEXT_SECONDARY), (str(t_rest), C.TEXT_PRIMARY),
             ("   下线 ", C.TEXT_SECONDARY), (str(t_offline), C.TEXT_PRIMARY),
             ("   背单 ", C.TEXT_SECONDARY), (str(t_off_deliv + t_rest_deliv), C.TEXT_PRIMARY)]
    x = pad_x + 14 + d.textlength("三站合计", font=site_f) + 18
    for txt, col in parts:
        d.text((x, y + (card_h - 16) // 2), txt, font=stat_f, fill=col)
        x += d.textlength(txt, font=stat_f)
    y += card_h + card_gap
    y += 12 - card_gap

    # 明细表头
    d.rectangle([pad_x, y, img_w - pad_x, y + header_h], fill=C.BRAND_TINT_RGB)
    x = pad_x
    for idx, (name, w) in enumerate(cols):
        if idx in (0, 1):
            tx = x + 10
        else:
            tw = d.textlength(name, font=head_f)
            tx = x + (w - tw) // 2
        d.text((tx, y + (header_h - 18) // 2), name, font=head_f, fill=C.TEXT_PRIMARY_RGB)
        x += w
    d.line([(pad_x, y + header_h), (img_w - pad_x, y + header_h)], fill=C.BRAND_RGB, width=2)
    y += header_h

    def cell_is_zero(idx, val):
        if idx in (3, 4, 6):
            try:
                return int(val) == 0
            except ValueError:
                return False
        if idx in (5, 7):
            return val == "0"
        return False

    if all_rows:
        for i, r in enumerate(all_rows):
            bg = C.WHITE_RGB if i % 2 == 0 else C.SURFACE_RGB
            d.rectangle([pad_x, y, img_w - pad_x, y + row_h], fill=bg)
            d.line([(pad_x, y + row_h), (img_w - pad_x, y + row_h)], fill=C.DIVIDER_RGB, width=1)
            values = [r["knightName"], r["site"], r["state"], str(r["delivering"]),
                      str(r["slotFinish"]), r["slotValid"], str(r["fullFinish"]), r["fullValid"]]
            x = pad_x
            for idx, ((name, w), val) in enumerate(zip(cols, values)):
                if name == "状态":
                    _pill(d, x + w / 2, y + row_h / 2, val, cell_f, C.DANGER_TINT_RGB, C.DANGER_RGB)
                elif cell_is_zero(idx, val):
                    font = fit_font(d, val, w - 20, cell_f)
                    ty = y + (row_h - font.size) // 2
                    d.text((x + (10 if idx in (0, 1) else (w - d.textlength(val, font=font)) // 2), ty),
                           val, font=font, fill=C.TEXT_TERTIARY_RGB)
                else:
                    font = fit_font(d, val, w - 20, cell_f)
                    ty = y + (row_h - font.size) // 2
                    if idx in (0, 1):
                        d.text((x + 10, ty), val, font=font, fill=C.TEXT_REGULAR_RGB)
                    else:
                        tw = d.textlength(val, font=font)
                        d.text((x + (w - tw) // 2, ty), val, font=font, fill=C.TEXT_REGULAR_RGB)
                x += w
            y += row_h
    else:
        d.text((pad_x + 10, y + 10), "✓ 当前时段所有有排班骑手均已在线配送",
               font=F(16), fill=C.SUCCESS_RGB)
        y += row_h

    d.text((pad_x, y + 10),
           "说明：在线(活跃)=上班/部分在线；小休=暂离(不计入在线)；下线=未在线装备。明细列出小休与下线骑手",
           font=sub_f, fill=C.TEXT_TERTIARY_RGB)
    img.save(out_path)
    return out_path


# ───────────── 3. 不满意单申诉提醒 ─────────────
def render_appeal(rows, date_str, out_path=None):
    out_path = out_path or IMG_APPEAL
    F = _font
    cols = [("违规时间", 165), ("运单号", 200), ("骑手信息", 160), ("所属团队", 200),
            ("违规分类", 95), ("违规类型", 125), ("违规原因", 270),
            ("申诉状态", 95), ("申诉剩余时间", 135)]
    title_f, sub_f, head_f, cell_f = F(28), F(15), F(15), F(14)
    pad_x, pad_y = 28, 18
    row_h, header_h, title_h, footer_h = 64, 50, 66, 48
    table_w = sum(w for _, w in cols)
    img_w = table_w + pad_x * 2
    img_h = pad_y * 2 + title_h + header_h + len(rows) * row_h + footer_h
    img = Image.new("RGB", (img_w, img_h), C.WHITE_RGB)
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, img_w, title_h], fill=C.BRAND_RGB)
    d.text((pad_x, 16), "不满意单申诉提醒", font=title_f, fill=C.WHITE_RGB)
    d.text((pad_x, 46), "统计日期：%s    非超时 · 待申诉 共 %d 条" % (date_str, len(rows)),
           font=sub_f, fill=(255, 255, 255))

    y = pad_y * 2 + title_h
    d.rectangle([pad_x, y, img_w - pad_x, y + header_h], fill=C.BRAND_TINT_RGB)
    x = pad_x
    for name, w in cols:
        d.text((x + 10, y + (header_h - 18) // 2), name, font=head_f, fill=C.TEXT_PRIMARY_RGB)
        x += w
    d.line([(pad_x, y + header_h), (img_w - pad_x, y + header_h)], fill=C.BRAND_RGB, width=2)
    y += header_h

    for i, r in enumerate(rows):
        bg = C.WHITE_RGB if i % 2 == 0 else C.SURFACE_RGB
        d.rectangle([pad_x, y, img_w - pad_x, y + row_h], fill=bg)
        d.line([(pad_x, y + row_h), (img_w - pad_x, y + row_h)], fill=C.DIVIDER_RGB, width=1)
        x = pad_x
        for name, w in cols:
            text = str(r[name])
            if name == "申诉状态":
                _pill(d, x + w / 2, y + row_h / 2, text, cell_f, C.BRAND_TINT_RGB, C.BRAND_HOVER_RGB)
            else:
                font = fit_font(d, text, w - 20, cell_f)
                ty = y + (row_h - font.size) // 2
                d.text((x + 10, ty), text, font=font, fill=C.TEXT_REGULAR_RGB)
            x += w
        y += row_h

    d.text((pad_x, y + 14), "请相关站点站长及时查看明细并处理申诉",
           font=sub_f, fill=C.TEXT_TERTIARY_RGB)
    img.save(out_path)
    return out_path


# ───────────── 4. 骑手装备未点亮明细 ─────────────
def render_equipment(display_rows, total_rows, date_str, out_path=None):
    out_path = out_path or IMG_EQUIP
    F = _font
    title_f, head_f, cell_f, note_f = F(22), F(15), F(14), F(13)
    pad_x, pad_y = 28, 18
    header_h, row_h, title_h, legend_h, footer_h = 42, 38, 56, 30, 36
    headers = ["日期", "骑手ID", "骑手姓名", "站点ID", "站点名称", "入职天数",
               "应季制服是否点亮", "应季头盔是否点亮", "整体餐箱是否点亮"]

    def text_w(font, s):
        b = font.getbbox(s)
        return b[2] - b[0]

    col_w = []
    for i, h in enumerate(headers):
        w = text_w(head_f, h)
        for r in display_rows:
            w = max(w, text_w(cell_f, str(r[i])))
        col_w.append(w + 24)
    table_w = sum(col_w)
    img_w = table_w + pad_x * 2
    img_h = title_h + legend_h + header_h + row_h * len(display_rows) + footer_h + 20
    img = Image.new("RGB", (img_w, img_h), C.WHITE_RGB)
    d = ImageDraw.Draw(img)

    # 标题（品牌色，不再用蓝色）
    d.text((pad_x, 14), "骑手装备未点亮明细", font=title_f, fill=C.BRAND_RGB)
    # 图例（字体字形：× 未点亮 / √ 点亮；SimHei 含这两个字形）
    legend_y = title_h + 16
    box_h = 20
    d.rounded_rectangle([pad_x, legend_y - box_h / 2, pad_x + box_h, legend_y + box_h / 2], radius=5, fill=C.DANGER_TINT_RGB)
    _centered_text(d, pad_x + box_h / 2, legend_y, "×", cell_f, C.DANGER_RGB)
    lx = pad_x + box_h + 8
    d.text((lx, legend_y - 8), "未点亮", font=note_f, fill=C.TEXT_SECONDARY_RGB)
    lx += text_w(note_f, "未点亮") + 14
    _centered_text(d, lx + 8, legend_y, "√", cell_f, C.SUCCESS_RGB)
    lx += 16
    d.text((lx, legend_y - 8), "点亮", font=note_f, fill=C.TEXT_SECONDARY_RGB)
    lx += text_w(note_f, "点亮") + 16
    d.text((lx, legend_y - 8),
           "日期：%s    共 %d 条（总数据 %d 行）" % (date_str, len(display_rows), total_rows),
           font=note_f, fill=C.TEXT_SECONDARY_RGB)

    y = title_h + legend_h
    x = pad_x
    d.rectangle([x, y, x + table_w, y + header_h], fill=C.BRAND_TINT_RGB)
    cx = x
    for i, h in enumerate(headers):
        tw = text_w(head_f, h)
        d.text((cx + (col_w[i] - tw) // 2, y + (header_h - 16) // 2), h, font=head_f, fill=C.TEXT_PRIMARY_RGB)
        cx += col_w[i]
    d.line([(pad_x, y + header_h), (pad_x + table_w, y + header_h)], fill=C.BRAND_RGB, width=2)
    y += header_h

    for ri, r in enumerate(display_rows):
        bg = C.WHITE_RGB if ri % 2 == 0 else C.SURFACE_RGB
        d.rectangle([pad_x, y, pad_x + table_w, y + row_h], fill=bg)
        d.line([(pad_x, y + row_h), (pad_x + table_w, y + row_h)], fill=C.DIVIDER_RGB, width=1)
        cx = pad_x
        for i, h in enumerate(headers):
            val = r[i]
            is_lit_col = i >= 6
            if is_lit_col and val == "0":
                d.rounded_rectangle([cx + 6, y + 6, cx + col_w[i] - 6, y + row_h - 6], radius=6, fill=C.DANGER_TINT_RGB)
                _centered_text(d, cx + col_w[i] / 2, y + row_h / 2, "×", cell_f, C.DANGER_RGB)
            elif is_lit_col:
                _centered_text(d, cx + col_w[i] / 2, y + row_h / 2, "√", cell_f, C.SUCCESS_RGB)
            else:
                d.text((cx + 12, y + (row_h - 14) // 2), str(val), font=cell_f, fill=C.TEXT_REGULAR_RGB)
            cx += col_w[i]
        y += row_h

    d.text((pad_x, y + 10), "数据来源：风神 Quark 报表", font=note_f, fill=C.TEXT_TERTIARY_RGB)
    img.save(out_path)
    return out_path


# ───────────── 5. 站长任务看板（进行中任务） ─────────────
def render_tasks(tasks, out_path=None):
    out_path = out_path or IMG_TASKS
    F = _font
    now_str = _bj_now().strftime("%Y-%m-%d %H:%M")
    columns = [("任务名称", "taskName"), ("任务对象", "taskObject"), ("状态", "status"),
               ("有效期", "taskExpireTime"), ("剩余时间", "remaining"), ("执行人", "executorName")]
    title_f, head_f, cell_f, small_f = F(20), F(13), F(12), F(11)
    margin = 28
    row_h, header_h, title_h, gap = 40, 40, 60, 16
    n_rows = max(len(tasks), 1)

    def _tw(font, s):
        b = font.getbbox(s)
        return b[2] - b[0]

    # 动态列宽：按「表头 / 内容」最大宽度自适应，内容完整显示、不截断；
    # 图片宽度由内容决定，自动变长。
    col_w = []
    for title, key in columns:
        w = _tw(head_f, title)
        for t in tasks:
            text = str(t.get(key, ""))
            if key == "status":  # 药丸两侧各有 12px 内边距
                w = max(w, _tw(cell_f, text) + 24 + 6)
            else:
                w = max(w, _tw(cell_f, text))
        col_w.append(w + 24)
    table_w = sum(col_w)
    img_width = table_w + margin * 2
    col_x = [margin]
    for w in col_w:
        col_x.append(col_x[-1] + w)
    img_h = margin + title_h + gap + header_h + n_rows * row_h + margin + 30
    img = Image.new("RGB", (img_width, img_h), C.WHITE_RGB)
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, img_width, title_h + margin], fill=C.BRAND_RGB)
    d.text((margin, 16), "站长任务看板 · 进行中任务", font=title_f, fill=C.WHITE_RGB)
    d.text((img_width - margin - 200, 24), "生成时间：%s" % now_str, font=small_f, fill=(255, 255, 255))

    y = margin + title_h + gap
    d.rectangle([margin, y, margin + table_w, y + header_h], fill=C.BRAND_TINT_RGB)
    for i, (title, _) in enumerate(columns):
        d.text((col_x[i] + 10, y + (header_h - 16) // 2), title, font=head_f, fill=C.TEXT_PRIMARY_RGB)
    d.line([(margin, y + header_h), (margin + table_w, y + header_h)], fill=C.BRAND_RGB, width=2)
    y += header_h

    for idx, task in enumerate(tasks):
        if idx % 2 == 0:
            d.rectangle([margin, y, margin + table_w, y + row_h], fill=C.SURFACE_RGB)
        status_text = task["status"]
        status_color = C.SUCCESS_RGB if status_text == "已开始" else C.TEXT_TERTIARY_RGB
        remaining_text = task["remaining"]
        remaining_color = C.DANGER_RGB if (remaining_text == "已过期" or "天" not in remaining_text and remaining_text not in ("无截止时间", "时间格式异常")) else C.TEXT_REGULAR_RGB
        if remaining_text not in ("已过期",):
            try:
                if "天" in remaining_text:
                    parts = remaining_text.replace("天", " ").replace("小时", " ").replace("分钟", " ").split()
                    total_hours = int(parts[0]) * 24 + (int(parts[1]) if len(parts) > 1 else 0)
                    if total_hours < 24:
                        remaining_color = C.DANGER_RGB
            except Exception:
                pass
        cells = [(task["taskName"], C.TEXT_REGULAR_RGB), (task["taskObject"], C.TEXT_SECONDARY_RGB),
                 (status_text, status_color), (task["taskExpireTime"], C.TEXT_REGULAR_RGB),
                 (remaining_text, remaining_color), (task["executorName"], C.TEXT_REGULAR_RGB)]
        for i, (text, color) in enumerate(cells):
            if columns[i][0] == "状态":
                _pill(d, col_x[i] + col_w[i] / 2, y + row_h / 2, text, cell_f,
                      C.SUCCESS_TINT_RGB if status_text == "已开始" else C.SURFACE_RGB,
                      status_color)
            else:
                d.text((col_x[i] + 10, y + (row_h - 14) // 2), text, fill=color, font=cell_f)
        d.line([(margin, y + row_h), (margin + table_w, y + row_h)], fill=C.DIVIDER_RGB, width=1)
        y += row_h

    d.text((margin, y + 10), "共 %d 条进行中任务" % len(tasks), fill=C.TEXT_TERTIARY_RGB, font=small_f)
    img.save(out_path, "PNG")
    return out_path
