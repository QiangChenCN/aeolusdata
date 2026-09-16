from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8909/"
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1366, "height": 900, "deviceScaleFactor": 2})
    pg.goto(URL, wait_until="domcontentloaded")
    pg.wait_for_timeout(1500)
    pg.evaluate("""() => { var el=[...document.querySelectorAll('.nav-item')].find(n=>n.textContent.includes('全部任务')); if(el) el.click(); }""")
    pg.wait_for_timeout(600)
    data = pg.evaluate("""() => {
        var block = document.querySelector('.nodes-block');
        var track = block.querySelector('.nodes-track');
        var step = block.querySelector('.nodes-step');
        var dot = block.querySelector('.nodes-dot');
        var cs = getComputedStyle(track);
        function r(e){var b=e.getBoundingClientRect();return {top:Math.round(b.top),bottom:Math.round(b.bottom),h:Math.round(b.height)};}
        return {
            blockOverflowY: getComputedStyle(block).overflowY,
            trackOverflowY: cs.overflowY, trackOverflowX: cs.overflowX,
            block: r(block), track: r(track), step: r(step), dot: r(dot),
            dotTopVsTrackTop: Math.round(dot.getBoundingClientRect().top - track.getBoundingClientRect().top),
            stepPadTop: getComputedStyle(step).paddingTop,
            blockPadTop: getComputedStyle(block).paddingTop,
            sp10: getComputedStyle(block).paddingTop
        };
    }""")
    print(data)
    # 截图放大第一个节点
    box = pg.evaluate("""() => { var d=document.querySelector('.nodes-dot'); var b=d.getBoundingClientRect(); return {x:b.x-20,y:b.y-20,w:b.width+40,h:b.height+40}; }""")
    nb = pg.evaluate("""() => { var n=document.querySelector('.nodes-block'); var b=n.getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height}; }""")
    pg.screenshot(path="_final_shots/dot_zoom.png", clip=nb)
    b.close()
