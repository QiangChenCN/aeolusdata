/* 首页 · 数据大屏
   —— 原首页（Hero / 服务状态 / 任务概览 / 快捷任务 / 今日待办 / 最近运行 / 分组总览）已全部移除，
   改为按「大屏」组织的运单数据看板：
     · KPI 巨字带：接单总量 / 配送完成量 / 完成率 / 有效单量
     · 站点对比：条形长度 = 接单量，深色段 = 其中配送完成的部分
     · 日趋势：逐日对比接单量与配送完成量（纯 CSS 柱，不引图表库）
     · 站点明细表：站点 × 接单量 / 完成量 / 完成率 / 有效单量 / 有效占比
   数据来自 GET /api/overview/site-orders（后端 site_orders.py，口径单一来源 order_rules：
   归属日 = 骑手接单时间的北京时间自然日，跨午夜单归接单当天）。 */
import { api } from "./api.js";
import { esc, viewHead } from "./ui.js";
import { TK } from "./tokens.js";
import "./home-screen.css";

/* 通用骨架屏：其它视图（任务中心等）也在用，保留导出 */
export function skeletonCards(host, n){
  host.innerHTML = "";
  for(var i=0;i<n;i++){
    var sk = document.createElement("div");
    sk.className = "skeleton sk-card";
    host.appendChild(sk);
  }
}

/* ---------- 区间选择（模块级：切视图后保持；同一会话内结果按区间缓存，切回不重复请求） ---------- */
var RANGES = [
  { k:"today", label:"今日",    days:1  },
  { k:"7d",    label:"近 7 天",  days:7  },
  { k:"14d",   label:"近 14 天", days:14 }
];
var _rangeKey = "7d";
var _cache = {};      // 已完成结果：区间 key -> 响应
var _inflight = {};   // 进行中请求：启动期会连续重绘多次，同区间必须复用同一个请求
                      //（否则每次重绘都触发一次全量聚合 —— 服务端要重读 24 个大 JSON，首屏也被拖慢）

function ymd(d){
  var p = function(n){ return (n<10?"0":"")+n; };
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());
}
function rangeOf(k){
  var r = RANGES.filter(function(x){ return x.k===k; })[0] || RANGES[1];
  var end = new Date();
  var start = new Date(end.getTime() - (r.days-1)*86400000);
  return { start: ymd(start), end: ymd(end), label: r.label, days: r.days };
}
function fmt(n){
  if(n === null || n === undefined) return "—";
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function pct(x){
  if(x === null || x === undefined) return "—";
  return (x*100).toFixed(1)+"%";
}
function rateCls(x){
  if(x === null || x === undefined) return "";
  return x >= 0.97 ? "" : (x >= 0.9 ? "low" : "bad");
}

/* ---------- 入口（renderMain 每次重绘都会调用；数据有缓存就直出，避免刷新风暴重复取数） ---------- */
export function renderHomeView(host){
  host.appendChild(viewHead("数据大屏",
    "运单概览 · 按站点汇总接单量与配送完成量（归属口径：骑手接单时间的北京时间自然日）",
    "layers", TK.brand, ""));
  var root = document.createElement("div");
  root.className = "scr";
  host.appendChild(root);
  draw(root);
}

function draw(root){
  root.innerHTML = "";
  root.appendChild(toolbar(root));
  var mount = document.createElement("div");
  mount.style.cssText = "display:flex;flex-direction:column;gap:16px";
  root.appendChild(mount);

  var rg = rangeOf(_rangeKey);
  var key = rg.start + "_" + rg.end;
  if(_cache[key]){ paint(mount, _cache[key]); return; }

  if(!_inflight[key]){
    _inflight[key] = api("/api/overview/site-orders?start="+rg.start+"&end="+rg.end)
      .then(function(j){
        if(j && j.ok) _cache[key] = j;
        _inflight[key] = null;
        return j;
      })
      .catch(function(e){
        _inflight[key] = null;
        throw e;
      });
  }
  mount.innerHTML = '<div class="scr-panel"><div class="scr-empty">正在汇总运单数据…</div></div>';
  _inflight[key].then(function(j){
    if(!document.contains(mount)) return;          // 期间视图已重绘 → 丢弃；新视图会复用同一请求再画
    if(!j || !j.ok){
      mount.innerHTML = '<div class="scr-panel"><div class="scr-empty">加载失败：'+esc((j && j.error) || "未知错误")+'</div></div>';
      return;
    }
    paint(mount, j);
  }).catch(function(e){
    if(!document.contains(mount)) return;
    mount.innerHTML = '<div class="scr-panel"><div class="scr-empty">加载失败：'+esc(String(e))+'</div></div>';
  });
}

/* ---------- 工具条 ---------- */
function toolbar(root){
  var bar = document.createElement("div"); bar.className = "scr-bar";
  var seg = document.createElement("div"); seg.className = "scr-seg";
  RANGES.forEach(function(r){
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = r.label;
    if(r.k === _rangeKey) b.className = "on";
    b.onclick = function(){ if(_rangeKey === r.k) return; _rangeKey = r.k; draw(root); };
    seg.appendChild(b);
  });
  bar.appendChild(seg);
  var rg = rangeOf(_rangeKey);
  var meta = document.createElement("div"); meta.className = "scr-meta";
  meta.innerHTML = '统计区间 <b>'+esc(rg.start)+' ~ '+esc(rg.end)+'</b>（'+rg.days+' 天）'+
                   '<br><span class="scr-warn">跨午夜的运单归到「接单当天」，不会被两天各计一次</span>';
  bar.appendChild(meta);
  return bar;
}

/* ---------- 面板小工具 ---------- */
function panel(title, hint, right){
  var el = document.createElement("div"); el.className = "scr-panel";
  var t = document.createElement("div"); t.className = "scr-pt";
  t.innerHTML = esc(title) + (right ? '<span class="hp">'+esc(right)+'</span>' : "");
  el.appendChild(t);
  if(hint){
    var h = document.createElement("div"); h.className = "scr-ph";
    h.textContent = hint;
    el.appendChild(h);
  }
  var body = document.createElement("div");
  el.appendChild(body);
  return { el: el, body: body };
}

/* ---------- 组装 ---------- */
function paint(mount, j){
  mount.innerHTML = "";
  var sites = j.sites || [];
  if(!sites.length){
    mount.innerHTML = '<div class="scr-panel"><div class="scr-empty">区间内没有可用数据：请先在「标准达成 → 全量刷新」拉取运单明细后再看大屏。</div></div>';
    return;
  }
  mount.appendChild(kpiCards(j));
  var two = document.createElement("div"); two.className = "scr-panels";
  two.appendChild(siteBars(j));
  two.appendChild(trendPanel(j));
  mount.appendChild(two);
  mount.appendChild(siteTable(j));
  mount.appendChild(notePanel(j));
}

function kpiCards(j){
  var t = j.totals || {};
  var g = document.createElement("div"); g.className = "scr-kpis";
  g.appendChild(kpi("接单总量", fmt(t.accepted), "单", "", "区间内归属的运单条数"));
  g.appendChild(kpi("配送完成量", fmt(t.completed), "单", "ok", "完成率 "+pct(t.complete_rate)));
  g.appendChild(kpi("完成率", pct(t.complete_rate), "", "cyan", "配送完成量 / 接单量"));
  g.appendChild(kpi("有效单量", fmt(t.valid), "单", "warn",
    "占接单 "+pct(t.valid_rate)+"（完成 · 非作弊 · 非逆向 · 非改派）"));
  return g;
}

function kpi(label, val, unit, tone, sub){
  var d = document.createElement("div");
  d.className = "scr-kpi" + (tone ? " "+tone : "");
  d.innerHTML = '<div class="k">'+esc(label)+'</div>'+
    '<div class="v">'+esc(val)+(unit ? '<small>'+esc(unit)+'</small>' : '')+'</div>'+
    '<div class="s">'+esc(sub)+'</div>';
  return d;
}

/* 站点对比：条形长度 = 接单量，深色段 = 其中已配送完成的部分 */
function siteBars(j){
  var p = panel("站点对比", "条形长度 = 接单量；深色段为其中「配送完成」的部分", "按接单量排序");
  var wrap = document.createElement("div"); wrap.className = "scr-bars";
  var max = Math.max.apply(null, j.sites.map(function(s){ return s.accepted; }).concat([1]));
  j.sites.forEach(function(s){
    var wAcc = Math.max(0, s.accepted/max*100);
    var wDone = s.accepted ? (s.completed/s.accepted*wAcc) : 0;
    var row = document.createElement("div"); row.className = "scr-bar-row";
    row.innerHTML =
      '<div class="h"><span class="nm">'+esc(s.team_name)+'</span>'+
        '<span class="sum">接单 <b>'+fmt(s.accepted)+'</b> · 完成 <b>'+fmt(s.completed)+'</b> · '+pct(s.complete_rate)+'</span></div>'+
      '<div class="scr-track">'+
        '<div class="scr-fill" style="width:'+wDone.toFixed(2)+'%"></div>'+
        '<div class="scr-fill rest" style="width:'+Math.max(0, wAcc-wDone).toFixed(2)+'%"></div>'+
      '</div>';
    wrap.appendChild(row);
  });
  p.body.appendChild(wrap);
  return p.el;
}

/* 日趋势：逐日柱状（跨站点求和），双色对比接单 / 完成 */
function trendPanel(j){
  var p = panel("日趋势", "每一天汇总所有站点，对比接单量与配送完成量", (j.range ? j.range.days : 0)+" 天");
  var byDate = {};
  (j.sites || []).forEach(function(s){
    (s.daily || []).forEach(function(d){
      var a = byDate[d.date] || (byDate[d.date] = { date:d.date, accepted:0, completed:0 });
      a.accepted += d.accepted;
      a.completed += d.completed;
    });
  });
  var days = Object.keys(byDate).sort().map(function(k){ return byDate[k]; });
  if(!days.length){
    p.body.innerHTML = '<div class="scr-empty">区间内没有日粒度数据</div>';
    return p.el;
  }
  var max = Math.max.apply(null, days.map(function(d){ return d.accepted; }).concat([1]));
  var wrap = document.createElement("div"); wrap.className = "scr-trend";
  days.forEach(function(d){
    var col = document.createElement("div"); col.className = "scr-day";
    col.title = d.date + "：接单 " + fmt(d.accepted) + " · 完成 " + fmt(d.completed);
    col.innerHTML =
      '<div class="cols">'+
        '<div class="c" style="height:'+Math.max(2, d.accepted/max*100).toFixed(1)+'%"></div>'+
        '<div class="c done" style="height:'+Math.max(2, d.completed/max*100).toFixed(1)+'%"></div>'+
      '</div>'+
      '<div class="d">'+esc(d.date.slice(5))+'</div>';
    wrap.appendChild(col);
  });
  p.body.appendChild(wrap);
  var lg = document.createElement("div"); lg.className = "scr-legend";
  lg.innerHTML = '<span><i style="background:var(--brand,#FF5000)"></i>接单量</span>'+
                 '<span><i style="background:var(--cyan,#0891B2)"></i>配送完成量</span>';
  p.body.appendChild(lg);
  return p.el;
}

/* 站点明细表 */
function siteTable(j){
  var p = panel("站点明细", "完成率 = 配送完成量 / 接单量；有效单量沿用项目口径（完成 · 非作弊 · 非逆向 · 非改派）");
  var rows = (j.sites || []).map(function(s){
    return '<tr>'+
      '<td><span class="nm">'+esc(s.team_name)+'</span><span class="id">'+esc(s.team_id)+'</span></td>'+
      '<td>'+fmt(s.accepted)+'</td>'+
      '<td>'+fmt(s.completed)+'</td>'+
      '<td><span class="scr-rate '+rateCls(s.complete_rate)+'">'+
        '<span class="track"><i style="width:'+Math.max(0, Math.min(100, (s.complete_rate||0)*100)).toFixed(1)+'%"></i></span>'+
        pct(s.complete_rate)+'</span></td>'+
      '<td>'+fmt(s.valid)+'</td>'+
      '<td>'+pct(s.valid_rate)+'</td>'+
      '<td>'+(s.days||0)+'</td>'+
    '</tr>';
  }).join("");
  var t = j.totals || {};
  var w = document.createElement("div"); w.className = "scr-tbl-wrap";
  w.innerHTML =
    '<table class="scr-tbl">'+
      '<thead><tr><th>站点</th><th>接单量</th><th>配送完成量</th><th>完成率</th>'+
        '<th>有效单量</th><th>有效占比</th><th>天数</th></tr></thead>'+
      '<tbody>'+rows+'</tbody>'+
      '<tfoot><tr><td>合计</td><td>'+fmt(t.accepted)+'</td><td>'+fmt(t.completed)+'</td>'+
        '<td>'+pct(t.complete_rate)+'</td><td>'+fmt(t.valid)+'</td><td>'+pct(t.valid_rate)+'</td><td>—</td></tr></tfoot>'+
    '</table>';
  p.body.appendChild(w);
  return p.el;
}

/* 数据状态：来源 / 截止时间 / 缺口（如实提示，别让空白显得像 0 单） */
function notePanel(j){
  var p = panel("数据状态", "", "");
  var miss = j.missing_count || 0;
  p.body.innerHTML = '<div class="scr-note">'+
    '数据来源：<b>本地运单明细缓存</b>（dashboard/data/orders_&lt;站点&gt;_&lt;日期&gt;.json，由「标准达成 → 全量刷新」落盘）<br>'+
    '最新落盘：<b>'+esc(j.cached_at || "—")+'</b>　·　参与汇总站点：<b>'+((j.totals||{}).sites||0)+'</b> 个'+
    (miss ? '<br><span class="scr-warn">区间内有 '+miss+' 个「站点 × 日期」没有缓存，未参与求和（不代表 0 单）</span>' : '')+
    '</div>';
  return p.el;
}
