// 自动生成的模块头：统一依赖（未使用的导入会被打包器摇树移除）
import { store, groupOf, taskById, countInGroup, producerOf, missingText, visibleTasks, taskState, argValue } from "./store.js";
import { api, savePrefs, loadPrefs, readTokens, withToken } from "./api.js";
import { svg, esc, hexA, toast, debounce, viewHead } from "./ui.js";
import { TK, TK_MAP, RISK_LABEL, RISK_CLS, STATUS_CLS, STATUS_TXT, ICON } from "./tokens.js";
import { bus } from "./bus.js";
import { refreshLan, bindLanToggle, setArg, openSide, closeSide, askConfirm, closeConfirm, bindConfirmUI, lockScroll, unlockScroll } from "./behavior.js";
import { navExpandOnly } from "./nav.js";
import { openRunDrawer } from "./runs.js";
import { todoOpenCount, tdIsToday, todoToggle, tdOverdue, tdFmt } from "./todo.js";
const state = store.state;

/* ================= 首页 =================
   一屏回答四件事：能不能跑（服务/Cookie/Quark）、有什么（任务与分组）、
   要做什么（今日待办）、刚发生了什么（最近运行）。点区块直接跳到对应视图。 */
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
                '<p class="hero-sub">'+esc(heroDate())+' · 工作台概览：服务状态、实时任务与今日待办，一目了然。</p>';
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
export function renderHomeView(host){
  host.appendChild(viewHead("首页", "工作台概览 · 服务状态、实时任务概览与今日待办", "house", TK.brand, ""));

  /* --- 服务状态 --- */
  host.appendChild(homeSection("服务状态", "info", '<span class="hp">每 60s 自动探测</span>'));
  var sg = document.createElement("div");
  sg.className = "stat-grid";

  var cv, cc;
  if(state.connected === true)       { cv = "已连接"; cc = TK.ok; }
  else if(state.connected === false) { cv = "已断开"; cc = TK.err; }
  else                               { cv = "连接中"; cc = TK.neutral; }
  sg.appendChild(homeStat("check-circle", cc, "工作台服务", cv));

  var kv, kc;
  if(!state.cookie)                          { kv = "待校验"; kc = TK.neutral; }
  else if(state.cookie.status === "valid")   { kv = "有效";   kc = TK.ok; }
  else if(state.cookie.status === "invalid") { kv = "已失效"; kc = TK.err; }
  else                                       { kv = "未知";   kc = TK.neutral; }
  sg.appendChild(homeStat("user-check", kc, "风神 Cookie", kv));

  var qv, qc;
  if(!state.quark)                            { qv = "待校验"; qc = TK.neutral; }
  else if(state.quark.status === "valid")     { qv = "有效";   qc = TK.ok; }
  else if(state.quark.status === "invalid")   { qv = "已失效"; qc = TK.err; }
  else if(state.quark.status === "nocache")   { qv = "未兑换"; qc = TK.neutral; }
  else                                        { qv = "未知";   qc = TK.neutral; }
  sg.appendChild(homeStat("layers", qc, "Quark DA", qv));
  host.appendChild(sg);

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
