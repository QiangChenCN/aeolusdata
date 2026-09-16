# -*- coding: utf-8 -*-
"""量取全部任务卡片的真实高度与内部各区块高度，按分组逐个视图检查。"""
import json, sys
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8909/"

JS = r"""
() => {
  const out = [];
  const cards = Array.from(document.querySelectorAll('#viewHost .card'));
  cards.forEach(c => {
    const q = s => c.querySelector(s);
    const h = el => el ? Math.round(el.getBoundingClientRect().height) : 0;
    const name = (q('.c-t b')||{}).textContent || '?';
    const desc = q('.desc'), outs = q('.outs'), note = q('.note'),
          nodes = c.querySelector('.nodes-hit') ? c.querySelector('.nodes-hit').closest('div') : null;
    const left = q('.card-left'), mid = q('.card-mid'), right = q('.card-right');
    const line = n => {
      const e = q(n);
      if(!e) return 0;
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return Math.round(r.height + parseFloat(cs.marginTop||0) + parseFloat(cs.marginBottom||0));
    };
    out.push({
      name: name.trim(),
      card: Math.round(c.getBoundingClientRect().height),
      cardBox: c.offsetHeight,
      left: h(left), mid: h(mid), right: h(right),
      title: h(q('.c-t b')), meta: h(q('.c-meta')),
      desc: h(desc), outs: h(outs), note: h(note),
      nodes: h(nodes),
      actions: h(q('.card-actions')),
      artBtn: h(q('.btn-ghost')),
      last: h(q('.last')),
      descText: desc ? desc.textContent.slice(0,40) : '',
      outsText: outs ? outs.textContent.slice(0,40) : '',
      descLines: desc ? Math.round(desc.getBoundingClientRect().height / parseFloat(getComputedStyle(desc).lineHeight||20)) : 0,
      top: Math.round(c.getBoundingClientRect().top),
    });
  });
  return out;
}
"""

def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1600, "height": 1000})
        pg.goto(URL, wait_until="domcontentloaded")
        pg.wait_for_timeout(2500)
        groups = pg.evaluate("() => state.groups.map(g => ({id:g.id, name:g.name}))")
        views = [{"id": "all", "name": "全部任务"}] + groups
        report = []
        for v in views:
            pg.evaluate("(gid) => { state.nav = {kind:'tasks', id:gid}; renderMain(); }", v["id"])
            pg.wait_for_timeout(250)
            cards = pg.evaluate(JS)
            report.append({"view": v, "cards": cards})
        # 也量首页（可能也有卡片）
        pg.evaluate("() => { state.nav = {kind:'home', id:''}; renderMain(); }")
        pg.wait_for_timeout(250)
        home = pg.evaluate(JS)
        report.append({"view": {"id": "home", "name": "首页"}, "cards": home})
        b.close()

    # 输出
    for sec in report:
        cards = sec["cards"]
        if not cards:
            continue
        hs = sorted(set(c["card"] for c in cards))
        print("\n" + "=" * 96)
        print("视图: %s   卡片数=%d   高度集合=%s  %s" % (
            sec["view"]["name"], len(cards), hs,
            "✅ 全等" if len(hs) == 1 else "❌ 不一致"))
        print("-" * 96)
        print("%-22s %5s %5s %5s %5s %5s %5s %5s %5s %5s" % (
            "任务", "card", "left", "mid", "right", "title", "meta", "desc", "outs", "nodes"))
        for c in cards:
            print("%-22s %5d %5d %5d %5d %5d %5d %5d %5d %5d" % (
                c["name"][:20], c["card"], c["left"], c["mid"], c["right"],
                c["title"], c["meta"], c["desc"], c["outs"], c["nodes"]))
        # 同行检测（top 相同视为同一行）
        rows = {}
        for c in cards:
            rows.setdefault(c["top"], []).append(c)
        for top, row in sorted(rows.items()):
            rh = sorted(set(x["card"] for x in row))
            if len(rh) > 1:
                print("  ⚠ 同一行 top=%d 高度不一致: %s" % (
                    top, [(x["name"][:14], x["card"]) for x in row]))
    json.dump(report, open(r"E:\WorkBuddy\风神数据处理\server\_card_heights.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("\n明细已写入 server/_card_heights.json")

main()
