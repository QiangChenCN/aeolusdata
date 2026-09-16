# -*- coding: utf-8 -*-
"""设计令牌自检脚本。

改完 tokens.css / index.html 后跑一遍，确认视觉取值没有漂移。

做的四件事：
  1. 未定义令牌扫描 —— 页面里所有 var(--x) 都能在 tokens.css 里找到定义
  2. 裸值残留统计   —— 还剩多少硬编码色值 / px
  3. 层级合规检查   —— 全屏浮层只能走 --z-* 令牌；--z-confirm 必须是最高可交互层
  4. 等价性比对     —— 把 var() 递归解析回字面量，与基线 CSS 逐条规则对比

用法：
    python check_tokens.py                      # 只跑 1、3（不需要基线）
    python check_tokens.py --baseline <旧.html> # 再跑 2（需要改造前的页面副本）

退出码：0 = 全部通过；1 = 有差异，需要人工确认。
"""
import argparse
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)   # 仓库根目录（server/ 的上一级）：实际页面在根 index.html，令牌在 web/tokens.css
INDEX_HTML = os.path.join(ROOT, "index.html")
TOKENS_CSS = os.path.join(ROOT, "web", "tokens.css")

# 改造过程中改过名的令牌：旧名 -> 新名。比对时按改名后的名字核对取值。
RENAMES = {
    "--radius": "--r-card",
    "--shadow-lg": "--shadow-2",
    "--shadow": "--shadow-1",
    "--hd": "--layout-hd",
    "--side": "--layout-side",
    "--mono": "--font-mono",
}


def read(path):
    with io.open(path, "r", encoding="utf-8") as f:
        return f.read()


def style_block(html):
    m = re.search(r"<style[^>]*>(.*?)</style>", html, re.S)
    return m.group(1) if m else ""


def strip_comments(css):
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def parse_root(css):
    """抽出 :root{...} 里的自定义属性定义。"""
    out = {}
    for m in re.finditer(r":root\s*\{(.*?)\}", strip_comments(css), re.S):
        for decl in m.group(1).split(";"):
            if ":" not in decl:
                continue
            k, v = decl.split(":", 1)
            k = k.strip()
            if k.startswith("--"):
                out[k] = v.strip()
    return out


def parse_local(css):
    """抽出「块内局部自定义属性」定义（如 .nodes-block{--ndot:16px}）。

    这类令牌只在某个组件内部用、且常带窄屏覆盖，塞进 tokens.css 反而把全局命名空间弄脏，
    所以允许就地定义；这里单独统计，不计入「未定义」，但仍然会列出来供人工过目。
    """
    out = {}
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", strip_comments(css), re.S):
        head = m.group(1).strip().split("\n")[-1].strip()
        if not head or head.startswith("@") or head == ":root":
            continue
        for decl in m.group(2).split(";"):
            if ":" not in decl:
                continue
            k, v = decl.split(":", 1)
            k = k.strip()
            if k.startswith("--"):
                out[k] = v.strip()
    return out


def resolve(value, varmap, depth=0):
    """把 value 里的 var(--x[, fallback]) 递归替换成最终字面量。"""
    if depth > 20:
        return value

    def one(mo):
        name, fallback = mo.group(1), mo.group(2)
        if name in varmap:
            return resolve(varmap[name], varmap, depth + 1)
        if fallback:
            return resolve(fallback.strip(), varmap, depth + 1)
        return "<<UNDEF:%s>>" % name

    new = re.sub(r"var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*?))?\)", one, value)
    return new if new == value else resolve(new, varmap, depth + 1)


def parse_rules(css, media=""):
    """解析成 [(media上下文, 选择器, {属性: 值}), ...]。@media 内的规则带上下文前缀。"""
    css = strip_comments(css)
    rules, buf, i, n = [], "", 0, len(css)
    while i < n:
        if css[i] == "{":
            head = buf.strip()
            depth, j = 1, i + 1
            while j < n and depth:
                if css[j] == "{":
                    depth += 1
                elif css[j] == "}":
                    depth -= 1
                j += 1
            body = css[i + 1:j - 1]
            if head.startswith("@media"):
                rules.extend(parse_rules(body, media=head + " >> "))
            elif head.startswith("@") or head == ":root":
                pass  # @keyframes 与变量定义单独处理
            else:
                decls = {}
                for d in body.split(";"):
                    if ":" not in d:
                        continue
                    k, v = d.split(":", 1)
                    k = k.strip()
                    if k and not k.startswith("--"):
                        decls[k] = " ".join(v.split())
                if decls:
                    rules.append((media, " ".join(head.split()), decls))
            buf, i = "", j
            continue
        buf += css[i]
        i += 1
    return rules


def check_layers(css, varmap):
    """层级合规检查（tokens.css 第 21 节「层级宪法」的自动校验）。

    两条硬规则：
      A. 全屏浮层（position:fixed）的 z-index 只能写 var(--z-*)，
         禁止裸数字、禁止 calc(var(--z-x) + n) 这类就地偏移；
         非 fixed 的局部层叠（sticky 表头、卡片高亮条）只要求是整数即可。
      B. --z-confirm 必须严格高于除 --z-toast 之外的所有层 ——
         危险确认弹窗可能从任意弹窗内弹出，必须是全局最高的可交互层。
    """
    bad, rows = [], []

    for media, sel, decls in parse_rules(css):
        z = decls.get("z-index")
        if not z:
            continue
        pos = decls.get("position", "")
        label = "%s%s" % (media, sel)
        if pos == "fixed":
            ok = re.fullmatch(r"var\(--z-[\w-]+\)", z) is not None
            if not ok:
                bad.append("%s { z-index:%s } —— 全屏浮层必须用 --z-* 令牌，"
                           "禁止裸值/calc 偏移" % (label, z))
            else:
                rows.append((label, z))
        else:
            if not re.fullmatch(r"-?\d+|var\(--z-[\w-]+\)", z):
                bad.append("%s { z-index:%s } —— 局部层叠只接受整数或 --z-* 令牌" % (label, z))

    zmap = {}
    for name, raw in varmap.items():
        if not name.startswith("--z-"):
            continue
        val = resolve(raw, varmap).strip()
        m = re.fullmatch(r"(-?\d+)", val)
        if not m:
            bad.append("%s 的值 %r 不是整数" % (name, val))
            continue
        zmap[name] = int(m.group(1))

    confirm = zmap.get("--z-confirm")
    toast = zmap.get("--z-toast")
    if confirm is None:
        bad.append("缺少 --z-confirm 令牌")
    else:
        for name, val in sorted(zmap.items(), key=lambda kv: kv[1]):
            if name in ("--z-confirm", "--z-toast"):
                continue
            if val >= confirm:
                bad.append("%s=%d 不低于 --z-confirm=%d，确认弹窗会被它盖住"
                           % (name, val, confirm))
        if toast is not None and toast <= confirm:
            bad.append("--z-toast=%d 必须高于 --z-confirm=%d" % (toast, confirm))

    return bad, rows


def hr(title):
    print("\n" + "=" * 68)
    print("  " + title)
    print("=" * 68)


def main():
    ap = argparse.ArgumentParser(description="设计令牌自检")
    ap.add_argument("--baseline", help="改造前的 index.html 副本，用于等价性比对")
    ap.add_argument("--index", default=INDEX_HTML)
    ap.add_argument("--tokens", default=TOKENS_CSS)
    args = ap.parse_args()

    html = read(args.index)
    tokens = read(args.tokens)
    css = style_block(html)
    varmap = parse_root(tokens)
    localmap = parse_local(css)   # 组件内就地定义的局部令牌（不入 :root）

    problems = []

    # ---------- 1. 未定义令牌扫描 ----------
    hr("1. 未定义令牌扫描")
    refs = set(re.findall(r"var\(\s*(--[\w-]+)", html))
    known = set(varmap) | set(localmap)
    undef = sorted(r for r in refs if r not in known)
    locals_used = sorted(r for r in refs if r in localmap and r not in varmap)
    print("  tokens.css 定义令牌 : %d 个" % len(varmap))
    print("  组件内局部令牌     : %d 个%s" % (
        len(localmap), ("（" + ", ".join(sorted(localmap)) + "）") if localmap else ""))
    print("  页面引用令牌       : %d 个" % len(refs))
    print("  引用了局部令牌     : %s" % (", ".join(locals_used) if locals_used else "无"))
    print("  引用但未定义       : %s" % (", ".join(undef) if undef else "无"))
    if undef:
        problems.append("存在未定义令牌：%s" % ", ".join(undef))

    # ---------- 3. 裸值残留统计 ----------
    hr("2. 裸值残留统计（style 块）")
    body_no_media = "\n".join(l for l in strip_comments(css).split("\n")
                              if "@media" not in l)
    hexes = re.findall(r"#[0-9a-fA-F]{3,8}\b", css)
    bare_px = re.findall(r"([a-z-]+)\s*:\s*[^;{}]*?\b\d+px\b", body_no_media)
    print("  硬编码色值  : %s" % (", ".join(sorted(set(hexes))) if hexes else "无"))
    print("  裸 px 声明  : %d 处" % len(bare_px))
    if hexes:
        problems.append("style 块仍有 %d 处硬编码色值" % len(set(hexes)))

    # ---------- 3. 层级合规 ----------
    hr("3. 层级合规（全屏浮层 / 确认层必须是最高可交互层）")
    layer_bad, layer_rows = check_layers(css, varmap)
    for label, z in layer_rows:
        print("    %-46s %s" % (label[:46], z))
    print("  --z-* 令牌：%s" % ", ".join(
        "%s=%s" % (k, resolve(v, varmap))
        for k, v in sorted(varmap.items(),
                           key=lambda kv: int(re.search(r"-?\d+", resolve(kv[1], varmap)).group(0))
                           if re.search(r"-?\d+", resolve(kv[1], varmap)) else 0)
        if k.startswith("--z-")))
    print("  层级违规   : %s" % ("无" if not layer_bad else ""))
    for b in layer_bad:
        print("      ! %s" % b)
    if layer_bad:
        problems.append("%d 处层级违规" % len(layer_bad))

    # ---------- 4. 等价性比对 ----------
    if not args.baseline:
        hr("4. 等价性比对")
        print("  未指定 --baseline，跳过。")
        print("  如需比对：python check_tokens.py --baseline <改造前的 index.html>")
    else:
        hr("4. 等价性比对（对照 %s）" % os.path.basename(args.baseline))
        before_vars = parse_root(style_block(read(args.baseline)))
        undef_hit = set()

        def res(v, vm):
            out = resolve(v, vm)
            for m in re.finditer(r"<<UNDEF:(--[\w-]+)>>", out):
                undef_hit.add(m.group(1))
            return out

        def collect(css_text, vm):
            d = {}
            for media, sel, decls in parse_rules(css_text):
                key = (media, sel)
                d.setdefault(key, {}).update(
                    {k: res(v, vm) for k, v in decls.items()})
            return d

        db = collect(style_block(read(args.baseline)), before_vars)
        da = collect(css, varmap)

        only_b = sorted(set(db) - set(da))
        only_a = sorted(set(da) - set(db))
        diffs = []
        for k in sorted(set(db) & set(da)):
            for prop in sorted(set(db[k]) | set(da[k])):
                bv, av = db[k].get(prop), da[k].get(prop)
                if bv != av:
                    diffs.append((k, prop, bv, av))

        print("  规则组数   before=%d   after=%d" % (len(db), len(da)))
        print("  声明总数   before=%d   after=%d" % (
            sum(len(v) for v in db.values()), sum(len(v) for v in da.values())))
        print("  未解析令牌 : %s" % (", ".join(sorted(undef_hit)) or "无"))
        print("  仅 before 有 : %d 个选择器" % len(only_b))
        for k in only_b[:10]:
            print("      - %s%s" % k)
        print("  仅 after 有  : %d 个选择器" % len(only_a))
        for k in only_a[:10]:
            print("      + %s%s" % k)
        print("  取值变化     : %d 处" % len(diffs))
        for k, prop, bv, av in diffs[:40]:
            print("      %s%s { %s }" % (k[0], k[1], prop))
            print("          before: %s" % bv)
            print("          after : %s" % av)

        if undef_hit:
            problems.append("有 var() 未解析：%s" % ", ".join(sorted(undef_hit)))
        if only_b or only_a:
            problems.append("选择器集合发生变化（+新增 %d / -消失 %d）"
                            % (len(only_a), len(only_b)))
        if diffs:
            problems.append("%d 处声明取值发生变化，需逐条确认是否为有意改动"
                            % len(diffs))

        # 改名令牌取值核对
        print("\n  改名令牌取值核对：")
        for old, new in RENAMES.items():
            if old not in before_vars:
                continue
            ov = res("var(%s)" % old, before_vars)
            nv = res("var(%s)" % new, varmap)
            flag = "OK " if ov == nv else "差异"
            print("    [%s] %-14s -> %-16s  %s" % (flag, old, new, ov))
            if ov != nv:
                problems.append("改名后取值变了：%s -> %s" % (old, new))

        # 语义色取值核对
        shared = [k for k in before_vars
                  if k in varmap and not k.startswith(("--c-",))]
        bad = 0
        for s in sorted(shared):
            ov = res("var(%s)" % s, before_vars)
            nv = res("var(%s)" % s, varmap)
            if ov != nv:
                bad += 1
                print("    [差异] %-14s before=%-22s after=%s" % (s, ov, nv))
        print("\n  同名令牌 %d 个，取值差异 %d 个" % (len(shared), bad))
        if bad:
            problems.append("%d 个同名令牌取值发生变化" % bad)

    # ---------- 结论 ----------
    hr("结论")
    if not problems:
        print("  全部通过：无未定义令牌、无裸色值、取值与基线一致。")
        return 0
    print("  发现 %d 项需要确认：" % len(problems))
    for i, p in enumerate(problems, 1):
        print("    %d. %s" % (i, p))
    return 1


if __name__ == "__main__":
    sys.exit(main())
