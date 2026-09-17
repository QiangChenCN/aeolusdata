/* 考核结算大屏
   —— 城市/区域运营管理者视角：今日实时为主视图，嵌入历史对比(环比) + 阈值红黄灯预警。
   数据来自 GET /api/overview/assessment（后端 assessment_overview，只读 dashboard/data 三源缓存，
   与「标准达成」「时段出勤」同源、口径零漂移；手动「刷新数据」触发实时落盘后本大屏重算）。
   图表：标准1~5 堆叠条 / 时段出勤热力(复用时段出勤进程缓存) 用 CSS；服务质量雷达、历史趋势用内联 SVG，
   不引第三方图表库（与首页大屏一致，首屏零额外依赖）。 */
import { api } from "./api.js";
import { esc, viewHead, toast } from "./ui.js";
import { TK } from "./tokens.js";
import "./assessment.css";

var RANGES = [{ k: "today", label: "今日" }];
var _cache = {};        // date -> 响应
var _inflight = null;

/* ---------- 工具 ---------- */
function ymd(d){ var p = function(n){ return (n < 10 ? "0" : "") + n; }; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }
function fmt(n){ if(n === null || n === undefined) return "—"; return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function pct(v){ if(v === null || v === undefined) return "—"; return (Math.round(v * 10) / 10) + "%"; }
function pct1(v){ if(v === null || v === undefined) return "—"; return (Math.round(v * 100) / 100) + "%"; }
function rateCls(x, red, yellow, higher){
  if(x === null || x === undefined) return "";
  if(higher){ return x < red ? "red" : (x < yellow ? "yellow" : "ok"); }
  return x > red ? "red" : (x > yellow ? "yellow" : "ok");
}

/* 嵌入渲染（不带 viewHead）：供首页直接作为主视图调用，复用同一套逻辑。 */
export function renderAssessmentInto(host){
  var root = document.createElement("div");
  root.className = "asm";
  host.appendChild(root);
  draw(root);
}

export function renderAssessmentView(host){
  host.appendChild(viewHead("考核结算大屏",
    "城市/区域运营管理者视角 · 今日实时达成 + 历史对比(环比) + 红黄灯预警 · 数据源：本地运单/排班/考勤缓存",
    "shield-alert", TK.brand, ""));
  renderAssessmentInto(host);
}

function draw(root){
  root.innerHTML = "";
  var bar = toolbar(root);
  root.appendChild(bar);
  var date = ymd(new Date());
  if(_cache[date]){ paint(root, _cache[date]); return; }
  if(!_inflight){
    _inflight = api("/api/overview/assessment?date=" + date)
      .then(function(j){ if(j && j.ok) _cache[date] = j; _inflight = null; return j; })
      .catch(function(e){ _inflight = null; throw e; });
  }
  var mount = document.createElement("div");
  mount.className = "asm-body";
  mount.style.cssText = "display:flex;flex-direction:column;gap:var(--scr-gap)";
  root.appendChild(mount);
  mount.innerHTML = '<div class="scr-panel"><div class="scr-empty">正在聚合考核结算数据…</div></div>';
  _inflight.then(function(j){
    if(!document.contains(mount)) return;
    if(!j || !j.ok){ mount.innerHTML = '<div class="scr-panel"><div class="scr-empty">加载失败：' + esc((j && j.error) || "未知错误") + '</div></div>'; return; }
    paint(root, j);
  }).catch(function(e){
    if(!document.contains(mount)) return;
    mount.innerHTML = '<div class="scr-panel"><div class="scr-empty">加载失败：' + esc(String(e)) + '</div></div>';
  });
}

function toolbar(root){
  var date = ymd(new Date());
  var bar = document.createElement("div"); bar.className = "asm-bar";
  var btn = document.createElement("button"); btn.className = "bt"; btn.textContent = "刷新数据";
  btn.onclick = function(){
    btn.disabled = true; btn.textContent = "刷新中…";
    api("/api/overview/assessment?date=" + date + "&refresh=1").then(function(j){
      btn.disabled = false; btn.textContent = "刷新数据";
      if(!j || !j.ok){ toast && toast("刷新失败：" + ((j && j.error) || "未知错误")); return; }
      _cache[date] = j; paint(root, j);
    }).catch(function(e){ btn.disabled = false; btn.textContent = "刷新数据"; });
  };
  bar.appendChild(btn);
  var meta = document.createElement("div"); meta.className = "asm-meta";
  meta.innerHTML = "统计日期 <b>" + esc(date) + "</b>（今日实时）";
  bar.appendChild(meta);
  return bar;
}

/* ---------- 组装 ---------- */
function paint(root, j){
  // 清掉挂载区（保留工具条）
  var mount = root.querySelector(".asm-body");
  if(!mount){
    mount = document.createElement("div");
    mount.className = "asm-body";
    mount.style.cssText = "display:flex;flex-direction:column;gap:var(--scr-gap)";
    root.appendChild(mount);
  }
  mount.innerHTML = "";
  // 数据状态元信息补到工具条
  var bar = root.querySelector(".asm-bar .asm-meta");
  if(bar && j.generated_at){ bar.innerHTML = "统计日期 <b>" + esc(j.date) + "</b>　·　聚合于 " + esc(j.generated_at); }

  mount.appendChild(kpiBand(j));
  var two = document.createElement("div"); two.className = "asm-2";
  two.appendChild(rankPanel(j));
  two.appendChild(stdPanel(j));
  mount.appendChild(two);
  var two2 = document.createElement("div"); two2.className = "asm-2";
  two2.appendChild(periodHeatPanel(j));
  two2.appendChild(radarPanel(j));
  mount.appendChild(two2);
  mount.appendChild(trendPanel(j));
  var two3 = document.createElement("div"); two3.className = "asm-2";
  two3.appendChild(alertPanel(j));
  two3.appendChild(placePanel(j));
  mount.appendChild(two3);
  mount.appendChild(notePanel(j));
}

/* ---------- KPI 巨字带 ---------- */
function kpiBand(j){
  var all = j.all || {};
  var st = all.station || {};
  var q = all.quality || {};
  var ar = st.achieved_rate, star = q.star;
  var alertN = (j.alerts || []).length;
  // 时段出勤达成率（全市）：取 period_all 各站「全天(9999)」达成率均值
  var periodRate = null;
  if(all.period && all.period.station_rows){
    var rs = all.period.station_rows.filter(function(r){ return r.metrics && r.metrics["9999"]; });
    var vals = rs.map(function(r){ return r.metrics["9999"].rate; }).filter(function(v){ return v != null; });
    if(vals.length) periodRate = vals.reduce(function(a, b){ return a + b; }, 0) / vals.length;
  }
  // 预估服务费(量)：达标骑手数 + 超额权重(peak_incentive%)
  var feeNum = st.achieved_num, feeSub = "金额需接定价表（各档单价/单均/膨胀系数）";
  if(st.peak_incentive != null) feeSub = "达标 " + fmt(st.achieved_num) + " 人 · 标准2+覆盖 " + pct(st.peak_incentive);

  var g = document.createElement("div"); g.className = "asm-kpis";
  g.appendChild(kpi("运力达标率", pct(ar), "", rateCls(ar, j.thresholds.achieved_red, j.thresholds.achieved_yellow, true),
    "达标 " + fmt(st.achieved_num) + " / 规模目标 " + fmt(st.scale_target)));
  g.appendChild(kpi("时段出勤达成率", pct(periodRate), "", periodRate == null ? "" : "cyan",
    periodRate == null ? "需先在「时段出勤」点查询" : "全市各站全天达成率均值"));
  g.appendChild(kpi("服务质量星级", star == null ? "—" : star.toFixed(2), "星", rateCls(star, j.thresholds.star_red, j.thresholds.star_yellow, true),
    "由投诉率按方案公式推算"));
  g.appendChild(kpi("预警站点数", String(alertN), "项", alertN > 0 ? "warn" : "ok",
    "红/黄灯触发合计"));
  g.appendChild(kpi("预估服务费(量)", fmt(feeNum), "人", "", feeSub));
  return g;
}
function kpi(label, val, unit, tone, sub){
  var d = document.createElement("div");
  d.className = "asm-kpi" + (tone ? " " + tone : "");
  d.innerHTML = '<div class="k">' + esc(label) + '</div>' +
    '<div class="v">' + esc(val) + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</div>' +
    '<div class="s">' + esc(sub) + '</div>';
  return d;
}

/* ---------- 跨站点排名表 + 红黄灯 ---------- */
function rankPanel(j){
  var p = panel("跨站点排名 · 红黄灯",
    "按运力达标率降序；灯色：红=达标率<" + j.thresholds.achieved_red + "% / 黄=<" + j.thresholds.achieved_yellow + "%。点击「时段出勤」可补时段数据。",
    "全市 " + (j.teams || []).length + " 站");
  var teams = (j.teams || []).slice().filter(function(t){ return t.station; });
  teams.sort(function(a, b){ return (b.station.achieved_rate || -1) - (a.station.achieved_rate || -1); });
  if(!teams.length){ p.body.innerHTML = '<div class="asm-empty">今日站点数据尚未落盘，无法排名。请先在「标准达成」点「刷新数据」。</div>'; return p.el; }
  var rows = teams.map(function(t){
    var s = t.station, q = t.quality || {};
    var lv = rateCls(s.achieved_rate, j.thresholds.achieved_red, j.thresholds.achieved_yellow, true);
    var starLv = rateCls(q.star, j.thresholds.star_red, j.thresholds.star_yellow, true);
    var std = [s.std1, s.std2, s.std3, s.std4, s.std5];
    return '<tr>' +
      '<td><span class="nm">' + esc(t.team_name) + '</span><span class="sub">达标 ' + fmt(s.achieved_num) + ' / 目标 ' + fmt(s.scale_target) + '</span></td>' +
      '<td><span class="light ' + lv + '"></span>' + pct(s.achieved_rate) + '</td>' +
      '<td class="asm-std-cell">' + std.map(function(n){ return fmt(n || 0); }).join(" / ") + '</td>' +
      '<td><span class="light ' + starLv + '"></span>' + (q.star == null ? "—" : q.star.toFixed(2)) + '</td>' +
      '<td>' + pct(q.complaint_rate) + '</td>' +
      '<td>' + pct(q.timeout_rate) + '</td>' +
      '<td>' + (s.peak_incentive == null ? "—" : pct(s.peak_incentive)) + '</td>' +
      '</tr>';
  }).join("");
  var w = document.createElement("div"); w.className = "scr-tbl-wrap";
  w.innerHTML = '<table class="asm-rank"><thead><tr>' +
    '<th>站点</th><th>运力达标率</th><th>标准1~5人数</th><th>服务质量星级</th><th>投诉率</th><th>超时率</th><th>高峰覆盖</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
  p.body.appendChild(w);
  return p.el;
}

/* ---------- 标准1~5 分布（全市） ---------- */
function stdPanel(j){
  var s = (j.all && j.all.station) || {};
  var p = panel("运力标准分布 · 全市",
    "堆叠条 = 全市达标骑手按标准1→5 分段；右侧为各档人数。未填满部分 = 未达任何标准。",
    "全市");
  if(!s.scale_target){ p.body.innerHTML = '<div class="asm-empty">运力数据缺失。</div>'; return p.el; }
  var std = [s.std1, s.std2, s.std3, s.std4, s.std5];
  var total = std.reduce(function(a, b){ return a + (b || 0); }, 0) || 1;
  var seg = std.map(function(n, i){
    var w = ((n || 0) / total * 100);
    return '<i class="s' + (i + 1) + '" style="width:' + w.toFixed(2) + '%" title="标准' + (i + 1) + '：' + fmt(n || 0) + ' 人"></i>';
  }).join("");
  var wrap = document.createElement("div");
  wrap.innerHTML = '<div class="asm-stack">' + seg + '</div>' +
    '<div class="asm-legend">' + [1, 2, 3, 4, 5].map(function(i){ return '<span><i class="s' + i + '"></i>标准' + i + '（' + fmt(std[i - 1] || 0) + '）</span>'; }).join("") + '</div>' +
    '<div class="asm-note" style="margin-top:10px">门槛合计 <b>' + fmt(s.threshold_count) + '</b>　·　封顶合计 <b>' + fmt(s.cap_count) + '</b>　·　排班满足率 <b>' + pct(s.schedule_rate) + '</b></div>';
  p.body.appendChild(wrap);
  return p.el;
}

/* ---------- 时段出勤热力 ---------- */
function periodHeatPanel(j){
  var pa = (j.all && j.all.period);
  var p = panel("时段出勤达成率 · 热力",
    "行=站点，列=时段；色深=达成率高（达标人数/时段目标人数）。数据来自「时段出勤」进程内缓存。",
    "实时");
  if(!pa || !pa.station_rows || !pa.station_rows.length){
    p.body.innerHTML = '<div class="asm-empty">时段出勤尚未拉取。<br>请先打开「数据看板 → 时段出勤」点一次「查询」拉取实时考勤，再回本大屏查看。</div>';
    return p.el;
  }
  var periods = (pa.periods || []).slice();
  // 排序：全天(9999) 置首，其余按 time_name 起始时间
  function hm(s){ if(!s || s.indexOf(":") < 0) return 9999; var a = s.split(":"); return parseInt(a[0], 10) * 60 + parseInt(a[1], 10); }
  periods.sort(function(a, b){
    if(str(a.time_code) === "9999") return -1;
    if(str(b.time_code) === "9999") return 1;
    return hm(a.time_name) - hm(b.time_name);
  });
  var head = "<tr><th>站点</th>" + periods.map(function(pd){ return "<th>" + esc(pd.time_name) + "</th>"; }).join("") + "</tr>";
  var body = pa.station_rows.map(function(r){
    var cells = periods.map(function(pd){
      var m = r.metrics ? r.metrics[str(pd.time_code)] : null;
      if(!m){ var k = pd.time_code; m = r.metrics[k] !== undefined ? r.metrics[k] : (r.metrics[String(k)] || r.metrics[Number(k)] || null); }
      if(!m || m.rate == null) return '<td><span class="c none">—</span></td>';
      var v = m.rate;
      var bg = v >= 95 ? "rgba(15,157,88,.85)" : (v >= 90 ? "rgba(15,157,88,.5)" : (v >= 80 ? "rgba(245,166,35,.7)" : "rgba(224,32,32,.7)"));
      return '<td><span class="c" style="background:' + bg + '">' + pct(v) + '</span></td>';
    }).join("");
    return "<tr><td class='tn'>" + esc(r.team_name) + "</td>" + cells + "</tr>";
  }).join("");
  var w = document.createElement("div"); w.style.cssText = "overflow-x:auto";
  w.innerHTML = '<table class="asm-heat"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  p.body.appendChild(w);
  return p.el;
}

/* ---------- 服务质量雷达（SVG） ---------- */
function radarPanel(j){
  var q = (j.all && j.all.quality) || {};
  var p = panel("服务质量雷达 · 全市",
    "6 维归一(0~100，越高越好)；外圈=满分目标，内圈=实际。星级/投诉/超时/索赔/违规按「反向」归一。",
    "今日");
  if(!q || q.star == null){ p.body.innerHTML = '<div class="asm-empty">质量数据缺失。</div>'; return p.el; }
  var axes = [
    { name: "完全妥投率", v: q.deliver_rate == null ? 0 : q.deliver_rate },
    { name: "服务质量星级", v: (q.star || 0) * 20 },
    { name: "投诉率(反)", v: clamp100(100 - (q.complaint_rate || 0)) },
    { name: "超时率(反)", v: clamp100(100 - (q.timeout_rate || 0)) },
    { name: "索赔率(反)", v: clamp100(100 - (q.claim_rate || 0)) },
    { name: "违规率(反)", v: clamp100(100 - (q.violate_rate || 0)) }
  ];
  var svg = radarSvg(axes, 200);
  var w = document.createElement("div");
  w.innerHTML = svg + '<div class="asm-note" style="text-align:center;margin-top:6px">妥投 ' + pct(q.deliver_rate) +
    '　·　星级 ' + (q.star == null ? "—" : q.star.toFixed(2)) + '　·　投诉 ' + pct(q.complaint_rate) +
    '　·　超时 ' + pct(q.timeout_rate) + '　·　索赔 ' + pct(q.claim_rate) + '　·　违规 ' + pct(q.violate_rate) + '</div>';
  p.body.appendChild(w);
  return p.el;
}
function clamp100(v){ return Math.max(0, Math.min(100, v)); }
function radarSvg(axes, R){
  var cx = 130, cy = 120, rad = R, N = axes.length;
  function pt(i, rr){
    var ang = -Math.PI / 2 + i * 2 * Math.PI / N;
    return [cx + rr * Math.cos(ang), cy + rr * Math.sin(ang)];
  }
  var grid = "";
  [0.25, 0.5, 0.75, 1].forEach(function(f){
    var pts = []; for(var i = 0; i < N; i++){ var p = pt(i, rad * f); pts.push(p[0].toFixed(1) + "," + p[1].toFixed(1)); }
    grid += '<polygon class="asm-grid" points="' + pts.join(" ") + '"/>';
  });
  var spokes = ""; for(var i = 0; i < N; i++){ var p = pt(i, rad); spokes += '<line class="asm-grid" x1="' + cx + '" y1="' + cy + '" x2="' + p[0].toFixed(1) + '" y2="' + p[1].toFixed(1) + '"/>'; }
  var labels = ""; for(var i = 0; i < N; i++){ var p = pt(i, rad + 16); labels += '<text class="asm-axis" x="' + p[0].toFixed(1) + '" y="' + (p[1] + 3).toFixed(1) + '" text-anchor="middle">' + esc(axes[i].name) + '</text>'; }
  var actual = []; for(var i = 0; i < N; i++){ var p = pt(i, rad * clamp100(axes[i].v) / 100); actual.push(p[0].toFixed(1) + "," + p[1].toFixed(1)); }
  return '<svg class="asm-radar" viewBox="0 0 260 248">' + grid + spokes +
    '<polygon points="' + actual.join(" ") + '" fill="rgba(255,80,0,.18)" stroke="#FF5000" stroke-width="2"/>' +
    labels + '</svg>';
}

/* ---------- 历史趋势（SVG 折线） ---------- */
function trendPanel(j){
  var t = j.trend;
  var p = panel("历史对比趋势",
    "逐日「运力达标率 / 完全妥投率 / 服务质量星级(×20)」；环比(vs 昨日)见角标。同比需上月同期缓存（当前数据范围不足）。",
    (t && t.dates ? t.dates.length : 0) + " 天");
  if(!t || !t.dates || !t.dates.length){ p.body.innerHTML = '<div class="asm-empty">无历史缓存可对比。</div>'; return p.el; }
  var ring = t.ring || {};
  var sub = "环比：达标率 " + (ring.achieved_rate == null ? "—" : (ring.achieved_rate >= 0 ? "+" : "") + ring.achieved_rate + "%");
  var foot = document.createElement("div"); foot.className = "asm-note"; foot.style.marginTop = "6px";
  foot.innerHTML = sub + "　·　区间 " + esc(t.dates[0]) + " ~ " + esc(t.dates[t.dates.length - 1]);
  var series = [
    { name: "运力达标率", color: "#FF5000", data: t.achieved_rate },
    { name: "完全妥投率", color: "#0891B2", data: t.deliver_rate },
    { name: "服务质量星级(×20)", color: "#0F9D58", data: t.star.map(function(v){ return v == null ? null : v * 20; }) }
  ];
  var svg = lineSvg(t.dates, series, 640, 240);
  var w = document.createElement("div");
  w.innerHTML = svg +
    '<div class="asm-legend">' + series.map(function(s){ return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>'; }).join("") + '</div>';
  p.body.appendChild(w);
  p.body.appendChild(foot);
  return p.el;
}
function lineSvg(dates, series, W, H){
  var pl = 38, pr = 12, pt = 12, pb = 26;
  var iw = W - pl - pr, ih = H - pt - pb;
  var n = dates.length;
  var x = function(i){ return pl + (n <= 1 ? iw / 2 : iw * i / (n - 1)); };
  var y = function(v){ return pt + ih * (1 - clamp100(v) / 100); };
  var grid = ""; [0, 25, 50, 75, 100].forEach(function(g){
    var yy = y(g); grid += '<line class="asm-grid" x1="' + pl + '" y1="' + yy.toFixed(1) + '" x2="' + (W - pr) + '" y2="' + yy.toFixed(1) + '"/>' +
      '<text class="asm-axis" x="' + (pl - 5) + '" y="' + (yy + 3).toFixed(1) + '" text-anchor="end">' + g + '</text>';
  });
  var xlabels = ""; dates.forEach(function(d, i){
    if(n > 10 && i % 2) return;
    xlabels += '<text class="asm-axis" x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(d.slice(5)) + '</text>';
  });
  var paths = "";
  series.forEach(function(s){
    var pts = []; s.data.forEach(function(v, i){ if(v != null) pts.push(x(i).toFixed(1) + "," + y(v).toFixed(1)); });
    paths += '<polyline class="asm-line" stroke="' + s.color + '" points="' + pts.join(" ") + '"/>';
  });
  return '<svg class="asm-trend" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none">' + grid + paths + xlabels + '</svg>';
}

/* ---------- 预警清单 ---------- */
function alertPanel(j){
  var p = panel("预警清单 · 红黄灯", "达标率/星级/投诉率/超时率 触发阈值的站点明细。", (j.alerts || []).length + " 项");
  var al = j.alerts || [];
  if(!al.length){ p.body.innerHTML = '<div class="asm-empty">暂无预警（全部站点在阈值内）。</div>'; return p.el; }
  var w = document.createElement("div"); w.className = "asm-alerts";
  w.innerHTML = al.map(function(a){
    return '<div class="asm-alert"><span class="badge ' + a.level + '">' + (a.level === "red" ? "红" : "黄") + '</span>' +
      '<span class="tn">' + esc(a.team) + '</span><span>' + esc(a.type) + '</span>' +
      '<span class="ms">' + esc(a.msg) + '</span></div>';
  }).join("");
  p.body.appendChild(w);
  return p.el;
}

/* ---------- 待接数据占位 ---------- */
function placePanel(j){
  var p = panel("待接数据源（占位）", "以下指标方案要求、当前订单缓存无对应字段，需另接数据源/定价表后启用。", (j.places || []).length + " 项");
  var w = document.createElement("div"); w.className = "asm-place";
  w.innerHTML = (j.places || []).map(function(pl){
    return '<div class="asm-pc"><span class="lb">' + esc(pl.label) + '</span><span class="rs">' + esc(pl.reason) + '</span></div>';
  }).join("");
  p.body.appendChild(w);
  return p.el;
}

/* ---------- 数据状态 ---------- */
function notePanel(j){
  var p = panel("数据状态 / 口径", "", "");
  var miss = j.missing_teams, notes = j.notes;
  p.body.innerHTML = '<div class="asm-note">数据来源：本地运单/排班/考勤缓存（dashboard/data），由「标准达成 → 刷新数据」落盘；大屏只读缓存、零额外请求。<br>' +
    '聚合时间：<b>' + esc(j.generated_at || "—") + '</b>　·　参与站点 <b>' + (j.teams || []).length + '</b> 个' +
    (miss ? '<br><span class="asm-warn">以下站点今日无落盘数据：' + esc(miss.join("、")) + '</span>' : '') +
    (notes ? '<br>' + notes.map(function(n){ return '<span class="asm-warn">· ' + esc(n) + '</span>'; }).join("<br>") : '') +
    '</div>';
  return p.el;
}

/* ---------- 面板小工具 ---------- */
function panel(title, hint, right){
  var el = document.createElement("div"); el.className = "scr-panel";
  var t = document.createElement("div"); t.className = "scr-pt";
  t.innerHTML = esc(title) + (right ? '<span class="hp">' + esc(right) + '</span>' : "");
  el.appendChild(t);
  if(hint){ var h = document.createElement("div"); h.className = "scr-ph"; h.textContent = hint; el.appendChild(h); }
  var body = document.createElement("div"); el.appendChild(body);
  return { el: el, body: body };
}
