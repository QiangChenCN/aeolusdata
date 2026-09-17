// 自动生成的模块头：统一依赖（未使用的导入会被打包器摇树移除）
import { store, groupOf, taskById, countInGroup, producerOf, missingText, visibleTasks, taskState, argValue, navExpandOnly } from "./store.js";
import { api, savePrefs, loadPrefs, readTokens, withToken } from "./api.js";
import { svg, esc, hexA, toast, debounce, viewHead } from "./ui.js";
import { TK, TK_MAP, RISK_LABEL, RISK_CLS, STATUS_CLS, STATUS_TXT, ICON } from "./tokens.js";
import { bus } from "./bus.js";
import { refreshLan, bindLanToggle, setArg, openSide, closeSide, askConfirm, closeConfirm, bindConfirmUI, lockScroll, unlockScroll } from "./behavior.js";

import { openRunDrawer } from "./runs.js";
import { todoOpenCount, tdIsToday, todoToggle, tdOverdue, tdFmt } from "./todo.js";
import "./home-screen.css";
const state = store.state;

/* ================= 首页 =================
   一屏回答三件事：有什么（任务与分组）、要做什么（今日待办）、
   刚发生了什么（最近运行）。点区块直接跳到对应视图。 */
export function homeSection(title, icon, rightHtml){
  var s = document.createElement("div");
  s.className = "home-sec";
  s.innerHTML = svg(icon) + "<b>" + esc(title) + "</b><span class='sp'></span>" + (rightHtml||"");
  return s;
}
/* 首页 Hero：Apple 式大标题 + 动态日期 eyebrow。日期随时间刷新，标题用品牌渐变。 */
export function heroDate(){
  var w = ["周日","周一","周二","周三","周四","周五","周六"];
  var d = new Date();
  return d.getFullYear()+"年"+(d.getMonth()+1)+"月"+d.getDate()+"日 · "+w[d.getDay()];
}
export function homeHero(){
  var h = document.createElement("div");
  h.className = "hero";
  h.innerHTML = '<div class="hero-eyebrow">AEOLUS WORKBENCH</div>'+
                '<h1 class="hero-title">风神工作台</h1>'+
                '<p class="hero-sub">'+esc(heroDate())+' · 工作台概览：实时任务与今日待办，一目了然。</p>';
  return h;
}
export function homeStat(icon, color, label, value, unit){
  var d = document.createElement("div");
  d.className = "stat";
  d.innerHTML = '<div class="s-ic" style="background:'+hexA(color,.12)+';color:'+color+'">'+svg(icon)+'</div>'+
                '<div class="s-b"><div class="s-v">'+esc(value)+
                (unit?'<span class="s-u">'+esc(unit)+'</span>':'')+'</div>'+
                '<div class="s-k">'+esc(label)+'</div></div>';
  return d;
}
/* D2 通用骨架屏：往 host 里塞 n 张 .sk-card 占位卡；首屏未加载 / 视图切换空窗期复用同一实现 */
export function skeletonCards(host, n){
  host.innerHTML = "";
  for(var i=0;i<n;i++){
    var sk = document.createElement("div");
    sk.className = "skeleton sk-card";
    host.appendChild(sk);
  }
}
export function homeBox(){
  var d = document.createElement("div");
  d.className = "home-box";
  return d;
}
export function homeRow(){
  var d = document.createElement("div");
  d.className = "home-row";
  return d;
}
export function todayYmd(){
  var d = new Date(), p = function(n){ return (n<10?"0":"")+n; };
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());
}
/* 首页「各站点标准达成」：拉全部站点报表，逐站渲染 9 列（含三档差值）。
   差值 = 达标人数 − 门槛人数 / 规模目标 / 封顶人数，正数绿（达标）、负数红（缺口）。 */
function _renderHomeStd(host){
  api("/api/standard/station-report?team=__all__").then(function(j){
    if(!j || j.ok===false){
      host.innerHTML = '<div class="empty">标准达成加载失败：'+esc((j&&j.error)||"未知错误")+'</div>';
      return;
    }
    var rows = j.rows || [];
    if(!rows.length){
      host.innerHTML = '<div class="empty">'+(j.data_note||"暂无标准达成数据，请先在标准达成点「刷新数据」")+'</div>';
      return;
    }
    host.innerHTML = _homeStdTable(rows);
  }).catch(function(e){
    host.innerHTML = '<div class="empty">请求失败：'+esc(String(e))+'</div>';
  });
}
function _homeStdTable(rows){
  var heads = ["站点名称","规模目标","门槛值","封顶值","达标人数","达成率","门槛差值","目标差值","封顶差值"];
  var html = '<table class="scr-tbl"><thead><tr>';
  heads.forEach(function(h){ html += "<th>"+esc(h)+"</th>"; });
  html += "</tr></thead><tbody>";
  rows.forEach(function(r){
    var scale = r.scale_target, th = r.threshold_count, cap = r.cap_count;
    var ach = r.achieved_num, rate = r.achieved_rate;
    html += "<tr>"+
      '<td class="nm">'+esc(r.team_name || r.team_id)+
        '<span class="sub">'+esc(r.team_id || "")+"</span></td>"+
      "<td>"+_stdFmt(scale)+"</td>"+
      "<td>"+_stdFmt(th)+"</td>"+
      "<td>"+_stdFmt(cap)+"</td>"+
      '<td class="ach">'+_stdFmt(ach)+"</td>"+
      _stdCellRate(rate)+
      _stdCellDiff(_stdDiff(ach, th))+
      _stdCellDiff(_stdDiff(ach, scale))+
      _stdCellDiff(_stdDiff(ach, cap))+
    "</tr>";
  });
  html += "</tbody></table>";
  return html;
}
function _stdFmt(v){ return (v===null || v===undefined) ? "—" : String(v); }
function _stdDiff(a, b){ return (a==null || b==null) ? null : (a - b); }
function _stdCellRate(rate){
  if(rate==null) return "<td>—</td>";
  var cls = rate>=100 ? "ok" : (rate>=90 ? "low" : "bad");
  var w = Math.min(100, rate) + "%";
  return '<td class="scr-rate '+cls+'"><span>'+rate+'%</span>'+
    '<span class="track"><i style="width:'+w+'"></i></span></td>';
}
function _stdCellDiff(d){
  if(d==null) return "<td>—</td>";
  var cls = d>0 ? "ok" : (d<0 ? "bad" : "");
  return '<td class="'+(cls ? "diff "+cls : "")+'">'+(d>0 ? "+" : "")+d+"</td>";
}
export function renderHomeView(host){
  host.appendChild(homeHero());

  /* --- 任务概览（实时） --- */
  host.appendChild(homeSection("任务概览", "layers", '<span class="hp">实时统计</span>'));
  var kp = document.createElement("div");
  kp.className = "stat-grid";
  var _running = (state.current ? 1 : 0) + (state.queuedIds ? state.queuedIds.length : 0);
  var _failed = 0; for(var _fk in (state.last||{})){ if(state.last[_fk] && state.last[_fk].status === "failed") _failed++; }
  var _tStr = todayYmd();
  var _today = 0; for(var _hi=0;_hi<state.history.length;_hi++){ if((state.history[_hi].start||"").indexOf(_tStr)===0) _today++; }
  kp.appendChild(homeStat("play", TK.info, "运行中", String(_running), "个"));
  kp.appendChild(homeStat("alert-triangle", TK.err, "失败", String(_failed), "个"));
  kp.appendChild(homeStat("calendar-days", TK.ok, "今日已跑", String(_today), "次"));
  kp.appendChild(homeStat("list-checks", TK.brand, "待办未完成", String(todoOpenCount()), "条"));
  kp.appendChild(homeStat("grid", TK.info, "任务总数", String(state.tasks.length), "个"));
  kp.appendChild(homeStat("clock", TK.neutral, "运行记录", String(state.history.length), "次"));
  host.appendChild(kp);

  /* --- 各站点标准达成（今日） --- */
  host.appendChild(homeSection("各站标准达成", "target", '<span class="hp">数据随刷新更新</span>'));
  var _stdWrap = document.createElement("div");
  _stdWrap.className = "scr-tbl-wrap std-apple-card";
  _stdWrap.innerHTML = '<div class="empty">标准达成加载中…</div>';
  host.appendChild(_stdWrap);
  _renderHomeStd(_stdWrap);

  /* --- 快捷任务 --- */
  if(state.tasks.length){
    host.appendChild(homeSection("快捷任务", "bolt", '<span class="hp">点卡片跳到所属分组</span>'));
    var qg = document.createElement("div");
    qg.className = "quick-grid";
    state.tasks.slice(0,6).forEach(function(t){
      var g = groupOf(t.group);
      var b = document.createElement("button");
      b.type = "button";
      b.className = "qcard";
      b.innerHTML = '<div class="q-ic" style="background:'+hexA(g.color,.12)+';color:'+g.color+'">'+svg("bolt")+'</div>'+
                    '<div class="q-b"><div class="q-t">'+esc(t.name)+'</div>'+
                    '<div class="q-d">'+esc(g.name)+' · '+esc(RISK_LABEL[t.risk]||"")+'</div></div>'+
                    svg("arrow","ic q-go");
      b.onclick = function(){
        state.nav = { kind:"tasks", id:t.group };
        navExpandOnly("hub");
        savePrefs(); bus.emit("refresh");
      };
      qg.appendChild(b);
    });
    host.appendChild(qg);
  }

  /* --- 今日待办 / 最近运行（并排两栏） --- */
  var two = document.createElement("div");
  two.className = "home-two";

  // 左：今日待办
  var tBox = homeBox();
  var todayItems = (state.todo ? state.todo.items : []).filter(function(x){
    return !x.done && tdIsToday(x);
  }).sort(function(a,b){ return (a.remindAt||"9").localeCompare(b.remindAt||"9"); });
  if(!todayItems.length){
    var te = document.createElement("div");
    te.className = "empty"; te.textContent = "今天没有待办。";
    tBox.appendChild(te);
  }else{
    todayItems.slice(0,6).forEach(function(it){
      var r = homeRow();
      var cir = document.createElement("button");
      cir.type = "button";
      cir.className = "rmd-cir";
      cir.innerHTML = svg("check");
      cir.title = "标记完成";
      cir.onclick = function(){ todoToggle(it.id); };
      r.appendChild(cir);
      var b = document.createElement("div");
      b.style.cssText = "flex:1;min-width:0";
      b.innerHTML = '<div class="rmd-tt">'+esc(it.title)+'</div>'+
        (it.remindAt ? '<div class="rmd-meta"><span class="m'+(tdOverdue(it)?" over":"")+'">'+
          svg("bell","ic")+esc(tdFmt(it.remindAt))+'</span></div>' : "");
      r.appendChild(b);
      tBox.appendChild(r);
    });
  }

  // 右：最近运行
  var hBox = homeBox();
  if(!state.history.length){
    var he = document.createElement("div");
    he.className = "empty"; he.textContent = "还没有运行记录。";
    hBox.appendChild(he);
  }else{
    state.history.slice(0,6).forEach(function(h){
      var r = homeRow();
      r.style.cursor = "pointer";
      r.innerHTML = '<span class="tm" style="color:var(--muted);font-size:var(--fs-small);flex:none">'+esc(h.start||"")+'</span>'+
        '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(h.name)+'</span>'+
        '<span class="badge '+(STATUS_CLS[h.status]||"b-stop")+'">'+(STATUS_TXT[h.status]||h.status)+'</span>';
      r.title = "查看运行详情";
      r.onclick = function(){ openRunDrawer(h); };
      hBox.appendChild(r);
    });
  }

  var c1 = document.createElement("div");
  c1.appendChild(homeSection("今日待办", "sun", '<span class="hp">点圆圈标记完成</span>'));
  c1.appendChild(tBox);
  var c2 = document.createElement("div");
  c2.appendChild(homeSection("最近运行", "clock", ""));
  c2.appendChild(hBox);
  two.appendChild(c1); two.appendChild(c2);
  host.appendChild(two);

  /* --- 分组总览 --- */
  if(state.groups.length){
    host.appendChild(homeSection("任务分组", "layers", '<span class="hp">共 '+state.tasks.length+' 个任务</span>'));
    var gg = document.createElement("div");
    gg.className = "quick-grid";
    state.groups.forEach(function(g){
      var n = countInGroup(g.id);
      if(!n) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "qcard";
      b.innerHTML = '<div class="q-ic" style="background:'+hexA(g.color,.12)+';color:'+g.color+'">'+svg("grid")+'</div>'+
                    '<div class="q-b"><div class="q-t">'+esc(g.name)+'</div>'+
                    '<div class="q-d">'+n+' 个任务</div></div>'+
                    svg("arrow","ic q-go");
      b.onclick = function(){
        state.nav = { kind:"tasks", id:g.id };
        navExpandOnly("hub");
        savePrefs(); bus.emit("refresh");
      };
      gg.appendChild(b);
    });
    host.appendChild(gg);
  }
}

/* 自动导出：供其他模块导入的内部顶层符号 */
export { state };
