# -*- coding: utf-8 -*-
"""量取全部任务卡片的宽度与横向位置，按分组逐个视图检查。"""
import json
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8909/"

JS = r"""
() => {
  const out = [];
  const cards = Array.from(document.querySelectorAll('#viewHost .card'));
  cards.forEach(c => {
    const q = s => c.querySelector(s);
    const r = el => el ? el.getBoundingClientRect() : null;
    const w = el => el ? Math.round(el.getBoundingClientRect().width) : 0;
    const x = el => el ? Math.round(el.getBoundingClientRect().left) : 0;
    const name = ((q('.c-t b')||{}).textContent || '?').trim();
    const nodes = Array.from(c.querySelectorAll('.nodes-hit')).map(w);
    const steps = Array.from(c.querySelectorAll('.nodes-hit')).map(n => {
        const p = n.parentElement; return p ? Math.round(p.getBoundingClientRect().width) : 0; });
    out.push({
      name,
      card: w(c), cardX: x(c),
      left: w(q('.card-left')),  leftX: x(q('.card-left')),
      mid:  w(q('.card-mid')),   midX:  x(q('.card-mid')),
      right: w(q('.card-right')),rightX: x(q('.card-right')),
      title: w(q('.c-t')), meta: w(q('.c-meta')),
      desc: w(q('.desc')), outs: w(q('.outs')),
      nodesW: nodes, stepW: steps,
      nodesWrap: w(q('.nodes-hit') ? q('.nodes-hit').parentElement.parentElement : null),
      conf: w(q('.btn-conf')), run: w(q('.btn-run')),
      acts: w(q('.card-actions')),
      ghost: w(q('.btn-ghost')),
      last: w(q('.last')), lastText: (q('.last')||{}).textContent ? q('.last').textContent.trim() : '',
    });
  });
  return out;
}
"""

def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1500, "height": 1000})
        pg.goto(URL, wait_until="domcontentloaded")
        pg.wait_for_timeout(2500)
        groups = pg.evaluate("() => state.groups.map(g => ({id:g.id, name:g.name}))")
        views = [{"id": "all", "name": "全部任务"}] + groups
        report = []
        for v in views:
            pg.evaluate("(gid) => { state.nav = {kind:'tasks', id:gid}; renderMain(); }", v["id"])
            pg.wait_for_timeout(250)
            report.append({"view": v, "cards": pg.evaluate(JS)})
        b.close()

    for sec in report:
        cards = sec["cards"]
        if not cards:
            continue
        print("\n" + "=" * 108)
        print("视图: %s   卡片数=%d" % (sec["view"]["name"], len(cards)))
        print("-" * 108)
        print("%-14s %5s %6s %6s %6s %6s | %5s %5s %5s %5s | %s" % (
            "任务", "card", "left", "mid", "right", "rightX", "conf", "run", "ghost", "acts", "节点宽(各)"))
        for c in cards:
            print("%-14s %5d %6d %6d %6d %6d | %5d %5d %5d %5d | %s" % (
                c["name"][:13], c["card"], c["left"], c["mid"], c["right"], c["rightX"],
                c["conf"], c["run"], c["ghost"], c["acts"],
                ",".join(str(x) for x in c["nodesW"])))
        # 差异检测
        for key in ("card", "left", "mid", "right", "rightX", "conf", "run", "ghost", "acts"):
            vals = sorted(set(c[key] for c in cards))
            if len(vals) > 1:
                print("  ❌ %s 不一致: %s" % (key, vals))
        allnodes = [x for c in cards for x in c["nodesW"]]
        if len(set(allnodes)) > 1:
            print("  ❌ 节点按钮宽度不一致: %s" % sorted(set(allnodes)))
    json.dump(report, open(r"E:\WorkBuddy\风神数据处理\server\_card_widths.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

main()
