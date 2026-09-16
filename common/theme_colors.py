# -*- coding: utf-8 -*-
"""风神数据处理 · 统一配色（单一事实来源）

品牌色：淘宝闪购橙 #FF5000
设计原则：60-30-10 / 统一中性阶 + 品牌克制强调 + 语义色分层。
- HTML / CSS：直接用十六进制常量（如 BRAND）。
- Pillow 渲染：用 rgb() 取 (r,g,b) 元组，或直接使用预生成的 *_RGB 元组。
"""
# ───────── 品牌色 Brand ─────────
BRAND = "#FF5000"              # 主色 / 强调（标题条、关键数字、状态点）
BRAND_HOVER = "#E64600"       # 按下 / 加深态
BRAND_TINT = "#FFF3EE"        # 表头浅底 / 浅色面
BRAND_TINT_SOFT = "#FFF7F4"   # 斑马纹 / 极浅底
BRAND_BORDER = "#FFE0D0"      # 品牌色描边

# ───────── 中性色阶 Neutrals ─────────
TEXT_PRIMARY = "#1D2129"      # 主文字 / 标题
TEXT_REGULAR = "#303133"      # 正文
TEXT_SECONDARY = "#4E5969"    # 次级文字
TEXT_TERTIARY = "#86909C"     # 说明 / 辅助
BORDER = "#E5E6EB"            # 描边 / 分割
DIVIDER = "#F2F3F5"           # 极细分割线
SURFACE = "#F7F8FA"           # 斑马纹 / 面板底
CANVAS = "#F5F6F8"            # 页面背景(HTML)
WHITE = "#FFFFFF"             # 卡片 / 正文底

# ───────── 语义 / 功能色 Semantic ─────────
SUCCESS = "#00B42A"           # 正常 / 已出勤 / 进行中
SUCCESS_TINT = "#E8FFEA"
DANGER = "#F53F3F"            # 未点亮 / 已过期 / 离线 / 异常
DANGER_TINT = "#FFECE8"
WARNING = "#FFB400"           # 提醒 / 临界（慎用）
WARNING_TINT = "#FFF7E8"
INFO = "#165DFF"              # 链接 / 信息（极少用）
INFO_TINT = "#E8F3FF"


def rgb(hex_color):
    """十六进制 -> (r, g, b) 元组，供 Pillow fill/outline 使用。"""
    h = hex_color.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


# Pillow 常用元组（预生成，避免重复调用）
BRAND_RGB = rgb(BRAND)
BRAND_HOVER_RGB = rgb(BRAND_HOVER)
BRAND_TINT_RGB = rgb(BRAND_TINT)
BRAND_TINT_SOFT_RGB = rgb(BRAND_TINT_SOFT)
BRAND_BORDER_RGB = rgb(BRAND_BORDER)
TEXT_PRIMARY_RGB = rgb(TEXT_PRIMARY)
TEXT_REGULAR_RGB = rgb(TEXT_REGULAR)
TEXT_SECONDARY_RGB = rgb(TEXT_SECONDARY)
TEXT_TERTIARY_RGB = rgb(TEXT_TERTIARY)
BORDER_RGB = rgb(BORDER)
DIVIDER_RGB = rgb(DIVIDER)
SURFACE_RGB = rgb(SURFACE)
CANVAS_RGB = rgb(CANVAS)
WHITE_RGB = rgb(WHITE)
SUCCESS_RGB = rgb(SUCCESS)
SUCCESS_TINT_RGB = rgb(SUCCESS_TINT)
DANGER_RGB = rgb(DANGER)
DANGER_TINT_RGB = rgb(DANGER_TINT)
WARNING_RGB = rgb(WARNING)
WARNING_TINT_RGB = rgb(WARNING_TINT)
INFO_RGB = rgb(INFO)
INFO_TINT_RGB = rgb(INFO_TINT)
