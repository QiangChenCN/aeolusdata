import { store, groupOf, taskById, countInGroup, producerOf, missingText, visibleTasks, taskState, argValue } from "./store.js";
import { api, savePrefs, loadPrefs, readTokens, withToken, ensureTeams, __API_TOKEN__ } from "./api.js";
import { svg, esc, hexA, toast, debounce, viewHead } from "./ui.js";
import { TK, TK_MAP, RISK_LABEL, RISK_CLS, STATUS_CLS, STATUS_TXT, ICON } from "./tokens.js";
import { bus } from "./bus.js";
import { refreshLan, bindLanToggle, setArg, openSide, closeSide, askConfirm, closeConfirm, bindConfirmUI, lockScroll, unlockScroll } from "./behavior.js";
const state = store.state;

/* ================= 工作内容（提醒事项）· 数据层 =================
   单独存一份 localStorage（键 wb_fengshen_todo_v1），与任务参数偏好互不干扰 ——
   待办是个人事务，不该和任务运行参数混在一个键里。
   结构：{ lists:[{id,name,icon,color}], items:[{id,listId,title,note,done,doneAt,remindAt,flag,createdAt}] }
   · remindAt："2026-09-06" 或 "2026-09-06T18:30"，空串 = 不提醒
   · flag=true 标重要（对应 iPad 提醒事项的旗标） */
/* 数据存在后端 SQLite（server/data/todo.db），通过 /api/todo 读写 ——
   换浏览器、换设备、多人看同一台机器都是同一份数据，不会像 localStorage 那样
   清一下缓存就没了。TODO_KEY 只留着做一次性迁移：老版本存在本地的数据，
   首次加载时若服务端为空就自动搬过去，搬完清空本地残留。 */
var TODO_KEY = "wb_fengshen_todo_v1";
export function todoDefaultLists(){
  return [
    { id:"l_work",    name:"工作", icon:"list-checks", color:"#FF5000" },
    { id:"l_station", name:"站点", icon:"store",       color:"#1A73E8" },
    { id:"l_temp",    name:"临时", icon:"lightbulb",   color:"#F5A623" }
  ];
}
export function todoLocalClone(){
  try{ return JSON.parse(localStorage.getItem(TODO_KEY) || "null"); }catch(e){ return null; }
}
export function todoDropLocal(){ try{ localStorage.removeItem(TODO_KEY); }catch(e){} }

/* 拉全量数据。cb 可选，用于「改完立刻重画」。 */
export function todoReload(cb){
  return api("/api/todo")
    .then(function(j){
      if(!j || !j.ok) throw new Error((j && j.error) || "读取工作内容失败");
      var d = j.todo || {};
      state.todo = { lists:d.lists || [], items:d.items || [], sched:d.scheduler || null };
      if(typeof cb === "function") cb();
      bus.emit("refresh");
    }).catch(function(e){
      if(!state.todo) state.todo = { lists:todoDefaultLists(), items:[] };
      console.warn("[todo] 加载失败：", e && e.message);
      bus.emit("refresh");
    });
}

/* 写操作统一入口：调接口 → 成功后重载。失败弹提示，不让界面和数据跑偏。 */
export function todoApi(path, payload){
  return fetch(path, {
    method:"POST", headers:{ "Content-Type":"application/json", "X-Token":__API_TOKEN__ },
    body: JSON.stringify(payload || {})
  }).then(function(r){ return r.json(); })
    .then(function(j){
      if(!j || !j.ok) throw new Error((j && j.error) || "操作失败");
      return j;
    });
}
/* 首次进入时把 localStorage 时代的旧数据搬进数据库（仅在服务端为空时执行） */
export function todoMigrateLocal(){
  var old = todoLocalClone();
  if(!old || !old.items || !old.items.length) return Promise.resolve();
  return todoApi("/api/todo/import", old).then(function(j){
    todoDropLocal();
    if(j && (j.items || j.lists)) toast("已把本地 " + (j.items||0) + " 条待办迁入数据库");
    return todoReload();
  }).catch(function(){ return Promise.resolve(); });
}
export function loadTodo(){
  return todoReload(function(){
    if(!state.todo.items.length) todoMigrateLocal();
  });
}
export function saveTodo(){
  /* 已废弃：数据由后端落库，本地不再存副本。
     保留空实现是为了让还没改干净的调用点不至于报错。 */
}
export function todoOpenCount(){
  if(!state.todo) return 0;
  return state.todo.items.filter(function(x){ return !x.done; }).length;
}
export function todoUid(p){
  return (p||"i") + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}
export function todoListById(id){
  if(!state.todo) return null;
  for(var i=0;i<state.todo.lists.length;i++) if(state.todo.lists[i].id===id) return state.todo.lists[i];
  return null;
}
/* 关联任务的名字（任务中心的任务表在 state.tasks 里） */
export function taskNameOf(tid){
  for(var i=0;i<state.tasks.length;i++) if(state.tasks[i].id===tid) return state.tasks[i].name;
  return tid;
}

/* ---- 待办日期小工具（前缀 td*，只服务工作内容视图） ---- */
export function tdPad(n){ return (n<10?"0":"") + n; }
export function tdToday(){
  var d = new Date();
  return d.getFullYear()+"-"+tdPad(d.getMonth()+1)+"-"+tdPad(d.getDate());
}
export function tdNowHM(){
  var d = new Date();
  return tdPad(d.getHours())+":"+tdPad(d.getMinutes());
}
export function tdShift(days){
  var d = new Date(); d.setDate(d.getDate()+days);
  return d.getFullYear()+"-"+tdPad(d.getMonth()+1)+"-"+tdPad(d.getDate());
}
/* "2026-09-06T18:30" → "今天 18:30" / "9月8日 周二" */
export function tdFmt(s){
  if(!s) return "";
  var d = s.slice(0,10), t = s.slice(11,16);
  var dt = new Date(d+"T00:00:00");
  if(isNaN(dt.getTime())) return s;
  var lab;
  if(d === tdToday())           lab = "今天";
  else if(d === tdShift(1))     lab = "明天";
  else if(d === tdShift(-1))    lab = "昨天";
  else lab = (dt.getMonth()+1)+"月"+dt.getDate()+"日 "+
             ["周日","周一","周二","周三","周四","周五","周六"][dt.getDay()];
  return t ? (lab+" "+t) : lab;
}
export function tdOverdue(it){
  if(it.done || !it.remindAt) return false;
  return it.remindAt.slice(0,16) < (tdToday() + "T" + tdNowHM());
}
/* 归入「今天」：有提醒且日期不晚于今天（含逾期，逾期在列表里标红） */
export function tdIsToday(it){
  if(it.done || !it.remindAt) return false;
  return it.remindAt.slice(0,10) <= tdToday();
}

/* ================= 工作内容（参照 iPad 提醒事项） =================
   顶部四宫格 = 智能分组（今天 / 计划 / 全部 / 已完成，跨列表统计）；
   左侧「我的列表」= 按列表过滤。两者互斥 —— 与 iPad 一致：点哪个就切到哪个视角。
   圆圈沿用所属列表的颜色，勾中即填色打勾、标题划掉；点标题进详情设提醒与备注。 */
export function todoView(){
  if(!state.todoView) state.todoView = { mode:"smart", smart:"today", listId:"" };
  return state.todoView;
}
export function todoFind(id){
  if(!state.todo) return null;
  for(var i=0;i<state.todo.items.length;i++) if(state.todo.items[i].id===id) return state.todo.items[i];
  return null;
}
export function todoCountsByList(id){
  if(!state.todo) return 0;
  return state.todo.items.filter(function(x){ return !x.done && x.listId===id; }).length;
}
export function todoFiltered(){
  var v = todoView(), items = state.todo ? state.todo.items : [];
  if(v.mode === "list")  return items.filter(function(x){ return !x.done && x.listId===v.listId; });
  if(v.smart === "done") return items.filter(function(x){ return x.done; });
  if(v.smart === "today")return items.filter(function(x){ return !x.done && tdIsToday(x); });
  if(v.smart === "planned") return items.filter(function(x){ return !x.done && !!x.remindAt; });
  return items.filter(function(x){ return !x.done; });          // all
}
/* 有提醒的按时间升序在前，没提醒的按创建时间倒序在后 */
export function todoSort(a,b){
  var ra = a.remindAt || "", rb = b.remindAt || "";
  if(ra && rb) return ra.localeCompare(rb);
  if(ra) return -1;
  if(rb) return 1;
  return String(b.createdAt||"").localeCompare(String(a.createdAt||""));
}
export function defaultListId(){
  var v = todoView();
  if(v.mode==="list" && v.listId) return v.listId;
  return (state.todo && state.todo.lists[0]) ? state.todo.lists[0].id : "";
}

export function renderTodoView(host){
  var v = todoView();
  var items = state.todo ? state.todo.items : [];
  var open = todoOpenCount();

  host.appendChild(viewHead("工作内容",
    "提醒事项 · 未完成 " + open + " 条，共 " + items.length + " 条",
    "list-checks", TK.brand, ""));

  /* --- 顶部四宫格（智能分组） --- */
  var defs = [
    { key:"today",   name:"今天",   icon:"sun",           color:TK.info,
      sub:"今天到期 · 含逾期", n: items.filter(function(x){ return !x.done && tdIsToday(x); }).length },
    { key:"planned", name:"计划",   icon:"calendar-days", color:TK.brand,
      sub:"已设定提醒日期",     n: items.filter(function(x){ return !x.done && !!x.remindAt; }).length },
    { key:"all",     name:"全部",   icon:"inbox",         color:TK.neutral,
      sub:"全部未完成事项",     n: open },
    { key:"done",    name:"已完成", icon:"check-circle",  color:TK.ok,
      sub:"已勾选完成",         n: items.length - open }
  ];
  var top = document.createElement("div");
  top.className = "rmd-top";
  defs.forEach(function(s){
    var on = (v.mode==="smart" && v.smart===s.key);
    var b = document.createElement("button");
    b.type = "button";
    b.className = "rmd-card" + (on?" on":"");
    b.innerHTML = '<div class="rc-ic" style="background:'+s.color+'">'+svg(s.icon)+'</div>'+
                  '<div class="rc-b"><div class="rc-n">'+esc(s.name)+'</div>'+
                  '<div class="rc-s">'+esc(s.sub)+'</div></div>'+
                  '<div class="rc-ct" style="color:'+s.color+'">'+s.n+'</div>';
    b.onclick = function(){ v.mode="smart"; v.smart=s.key; bus.emit("refresh"); };
    top.appendChild(b);
  });
  host.appendChild(top);

  /* --- 列表栏 + 任务区 --- */
  var body = document.createElement("div");
  body.className = "rmd-body";
  body.appendChild(todoSide(v));
  body.appendChild(todoMain(v));
  host.appendChild(body);
}

/* 左栏：我的列表（双击改名/编辑，+ 新建列表） */
export function todoSide(v){
  var side = document.createElement("div");
  side.className = "rmd-side";

  var h = document.createElement("div");
  h.className = "rmd-side-h";
  h.innerHTML = "<span>我的列表</span><span class='sp'></span>";
  var add = document.createElement("button");
  add.type = "button"; add.title = "新建列表"; add.innerHTML = svg("plus","ic ic-sm");
  add.onclick = function(){ openListEditor(null); };
  h.appendChild(add);
  side.appendChild(h);

  (state.todo ? state.todo.lists : []).forEach(function(l){
    var on = (v.mode==="list" && v.listId===l.id);
    var b = document.createElement("button");
    b.type = "button";
    b.className = "rmd-lst" + (on?" on":"");
    b.title = l.name + "（双击编辑）";
    b.innerHTML = '<div class="rl-ic" style="background:'+l.color+'">'+svg(l.icon,"ic")+'</div>'+
                  '<span class="rl-nm">'+esc(l.name)+'</span>'+
                  '<span class="rl-ct">'+todoCountsByList(l.id)+'</span>';
    b.onclick = function(){ v.mode="list"; v.listId=l.id; bus.emit("refresh"); };
    b.ondblclick = function(e){ e.preventDefault(); openListEditor(l); };
    side.appendChild(b);
  });
  return side;
}

/* 右栏：当前视角的任务列表 + 底部新建输入 */
export function todoMain(v){
  var main = document.createElement("div");
  main.className = "rmd-main";

  var title, sub;
  if(v.mode === "list"){
    var l = todoListById(v.listId);
    title = l ? l.name : "列表";
    sub = "该列表下未完成的事项";
  }else{
    title = { today:"今天", planned:"计划", all:"全部", done:"已完成" }[v.smart] || "全部";
    sub   = { today:"今天到期与已逾期", planned:"已设定提醒日期",
              all:"全部未完成事项",     done:"已勾选完成" }[v.smart] || "";
  }
  var head = document.createElement("div");
  head.className = "rmd-mh";
  head.innerHTML = '<span class="t">'+esc(title)+'</span><span class="c">'+esc(sub)+'</span><span class="sp"></span>';
  main.appendChild(head);

  var list = todoFiltered().sort(todoSort);
  var box = document.createElement("div");
  box.className = "rmd-items";
  if(!list.length){
    var e = document.createElement("div");
    e.className = "empty";
    e.textContent = (v.mode==="list") ? "这个列表还没有待办。" : "这里没有事项。";
    box.appendChild(e);
  }else{
    list.forEach(function(it){ box.appendChild(todoRow(it)); });
  }
  main.appendChild(box);

  var add = document.createElement("div");
  add.className = "rmd-add";
  var pl = document.createElement("div");
  pl.className = "pl";
  add.appendChild(pl);
  var inp = document.createElement("input");
  inp.type = "text";
  inp.placeholder = "添加提醒事项…（回车即存，默认放进当前列表）";
  inp.onkeydown = function(ev){
    if(ev.key !== "Enter") return;
    var t = inp.value.trim();
    if(!t) return;
    todoAdd(t, defaultListId());
  };
  add.appendChild(inp);
  main.appendChild(add);
  return main;
}

/* 单条事项：圆圈（列表色）+ 标题（点进详情）+ meta（提醒/重要/备注）+ 删除 */
export function todoRow(it){
  var l = todoListById(it.listId) || { color:TK.brand, name:"" };
  var row = document.createElement("div");
  row.className = "rmd-row" + (it.done ? " done" : "");

  var cir = document.createElement("button");
  cir.type = "button";
  cir.className = "rmd-cir";
  cir.innerHTML = svg("check");
  cir.title = it.done ? "标为未完成" : "标记完成";
  if(it.done){ cir.style.background = l.color; cir.style.borderColor = l.color; }
  else if(l.color){ cir.style.borderColor = l.color; }
  cir.onclick = function(){ todoToggle(it.id); };
  row.appendChild(cir);

  var cnt = document.createElement("button");
  cnt.type = "button";
  cnt.className = "rmd-cnt";
  cnt.title = "点开设置提醒与备注";
  var meta = "";
  if(it.remindAt){
    meta += '<span class="m'+(tdOverdue(it)?" over":"")+'">'+svg("bell","ic")+
            esc(tdFmt(it.remindAt))+(tdOverdue(it)?" · 已逾期":"")+'</span>';
  }
  if(it.flag) meta += '<span class="m flag">'+svg("flag","ic")+'重要</span>';
  if(it.repeatType && it.repeatType !== "none"){
    meta += '<span class="rmd-tag">'+svg("retry","ic")+esc(it.repeatLabel || "重复")+'</span>';
  }
  if(it.taskId){
    meta += '<span class="rmd-tag'+(it.autoRun ? " auto" : "")+'">'+svg("bolt","ic")+
            esc(taskNameOf(it.taskId))+(it.autoRun ? " · 自动" : "")+'</span>';
    if(it.linkState && it.linkState !== "ok"){
      meta += '<span class="rmd-tag bad">'+svg("warn","ic")+
              (it.linkState === "missing" ? "任务已不存在" : "任务已禁用")+'</span>';
    }
  }
  if(it.hasOpenRun)            meta += '<span class="rmd-tag run">执行中</span>';
  else if(it.lastRunStatus === "failed") meta += '<span class="rmd-tag bad">上次失败</span>';
  if(it.note){
    var sn = it.note.length > 20 ? (it.note.slice(0,20)+"…") : it.note;
    meta += '<span class="m">'+svg("sticky-note","ic")+esc(sn)+'</span>';
  }
  cnt.innerHTML = '<div class="rmd-tt">'+esc(it.title)+'</div>' +
                  (meta ? '<div class="rmd-meta">'+meta+'</div>' : "");
  cnt.onclick = function(){ openTodoEditor(it.id); };
  row.appendChild(cnt);

  var del = document.createElement("button");
  del.type = "button";
  del.className = "rmd-del";
  del.title = "删除";
  del.innerHTML = svg("trash","ic");
  del.onclick = function(){ todoRemove(it.id); };
  row.appendChild(del);
  return row;
}

/* ---------- 数据操作（改完统一 saveTodo + refreshAll，与其它视图同一套路） ---------- */
export function todoToggle(id){
  var it = todoFind(id); if(!it) return;
  // 先本地翻转，界面立刻响应；服务端返回后再以服务端为准重载
  it.done = !it.done;
  bus.emit("refresh");
  todoApi("/api/todo/items", { op:"toggle", id:id, done:it.done })
    .then(function(j){
      if(j && j.item && j.item.repeatType && j.item.repeatType !== "none"){
        toast("已完成，下一次：" + tdFmt(j.item.remindAt || ""));
      }
      return todoReload();
    })
    .catch(function(e){ todoReload(); toast(e.message || "操作失败"); });
}
export function todoAdd(title, listId){
  todoApi("/api/todo/items", {
    op:"create", title:title, list_id: listId || defaultListId()
  }).then(function(){ return todoReload(); })
    .catch(function(e){ toast(e.message || "新建失败"); });
}
export function todoRemove(id){
  todoApi("/api/todo/items", { op:"delete", id:id })
    .then(function(){ return todoReload(); })
    .catch(function(e){ todoReload(); toast(e.message || "删除失败"); });
}

/* ---------- 重复规则编辑器 ----------
   五种：不重复 / 每天（每 N 天）/ 每周（每 N 周 + 星期多选）/
   每月（每 N 个月 + 几号或最后一天）/ 自定义（每 N 小时）。
   存进库的是 {type, interval, by, end}，显示文案由后端 describe_rule 统一算好下发，
   这里只负责把用户的选择收成一个规则对象。 */
var TD_WEEK = ["一","二","三","四","五","六","日"];
export function todoRepeatEditor(item){
  var rule = {
    type:     item.repeatType || "none",
    interval: Math.max(1, parseInt(item.repeatInterval, 10) || 1),
    by:       item.repeatBy || "",
    end:      item.repeatEnd || ""
  };
  var wrap = document.createElement("div");
  wrap.className = "cf-row";
  var lb = document.createElement("label");
  lb.textContent = "重复";
  wrap.appendChild(lb);

  var box = document.createElement("div");
  box.className = "td-rpt";
  var top = document.createElement("div");
  top.className = "td-rpt-top";

  var sel = document.createElement("select");
  sel.className = "td-sel";
  [["none","不重复"],["daily","每天"],["weekly","每周"],
   ["monthly","每月"],["custom","自定义周期"]].forEach(function(o){
    var op = document.createElement("option");
    op.value = o[0]; op.textContent = o[1];
    sel.appendChild(op);
  });
  sel.value = rule.type;

  var num = document.createElement("input");
  num.type = "number"; num.className = "td-num"; num.min = "1"; num.max = "999";
  num.value = rule.interval;

  var unit = document.createElement("span");
  unit.className = "td-hint";
  top.appendChild(sel); top.appendChild(num); top.appendChild(unit);
  box.appendChild(top);

  var ex = document.createElement("div");
  ex.className = "td-rpt-ex";
  box.appendChild(ex);

  var hint = document.createElement("div");
  hint.className = "td-hint";
  box.appendChild(hint);
  wrap.appendChild(box);

  function hintText(){
    var t = sel.value, n = Math.max(1, parseInt(num.value, 10) || 1);
    if(t === "daily")   return n === 1 ? "每天在此提醒一次" : ("每 " + n + " 天在此提醒一次");
    if(t === "weekly")  return n === 1 ? "每周选定的日子提醒" : ("每 " + n + " 周的选定日提醒");
    if(t === "monthly") return rule.by === "L" ? "每月最后一天提醒" : ("每月 " + (rule.by || 1) + " 日提醒");
    if(t === "custom")  return "每 " + n + " 小时提醒一次（从提醒时间起算）";
    return "只提醒一次，勾选完成后归入「已完成」";
  }

  function render(){
    var t = sel.value;
    num.style.display = (t === "none") ? "none" : "";
    ex.innerHTML = "";
    if(t === "daily"){
      unit.textContent = "天";
    }else if(t === "weekly"){
      unit.textContent = "周";
      if(!rule.by) rule.by = String((new Date().getDay() || 7));   // 默认今天
      var cur = rule.by.split(",");
      [1,2,3,4,5,6,7].forEach(function(d){
        var c = document.createElement("button");
        c.type = "button";
        c.className = "td-chip" + (cur.indexOf(String(d)) >= 0 ? " on" : "");
        c.textContent = TD_WEEK[d-1];
        c.style.padding = "var(--sp-5) var(--sp-10)";
        c.onclick = function(){
          var arr = rule.by.split(",");
          var i = arr.indexOf(String(d));
          if(i >= 0) arr.splice(i, 1); else arr.push(String(d));
          arr.sort(function(a, b){ return a - b; });
          if(!arr.length) arr.push(String(d));      // 至少留一天，否则算不出下一次
          rule.by = arr.join(",");
          render();
        };
        ex.appendChild(c);
      });
    }else if(t === "monthly"){
      unit.textContent = "个月";
      if(!rule.by) rule.by = String(new Date().getDate());
      var l1 = document.createElement("span"); l1.textContent = "每月"; ex.appendChild(l1);
      var mi = document.createElement("input");
      mi.type = "number"; mi.className = "td-num"; mi.min = "1"; mi.max = "31";
      mi.value = /^\d+$/.test(rule.by) ? rule.by : String(new Date().getDate());
      mi.oninput = function(){
        rule.by = String(Math.max(1, Math.min(31, parseInt(mi.value, 10) || 1)));
        hint.textContent = hintText();               // 只改文案，不重建，避免输入焦点丢失
      };
      ex.appendChild(mi);
      var l2 = document.createElement("span"); l2.textContent = "日"; ex.appendChild(l2);
      var last = document.createElement("button");
      last.type = "button";
      last.className = "td-chip" + (rule.by === "L" ? " on" : "");
      last.textContent = "或用最后一天";
      last.onclick = function(){
        rule.by = (rule.by === "L") ? String(new Date().getDate()) : "L";
        render();
      };
      ex.appendChild(last);
    }else if(t === "custom"){
      unit.textContent = "小时";
    }else{
      unit.textContent = "";
    }
    if(t !== "none"){
      var el = document.createElement("span"); el.textContent = "结束于"; ex.appendChild(el);
      var ei = document.createElement("input");
      ei.type = "date"; ei.className = "td-sel"; ei.value = rule.end || "";
      ei.onchange = function(){ rule.end = ei.value || ""; };
      ex.appendChild(ei);
    }
    hint.textContent = hintText();
  }

  sel.onchange = function(){ rule.type = sel.value; render(); };
  num.oninput  = function(){
    rule.interval = Math.max(1, Math.min(999, parseInt(num.value, 10) || 1));
    hint.textContent = hintText();
  };
  render();

  return { el: wrap, get: function(){
    var t = sel.value;
    return { type: t,
             interval: Math.max(1, parseInt(num.value, 10) || 1),
             by: (t === "weekly" || t === "monthly") ? (rule.by || "") : "",
             end: rule.end || "" };
  }};
}

/* ---------- 关联任务编辑器 ----------
   选中任务后可开「到点自动执行」；任务若已被删除/禁用，显示告警但不自动解绑 ——
   解绑与否由用户决定，不替用户做数据销毁的决定。 */
export function todoTaskEditor(item){
  var wrap = document.createElement("div");
  wrap.className = "cf-row";
  var lb = document.createElement("label");
  lb.textContent = "关联任务";
  wrap.appendChild(lb);

  var row = document.createElement("div");
  row.className = "td-task";
  var sel = document.createElement("select");
  sel.className = "td-sel";
  var o0 = document.createElement("option");
  o0.value = ""; o0.textContent = "不关联";
  sel.appendChild(o0);
  state.tasks.forEach(function(t){
    var op = document.createElement("option");
    op.value = t.id;
    op.textContent = groupOf(t.group).name + " · " + t.name;
    sel.appendChild(op);
  });
  sel.value = item.taskId || "";
  row.appendChild(sel);

  var go = document.createElement("button");
  go.type = "button"; go.className = "btn-cancel";
  go.innerHTML = svg("bolt","ic ic-sm") + "立即执行";
  go.title = "立刻跑一次（不影响定时计划）";
  go.onclick = function(){
    todoApi("/api/todo/trigger", { item_id: item.id })
      .then(function(){ toast("已触发执行，可在任务中心看日志"); return todoReload(); })
      .catch(function(e){ toast(e.message || "触发失败"); });
  };
  row.appendChild(go);
  wrap.appendChild(row);

  var autoWrap = document.createElement("label");
  autoWrap.className = "td-sw" + (item.autoRun ? " on" : "");
  var cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = !!item.autoRun;
  cb.onchange = function(){ autoWrap.className = "td-sw" + (cb.checked ? " on" : ""); syncHint(); };
  autoWrap.appendChild(cb);
  autoWrap.appendChild(document.createTextNode("到点自动执行"));
  wrap.appendChild(autoWrap);

  var hint = document.createElement("div");
  hint.className = "td-hint";
  wrap.appendChild(hint);
  function syncHint(){
    if(!sel.value)      hint.textContent = "不关联时只作普通提醒，不会自动跑任务。";
    else if(cb.checked) hint.textContent = "到提醒时间自动把该任务加入执行队列（同一时刻只会跑一次）。";
    else                hint.textContent = "已关联，但只提醒不自动执行，需要时点「立即执行」。";
  }

  var warn = null;
  function syncWarn(){
    var bad = sel.value && item.linkState && item.linkState !== "ok";
    if(bad && !warn){
      warn = document.createElement("div");
      warn.className = "td-warn";
      warn.innerHTML = svg("info","ic") +
        "<span>关联的" + (item.linkState === "missing" ? "任务已不存在" : "任务已被禁用") +
        "，到点会跳过执行。可改选其它任务或取消关联。</span>";
      wrap.appendChild(warn);
    }
  }
  sel.onchange = function(){
    if(!sel.value) cb.checked = false;
    syncHint(); syncWarn();
  };
  syncHint(); syncWarn();

  return { el: wrap, getTaskId: function(){ return sel.value; },
           getAutoRun: function(){ return !!cb.checked && !!sel.value; } };
}

/* ---------- 执行记录 ---------- */
var TD_RUN_COLOR = { success:TK.ok, failed:TK.err, missed:TK.warn,
                     skipped:TK.warn, running:TK.info, retrying:TK.warn };
var TD_RUN_NAME  = { success:"成功", failed:"失败", missed:"错过", skipped:"跳过",
                     running:"运行中", retrying:"等待重试" };
export function todoRunRow(r){
  var d = document.createElement("div");
  d.className = "td-run";
  var dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = TD_RUN_COLOR[r.status] || TK.neutral;
  d.appendChild(dot);
  var when = document.createElement("span");
  when.className = "when";
  var due = (r.dueAt || r.due_at || "");
  when.textContent = due.replace("T", " ").slice(0, 16) +
                     ((r.attempt || 0) > 1 ? (" · 第" + r.attempt + "次") : "");
  d.appendChild(when);
  var msg = document.createElement("span");
  msg.className = "msg";
  var name = TD_RUN_NAME[r.status] || r.status;
  msg.textContent = name + (r.message ? (" · " + r.message) : "");
  msg.title = msg.textContent;
  d.appendChild(msg);
  return d;
}
export function todoRunsBlock(item){
  var wrap = document.createElement("div");
  wrap.className = "cf-row";
  var lb = document.createElement("label");
  lb.textContent = "执行记录";
  wrap.appendChild(lb);
  var box = document.createElement("div");
  box.className = "td-runs";
  var ph = document.createElement("div");
  ph.className = "td-run-empty"; ph.textContent = "加载中…";
  box.appendChild(ph);
  wrap.appendChild(box);

  api("/api/todo/runs?item_id=" + encodeURIComponent(item.id) + "&limit=8")
    .then(function(j){
      var runs = (j && j.runs) || [];
      box.innerHTML = "";
      if(!runs.length){
        var e = document.createElement("div");
        e.className = "td-run-empty"; e.textContent = "还没有执行过。";
        box.appendChild(e);
        return;
      }
      runs.forEach(function(x){ box.appendChild(todoRunRow(apiRun(x))); });
    }).catch(function(){
      box.innerHTML = "";
      var e = document.createElement("div");
      e.className = "td-run-empty"; e.textContent = "执行记录加载失败。";
      box.appendChild(e);
    });
  return wrap;
}
/* 后端的执行记录是蛇形字段，这里转驼峰后统一渲染 */
export function apiRun(r){
  return { status:r.status, attempt:r.attempt, message:r.message || "",
           dueAt:r.due_at || r.dueAt || "" };
}

/* ---------- 事项详情弹窗（设提醒 / 备注 / 归组 / 标重要） ---------- */
export function closeTodoEditor(){
  document.getElementById("tdMask").className = "td-mask";
}
export function openTodoEditor(id){
  var it = todoFind(id); if(!it) return;
  var box = document.getElementById("tdBox");
  box.innerHTML = "";

  var head = document.createElement("div");
  head.className = "cf-head";
  head.innerHTML = '<div class="cf-tit">'+svg("list-checks","ic")+
    '<div><b>编辑事项</b><span class="sub">设置提醒时间、备注与所属列表</span></div></div>';
  var close = document.createElement("button");
  close.type = "button"; close.className = "cf-close"; close.innerHTML = svg("close","ic ic-sm");
  close.onclick = closeTodoEditor;
  head.appendChild(close);
  box.appendChild(head);

  var body = document.createElement("div");
  body.className = "td-body";

  // 事项标题
  var r1 = document.createElement("div");
  r1.className = "cf-row";
  r1.innerHTML = "<label>事项</label>";
  var ti = document.createElement("input");
  ti.type = "text"; ti.value = it.title;
  r1.appendChild(ti); body.appendChild(r1);

  // 提醒：开关 + 日期 + 时间（原生控件，与配置弹窗的日期参数同一套观感）
  var r2 = document.createElement("div");
  r2.className = "cf-row";
  r2.innerHTML = "<label>提醒</label>";
  var sw = document.createElement("label");
  sw.className = "td-sw" + (it.remindAt ? " on" : "");
  var cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = !!it.remindAt;
  sw.appendChild(cb);
  sw.appendChild(document.createTextNode("设置提醒时间"));
  var dt = document.createElement("div");
  dt.className = "td-time";
  dt.style.display = it.remindAt ? "flex" : "none";
  var di = document.createElement("input");
  di.type = "date"; di.value = it.remindAt.slice(0,10) || tdToday();
  var tm = document.createElement("input");
  tm.type = "time"; tm.value = it.remindAt.slice(11,16) || "09:00";
  dt.appendChild(di); dt.appendChild(tm);
  cb.onchange = function(){
    dt.style.display = cb.checked ? "flex" : "none";
    sw.className = "td-sw" + (cb.checked ? " on" : "");
  };
  r2.appendChild(sw); r2.appendChild(dt);
  body.appendChild(r2);

  // 重复规则
  var rpt = todoRepeatEditor(it);
  body.appendChild(rpt.el);

  // 标记重要
  var r3 = document.createElement("div");
  r3.className = "cf-row";
  r3.innerHTML = "<label>标记</label>";
  var fl = document.createElement("label");
  fl.className = "td-sw" + (it.flag ? " on" : "");
  var fb = document.createElement("input");
  fb.type = "checkbox"; fb.checked = !!it.flag;
  fb.onchange = function(){ fl.className = "td-sw" + (fb.checked ? " on" : ""); };
  fl.appendChild(fb);
  fl.appendChild(document.createTextNode("标记重要"));
  r3.appendChild(fl); body.appendChild(r3);

  // 所属列表
  var r4 = document.createElement("div");
  r4.className = "cf-row";
  r4.innerHTML = "<label>所属列表</label>";
  var seg = document.createElement("div");
  seg.className = "td-seg";
  var curList = it.listId;
  (state.todo ? state.todo.lists : []).forEach(function(l){
    var c = document.createElement("button");
    c.type = "button";
    c.className = "td-chip" + (l.id===curList ? " on" : "");
    c.innerHTML = '<span style="width:8px;height:8px;border-radius:var(--r-circle);background:'+l.color+
                  ';display:inline-block"></span>'+esc(l.name);
    c.onclick = function(){
      curList = l.id;
      Array.prototype.forEach.call(seg.children, function(x){ x.className = "td-chip"; });
      c.className = "td-chip on";
    };
    seg.appendChild(c);
  });
  r4.appendChild(seg); body.appendChild(r4);

  // 关联任务（可选到点自动执行）
  var tsk = todoTaskEditor(it);
  body.appendChild(tsk.el);

  // 备注
  var r5 = document.createElement("div");
  r5.className = "cf-row";
  r5.innerHTML = "<label>备注</label>";
  var ta = document.createElement("textarea");
  ta.className = "td-note";
  ta.value = it.note || "";
  ta.placeholder = "补充说明（可留空）";
  r5.appendChild(ta); body.appendChild(r5);
  if(it.taskId) body.appendChild(todoRunsBlock(it));
  box.appendChild(body);

  // 底部
  var foot = document.createElement("div");
  foot.className = "td-foot";
  var del = document.createElement("button");
  del.type = "button"; del.className = "btn-cancel"; del.style.color = "var(--err)";
  del.innerHTML = svg("trash","ic ic-sm") + "删除";
  del.onclick = function(){ closeTodoEditor(); todoRemove(id); };
  foot.appendChild(del);
  var sp = document.createElement("div"); sp.className = "sp"; foot.appendChild(sp);
  var cancel = document.createElement("button");
  cancel.type = "button"; cancel.className = "btn-cancel"; cancel.textContent = "取消";
  cancel.onclick = closeTodoEditor;
  foot.appendChild(cancel);
  var save = document.createElement("button");
  save.type = "button"; save.className = "btn-save";
  save.style.cssText = "background:var(--brand);color:var(--white);border-color:var(--brand)";
  save.textContent = "保存";
  save.onclick = function(){
    var t = ti.value.trim();
    if(!t){ toast("事项不能为空"); return; }
    var payload = {
      op: "update", id: id,
      title: t, note: ta.value, flag: fb.checked, list_id: curList,
      remind_at: cb.checked && di.value ? (di.value + "T" + (tm.value || "09:00")) : "",
      repeat: rpt.get(),
      task_id: tsk.getTaskId(), auto_run: tsk.getAutoRun()
    };
    save.disabled = true;
    todoApi("/api/todo/items", payload).then(function(){
      closeTodoEditor(); return todoReload();
    }).then(function(){
      toast("已保存");
    }).catch(function(e){
      save.disabled = false;
      toast(e.message || "保存失败");
    });
  };
  foot.appendChild(save);
  box.appendChild(foot);

  document.getElementById("tdMask").className = "td-mask show";
  setTimeout(function(){ ti.focus(); }, 60);
}

/* ---------- 列表编辑弹窗（新建 / 改名换色） ---------- */
export function openListEditor(list){
  var editing = !!list;
  var ICONS  = ["list-checks","store","truck","lightbulb","bell","flag","wrench","layers","grid","file"];
  var COLORS = [TK.brand, TK.info, TK.ok, TK.warn, TK.err, "#7A5AF8", TK.neutral];
  var pickIcon  = editing ? list.icon  : "list-checks";
  var pickColor = editing ? list.color : TK.brand;

  var box = document.getElementById("tdBox");
  box.innerHTML = "";

  var head = document.createElement("div");
  head.className = "cf-head";
  head.innerHTML = '<div class="cf-tit">'+svg("layers","ic")+
    '<div><b>'+(editing?"编辑列表":"新建列表")+'</b><span class="sub">选一个图标和颜色</span></div></div>';
  var close = document.createElement("button");
  close.type = "button"; close.className = "cf-close"; close.innerHTML = svg("close","ic ic-sm");
  close.onclick = closeTodoEditor;
  head.appendChild(close);
  box.appendChild(head);

  var body = document.createElement("div");
  body.className = "td-body";

  var r1 = document.createElement("div");
  r1.className = "cf-row";
  r1.innerHTML = "<label>名称</label>";
  var ni = document.createElement("input");
  ni.type = "text"; ni.value = editing ? list.name : ""; ni.placeholder = "如：站点巡检";
  r1.appendChild(ni); body.appendChild(r1);

  var r2 = document.createElement("div");
  r2.className = "cf-row";
  r2.innerHTML = "<label>图标</label>";
  var iseg = document.createElement("div");
  iseg.className = "td-seg";
  ICONS.forEach(function(ic){
    var c = document.createElement("button");
    c.type = "button";
    c.className = "td-chip" + (ic===pickIcon ? " on" : "");
    c.innerHTML = svg(ic,"ic ic-sm");
    c.onclick = function(){
      pickIcon = ic;
      Array.prototype.forEach.call(iseg.children, function(x){ x.className = "td-chip"; });
      c.className = "td-chip on";
    };
    iseg.appendChild(c);
  });
  r2.appendChild(iseg); body.appendChild(r2);

  var r3 = document.createElement("div");
  r3.className = "cf-row";
  r3.innerHTML = "<label>颜色</label>";
  var cseg = document.createElement("div");
  cseg.className = "td-seg";
  COLORS.forEach(function(col){
    var c = document.createElement("button");
    c.type = "button";
    c.className = "td-chip" + (col===pickColor ? " on" : "");
    c.style.padding = "var(--sp-6)";
    c.innerHTML = '<span style="width:16px;height:16px;border-radius:var(--r-circle);background:'+
                  col+';display:inline-block"></span>';
    c.onclick = function(){
      pickColor = col;
      Array.prototype.forEach.call(cseg.children, function(x){ x.className = "td-chip"; x.style.padding = "var(--sp-6)"; });
      c.className = "td-chip on";
    };
    cseg.appendChild(c);
  });
  r3.appendChild(cseg); body.appendChild(r3);
  box.appendChild(body);

  var foot = document.createElement("div");
  foot.className = "td-foot";
  if(editing){
    var del = document.createElement("button");
    del.type = "button"; del.className = "btn-cancel"; del.style.color = "var(--err)";
    del.innerHTML = svg("trash","ic ic-sm") + "删除列表";
    del.onclick = function(){
      // 后端会检查列表下是否还有事项，有则直接拒绝并给出提示
      todoApi("/api/todo/lists", { op:"delete", id:list.id })
        .then(function(){ closeTodoEditor(); return todoReload(); })
        .then(function(){ toast("已删除列表"); })
        .catch(function(e){ toast(e.message || "删除失败"); });
    };
    foot.appendChild(del);
  }
  var sp = document.createElement("div"); sp.className = "sp"; foot.appendChild(sp);
  var cancel = document.createElement("button");
  cancel.type = "button"; cancel.className = "btn-cancel"; cancel.textContent = "取消";
  cancel.onclick = closeTodoEditor;
  foot.appendChild(cancel);
  var save = document.createElement("button");
  save.type = "button"; save.className = "btn-save"; save.textContent = "保存";
  save.style.cssText = "background:var(--brand);color:var(--white);border-color:var(--brand)";
  save.onclick = function(){
    var n = ni.value.trim();
    if(!n){ toast("名称不能为空"); return; }
    var payload = editing
      ? { op:"update", id:list.id, name:n, icon:pickIcon, color:pickColor }
      : { op:"create", name:n, icon:pickIcon, color:pickColor };
    save.disabled = true;
    todoApi("/api/todo/lists", payload).then(function(){
      closeTodoEditor(); return todoReload();
    }).then(function(){
      toast(editing ? "已保存" : "已新建列表");
    }).catch(function(e){
      save.disabled = false; toast(e.message || "保存失败");
    });
  };
  foot.appendChild(save);
  box.appendChild(foot);

  document.getElementById("tdMask").className = "td-mask show";
  setTimeout(function(){ ni.focus(); }, 60);
}

/* 挂载：把唯一的日志控制台 DOM 移到当前视图对应的宿主（移动节点不会丢内容） */
export function lineEl(raw){
  var d = document.createElement("div");
  d.className = "ln";
  var t = String(raw);
  if(/^\[错误\]|Traceback|Error:|✗/.test(t)) d.className = "ln bad";
  else if(/^\[系统\]/.test(t)) d.className = "ln warn";
  else if(/^\$ /.test(t)) d.className = "ln cmd";
  else if(/^\[开始\]/.test(t)) d.className = "ln ok";
  else if(/^\s*(File "|raise |Exception)/.test(t)) d.className = "ln dim";
  d.textContent = t;
  return d;
}

/* 运行日志弹窗的渲染（独立 DOM，与底部抽屉互不干扰）。
   叶子渲染器：只被 openRunModal / SSE 的 log·run_start 调用，自身不回调任何渲染函数。 */
export function renderModalDiag(run){
  var box = document.getElementById("mlDiag");
  box.innerHTML = "";
  if(!run || run.status!=="failed" || !run.error_kind) return;
  var d = document.createElement("div");
  d.className = "diag";
  d.innerHTML = svg("info")+
    '<div><b>失败原因：'+esc(run.error_kind)+'</b><p>'+esc(run.error_advice||"")+'</p></div>';
  box.appendChild(d);
}

/* 自动导出：供其他模块导入的内部顶层符号 */
export { TD_RUN_COLOR, TD_RUN_NAME, TD_WEEK, TODO_KEY, state };
