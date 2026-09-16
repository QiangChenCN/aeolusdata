import sys
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8909/"
OUT = "_final_shots/badge_center.png"

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1366, "height": 900})
    msgs = []
    pg.on("console", lambda m: msgs.append(m.type + ": " + m.text))
    pg.on("pageerror", lambda e: msgs.append("PAGEERROR: " + str(e)))
    pg.goto(URL, wait_until="domcontentloaded")
    pg.wait_for_timeout(1500)
    # 切换到"全部任务"视图
    pg.evaluate("""() => {
        var el = [...document.querySelectorAll('.nav-item')].find(n => n.textContent.includes('全部任务'));
        if (el) el.click();
    }""")
    pg.wait_for_timeout(600)
    # 量第一张卡 c-t 与 c-meta 的几何，验证居中
    data = pg.evaluate("""() => {
        var cards = [...document.querySelectorAll('.card')];
        var r = [];
        cards.slice(0,9).forEach(c => {
            var ct = c.querySelector('.c-t');
            var cm = c.querySelector('.c-meta');
            if (!ct || !cm) return;
            var ctb = ct.getBoundingClientRect();
            var cmb = cm.getBoundingClientRect();
            // c-meta 相对 c-t 的左偏移是否让徽章居中
            var leftGap = cmb.left - ctb.left;
            var rightGap = (ctb.left+ctb.width) - (cmb.left+cmb.width);
            r.push({name: (c.querySelector('.c-t b')||{}).textContent, ctw: Math.round(ctb.width), cmw: Math.round(cmb.width), leftGap: Math.round(leftGap), rightGap: Math.round(rightGap)});
        });
        return r;
    }""")
    print("title vs meta centering (leftGap≈rightGap means centered):")
    for d in data:
        print("  ", d["name"], "| ctw=", d["ctw"], "cmw=", d["cmw"], "leftGap=", d["leftGap"], "rightGap=", d["rightGap"])
    # 截图：全部任务视图的首屏卡片
    pg.screenshot(path=OUT, clip={"x":0, "y":0, "width":1366, "height":900})
    print("console messages:", msgs if msgs else "none")
    b.close()
