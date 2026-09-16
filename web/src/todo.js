import { store, groupOf, taskById, countInGroup, producerOf, missingText, visibleTasks, taskState, argValue } from "./store.js";
import { api, savePrefs, loadPrefs, readTokens, withToken, ensureTeams, __API_TOKEN__ } from "./api.js";
import { svg, esc, hexA, toast, debounce, viewHead } from "./ui.js";
import { TK, TK_MAP, RISK_LABEL, RISK_CLS, STATUS_CLS, STATUS_TXT, ICON } from "./tokens.js";
import { bus } from "./bus.js";
import { refreshLan, bindLanToggle, setArg, openSide, closeSide, askConfirm, closeConfirm, bindConfirmUI, lockScroll, unlockScroll } from "./behavior.js";
/* 数据层已拆到 todo-core.js（本地缓存 / 后端 API / 纯数据工具）。这里导入本模块用到的，
   并原样再导出给 nav / main / home / runs 的既有导入路径。 */
import { TODO_KEY, todoDefaultLists, todoLocalClone, todoDropLocal, todoReload, todoApi, todoMigrateLocal, loadTodo, saveTodo, todoOpenCount, todoUid, todoListById, taskNameOf, tdPad, tdToday, tdNowHM, tdShift, tdFmt, tdOverdue, tdIsToday, todoView, todoFind, todoCountsByList, todoFiltered, todoSort, defaultListId, todoToggle, todoAdd, todoRemove } from "./todo-core.js";
export { TODO_KEY, todoReload, loadTodo, todoOpenCount, tdFmt, tdIsToday, tdOverdue, todoToggle };
/* 编辑器已拆到 todo-editors.js（重复规则 / 任务 / 清单三类弹窗 + 运行记录区块）。
   这里导入本模块用到的，并把 openTodoEditor / closeTodoEditor 再导出给 main.js。 */
import { TD_WEEK, TD_RUN_COLOR, TD_RUN_NAME, todoRepeatEditor, todoTaskEditor, todoRunRow, todoRunsBlock, openTodoEditor, closeTodoEditor, openListEditor } from "./todo-editors.js";
export { openTodoEditor, closeTodoEditor };
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
export { TD_RUN_COLOR, TD_RUN_NAME, TD_WEEK, state };
