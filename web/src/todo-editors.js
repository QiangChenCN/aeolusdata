// todo-editors.js —— 「工作内容（提醒事项）」的三类编辑器弹窗：
//   重复规则编辑器（todoRepeatEditor）/ 任务编辑器（openTodoEditor·closeTodoEditor）/ 清单编辑器（openListEditor），
//   以及运行记录区块（todoRunsBlock·todoRunRow）。
// 从 todo.js 拆出（原 384-938 行）：数据读写统一走 todo-core.js，DOM 工具走 ui.js。
import { store, groupOf, taskById } from "./store.js";
import { api } from "./api.js";
import { svg, esc, hexA, toast, viewHead } from "./ui.js";
import { TK, ICON } from "./tokens.js";
import { bus } from "./bus.js";
import { askConfirm, setArg } from "./behavior.js";
import { TODO_KEY, todoReload, todoApi, loadTodo, saveTodo, todoOpenCount, todoUid, todoListById, taskNameOf, tdPad, tdToday, tdNowHM, tdShift, tdFmt, todoView, todoFind, todoCountsByList, defaultListId, todoRemove } from "./todo-core.js";
/* 内嵌部件（重复规则 / 关联任务 / 执行记录）已拆到 todo-editor-parts.js —— 本模块只管两级弹窗外壳 */
import { todoRepeatEditor, todoTaskEditor, todoRunRow, todoRunsBlock, apiRun } from "./todo-editor-parts.js";
const state = store.state;


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
