// todo-core.js —— 「工作内容（提醒事项）」的数据层：本地缓存 / 后端 API / 纯数据工具函数。
// 从 todo.js 拆出（原 19-171 行）。本模块不含任何 DOM 渲染，
// 因此 todo.js（视图）与 todo-editors.js（编辑器）都可以安全依赖它，且不会形成循环。
import { store } from "./store.js";
import { api } from "./api.js";
import { toast } from "./ui.js";
import { bus } from "./bus.js";
const state = store.state;

export var TODO_KEY = "wb_fengshen_todo_v1";
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
  return api(path, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(payload || {}),
    _silent:true
  }).then(function(j){
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
