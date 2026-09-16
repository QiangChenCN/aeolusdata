// store.js —— 全局状态单例 + 选择器 + 订阅（state/store 模式，显式解耦，取代隐式全局）
import { TK } from "./tokens.js";

/* 全局唯一状态对象。所有模块通过 store.state 读写；
   通过 store.set / store.update 做语义化变更并通知订阅者；
   通过 store.subscribe 响应变更（如未来要做细粒度重渲染）。 */
const state = {
  registry: { groups: [], tasks: [], presets: [] },
  groups: [],           // [{id,name,color}]
  tasks: [],            // 任务数组
  nav: { kind:"tasks", id:"all" },   // kind: tasks | preset | history | home | hub | todo
  navOpen: { hub:true },             // 一级菜单展开状态（只对带子项的一级有意义）
  todo: null,                        // 工作内容（提醒事项）：{lists:[],items:[]}，由 loadTodo() 填充
  args: {},             // taskId -> {flag: value}
  runs: {},             // runId -> {status,name,lines:[]}
  current: null,       // 当前 run 元信息
  queuedIds: [],
  history: [],
  last: {},             // taskId -> 最近一次历史
  connected: null,      // null=尚未建立 / true=事件流已通 / false=已断（首帧不要误报红）
  cookie: null,         // 风神 cookie 探针结果：{status,checked_at,reason}；null=尚未拉取
  quark: null,          // Quark DA cookie 探针结果：{status,checked_at,reason,age_hours}；null=尚未拉取
  cookiePollHandle: null,    // setTimeout 句柄
  cookiePollActive: false,   // 当前是否处于「页面可见 + 轮询链已挂」状态
  autoScroll: true,
  modalRunId: null,     // 运行日志弹窗当前显示的 run（null=弹窗未开）
  modalAutoScroll: true,
  modalCount: 0,       // 弹窗已渲染行数（增量渲染用）
  modalRenderedRunId: null,
  /* 2026-09-07：每个任务的「个人默认群」gid 映射（任务级个人化覆盖；
     不依赖 tasks.json 写死 default，UI 端 user-managed）。 */
  taskDefaultGroup: {}
};

const subs = new Set();
function notify(){
  subs.forEach(function(f){
    try { f(state); } catch(e){ console.error("[store] subscriber error", e); }
  });
}

export const store = {
  get state(){ return state; },
  /** 浅合并顶层字段并通知订阅者 */
  set(patch){ if(patch && typeof patch === "object") Object.assign(state, patch); notify(); },
  /** 命令式变更：fn(state) 内直接改 state，改完统一通知 */
  update(fn){ if(typeof fn === "function") fn(state); notify(); },
  /** 订阅状态变更，返回取消订阅函数 */
  subscribe(fn){ if(typeof fn === "function") subs.add(fn); return function(){ subs.delete(fn); }; },
  /** 语义化动作入口（占位，调用方可按需按 type 扩展副作用） */
  dispatch(type, payload){ notify(); }
};


/* ============ 选择器（纯读 state，无副作用） ============ */

export function groupOf(gid){
  for(var i=0;i<state.groups.length;i++) if(state.groups[i].id===gid) return state.groups[i];
  return { id:gid, name:gid, color:TK.neutral };
}
export function taskById(id){
  for(var i=0;i<state.tasks.length;i++) if(state.tasks[i].id===id) return state.tasks[i];
  return null;
}
export function countInGroup(gid){
  return state.tasks.filter(function(t){ return t.group===gid; }).length;
}
/* ---- 前置产物（tasks.json 的 needs 字段） ----
   missing 由服务端按磁盘现状算出，前端只负责把缺失项说清楚、并指出该先跑谁。 */
export function producerOf(rel){
  var want = String(rel).replace(/\\/g,"/").replace(/\/$/,"");
  for(var i=0;i<state.tasks.length;i++){
    var outs = state.tasks[i].outputs || [];
    for(var j=0;j<outs.length;j++){
      var o = String(outs[j]).replace(/\\/g,"/").replace(/\/$/,"");
      if(o === want) return state.tasks[i];
    }
  }
  return null;
}
export function missingText(list){
  return (list||[]).map(function(rel){
    var p = producerOf(rel);
    return rel + (p ? "（先跑「"+p.name+"」）" : "");
  }).join("、");
}
export function visibleTasks(){
  if(state.nav.kind!=="tasks" || state.nav.id==="all") return state.tasks;
  return state.tasks.filter(function(t){ return t.group===state.nav.id; });
}

export function taskState(tid){
  if(state.current && state.current.task_id===tid) return "running";
  if(state.queuedIds.indexOf(tid)>=0) return "queued";
  var h = state.last[tid];
  return h ? h.status : null;
}
export function argValue(tid, p){
  var m = state.args[tid];
  if(m && Object.prototype.hasOwnProperty.call(m, p.flag)) return m[p.flag];
  return p.default !== undefined ? p.default : "";
}

/* 自动导出：供其他模块导入的内部顶层符号 */
export { notify, state, subs };
