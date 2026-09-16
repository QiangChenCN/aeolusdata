# -*- coding: utf-8 -*-
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1500, "height": 1400}, device_scale_factor=2)
    errs = []
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
    pg.goto("http://127.0.0.1:8909/", wait_until="domcontentloaded")
    pg.wait_for_timeout(2500)
    pg.evaluate("() => { state.nav = {kind:'tasks', id:'all'}; renderMain(); }")
    pg.wait_for_timeout(400)
    pg.screenshot(path=r"E:\WorkBuddy\风神数据处理\server\_final_shots\cards_all.png", full_page=True)
    # 节点名是否被截断、last 是否单行
    data = pg.evaluate("""() => Array.from(document.querySelectorAll('#viewHost .card')).map(c => {
        const nm = Array.from(c.querySelectorAll('.nodes-name')).map(n => ({t:n.textContent.trim(),
                clip: n.scrollWidth > n.clientWidth + 1}));
        const l = c.querySelector('.last');
        const ls = l ? l.querySelector('span') : null;
        return {name: c.querySelector('.c-t b').textContent.trim(),
                nodes: nm,
                last: l ? l.textContent.trim() : '(无)',
                lastClip: ls ? (ls.scrollWidth > ls.clientWidth + 1) : null};
    })""")
    print("console errors:", errs or "none")
    for d in data:
        clips = [n["t"] for n in d["nodes"] if n["clip"]]
        print("  %-14s 节点截断=%s | last=%s 截断=%s" % (
            d["name"], clips or "无", d["last"][:30], d["lastClip"]))
    b.close()
