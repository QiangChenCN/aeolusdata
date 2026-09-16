// todo-editor-parts.js —— 「工作内容」事项详情弹窗里内嵌的三块编辑部件：
//   · 重复规则编辑器（todoRepeatEditor + TD_WEEK）
//   · 关联任务编辑器（todoTaskEditor）
//   · 执行记录（TD_RUN_COLOR / TD_RUN_NAME / todoRunRow / todoRunsBlock / apiRun）
// 从 todo-editors.js 拆出（原 14-295 行）：这三块是「正文部件」，
// 而 todo-editors.js 保留两级弹窗外壳（事项详情 / 列表编辑）。数据读写走 todo-core.js。
import { store, groupOf, taskById } from "./store.js";
import { api } from "./api.js";
import { svg, esc, hexA, toast } from "./ui.js";
import { TK } from "./tokens.js";
import { bus } from "./bus.js";
import { askConfirm, setArg } from "./behavior.js";
import { TODO_KEY, todoReload, todoApi, loadTodo, saveTodo, todoOpenCount, todoUid, todoListById, taskNameOf, tdPad, tdToday, tdNowHM, tdShift, tdFmt, todoView, todoFind, todoCountsByList, defaultListId, todoRemove } from "./todo-core.js";
const state = store.state;

/* ---------- 重复规则编辑器 ----------
   五种：不重复 / 每天（每 N 天）/ 每周（每 N 周 + 星期多选）/
   每月（每 N 个月 + 几号或最后一天）/ 自定义（每 N 小时）。
   存进库的是 {type, interval, by, end}，显示文案由后端 describe_rule 统一算好下发，
   这里只负责把用户的选择收成一个规则对象。 */
export var TD_WEEK = ["一","二","三","四","五","六","日"];
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
export var TD_RUN_COLOR = { success:TK.ok, failed:TK.err, missed:TK.warn,
                     skipped:TK.warn, running:TK.info, retrying:TK.warn };
export var TD_RUN_NAME  = { success:"成功", failed:"失败", missed:"错过", skipped:"跳过",
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
