// datepicker.js —— 自绘日期选择器（替换 <input type="date"> 的 native widget）+「单日/多日」分组。
// 从 task.js 拆出（原 1173-1690 行）：自带 _dpkState 状态、对外契约与 native date 一致，
// 与任务参数表单机制解耦，独立成模块便于维护。
// task.js 通过本模块导入 dateRangeGroupFlags / createDateTrigger / setDateValue / getDateValue /
// _yesterdayStr / _defaultsToYesterday / renderDateRangeGroup，并把 _dpkState 原样再导出给 main.js。
import { store, argValue } from "./store.js";
import { svg, esc, toast } from "./ui.js";

export function dateRangeGroupFlags(t){
  var fl = (t.params||[]).map(function(p){ return p.flag; });
  if(fl.indexOf("--date")>=0 && fl.indexOf("--start-date")>=0 && fl.indexOf("--end-date")>=0){
    return { single:"--date", start:"--start-date", end:"--end-date" };
  }
  return null;
}

/* ============================================================================
   日期 picker（自绘，替换 <input type="date"> 的 native widget）

   流程：
   · createDateTrigger(value) —— 生成一个可点击的 div 占位（内含 hidden input），
     给 renderParamRow / renderDateRangeGroup 用，等价于原 <input type=date> 的「DOM 槽」。
   · openDatePicker(anchor, { value, onPick }) —— 在 anchor 下方弹出日历浮层
   · closeDatePicker(returnFocus) —— 关闭浮层

   数据契约（与 native date 对外保持一致）：
   · 输入：YYYY-MM-DD 字符串（空串 = 未选）
   · 输出（onPick）：YYYY-MM-DD 字符串（空串 = 清除）
   · hidden input 的 value = 同一字符串，commitParamsForm / commitDateRangeGroup 读它

   为什么不用 native date picker：
   1. native picker 的弹出位置由浏览器控制，跟 cf-mask 的 z-index 解耦不好调
   2. 配色（白底蓝字 + 灰色顶部月份条）跟项目的 --brand / --border 对不上
   3. 边框在 native picker 下无法完全覆盖，输入框看着像「禁用态的灰块」
   ========================================================================== */

export var _dpkState = null;   /* 当前打开的 picker 状态：{anchor, onPick, view:{y,m}, value, prevFocus} */
var _dpkDocHandler = null;  /* document 监听器引用，便于解绑 */

export function _dpkPad(n){ return String(n).padStart(2, "0"); }
export function _dpkParseIso(iso){
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(iso || "");
  if(!m) return null;
  var y = +m[1], mo = +m[2]-1, d = +m[3];
  if(mo < 0 || mo > 11) return null;
  return { y: y, m: mo, d: d };
}
export function _dpkDaysIn(y, m){   /* m = 0..11 */
  return [31,(_isLeap(y)?29:28),31,30,31,30,31,31,30,31,30,31][m];
}
export function _isLeap(y){ return (y%4===0 && y%100!==0) || y%400===0; }
export function _dpkTodayStr(){ var d = new Date(); return d.getFullYear()+"-"+_dpkPad(d.getMonth()+1)+"-"+_dpkPad(d.getDate()); }
export function _dpkSame(a, b){ return a && b && a.y===b.y && a.m===b.m && a.d===b.d; }

/* 创建一个日期 trigger（替换原 input[type=date]）。外部通过 .dpk-value 读 yyyy-mm-dd */
export function createDateTrigger(initialValue){
  var wrap = document.createElement("div");
  wrap.className = "dpk-trigger";
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "button");
  wrap.setAttribute("aria-haspopup", "dialog");

  var hidden = document.createElement("input");
  hidden.type = "hidden";
  hidden.className = "dpk-value";
  hidden.value = initialValue || "";

  var text = document.createElement("span");
  text.className = "dpk-text";

  var ic = document.createElement("span");
  ic.className = "dpk-ic";
  ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';

  var clr = document.createElement("button");
  clr.type = "button";
  clr.className = "dpk-clear";
  clr.title = "清除";
  clr.setAttribute("aria-label", "清除日期");
  clr.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>';
  clr.onclick = function(ev){
    ev.stopPropagation();
    hidden.value = "";
    _dpkPaintText(wrap);
    /* 必须同步摘掉 has-value，否则清除按钮靠 .has-value 显形，清完仍挂在原地不消失 */
    wrap.classList.remove("has-value");
    if(_dpkState && _dpkState.anchor === wrap){
      var cur = _dpkParseIso(hidden.value);
      _dpkRenderDays(cur ? {y: cur.y, m: cur.m, d: -1} : null);
    }
    /* 同步外部 onChange（若调用方注册了） */
    if(typeof wrap._dpkOnChange === "function") wrap._dpkOnChange("");
    clr.blur();
  };

  wrap.appendChild(hidden);
  wrap.appendChild(text);
  wrap.appendChild(ic);
  wrap.appendChild(clr);
  _dpkPaintText(wrap);

  function open(){ openDatePicker(wrap, { value: hidden.value, onPick: function(v){ setDateValue(wrap, v); if(typeof wrap._dpkOnChange === "function") wrap._dpkOnChange(v); } }); }
  wrap.addEventListener("click", function(ev){
    if(ev.target === clr || clr.contains(ev.target)) return;   /* 清除按钮自己处理 */
    open();
  });
  wrap.addEventListener("keydown", function(ev){
    if(ev.key === "Enter" || ev.key === " "){
      ev.preventDefault();
      open();
    } else if(ev.key === "Escape" && _dpkState && _dpkState.anchor === wrap){
      closeDatePicker(true);
    }
  });

  /* 提供外部读写接口 */
  wrap._dpkSetOpenClass = function(on){ wrap.classList.toggle("open", !!on); };
  return wrap;
}

/* 把 yyyy-mm-dd 写回 trigger；空串 = 清除 */
export function setDateValue(trigger, value){
  if(!trigger || !trigger.classList || !trigger.classList.contains("dpk-trigger")) return;
  var hi = trigger.querySelector("input.dpk-value");
  if(hi) hi.value = value || "";
  _dpkPaintText(trigger);
  trigger.classList.toggle("has-value", !!(hi && hi.value));
  if(_dpkState && _dpkState.anchor === trigger){
    var cur = _dpkParseIso(value);
    _dpkRenderDays(cur ? {y: cur.y, m: cur.m, d: cur.d} : null);
  }
}
export function getDateValue(trigger){
  if(!trigger) return "";
  var hi = trigger.querySelector ? trigger.querySelector("input.dpk-value") : null;
  return (hi && hi.value) || "";
}

export function _dpkPaintText(trigger){
  var hi = trigger.querySelector("input.dpk-value");
  var t = trigger.querySelector(".dpk-text");
  if(!t) return;
  var v = hi ? hi.value : "";
  if(v){
    var d = _dpkParseIso(v);
    if(d){ t.textContent = d.y + "/" + _dpkPad(d.m+1) + "/" + _dpkPad(d.d); t.classList.remove("placeholder"); }
    else { t.textContent = ""; t.classList.add("placeholder"); }
  } else {
    t.textContent = "yyyy/mm/日";
    t.classList.add("placeholder");
  }
  trigger.classList.toggle("has-value", !!v);
}

export function openDatePicker(anchor, opts){
  opts = opts || {};
  closeDatePicker(false);
  var cur = _dpkParseIso(opts.value);
  var view = cur ? { y: cur.y, m: cur.m } : (function(){ var t = new Date(); return { y: t.getFullYear(), m: t.getMonth() }; })();

  _dpkState = {
    anchor: anchor,
    onPick: opts.onPick || function(){},
    view: view,
    value: opts.value || "",
    prevFocus: document.activeElement
  };
  anchor.classList.add("open");
  if(anchor._dpkSetOpenClass) anchor._dpkSetOpenClass(true);

  var pk = document.getElementById("dpk");
  _dpkRenderShell(pk);
  pk.classList.add("show");
  _dpkPlace(pk, anchor);
  _dpkBindDocClose();

  /* 让 picker 内部首个可交互元素获焦，方便键盘 */
  setTimeout(function(){
    var first = pk.querySelector(".dpk-day:not(:disabled), .dpk-navbtn");
    if(first) first.focus();
  }, 0);
}

export function closeDatePicker(returnFocus){
  var pk = document.getElementById("dpk");
  if(pk) pk.classList.remove("show");
  if(_dpkState){
    if(_dpkState.anchor && _dpkState.anchor.classList){
      _dpkState.anchor.classList.remove("open");
      if(_dpkState.anchor._dpkSetOpenClass) _dpkState.anchor._dpkSetOpenClass(false);
    }
    var prev = _dpkState.prevFocus;
    _dpkState = null;
    if(returnFocus && prev && prev.focus) prev.focus();
  }
  _dpkUnbindDocClose();
}

export function _dpkPlace(pk, anchor){
  var r = anchor.getBoundingClientRect();
  var pw = pk.offsetWidth || 296;
  var ph = pk.offsetHeight || 340;
  var gap = 6;
  /* 默认贴 anchor 下方 */
  var top = r.bottom + gap;
  var left = r.left;
  /* 视口超出 → 翻转 / 横向对齐 */
  var vw = document.documentElement.clientWidth;
  var vh = document.documentElement.clientHeight;
  if(top + ph > vh - 8 && r.top - ph - gap > 8) top = r.top - ph - gap;   /* 下方空间不够则贴上方 */
  if(left + pw > vw - 8) left = Math.max(8, vw - pw - 8);
  if(left < 8) left = 8;
  pk.style.top = top + "px";
  pk.style.left = left + "px";
}

export function _dpkBindDocClose(){
  _dpkUnbindDocClose();
  _dpkDocHandler = function(ev){
    if(!_dpkState) return;
    var pk = document.getElementById("dpk");
    var t = ev.target;
    if(pk && pk.contains(t)) return;
    if(_dpkState.anchor && (_dpkState.anchor === t || _dpkState.anchor.contains(t))) return;
    closeDatePicker(false);
  };
  document.addEventListener("mousedown", _dpkDocHandler, true);
  document.addEventListener("keydown", function(ev){
    if(ev.key === "Escape" && _dpkState) closeDatePicker(true);
  });
  window.addEventListener("resize", _dpkOnViewportChange);
  window.addEventListener("scroll", _dpkOnViewportChange, true);
}
export function _dpkUnbindDocClose(){
  if(_dpkDocHandler) document.removeEventListener("mousedown", _dpkDocHandler, true);
  document.removeEventListener("keydown", _dpkEscClose);
  window.removeEventListener("resize", _dpkOnViewportChange);
  window.removeEventListener("scroll", _dpkOnViewportChange, true);
  _dpkDocHandler = null;
}
export function _dpkEscClose(ev){ if(ev.key === "Escape" && _dpkState) closeDatePicker(true); }
export function _dpkOnViewportChange(){
  if(!_dpkState) return;
  var pk = document.getElementById("dpk");
  var a = _dpkState.anchor;
  if(!pk || !a) return;
  _dpkPlace(pk, a);
}

/* 渲染 picker 整体结构（年月头 + 星期表头 + 日期格 + 底部按钮） */
export function _dpkRenderShell(pk){
  var s = _dpkState;
  pk.innerHTML = "";
  /* 头部：上 / 下月按钮 + 年月标题 */
  var hd = document.createElement("div"); hd.className = "dpk-hd";
  var nav = document.createElement("div"); nav.className = "dpk-nav";

  var prev = document.createElement("button");
  prev.type = "button"; prev.className = "dpk-navbtn"; prev.title = "上一月";
  prev.setAttribute("aria-label", "上一月");
  prev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  var next = document.createElement("button");
  next.type = "button"; next.className = "dpk-navbtn"; next.title = "下一月";
  next.setAttribute("aria-label", "下一月");
  next.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  nav.appendChild(prev); nav.appendChild(next);

  var tit = document.createElement("div"); tit.className = "dpk-title";

  hd.appendChild(nav); hd.appendChild(tit); hd.appendChild((function(){ var sp = document.createElement("div"); sp.style.width = "62px"; return sp; })());
  pk.appendChild(hd);

  /* 周表头 + 日历网格容器 */
  var wk = document.createElement("div"); wk.className = "dpk-week";
  ["一","二","三","四","五","六","日"].forEach(function(d){
    var s = document.createElement("span"); s.textContent = d; wk.appendChild(s);
  });
  pk.appendChild(wk);

  var grid = document.createElement("div"); grid.className = "dpk-grid";
  pk.appendChild(grid);

  var ymPane = document.createElement("div"); ymPane.className = "dpk-ym-pane";
  pk.appendChild(ymPane);

  /* 底部：清除 / 今天 */
  var ft = document.createElement("div"); ft.className = "dpk-foot";
  var btnClr = document.createElement("button"); btnClr.type = "button"; btnClr.textContent = "清除";
  var btnToday = document.createElement("button"); btnToday.type = "button"; btnToday.className = "dpk-today"; btnToday.textContent = "今天";
  var sp = document.createElement("span"); sp.className = "sp";
  ft.appendChild(btnClr); ft.appendChild(sp); ft.appendChild(btnToday);
  pk.appendChild(ft);

  prev.onclick = function(){ s.view.m--; if(s.view.m<0){ s.view.m=11; s.view.y--; } _dpkRefresh(); };
  next.onclick = function(){ s.view.m++; if(s.view.m>11){ s.view.m=0; s.view.y++; } _dpkRefresh(); };
  btnClr.onclick = function(){ s.onPick(""); closeDatePicker(true); };
  btnToday.onclick = function(){
    var t = _dpkTodayStr();
    s.onPick(t); closeDatePicker(true);
  };

  s._refs = { tit: tit, grid: grid, ymPane: ymPane, prev: prev, next: next };
  _dpkRefresh();
}

export function _dpkRefresh(){
  var s = _dpkState; if(!s) return;
  var r = s._refs;
  r.tit.innerHTML = "";
  var yy = document.createElement("span"); yy.className = "dpk-y"; yy.textContent = s.view.y; yy.tabIndex = 0;
  var sep = document.createElement("span"); sep.className = "dpk-sep"; sep.textContent = "/";
  var mm = document.createElement("span"); mm.className = "dpk-m"; mm.textContent = (s.view.m+1) + "月"; mm.tabIndex = 0;
  r.tit.appendChild(yy); r.tit.appendChild(sep); r.tit.appendChild(mm);
  yy.onclick = function(){ _dpkShowYear(); };
  mm.onclick = function(){ _dpkShowMonth(); };
  /* 选完年月跳回日历 */
  yy.addEventListener("keydown", function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); _dpkShowYear(); } });
  mm.addEventListener("keydown", function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); _dpkShowMonth(); } });

  /* 默认显示日历网格、隐藏年月侧栏 */
  r.ymPane.classList.remove("show");
  r.grid.style.display = "";
  wkShow(true);
  _dpkRenderDays(null);
}

export function _dpkShowYear(){
  var s = _dpkState; if(!s) return;
  var r = s._refs;
  r.grid.style.display = "none";
  wkShow(false);
  var p = r.ymPane;
  p.className = "dpk-ym-pane show";
  p.innerHTML = "";
  var wrap = document.createElement("div"); wrap.className = "dpk-ym-grid year";
  var y0 = Math.floor(s.view.y/9)*9;
  for(var i=0;i<9;i++){
    (function(yy){
      var c = document.createElement("button"); c.type = "button";
      c.className = "dpk-ym-cell" + (yy===s.view.y?" sel":"");
      c.textContent = yy;
      c.onclick = function(){ s.view.y = yy; _dpkRefresh(); };
      wrap.appendChild(c);
    })(y0+i);
  }
  p.appendChild(wrap);

  /* 上下翻 9 年的两个按钮：复用 nav 区域 */
  r.prev.onclick = function(){ s.view.y -= 9; _dpkRefresh(); _dpkShowYear(); };
  r.next.onclick = function(){ s.view.y += 9; _dpkRefresh(); _dpkShowYear(); };
}
export function _dpkShowMonth(){
  var s = _dpkState; if(!s) return;
  var r = s._refs;
  r.grid.style.display = "none";
  wkShow(false);
  var p = r.ymPane;
  p.className = "dpk-ym-pane show";
  p.innerHTML = "";
  var wrap = document.createElement("div"); wrap.className = "dpk-ym-grid month";
  for(var i=0;i<12;i++){
    (function(mm){
      var c = document.createElement("button"); c.type = "button";
      c.className = "dpk-ym-cell" + (mm===s.view.m?" sel":"") + (mm===new Date().getMonth() && s.view.y===new Date().getFullYear()?" cur":"");
      c.textContent = (mm+1) + "月";
      c.onclick = function(){ s.view.m = mm; _dpkRefresh(); };
      wrap.appendChild(c);
    })(i);
  }
  p.appendChild(wrap);

  /* 月视图时上下按钮改回切年 */
  r.prev.onclick = function(){ s.view.y--; _dpkRefresh(); _dpkShowMonth(); };
  r.next.onclick = function(){ s.view.y++; _dpkRefresh(); _dpkShowMonth(); };
}
export function wkShow(on){
  var pk = document.getElementById("dpk");
  var w = pk.querySelector(".dpk-week");
  if(w) w.style.display = on ? "" : "none";
}

export function _dpkRenderDays(argSelected){
  var s = _dpkState; if(!s) return;
  var r = s._refs;
  var cur = _dpkParseIso(s.value || "");
  /* 如果新传入选中且月份/年份对应不上 view，则滑过去；否则保持 view */
  if(argSelected && (argSelected.y !== s.view.y || argSelected.m !== s.view.m)){
    s.view.y = argSelected.y; s.view.m = argSelected.m;
    _dpkRefresh();
    return;
  }
  var sel = cur && cur.y===s.view.y && cur.m===s.view.m ? cur.d : -1;
  var today = _dpkParseIso(_dpkTodayStr());
  var grid = r.grid;
  grid.innerHTML = "";

  var firstWeekday = (new Date(s.view.y, s.view.m, 1).getDay() + 6) % 7;   /* 周一=0 */
  var dim = _dpkDaysIn(s.view.y, s.view.m);
  var prevDim = _dpkDaysIn(s.view.y, s.view.m===0 ? 11 : s.view.m-1);
  var prevY = s.view.m===0 ? s.view.y-1 : s.view.y;
  var prevM = s.view.m===0 ? 11 : s.view.m-1;
  var nextY = s.view.m===11 ? s.view.y+1 : s.view.y;
  var nextM = s.view.m===11 ? 0 : s.view.m+1;

  for(var i=0;i<firstWeekday;i++){
    var d = prevDim - firstWeekday + 1 + i;
    grid.appendChild(_dpkDayBtn(prevY, prevM, d, true));
  }
  for(var d=1; d<=dim; d++){
    var isSel = (d===sel);
    var isToday = today && today.y===s.view.y && today.m===s.view.m && today.d===d;
    grid.appendChild(_dpkDayBtn(s.view.y, s.view.m, d, false, isSel, isToday));
  }
  /* 补齐 6 行（最多 42 格） */
  var total = firstWeekday + dim;
  var tail = (Math.ceil(total/7)*7) - total;
  for(var i=1;i<=tail;i++){
    grid.appendChild(_dpkDayBtn(nextY, nextM, i, true));
  }
}

export function _dpkDayBtn(y, m, d, muted, sel, today){
  var b = document.createElement("button");
  b.type = "button";
  b.className = "dpk-day" + (muted?" muted":"") + (sel?" sel":"") + (today?" today":"");
  b.textContent = d;
  b.tabIndex = muted ? -1 : 0;
  (function(yy,mm,dd){
    b.onclick = function(){
      var s = _dpkState;
      var v = yy + "-" + _dpkPad(mm+1) + "-" + _dpkPad(dd);
      s.onPick(v);
      closeDatePicker(true);
    };
  })(y, m, d);
  return b;
}

/* 取本地「昨天」的 YYYY-MM-DD 字符串；与 Python 端 _resolve_days() 默认行为保持一致 */
export function _yesterdayStr(){
  var d = new Date();
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + "-" +
         String(d.getMonth()+1).padStart(2,"0") + "-" +
         String(d.getDate()).padStart(2,"0");
}

/* 判断一个 date 参数的 placeholder 是否声明了「默认昨天」语义（与 Python 端
   _resolve_days 默认值对齐）。命中时该参数的空值会被预填为昨天，等同「勾选默认」 */
export function _defaultsToYesterday(p){
  if(!p) return false;
  var ph = String(p.placeholder || "");
  return ph.indexOf("默认昨天") >= 0 || /T-1/.test(ph);
}

export function renderDateRangeGroup(task){
  var g = dateRangeGroupFlags(task);
  if(!g) return null;
  var curDate = argValue(task.id, {flag:g.single}) || "";
  var curStart = argValue(task.id, {flag:g.start}) || "";
  var curEnd = argValue(task.id, {flag:g.end}) || "";
  /* 三个值都空 = 用户从未保存过日期参数 → 按 Python 端 _resolve_days 默认「昨天」预填，
     让 UI 与脚本默认行为同步（避免「脚本跑昨天，配置界面却空着」让人误以为漏配） */
  if(!curDate && !curStart && !curEnd){
    curDate = _yesterdayStr();
    store.ui.cfDateMode = "single";
  } else {
    store.ui.cfDateMode = curDate ? "single" : "range";
  }

  var wrap = document.createElement("div");
  wrap.className = "cf-dr";

  var head = document.createElement("div");
  head.className = "cf-dr-head";
  /* head 里加一行「留空 = 默认昨天」提示，与脚本端默认逻辑对齐 */
  head.innerHTML = '<span class="cf-dr-title">日期范围</span>'+
    '<span class="cf-dr-hint">留空 = 默认昨天</span>';
  var radios = document.createElement("div");
  radios.className = "cf-dr-radios";
  [["single","单日"],["range","多日"]].forEach(function(pair){
    var lab = document.createElement("label");
    lab.className = "cf-radio";
    var r = document.createElement("input");
    r.type = "radio"; r.name = "cfDrMode"; r.value = pair[0];
    r.checked = (store.ui.cfDateMode === pair[0]);
    r.onchange = function(){ store.ui.cfDateMode = pair[0]; syncDrPanels(); };
    lab.appendChild(r);
    lab.appendChild(document.createTextNode(" " + pair[1]));
    radios.appendChild(lab);
  });
  head.appendChild(radios);
  wrap.appendChild(head);

  var pSingle = document.createElement("div");
  pSingle.className = "cf-dr-panel";
  pSingle.id = "cfDrSingle";
  /* 单日日期触发器：隐藏的 input.dpk-value 存 yyyy-mm-dd，供 commitDateRangeGroup 读取 */
  var singleTrigger = createDateTrigger(curDate);
  singleTrigger.id = "cfDrDate";
  var lab1 = document.createElement("label"); lab1.className = "cf-dr-lab"; lab1.textContent = "单日";
  pSingle.appendChild(lab1);
  pSingle.appendChild(singleTrigger);
  wrap.appendChild(pSingle);

  var pRange = document.createElement("div");
  pRange.className = "cf-dr-panel";
  pRange.id = "cfDrRange";
  /* 起 / 止两个 trigger */
  var startTrigger = createDateTrigger(curStart);
  startTrigger.id = "cfDrStart";
  var endTrigger = createDateTrigger(curEnd);
  endTrigger.id = "cfDrEnd";
  var lab2 = document.createElement("label"); lab2.className = "cf-dr-lab"; lab2.textContent = "起";
  var lab3 = document.createElement("label"); lab3.className = "cf-dr-lab"; lab3.textContent = "止";
  pRange.appendChild(lab2); pRange.appendChild(startTrigger);
  pRange.appendChild(lab3); pRange.appendChild(endTrigger);
  wrap.appendChild(pRange);

  function syncDrPanels(){
    pSingle.style.display = (store.ui.cfDateMode==="single") ? "" : "none";
    pRange.style.display  = (store.ui.cfDateMode==="range")  ? "" : "none";
  }
  syncDrPanels();
  return wrap;
}
