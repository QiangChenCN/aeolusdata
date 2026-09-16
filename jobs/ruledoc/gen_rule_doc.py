"""gen_rule_doc.py —— 纯 HTTP 取骑士规则中心数据 + 前台原生渲染。

链路（按用户要求）：
  1. 排版逻辑 + 数据接口：由 cdp_capture_spec.py（真 Edge 非 headless 调试模式）一次性探明，
     原生块签名 / 标题栏结构固化在 rule_native_reference*.html（CDP 抓的前台真实渲染 DOM）。
  2. 本脚本运行时【只走 HTTP】：ensure_cookies() 拿 Aeolus cookie →
     POST queryRuleInfo 取 Slate JSON（ruleContent）→ 用原生签名渲染成前台同款 HTML。
  3. 原生效果：块级 data-type / class / style 全部取自前台参考 DOM（computed 样式），
     不改任何排版（仅剔除依赖视口的写死 width/height，让文档在浏览器里自然流式，等同前台响应式）。

用法：
  .venv/Scripts/python.exe gen_rule_doc.py --rule 6451 --history
  .venv/Scripts/python.exe gen_rule_doc.py --rule 6355 --no-history
"""
import os
import sys
import json
import re
import html
import argparse

# 任务脚本已迁到 jobs/ruledoc/ 下，公共模块（aeolus_sdk 等）在项目根：
# 显式按脚本位置推算，不依赖调用方的 cwd。
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_COMMON = os.path.join(ROOT, "common")
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
if _COMMON not in sys.path:
    sys.path.insert(0, _COMMON)
from aeolus_sdk.login import ensure_cookies
from get_data import ruledoc   # 骑士规则中心取数（单一来源；query_rule 在此）

HERE = os.path.dirname(os.path.abspath(__file__))      # jobs/ruledoc
OUT_DIR = os.path.join(HERE, "out")                    # 产物统一进 out/
os.makedirs(OUT_DIR, exist_ok=True)
# 参考快照（CDP 抓的前台原生渲染 DOM）与探针同目录收在 jobs/ruledoc/ 下
REF_DIR = HERE
REFS = [os.path.join(REF_DIR, "rule_native_reference.html"),
        os.path.join(REF_DIR, "rule_native_reference_6355.html")]

TAG_TO_DT = {"h1": "heading-1", "h2": "heading-2", "h3": "heading-3",
             "h4": "heading-4", "h5": "heading-5", "h6": "heading-6",
             "p": "paragraph"}


def _read_refs():
    """读取参考快照。缺失时直接报错——静默跳过会让正文样式全部丢失却不自知。"""
    out = []
    for f in REFS:
        if not os.path.exists(f):
            raise RuntimeError(
                "参考快照缺失，无法提取前台原生样式：%s\n"
                "（快照应位于 %s ；若目录改名或被移动，请同步修改 gen_rule_doc.py 的 REF_DIR）"
                % (f, REF_DIR))
        out.append(open(f, encoding="utf-8").read())
    if not out:
        raise RuntimeError("REFS 为空，无法提取前台原生样式：%s" % REFS)
    return out


def block_spec():
    spec = {}
    for raw in _read_refs():
        for m in re.finditer(r'<([a-zA-Z0-9]+)[^>]*?\bdata-type="([a-z0-9-]+)"[^>]*>', raw):
            dt = m.group(2)
            if dt in spec:
                continue
            whole = m.group(0)
            cm = re.search(r'class="([^"]*)"', whole)
            sm = re.search(r'style="([^"]*)"', whole)
            spec[dt] = {"tag": m.group(1),
                        "class": cm.group(1) if cm else "",
                        "style": sm.group(1) if sm else ""}
    return spec


def style_of(raw, pat):
    m = re.search(pat, raw)
    return m.group(1) if m else ""


def clean_style(s):
    if not s:
        return ""
    for prop in ("width", "height", "max-width", "min-width", "min-height"):
        s = re.sub(r'(?:^|;)\s*%s:[^;]+;?' % re.escape(prop), ";", s)
    return s.strip(";").strip()


def render_leaf(attrs, text):
    style = ""
    if attrs.get("bold"):
        style += "font-weight:bold;"
    sz = attrs.get("sz")
    if sz:
        style += "font-size:%spt;" % sz
    color = attrs.get("color")
    if color:
        style += "color:%s;" % color
    return '<span data-type="leaf" style="%s">%s</span>' % (style, html.escape(text))


def is_slate_node(x):
    # 嵌套 Slate 节点: ["type", {attrs}, child1, child2, ...]
    return (isinstance(x, list) and x and isinstance(x[0], str)
            and (len(x) == 1 or isinstance(x[1], dict)))


def render_children(children, spec):
    if children is None:
        return ""
    if isinstance(children, str):
        return html.escape(children)
    if not isinstance(children, list):
        return ""
    out = []
    for ch in children:
        if isinstance(ch, str):
            out.append(html.escape(ch))
        elif is_slate_node(ch):
            out.append(render_node(ch, spec))
    return "".join(out)


def render_node(node, spec):
    if not is_slate_node(node):
        return ""
    type_ = node[0]
    attrs = node[1] if (len(node) > 1 and isinstance(node[1], dict)) else {}
    children = node[2:]  # 全部子节点（嵌套结构，勿只取第一个）
    if type_ == "span":
        if len(children) == 1 and isinstance(children[0], str):
            return render_leaf(attrs, children[0])
        inner = render_children(children, spec)
        style = ""
        if attrs.get("bold"):
            style += "font-weight:bold;"
        if attrs.get("sz"):
            style += "font-size:%spt;" % attrs["sz"]
        if attrs.get("color"):
            style += "color:%s;" % attrs["color"]
        if style:
            return '<span data-type="leaf" style="%s">%s</span>' % (style, inner)
        return inner
    if type_ in ("table", "tr", "tc"):
        return render_table(type_, children, spec)
    dt = TAG_TO_DT.get(type_)
    if dt is None:
        return "<div>%s</div>" % render_children(children, spec)
    b = spec.get(dt)
    if not b:
        return '<div data-type="%s">%s</div>' % (dt, render_children(children, spec))
    st = clean_style(b["style"])
    return '<%s data-type="%s" class="%s" style="%s">%s</%s>' % (
        b["tag"], dt, b["class"], st, render_children(children, spec), b["tag"])


def _extract_text(children):
    out = []
    def w(x):
        if isinstance(x, str):
            out.append(x)
        elif is_slate_node(x):
            for k in x[2:]:
                w(k)
    if isinstance(children, list):
        for c in children:
            w(c)
    return "".join(out)


def render_table(type_, children, spec):
    if type_ == "table":
        b = spec.get("table", {"tag": "div", "class": "", "style": ""})
        inner = render_children(children, spec)
        return '<div data-type="table" class="%s" style="%s"><table><tbody>%s</tbody></table></div>' % (
            b["class"], clean_style(b["style"]), inner)
    if type_ == "tr":
        return "<tr>%s</tr>" % render_children(children, spec)
    if type_ in ("td", "tc"):
        # 前台(cangjie)不渲染空单元格：与参考 DOM 保持一致（86 格 vs 数据 109 格）
        if _extract_text(children).strip() == "":
            return ""
        b = spec.get("table-cell", {"tag": "td", "class": "", "style": ""})
        return '<td data-type="table-cell" class="%s" style="%s">%s</td>' % (
            b["class"], clean_style(b["style"]), render_children(children, spec))
    return ""


def build_header(raw, rule_name, eff, meta_html=""):
    """标题区（rule-details__header）：标题 + 生效时间 + 操作按钮 + 元数据块。

    元数据块作为 header 的最后一个子块，但 header 本身是 flex 横排（nowrap），
    直接插入会变成第三个横排 item 挤掉标题，所以这里覆盖 flex-wrap:wrap，
    并让元数据块 flex:0 0 100% 独占一行 —— 结果就是「标题/按钮一行，元数据一行」，
    两者都在同一个 header 大元素内。
    """
    h_style = clean_style(style_of(raw, r'class="rule-details__header"[^>]*style="([^"]*)"'))
    t_style = clean_style(style_of(raw, r'class="rule-details__header-title"[^>]*style="([^"]*)"'))
    h1_style = clean_style(style_of(raw, r'class="text-limit-two-lines"[^>]*style="([^"]*)"'))
    time_style = clean_style(style_of(raw, r'class="rule-details__header-update-time"[^>]*style="([^"]*)"'))
    a_style = clean_style(style_of(raw, r'class="rule-details__header-actions"[^>]*style="([^"]*)"'))
    btn_style = clean_style(style_of(raw, r'class="ant-btn css-w18tjb ant-btn-default"[^>]*style="([^"]*)"'))
    # 生效时间为空时不渲染该行，避免留下「生效时间： 」空白
    # （完整日期由元数据块负责，那里有含 updatedAt 的兜底链）
    time_html = ""
    if eff:
        time_html = ('<div class="rule-details__header-update-time" style="%s">生效时间：%s </div>'
                     % (time_style, html.escape(eff)))
    # 同声明块内后置属性覆盖前置：把参考 DOM 的 flex-wrap:nowrap 改为 wrap，
    # 元数据块才能换行到第二行通栏（见函数 docstring）。
    if meta_html:
        h_style = (h_style + ";flex-wrap:wrap") if h_style else "flex-wrap:wrap"
    return ('<div class="rule-details__header" style="%s">'
            '<div class="rule-details__header-title" style="%s">'
            '<h1 class="text-limit-two-lines" style="%s">%s</h1>'
            '%s'
            '</div>'
            '<div class="rule-details__header-actions" style="%s">'
            '<button type="button" class="ant-btn css-w18tjb ant-btn-default" style="%s">'
            '<span>最新版本</span></button></div>'
            '%s'
            '</div>') % (h_style, t_style, h1_style, html.escape(rule_name),
                         time_html, a_style, btn_style, meta_html)


def build_doc(data, spec, raw):
    tree = json.loads(data["ruleContent"])
    body = render_children(tree[2:], spec)
    rule_name = data.get("ruleName") or "未命名规则"
    eff = (data.get("effectiveTime") or data.get("effectiveStartTime")
           or data.get("publishEndTime") or "")
    eff = (eff or "")[:10]
    rd_style = clean_style(style_of(raw, r'class="rule-details"(?:\s[^>]*)?style="([^"]*)"'))
    cont_style = clean_style(style_of(raw, r'class="rule-details-container"[^>]*style="([^"]*)"'))
    # 参考 DOM 里 container 带 padding-top:129px —— 那是前台给「悬浮 header」预留的避让空间
    # （前台 header 悬浮在正文之上，正文必须下移才不被盖住）。
    # 本文档的 header 没有 position（普通流式，正常占位、不会覆盖正文），
    # 这 129px 就变成 header 与正文之间的一大段空白 → 覆盖为 0。
    # 这是适配差异，不是吞异常：header 与正文的间距由 header 自身的 padding-bottom 提供。
    cont_style = (cont_style + ";padding-top:0") if cont_style else "padding-top:0"
    prev_style = clean_style(style_of(raw, r'class="ruleDetail-preview ruleDetail-preview-withToc"[^>]*style="([^"]*)"'))
    cc_style = clean_style(style_of(raw, r'data-cangjie-content="true"[^>]*style="([^"]*)"'))
    # 前台 cangjie 富文本编辑器为接管光标/选区，在内容容器上写了 user-select:none。
    # 我们生成的是只读文档，必须允许选中复制 → 覆盖为 text（同声明块后置覆盖前置）。
    # 只改这一个交互属性，不动任何排版样式。
    cc_style = ((cc_style + ";-webkit-user-select:text;-moz-user-select:text;user-select:text")
                if cc_style else "user-select:text")
    ce_style = clean_style(style_of(raw, r'data-cangjie-editable="true"[^>]*style="([^"]*)"'))
    meta_row = build_meta_row(data)
    # 附件块在正文容器之外，自己补上正文的左缩进（container + 内容区 padding-left），
    # 否则会比正文更靠左。动态算，参考 DOM 改了也跟着变。
    att_indent = _pad_left(cont_style) + _pad_left(cc_style)
    attachments_html = build_attachments_html(data, att_indent)
    # 结构 = rule-details > [ header(标题 + 生效时间 + 按钮 + 元数据), container, attachments ]
    # 元数据嵌在 header 大元素内（见 build_header docstring），不再单独挂在 header 之后。
    header = build_header(raw, rule_name, eff, meta_row)
    doc = ("<!DOCTYPE html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\n"
           "<title>%s</title>\n<style>html,body{margin:0;padding:0;background:#fff;}</style>\n"
           "</head>\n<body>\n"
           "<div class=\"rule-details\" style=\"%s\">\n%s\n"
           "<div class=\"rule-details-container\" style=\"%s\">\n"
           "<div class=\"ruleDetail-preview ruleDetail-preview-withToc\" style=\"%s\">\n"
           "<div data-cangjie-content=\"true\" data-zoom=\"1\" style=\"%s\">\n"
           "<div data-cangjie-editable=\"true\" style=\"%s\">\n%s\n"
           "</div></div></div></div>%s\n</div>\n</body></html>") % (
        html.escape(rule_name), rd_style, header, cont_style, prev_style,
        cc_style, ce_style, body, attachments_html)
    return doc


# --- 元数据行（复刻前台详情页"生效时间 / 文件组号 / ... / 查看历史版本"那行）---
# 风神 xtop 没有公开的"历史版本列表"接口（试了 21+6 个 action 全 404），
# 所以"查看历史版本"位置不显示"共 N 个版本"（不能编造），
# 而是显示**当前历史快照**的版本号 + 更新时间，让用户能识别"这是哪一版"。
META_FIELDS = [
    # 只用真正的生效时间字段；不再拿 updatedAt 兜底冒充（updatedAt 单独作为「更新时间」展示，
    # 两者语义不同，混在一起会让用户误以为拿到了生效时间）。
    ("生效时间",     lambda d: _trunc(d.get("effectiveStartTime") or d.get("effectiveEndTime")
                                       or d.get("publishStartTime"))),
    ("更新时间",     lambda d: _trunc(d.get("updatedAt"))),
    ("文件组号",     lambda d: (d.get("ruleSerialId") or "").strip()),
    ("文件类型",     lambda d: (d.get("ruleTypeDesc") or "").strip()),
    ("文件版本号",   lambda d: (d.get("ruleVesion") or "").strip()),
    ("查看历史版本", lambda d: "当前快照 v%s · %s" % ((d.get("ruleVesion") or "?"),
                                                       _trunc(d.get("updatedAt")))),
    ("文件发文部门", lambda d: (d.get("bizOwnerDept") or "").strip()),
    ("业务模块",     lambda d: (d.get("ruleCategoryName") or "").strip()),
    ("文件负责人",   lambda d: (d.get("bizOwnerName") or "").strip()),
]


def _trunc(v, n=10):
    if v is None:
        return ""
    return str(v)[:n]


def meta_pairs(data):
    """返回 [(label, value)]，**只含有值的字段**。

    风神 queryRuleInfo 只返回精简快照（见 MEMORY.md），文件类型 / 发文部门 /
    业务模块 / 文件负责人 / 生效时间等字段 key 存在但值恒为 null。
    这里统一「无值即跳过」，不再渲染成 '-' 占位，避免一排横线。

    注意：是**渲染时跳过**，不是从 META_FIELDS 里删掉 ——
    万一哪天接口给了值，无需改代码就会自动显示。

    HTML 与 Markdown 共用此函数，保证两处字段完全一致。
    """
    out = []
    for label, fn in META_FIELDS:
        v = (fn(data) or "").strip()
        if not v:
            continue
        out.append((label, v))
    return out


def build_meta_row(data):
    """元数据块：首个字段独占一行，其余横排。位置在标题区内、正文上方。"""
    pairs = meta_pairs(data)
    if not pairs:
        return ""
    first_label, first_val = pairs[0]
    eff_html = ('<div style="margin-bottom:6px;"><strong style="color:#555;">%s：</strong>%s</div>'
                % (html.escape(first_label), html.escape(first_val)))
    # 其余字段横排
    parts = []
    for label, v in pairs[1:]:
        parts.append('<span style="margin-right:18px;white-space:nowrap;">'
                     '<strong style="color:#555;">%s：</strong>%s</span>'
                     % (html.escape(label), html.escape(v)))
    # 无独立边框/背景：直接作为 header 内的一行文字，与标题共用 header 的 border-bottom
    return ('<div class="rule-details__meta" '
            'style="flex:0 0 100%%;margin-top:12px;padding:0;font-size:13px;'
            'color:#555;line-height:1.9;">'
            '%s<div>%s</div></div>') % (eff_html, "".join(parts))


# --- 附件区块（data.attachments 之前被完全忽略 → 现在追加在文档末尾）---
def _pad_left(style):
    """从 inline style 里取 padding-left 的 px 数值，取不到算 0。"""
    m = re.search(r"padding-left\s*:\s*(\d+)px", style or "")
    return int(m.group(1)) if m else 0


def build_attachments_html(data, indent=0):
    """附件区块（data.attachments 之前被完全忽略 → 现在追加在正文之后）。

    indent: 左缩进 px，由调用方按「正文容器 padding-left + 内容区 padding-left」算出，
            让附件与正文左边缘对齐（附件在正文容器之外，不补就会更靠左）。
    """
    atts = data.get("attachments") or []
    valid = [a for a in atts if a.get("url") and a.get("name")]
    if not valid:
        return ""
    items = "".join(
        '<li style="margin-bottom:6px;"><a href="%s" target="_blank" rel="noopener noreferrer" '
        'style="color:#1677ff;text-decoration:none;">%s</a></li>'
        % (html.escape(a["url"]), html.escape(a["name"]))
        for a in valid
    )
    # 无边框/无背景：作为正文之后的普通区块，与正文同一排版语言
    # （此前用的橙底 #fff8e6 + 边框是我自己编的，前台没有这个样式，已按"照搬前台"原则去掉）
    return ('<div class="rule-details__attachments" '
            'style="margin:16px %dpx 24px;padding:0;font-size:13px;'
            'color:#333;line-height:1.9;">'
            '<div style="font-weight:bold;margin-bottom:8px;">附件</div>'
            '<ul style="margin:0;padding-left:0;list-style:none;line-height:1.9;">%s</ul>'
            '</div>') % (indent, items)


_HEAD_MD = {"h1": "# ", "h2": "## ", "h3": "### ",
           "h4": "#### ", "h5": "##### ", "h6": "###### "}


def _md_lines(children):
    """把 Slate 顶层块转成 Markdown 行：标题加 # 前缀，表格按行用 | 分隔。"""
    out = []
    for ch in children or []:
        if not is_slate_node(ch):
            continue
        if ch[0] == "table":
            for tr in ch[2:]:
                if not is_slate_node(tr) or tr[0] != "tr":
                    continue
                cells = [_extract_text(tc[2:]).strip()
                         for tc in tr[2:] if is_slate_node(tc)]
                cells = [c for c in cells if c]
                if cells:
                    out.append(" | ".join(cells))
            continue
        line = _extract_text(ch[2:]).strip()
        if line:
            out.append(_HEAD_MD.get(ch[0], "") + line)
    return out


def build_markdown(data):
    """生成同名 .md：标题 + 生效时间 + 正文纯文本 + 元数据行 + 附件列表。

    规则正文是富文本（表格/加粗/字号/颜色），转 Markdown 必然丢排版，
    所以 md 定位为「可检索的纯文本副本」，完整排版以同名 .html 为准。
    """
    rule_name = data.get("ruleName") or "未命名规则"
    eff = (data.get("effectiveTime") or data.get("effectiveStartTime")
           or data.get("publishEndTime") or "")
    eff = (eff or "")[:10]
    try:
        tree = json.loads(data["ruleContent"])
    except (TypeError, ValueError) as e:
        raise RuntimeError("ruleContent 不是合法 JSON，无法生成 Markdown：%s" % e) from e
    lines = ["# %s" % rule_name, ""]
    if eff:
        lines += ["生效时间：%s" % eff, ""]
    lines += ["（正文完整排版详见同名 .html）", ""]

    # 元数据块在正文前（与 .html 一致：标题 → 元数据 → 正文）
    # 与 HTML 共用 meta_pairs()，空值字段直接跳过、不留 '-'
    _pairs = meta_pairs(data)
    if _pairs:
        lines += ["## 元数据", ""]
        lines += ["%s：%s" % (label, v) for label, v in _pairs]
        lines += [""]

    lines += _md_lines(tree[2:])

    # 附件列表保持在末尾（data.attachments 之前完全被忽略 → 现在追加）
    atts = [a for a in (data.get("attachments") or []) if a.get("url") and a.get("name")]
    if atts:
        lines += ["", "## 附件", ""]
        for a in atts:
            lines += ["- [%s](%s)" % (a["name"], a["url"])]

    return "\n".join(lines).rstrip() + "\n"


# 取数（RuleQueryError / query_rule）已迁到 get_data.ruledoc（单一来源；cookie 由调用方传入）。


# ==================== 执行节点（server 步进条按顺序跑）====================
NODES = [
    {"id": "login",  "name": "登录风神", "desc": "复用本地有效 cookie，失效才重新登录"},
    {"id": "query",  "name": "查询规则", "desc": "调 knight-rule-center 拿规则 JSON"},
    {"id": "build",  "name": "组装文档", "desc": "按 block_spec 渲染成 HTML"},
    {"id": "write",  "name": "写出 HTML", "desc": "写 rule_doc_<id>.html"},
]


def node_login(ctx):
    cookie, status = ensure_cookies()
    print("[cookie] %s" % status)
    ctx["cookie"] = cookie


def node_query(ctx):
    ctx["data"] = ruledoc.query_rule(ctx["rule"], ctx["history"], ctx["cookie"])


def node_build(ctx):
    raw = _read_refs()[0] if _read_refs() else ""
    spec = block_spec()
    ctx["doc"] = build_doc(ctx["data"], spec, raw)
    ctx["md"] = build_markdown(ctx["data"])


def node_write(ctx):
    out = os.path.join(OUT_DIR, "rule_doc_%d.html" % ctx["rule"])
    with open(out, "w", encoding="utf-8") as f:
        f.write(ctx["doc"])
    print("[save] %s (%d KB)" % (out, len(ctx["doc"].encode("utf-8")) // 1024))
    # outputs 里声明了同名 .md，必须真的写出来，否则产物面板缺项
    md = ctx.get("md")
    if not md:
        raise RuntimeError("build 节点未产出 markdown 内容，拒绝写出空 .md")
    md_out = os.path.join(OUT_DIR, "rule_doc_%d.md" % ctx["rule"])
    with open(md_out, "w", encoding="utf-8") as f:
        f.write(md)
    print("[save] %s (%d KB)" % (md_out, len(md.encode("utf-8")) // 1024))


for _n in NODES:
    _n["fn"] = {"login": node_login, "query": node_query,
                "build": node_build, "write": node_write}[_n["id"]]


def main():
    import nodeflow
    ap = argparse.ArgumentParser()
    ap.add_argument("--rule", type=int, required=True)
    ap.add_argument("--history", dest="history", action="store_true")
    ap.add_argument("--no-history", dest="history", action="store_false")
    ap.set_defaults(history=True)

    todo, err = nodeflow.prepare(NODES)   # 先摘掉 --begin/--end，再交给 argparse
    if err:
        print("✗ " + err)
        sys.exit(1)
    args = ap.parse_args()

    ctx = {"rule": args.rule, "history": args.history}
    sys.exit(nodeflow.execute(todo, ctx, title="[规则文档]"))


if __name__ == "__main__":
    main()
