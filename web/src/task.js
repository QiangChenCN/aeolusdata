import { store, groupOf, taskById, countInGroup, producerOf, missingText, visibleTasks, taskState, argValue, applyTaskFilter } from "./store.js";
import { api, savePrefs, loadPrefs, readTokens, withToken, ensureTeams } from "./api.js";
import { svg, esc, hexA, toast, debounce, viewHead } from "./ui.js";
import { TK, TK_MAP, RISK_LABEL, RISK_CLS, STATUS_CLS, STATUS_TXT, ICON } from "./tokens.js";
import { bus } from "./bus.js";
import { setArg, openSide, closeSide, askConfirm, closeConfirm, bindConfirmUI, lockScroll, unlockScroll } from "./behavior.js";
import { skeletonCards } from "./home.js";
const state = store.state;
/* 视图层共享状态统一归 store.ui（单一归属）；此处取别名，既有 `_taskFilter.q` 等写法不变。
   taskViewMode 是标量且会被重新赋值，无法别名，统一走 store.ui.taskViewMode。 */
var _taskFilter = store.ui.taskFilter;
var _expandedGroups = store.ui.expandedGroups;

import { openRunModal, openArtifacts } from "./runs.js";
import { runTasks } from "./run.js";
import { dateRangeGroupFlags, createDateTrigger, setDateValue, getDateValue, _yesterdayStr, _defaultsToYesterday, renderDateRangeGroup, _dpkState } from "./date-picker.js";
/* _dpkState 原样再导出，main.js 的既有导入路径不变 */
export { _dpkState };
import { createGroupPicker, createMultiTeamPicker, _gpReap, closeAllGroupPickers } from "./pickers.js";
/* _gpReap 原样再导出，nav.js 的既有导入路径不变 */
export { _gpReap };

export function renderTaskView(host){
  var isAll = (state.nav.id==="all");
  if(!isAll) _taskFilter.group = "all";   /* 离开「全部任务」时清空分组筛选，避免残留 */
  var g = isAll ? null : groupOf(state.nav.id);
  var base = visibleTasks();
  host.appendChild(viewHead(
    isAll ? "全部任务" : g.name,
    isAll ? "按分组归类，共 " + state.tasks.length + " 个任务"
          : (g.name + " 分组 · " + base.length + " 个任务"),
    "grid", isAll ? TK.brand : g.color,
    '<span style="font-size:var(--fs-note);color:var(--muted)">勾选后按列表顺序串行执行</span>'
  ));

  /* 工具条：搜索 + 状态筛选 + 列表/看板切换（E5/A2） */
  var bar = document.createElement("div");
  bar.className = "tf-bar";
  bar.innerHTML =
    '<div class="tf-search"><svg class="ic-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'+
    '<input type="text" id="tfQ" placeholder="搜索任务名…" value="'+esc(_taskFilter.q)+'"></div>'+
    '<select id="tfStatus" class="tf-sel">'+
      '<option value="all">全部状态</option>'+
      '<option value="running">运行中</option>'+
      '<option value="queued">排队中</option>'+
      '<option value="success">成功</option>'+
      '<option value="failed">失败</option>'+
      '<option value="none">未运行</option>'+
    '</select>'+
    (isAll ? '<select id="tfGroup" class="tf-sel"><option value="all">全部分组</option>'+ state.groups.map(function(g){ return '<option value="'+esc(g.id)+'">'+esc(g.name)+'</option>'; }).join("") +'</select>' : "")+
    '<select id="tfSort" class="tf-sel"><option value="last">排序：最近运行</option><option value="name">排序：名称</option><option value="status">排序：状态</option></select>'+
    '<div class="view-switch" id="tfView">'+
      '<button type="button" data-m="list" class="'+( store.ui.taskViewMode==="list"?"on":"")+'">'+svg("list","ic-sm")+'列表</button>'+
      '<button type="button" data-m="board" class="'+( store.ui.taskViewMode==="board"?"on":"")+'">'+svg("grid","ic-sm")+'看板</button>'+
    '</div>';
  host.appendChild(bar);

  var grid = document.createElement("div");
  grid.id = "tfGrid";
  host.appendChild(grid);

  var qEl = bar.querySelector("#tfQ");
  qEl.addEventListener("input", debounce(function(){ _taskFilter.q = qEl.value; renderTaskGrid(grid, isAll); }, 120));
  var sEl = bar.querySelector("#tfStatus");
  sEl.value = _taskFilter.status;
  sEl.addEventListener("change", function(){ _taskFilter.status = sEl.value; renderTaskGrid(grid, isAll); });
  if(isAll){
    var grpEl = bar.querySelector("#tfGroup");
    grpEl.value = _taskFilter.group;
    grpEl.addEventListener("change", function(){ _taskFilter.group = grpEl.value; renderTaskGrid(grid, isAll); });
  }
  var sortEl = bar.querySelector("#tfSort");
  sortEl.value = _taskFilter.sort;
  sortEl.addEventListener("change", function(){ _taskFilter.sort = sortEl.value; renderTaskGrid(grid, isAll); });
  bar.querySelectorAll("#tfView button").forEach(function(b){
    b.addEventListener("click", function(){
      store.ui.taskViewMode = b.dataset.m;
      bar.querySelectorAll("#tfView button").forEach(function(x){ x.classList.toggle("on", x===b); });
      renderTaskGrid(grid, isAll);
    });
  });

  renderTaskGrid(grid, isAll);
}

export function renderTaskGrid(grid, isAll){
  grid.innerHTML = "";
  var base = visibleTasks();
  var list = applyTaskFilter(base, isAll);

  /* 首屏未加载：骨架屏占位（B3/D2） */
  if(!state.tasks.length){
    skeletonCards(grid, 4);
    return;
  }
  /* 无匹配：空态三件套（B3） */
  if(!list.length){
    var e = document.createElement("div");
    e.className = "estate"; e.style.gridColumn = "1/-1";
    e.innerHTML = '<div class="e-ic">'+svg("search")+'</div>'+
      '<div class="e-tt">没有匹配的任务</div>'+
      '<div class="e-sub">试试调整搜索关键词或状态筛选条件。</div>';
    grid.appendChild(e);
    return;
  }

  /* 看板视图：按运行结果状态分列（只读可视化） */
  if(store.ui.taskViewMode === "board"){
    grid.className = "board";
    var order = [["running","运行中"],["queued","排队中"],["success","成功"],["failed","失败"],["none","未运行"]];
    order.forEach(function(pair){
      var items = list.filter(function(t){ var st = taskState(t.id); return (pair[0]==="none" ? !st : st===pair[0]); });
      if(!items.length) return;
      var col = document.createElement("div");
      col.className = "board-col";
      col.innerHTML = '<div class="board-col-h"><span class="badge '+(STATUS_CLS[pair[0]]||"b-stop")+'">'+pair[1]+'</span><span class="ct">'+items.length+'</span></div>';
      var colGrid = document.createElement("div");
      colGrid.className = "tasks";
      items.forEach(function(t){ colGrid.appendChild(taskCard(t)); });
      col.appendChild(colGrid);
      grid.appendChild(col);
    });
    return;
  }

  /* 列表视图 */
  if(isAll){
    grid.className = "task-groups";
    state.groups.forEach(function(gp){
      var items = list.filter(function(t){ return t.group===gp.id; });
      if(!items.length) return;
      var sec = document.createElement("div");
      sec.className = "section task-group";
      var head = document.createElement("div");
      head.className = "section-head task-group-h";
      head.innerHTML = '<span style="width:10px;height:10px;border-radius:50%;background:'+gp.color+';flex:none"></span>'+
        '<b>'+esc(gp.name)+'</b><span class="sp"></span>'+
        '<span class="ct" style="font-size:var(--fs-caption);color:var(--muted-2);font-variant-numeric:tabular-nums">'+items.length+'</span>'+
        '<span class="tg">'+svg("arrow","ic-xs")+'</span>';
      var wrap = document.createElement("div");
      wrap.className = "tasks";
      items.forEach(function(t){ wrap.appendChild(taskCard(t)); });
      sec.appendChild(head);
      sec.appendChild(wrap);
      var expanded = !!_expandedGroups[gp.id];
      if(!expanded){ sec.classList.add("collapsed"); wrap.style.display = "none"; }
      head.addEventListener("click", function(){
        var hid = sec.classList.toggle("collapsed");
        wrap.style.display = hid ? "none" : "";
        _expandedGroups[gp.id] = !hid;
      });
      grid.appendChild(sec);
    });
  } else {
    grid.className = "tasks";
    list.forEach(function(t){ grid.appendChild(taskCard(t)); });
  }
}





/* === 节点选择：nodes 区块的渲染与校验 ===
   形态：横向步进条 —— 一条横线上等距排布圆点，圆点下方是节点名，点圆点选两端。
   点击规则（只认"两端"，中间永远是连续区间，所以跳选/多段在交互上就不可能发生）：
     · 未选 / 已选满 → 点谁谁就是「开始」，结束清空，进入待选态
     · 已选开始、待选结束 → 点在起点之后（含自身）=「结束」；点在起点之前 = 重设开始
   状态只保留 ok / invalid：valid 表示可跑；invalid 出现时把红色错误行展开，
   正常情况下一行说明都没有，卡片保持干净。 */
export function effectiveOptions(p, t){
  /* options_source="nodes" 时从 task.nodes 派生选项；否则用 params.options */
  if(p.type !== "select") return p.options || [];
  if(p.options_source === "nodes" && t && Array.isArray(t.nodes)){
    return t.nodes.map(function(n){ return { value:n.id, label:n.name }; });
  }
  return p.options || [];
}

export function nodeName(id, nodes){
  for(var i=0;i<nodes.length;i++) if(nodes[i].id===id) return nodes[i].name;
  return null;
}
export function nodeIdx(nodes, id){
  for(var i=0;i<nodes.length;i++) if(nodes[i].id===id) return i;
  return -1;
}

/* 节点列表变更（如某个节点被删掉）后，localStorage 里可能残留已失效的节点 id。
   这里在渲染前一次性回落成默认值，避免用户一打开卡片就看到「xx 不在节点列表中」的红字。
   只改数据、不触发任何渲染，由调用方在 refreshNodesBlock 之前调用 —— 单向，无环路。 */
export function sanitizeNodeRange(task, ns){
  var bv = argValue(task.id, ns.beginParam);
  var ev = argValue(task.id, ns.endParam);
  var stale = (bv && nodeIdx(ns.nodes, bv) < 0) || (ev && nodeIdx(ns.nodes, ev) < 0);
  if(!stale) return;
  setArg(task.id, ns.beginParam.flag, ns.beginParam.default || "");
  setArg(task.id, ns.endParam.flag,   ns.endParam.default   || "");
  savePrefs();
}

export function nodesBlock(task, nodes, beginParam, endParam){
  var block = document.createElement("div");
  block.className = "nodes-block";

  var head = document.createElement("div");
  head.className = "nodes-head";
  head.innerHTML = svg("bolt","ic-sm")+"<span>执行节点</span>";
  block.appendChild(head);

  /* ns 先建好，再被 onclick 闭包捕获 —— 顺序不能反 */
  var ns = {
    block: block,
    task: task,
    nodes: nodes,
    beginParam: beginParam,
    endParam: endParam,
    valid: true,
    invalidMsg: "",
    trackEl: null, warnEl: null
  };

  /* 步进条：<ol> 里每个 <li> 是一个节点，内部放 button（保证键盘可达） */
  var track = document.createElement("ol");
  track.className = "nodes-track";
  nodes.forEach(function(n, i){
    var li = document.createElement("li");
    li.className = "nodes-step";
    li.dataset.idx = i;
    li.dataset.id = n.id;
    var hit = document.createElement("button");
    hit.type = "button";
    hit.className = "nodes-hit";
    hit.title = n.name + (n.desc ? " —— " + n.desc : "");
    hit.innerHTML = '<span class="nodes-dot"></span>'+
      '<span class="nodes-name">'+esc(n.name)+'</span>'+
      '<span class="nodes-role"></span>';
    hit.onclick = function(){ onNodeClick(task, ns, i); };
    li.appendChild(hit);
    track.appendChild(li);
  });
  block.appendChild(track);
  ns.trackEl = track;

  /* 错误行：仅在真正异常时（倒置 / 空选）显示一行红字；ok 态完全静默 */
  var warn = document.createElement("div");
  warn.className = "nodes-warn";
  warn.style.display = "none";
  block.appendChild(warn);
  ns.warnEl = warn;

  sanitizeNodeRange(task, ns);      /* 先清掉可能因节点列表变更而失效的旧值 */
  refreshNodesBlock(task, ns);
  return ns;
}

/* 点击某个节点：只可能落在上面那三条规则里 */
export function onNodeClick(task, ns, idx){
  var bIdx = nodeIdx(ns.nodes, argValue(task.id, ns.beginParam));
  var eIdx = nodeIdx(ns.nodes, argValue(task.id, ns.endParam));
  if(bIdx < 0 || eIdx >= 0){
    /* 没选过，或已经选满了 → 重新起一轮，这个点就是开始 */
    setNodeRange(task, ns, idx, -1);
  } else if(idx < bIdx){
    /* 点在起点之前 → 起点往前挪，结束继续待选 */
    setNodeRange(task, ns, idx, -1);
  } else {
    /* 点在起点之后（含自身）→ 收尾；点自身 = 只跑这一个节点 */
    setNodeRange(task, ns, bIdx, idx);
  }
}

/* 写回 args。传 -1 表示"未选"：写显式空串而不是删 key，
   删 key 会让 argValue 回落到 params[].default（等于又全选了），空选择提示就永远不出现。
   服务端 build_cmd 遇到空值不传该 flag，行为与 default 一致 —— 前后端口径统一。 */
export function setNodeRange(task, ns, bIdx, eIdx){
  setArg(task.id, ns.beginParam.flag, bIdx < 0 ? "" : ns.nodes[bIdx].id);
  setArg(task.id, ns.endParam.flag,   eIdx < 0 ? "" : ns.nodes[eIdx].id);
  savePrefs();
  refreshNodesBlock(task, ns);
}

export function refreshNodesBlock(task, ns){
  if(!ns) return;
  var bv = argValue(task.id, ns.beginParam);
  var ev = argValue(task.id, ns.endParam);
  var bIdx = nodeIdx(ns.nodes, bv);
  var eIdx = nodeIdx(ns.nodes, ev);

  /* 二态判定：ok / invalid。pending 不再当独立状态展示——
     默认 begin/end 都填好，没有提示；只有倒置 / 空选 / begin 越界这些真错误才显示一行红字。 */
  var mode = "ok", msg = "";
  if(!bv && !ev){
    mode = "invalid"; msg = "未选择节点";
  } else if(bIdx < 0){
    mode = "invalid"; msg = "开始节点「" + bv + "」不在节点列表中";
  } else if(eIdx >= 0 && eIdx < bIdx){
    mode = "invalid"; msg = "结束节点不得早于开始节点";
  }
  var valid = (mode === "ok");

  ns.valid = valid;
  ns.invalidMsg = msg;
  ns.block.className = "nodes-block" + (mode === "invalid" ? " invalid" : "");
  if(ns.warnEl){
    var show = (mode !== "ok");
    ns.warnEl.style.display = show ? "flex" : "none";
    ns.warnEl.className = "nodes-warn";
    ns.warnEl.innerHTML = show ? (svg("warn","ic-sm") + "<span>" + esc(msg) + "</span>") : "";
  }

  /* 区间高亮：lo/hi 由当前状态决定。pending 已经不算独立态，但「已选开始、等选结束」
     仍然要给开始端一个 edge 视觉反馈，让用户知道下一步点哪个 —— 沿用原 lo 计算。 */
  var lo, hi;
  if(valid){
    lo = bIdx; hi = eIdx;
  } else if(bIdx >= 0){
    lo = bIdx; hi = bIdx;          /* 倒置 / 空选时只突出开始点，不画"区间"避免误导 */
  } else {
    lo = -1; hi = -1;
  }
  var steps = ns.trackEl.children;
  for(var i=0;i<steps.length;i++){
    var li = steps[i];
    var inRange = (lo >= 0 && i >= lo && i <= hi);
    li.classList.remove("in","edge","seg-l","seg-r");
    if(inRange) li.classList.add("in");
    if(lo >= 0 && (i === lo || i === hi)) li.classList.add("edge");
    if(lo >= 0 && i > lo && i <= hi) li.classList.add("seg-l");   /* 与上一个节点之间 */
    if(lo >= 0 && i >= lo && i < hi) li.classList.add("seg-r");   /* 与下一个节点之间 */
    var role = li.querySelector(".nodes-role");
    if(role){
      if(lo < 0) role.textContent = "";
      else if(i === lo && i === hi) role.textContent = "仅此一步";
      else if(i === lo) role.textContent = "开始";
      else if(i === hi) role.textContent = "结束";
      else role.textContent = "";
    }
  }

  /* 联动卡片上的运行按钮：禁用 + title */
  var card = ns.block.closest && ns.block.closest(".card");
  var btn = card ? card.querySelector(".btn-run") : null;
  if(btn){
    var busy = state.current && state.current.task_id===task.id;
    btn.disabled = busy || !valid;
    btn.title = (!valid && !busy) ? msg : "";
  }
}

/* === 任务参数表单（仅配置弹窗使用）

   渲染 → renderParamRow，收集 → commitParamsForm，回填默认值 → fillDefaultToForm。
   配置入口是卡片右下「配置」按钮（openConfigDialog），弹窗里 renderParamRow(live=false) +
   底部「保存」调 commitParamsForm。
   data-flag 标识每行归属于哪个 param：commitParamsForm 通过它读到任务 params 里的原始定义，
   不依赖 DOM 里把 label/option 留给前端硬塞回去。添加新 param 类型时只要在 renderParamRow 里
   加一个分支即可，不需要再为新任务复制 UI。 */
export function paramLabelOnly(t, p){ return /* 任务自带的 --begin/--end 在节点步进条里已有 UI，
                                         摘要与弹窗都不再渲染这俩字段 */ (t.nodes && (p.flag==="--begin" || p.flag==="--end")); }
export function visibleParams(t){
  return (t.params || []).filter(function(p){ return !paramLabelOnly(t,p); });
}
export function paramDefaultString(p){ return (p.default === undefined || p.default === null) ? "" : String(p.default); }
export function paramHasDefault(p){ return !(p.default === undefined || p.default === null); }
export function paramIsModified(task, p){
  var v = argValue(task.id, p);
  // boolean / string 分别比较，避免 0/false/null 撞 default ""
  if(p.type === "switch") return !!v !== !!p.default;
  var s = (v === undefined || v === null || v === "") ? "" : String(v);
  return s !== paramDefaultString(p);
}
/* 把 param 当前值美化成短串：switch→「✓ / —」，select→取 option.label，其它→原文 */
/* --- 危险开关：勾上的那一刻就弹二次确认，不等到点「运行」才警告 --- */
/* 为什么要放在勾选时：老板的诉求是「勾 DROP 即弹窗确认」——决定风险的那一刻
   就拦住，而不是等点运行才说。确认 → 保持勾选；取消 / 点遮罩 / Esc → 立刻拨回去。 */
var DANGER_TOGGLE = {
  "--reinit": {
    title: "高危操作确认",
    body: "DROP 重建表会先清空表 ods_delivery_tracking 的全部已入库数据，再重建。",
    sub: "勾上后点「运行」即真实执行，数据清空后无法恢复。确认要开启这个开关吗？"
  }
};
/* 本会话已确认过的危险开关 → 点「运行」时不再重复弹（勾的那次已经确认过了）。
   若开关是上一次会话遗留下来的（刷新后依然勾着），这里没有记录，运行时仍会兜底确认。 */
var _sessionDangerOK = store.ui.sessionDangerOK;   /* 单一归属 store.ui，与 run.js 共享 */
/* 统一处理开关切换：live=true 立即写 state（卡片内嵌），false 只改外观（弹窗提交时才写）。
   命中 DANGER_TOGGLE 且是「勾上」时，先弹确认，用户决断后再落地。 */
export function _onSwitchChange(task, p, row, cb, live){
  var apply = function(on){
    cb.checked = on;
    row.classList.toggle("on", on);
    row.classList.toggle("off", !on);
    if(live) setArg(task.id, p.flag, on);
  };
  var d = DANGER_TOGGLE[p.flag];
  if(cb.checked && d){
    askConfirm(d.title, d.body, d.sub,
      function(){ _sessionDangerOK[p.flag] = true; apply(true); },
      function(){ apply(false); });
    return;                       /* 等用户决断，先不写 state */
  }
  apply(cb.checked);
}
/* 渲染单个参数行；live=true 时每个控件立即写 state.args（卡片内嵌用），
   live=false 时只在 data-flag 上挂 flag，不绑事件，由 commitParamsForm 一次性收集（弹窗用） */

export function renderParamRow(task, p, live){
  var row = document.createElement("div");
  row.dataset.flag = p.flag;
  if(p.type === "switch"){
    row.className = live ? "pr pr-sw" : "cf-row-sw";
    var on = !!argValue(task.id, p);
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = on;
    row.classList.add(on ? "on" : "off");
    if(live){
      cb.onchange = function(){ _onSwitchChange(task, p, row, cb, true); };
    } else {
      cb.addEventListener("change", function(){ _onSwitchChange(task, p, row, cb, false); });
    }
    var lb = document.createElement("span");
    lb.textContent = p.label;
    row.appendChild(cb); row.appendChild(lb);
  }else{
    row.className = live ? "pr" : "cf-row";
    var la = document.createElement("label");
    la.textContent = p.label + (p.required ? " *" : "");
    if(!live && p.type !== "group"){
      /* group / date 类型都不显示这个 hint：
         group 的默认值已在 placeholder 用群名说明、不再在这里重复原文；
         date 的默认行为（如「默认昨天」）也在 placeholder 写明，
         且 p.default 通常是空串，拼出来就是「默认 」两个孤儿字，无意义。 */
      var hint = document.createElement("span");
      hint.className = "h";
      hint.textContent = (paramHasDefault(p) && p.default !== "")
                          ? ("默认 " + paramDefaultString(p)) : "";
      la.appendChild(hint);
    }
    var el;
    if(p.type === "select"){
      el = document.createElement("select");
      var opts = effectiveOptions(p, task) || [];
      opts.forEach(function(o){
        var op = document.createElement("option");
        op.value = o.value;
        op.textContent = o.label;
        if(String(argValue(task.id, p)) === String(o.value)) op.selected = true;
        el.appendChild(op);
      });
      if(live) el.onchange = function(){ setArg(task.id, p.flag, el.value); };
    }else if(p.type === "group"){
      /* 目标群：可搜索的 Combobox。真正的取值在它内部的隐藏域（gid 或手输的群名）。
         2026-09-07：若 state.taskDefaultGroup[task.id] 有个人默认，优先用它预填，
         覆盖 tasks.json 的 params[].default（用户诉求：默认群不要写死）。 */
      var personalDefault = ((state.taskDefaultGroup||{})[task.id]) || "";
      var initial = personalDefault || argValue(task.id, p) || "";
      el = createGroupPicker(initial,
                             live ? function(v){ setArg(task.id, p.flag, v); } : null);
      el.setTaskId(task.id);
      /* label 右侧 hint：展示当前默认（个人 > 出厂）。在 row 挂上后再标 */
      if(personalDefault){
        el._personalDefault = personalDefault;
      }
    }else if(p.type === "multi-team"){
      /* 「实时在线播报」多选站点选择器：state.teams 为数据源（首次展开下拉时才拉），
         state.args 里存的是 "id1=名称1,id2=名称2" 逗号分隔字符串
         （与 Python parse_teams_arg 对齐；带名称是为了让跑任务时不用再打站点接口）。
         留空 → 沿用上次选择的站点（p.default="" 的语义，见 run_fetch）。 */
      el = createMultiTeamPicker(argValue(task.id, p) || "",
                                 live ? function(v){ setArg(task.id, p.flag, v); } : null);
    }else if(p.type === "date"){
      /* date 类型走自绘 trigger（createDateTrigger），不在 live=true 路径上挂 onChange：
         卡片内嵌的表单只有「点配置弹窗后才生效」，live=true 路径上的 setArg
         写的是当前 state.args，跟弹窗提交与否无关，便于「保存」语义统一。 */
      var init = argValue(task.id, p) || "";
      if(!init && _defaultsToYesterday(p)) init = _yesterdayStr();
      el = createDateTrigger(init);
      if(live){
        el._dpkOnChange = function(v){ setArg(task.id, p.flag, v); };
      }
    }else{
      el = document.createElement("input");
      el.type = "text";
      el.value = argValue(task.id, p) || "";
      el.placeholder = p.placeholder || "";
      if(live){
        el.oninput = function(){ setArg(task.id, p.flag, el.value); };
      }
    }
    /* select / date / text 三种非 switch 控件都要把 label + 控件挂到 row。
       原 select 分支漏了 append，导致「目标群」等下拉整行不渲染（配置弹窗里看不到）。
       见 2026-09-04：attendance 报告「任务配置界面没有选择群的设置项」。 */
    row.appendChild(la); row.appendChild(el);
  }
  return row;
}
/* 收集弹窗表单回写 state.args；一次写完再 savePrefs，避免每改一项就 localStorage.setItem */
export function commitParamsForm(task, container){
  var rows = container.querySelectorAll("[data-flag]");
  rows.forEach(function(r){
    var p = (task.params || []).filter(function(x){ return x.flag === r.dataset.flag; })[0];
    if(!p) return;
    if(p.type === "switch"){
      var cb = r.querySelector("input[type=checkbox]");
      setArg(task.id, p.flag, !!cb.checked);
    }else if(p.type === "date"){
      var t = r.querySelector(".dpk-trigger");
      setArg(task.id, p.flag, getDateValue(t));
    }else if(p.type === "group"){
      /* 必须在 text 分支之前：群选择器内部也有 input[type=text]（显示群名），
         真正的取值是隐藏域里的 gid，取错了会把群名当 gid 发给脚本。 */
      var hd = r.querySelector("input[type=hidden]");
      setArg(task.id, p.flag, (hd && hd.value) || "");
    }else if(p.type === "multi-team"){
      /* 多选站点选择器同样依赖隐藏域取值（input[type=text] 是只读的「已选 N/M」摘要，
         不能像 text 分支那样取它）。空字符串合法：表示「沿用上次选择的站点」。 */
      var mhd = r.querySelector("input[type=hidden]");
      setArg(task.id, p.flag, (mhd && mhd.value) || "");
    }else{
      var el = r.querySelector("select") || r.querySelector("input[type=text]");
      setArg(task.id, p.flag, (el && el.value) || "");
    }
  });
  savePrefs();
}
/* 把弹窗表单控件值全部重置为 params[].default，不写 state.args（点「保存」才会写） */
export function fillDefaultToForm(task, container){
  var rows = container.querySelectorAll("[data-flag]");
  rows.forEach(function(r){
    var p = (task.params || []).filter(function(x){ return x.flag === r.dataset.flag; })[0];
    if(!p) return;
    var def = paramDefaultString(p);
    if(p.type === "switch"){
      var on = !!p.default;
      var cb = r.querySelector("input[type=checkbox]");
      cb.checked = on;
      r.classList.toggle("on", on);
      r.classList.toggle("off", !on);
    }else if(p.type === "date"){
      var t = r.querySelector(".dpk-trigger");
      if(!t) return;
      var v = def;
      /* date 类参数若声明「默认昨天」，恢复默认时把昨天回填（而不是空字符串）*/
      if(!v && _defaultsToYesterday(p)) v = _yesterdayStr();
      setDateValue(t, v);
    }else if(p.type === "group"){
      var gp = r.querySelector(".gp");
      if(gp && gp._setValue) gp._setValue(def);
    }else{
      var el = r.querySelector("select") || r.querySelector("input[type=text]");
      if(!el) return;
      el.value = def;
    }
  });
}
/* ============================================================================
   任务卡片 + 配置弹窗 + 日期范围提交
   原在 config.js。与本题的参数表单机制（renderParamRow / nodesBlock / _gpReap…）本就同源，
   移入本模块后 task.js 不再 import config.js —— 打断 task↔config 循环依赖。
   ========================================================================== */
export function cardTasksMod(task){
  var params = visibleParams(task);
  return params.some(function(p){ return paramIsModified(task, p); });
}

/* 配置弹窗（与 .mask 独立 DOM）：单实例复用，cfCurrent 记当前任务 */
export var cfCurrent = null;
export function openConfigDialog(taskId){
  var t = taskById(taskId); if(!t) return;
  cfCurrent = t;
  /* 上一次弹窗的 combobox 已随 innerHTML 清空而丢弃，但它们的浮层挂在 body 上
     会变成孤儿（一直悬空显示）→ 重建前先回收 */
  _gpReap();
  var body = document.getElementById("cfBody");
  body.innerHTML = "";
  /* 所有日期类参数（无论单日/多日/零散）统一提到配置第一项 */
  var DATE_FLAGS = ["--date", "--start-date", "--end-date"];
  /* 双重保险：节点步进条已承载 begin/end 选择，配置弹窗里不重复露出来 */
  var params = visibleParams(t).filter(function(p){
    return p.flag !== "--begin" && p.flag !== "--end";
  });
  /* 日期「单日/多日」分组：三兄弟齐全时交给 renderDateRangeGroup 用单选框统一渲染，
     避免三选框同时出现造成误导；它放第一项（见下方 drBlock 先于普通参数 append） */
  var drg = dateRangeGroupFlags(t);
  /* 把日期类参数从普通参数里摘出来，单独提到最前 */
  function isDateFlag(f){ return DATE_FLAGS.indexOf(f) >= 0; }
  function inDrg(f){
    if(!drg) return false;
    return f === drg.single || f === drg.start || f === drg.end;
  }
  var dateParams = params.filter(function(p){ return isDateFlag(p.flag) && !inDrg(p.flag); });
  /* 所有日期 flag 一律从普通参数里剔除：
       · 命中 drg 的三个 → 已由 renderDateRangeGroup 统一渲染成「单日/多日」分组块，
         若再留在 params 里会被下面 params.forEach 原样渲染一遍，导致「分组块 + 3 个
         独立日期行」重复出现（2026-09-03 修：旧条件 !(isDate && !inDrg) 恰好把
         这三个 flag 全部放行，属于漏剔除）。
       · 没命中 drg 的零散日期参数 → 由上面的 dateParams 单独提到最前渲染，同样不重复。 */
  params = params.filter(function(p){ return !isDateFlag(p.flag); });
  /* 目标群（--group）排在日期之后、其他之前（2026-09-07）；节点/开关/文本
     等保持原相对顺序，避免误改动结构。 */
  var groupParams = params.filter(function(p){ return p.type === "group"; });
  var otherParams = params.filter(function(p){ return p.type !== "group"; });
  params = groupParams.concat(otherParams);
  document.getElementById("cfTitle").textContent = t.name;
  var shownCount = params.length + (drg ? 1 : 0) + dateParams.length;
  document.getElementById("cfSub").textContent = shownCount ? ("共 " + shownCount + " 项参数") : "";
  /* 日期区永远放配置第一项：三兄弟齐全 → 分组块；零散日期参数 → 单独行；两者都可能有 */
  var drBlock = renderDateRangeGroup(t);
  if(drBlock) body.appendChild(drBlock);
  dateParams.forEach(function(p){ body.appendChild(renderParamRow(t, p, false)); });
  if(!params.length && !drg && !dateParams.length){
    var e = document.createElement("div");
    e.className = "cf-empty";
    e.innerHTML = svg("info") + "<div>这个任务没有可配置的参数。</div>";
    body.appendChild(e);
    document.getElementById("cfDefault").style.display = "none";
  } else {
    document.getElementById("cfDefault").style.display = "";
    params.forEach(function(p){ body.appendChild(renderParamRow(t, p, false)); });
  }
  document.getElementById("cfMask").className = "cf-mask show";
  /* 打开配置弹窗不主动激活任何控件：保留关闭弹窗前的焦点位置，符合 a11y
     与「不主动打断当前工作」原则；想用哪个控件就点哪个。 */
}
export function closeConfigDialog(){
  closeAllGroupPickers();     /* 浮层挂在 body 上，不随弹窗 DOM 消失，必须显式销毁 */
  document.getElementById("cfMask").className = "cf-mask";
  cfCurrent = null;
}

export function taskCard(t){
  var g = groupOf(t.group);
  var st = taskState(t.id);
  var c = document.createElement("div");
  c.className = "card " + (st||"");

  var left = document.createElement("div");
  left.className = "card-left";

  var tt = document.createElement("div");
  tt.className = "c-t card-h";
  var stBadge = st ? '<span class="badge '+(STATUS_CLS[st]||"b-stop")+'">'+
    (st==="running" ? '<span class="dot" style="background:currentColor"></span>' : "")+
    (STATUS_TXT[st]||st)+'</span>' : '';
  /* 前置条件提示：原来渲染成卡片中部的黄色横条，会让有 prereq_note 的卡片比邻居
     高 30+px。现在缩成 c-meta 行内的一个 ⚠ 角标，hover 弹完整文案，零高度代价。 */
  var prereqTip = t.prereq_note
    ? '<span class="badge b-tip" title="'+esc(t.prereq_note)+'">'+svg("warn","ic-xs")+'<span>前置</span></span>'
    : '';
  tt.innerHTML = "<b>"+esc(t.name)+"</b><div class='c-meta'>"+
    '<span class="gchip" style="background:'+hexA(g.color,.12)+';color:'+g.color+'">'+esc(g.name)+"</span>"+
    '<span class="badge '+(RISK_CLS[t.risk]||"b-safe")+'">'+(RISK_LABEL[t.risk]||"只读")+"</span>"+
    prereqTip+stBadge+"</div>";
  left.appendChild(tt);
  c.appendChild(left);

  var mid = document.createElement("div");
  mid.className = "card-mid";

  if(t.desc){
    var d = document.createElement("p");
    d.className = "desc"; d.textContent = t.desc;
    mid.appendChild(d);
  }
  /* 产物行恒定渲染：无 outputs 的任务也渲染一行「产物：—」占位。配合 .outs 的
     min-height = max-height 高度锁，「无产物 / 1 个 / 多个产物」三种卡片高度完全一致。
     完整清单走 title hover，不再靠换行展示。 */
  var o = document.createElement("div");
  if(t.outputs && t.outputs.length){
    var outsTxt = "产物：" + t.outputs.join("、");
    o.className = "outs";
    o.title = outsTxt;
    o.innerHTML = svg("file","ic-sm")+"<span>"+esc(outsTxt)+"</span>";
  } else {
    o.className = "outs outs-none";
    o.innerHTML = svg("file","ic-sm")+"<span>产物：—</span>";
  }
  mid.appendChild(o);
  /* 前置产物缺失提示（needs 字段，由服务端按磁盘现算后附在 missing 上） */
  if(t.missing && t.missing.length){
    var mn = document.createElement("div");
    mn.className = "note";
    var mnText = "缺少前置产物："+missingText(t.missing);
    mn.innerHTML = svg("warn","ic-sm")+"<span title='"+esc(mnText)+"'>"+esc(mnText)+"</span>";
    mid.appendChild(mn);
  }

  var params = t.params || [];
  /* --- 执行节点区块（tasks.json 的 nodes 字段） ---
     只在该任务声明了 nodes 时渲染：显示节点列表 + 开始/结束两个 select，
     让用户圈定一段连续执行区间。
     · 默认值：begin=首节点，end=末节点（来自 params[].default）
     · 校验：begin/end 任一为空、或 end 索引 < begin 索引 → 整块转 err 态，运行按钮禁用
     · 选中区间内的 li 加 .between（品牌色淡化底），start/end 两端再加 .start/.end 强调色
  */
  var nodes = t.nodes || [];
  var nodesState = null;
  if(nodes.length){
    /* --begin / --end 通常由 tasks.json 的 params 提供（sync_nodes.py 会自动补）；
       万一某个任务只想展示节点、没配这两个 param，这里用内部虚拟 param 兜底 ——
       它们只用于读写 state.args，不会进 params 循环，也就不会渲染两遍。 */
    var beginParam = params.filter(function(p){ return p.flag==="--begin"; })[0]
      || { flag:"--begin", label:"开始节点", type:"select", default:nodes[0].id };
    var endParam   = params.filter(function(p){ return p.flag==="--end"; })[0]
      || { flag:"--end", label:"结束节点", type:"select", default:nodes[nodes.length-1].id };
    nodesState = nodesBlock(t, nodes, beginParam, endParam);
    mid.appendChild(nodesState.block);
  }

  /* 配置入口只剩卡片右下「配置」按钮（点开弹窗）。不再在卡片中部渲染摘要 pill 行 —— 占地方。 */
  c.appendChild(mid);

  var right = document.createElement("div");
  right.className = "card-right";

  /* 等宽按钮组：配置 + 运行。两个按钮在 .card-actions 的 grid 里等宽，
     列数固定，对齐整齐不再因文案长短而宽窄不一；内部 min-width:0 + ellipsis，
     在窄屏下也能塞得下。 */
  var acts = document.createElement("div");
  acts.className = "card-actions";
  var confBtn = document.createElement("button");
  confBtn.type = "button";
  confBtn.className = "btn-conf" + (cardTasksMod(t) ? " has-mod" : "");
  confBtn.innerHTML = svg("gear") + "<span>配置</span>";
  confBtn.onclick = function(ev){ ev.stopPropagation(); openConfigDialog(t.id); };
  acts.appendChild(confBtn);
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-run" + (t.risk==="danger" ? " danger" : "");
  btn.disabled = (state.current && state.current.task_id===t.id) || (nodesState && !nodesState.valid);
  btn.title = btn.disabled && nodesState && !nodesState.valid ? nodesState.invalidMsg : "";
  btn.innerHTML = (st==="running"
    ? svg("clock")+"运行中…"
    : svg("play")+"运行");
  btn.onclick = function(){
    if(nodesState && !nodesState.valid){ toast(nodesState.invalidMsg); return; }
    runTasks([{ task_id:t.id, args: state.args[t.id] || {} }]);
  };
  acts.appendChild(btn);
  right.appendChild(acts);

  /* 任务卡片底部整行「查看产物」按钮：打开产物浏览器，列出本次任务已生成的全部产物 */
  var artBtn = document.createElement("button");
  artBtn.type = "button";
  artBtn.className = "btn-ghost";
  artBtn.style.width = "100%";
  artBtn.style.marginTop = "var(--sp-7)";
  artBtn.innerHTML = '<svg class="ic-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>查看产物</span>';
  artBtn.onclick = function(ev){ ev.stopPropagation(); openArtifacts(t.id); };
  right.appendChild(artBtn);

  var hLast = state.last[t.id];
  if(hLast){
    var l = document.createElement("div");
    l.className = "last";
    /* 文案包进 span：flex 容器里的裸文本节点吃不到 text-overflow:ellipsis */
    var lastTxt = esc(hLast.start||"") + " · " + (hLast.duration||0) + "s · " +
      (hLast.status==="success" ? "成功" : (hLast.error_kind || hLast.status));
    l.title = lastTxt;
    l.innerHTML = svg("clock","ic-sm")+"<span>"+lastTxt+"</span>";
    right.appendChild(l);
  }
  c.appendChild(right);
  return c;
}

/* 配置弹窗「保存 / 恢复默认」时的日期范围提交与重置（与 renderDateRangeGroup 同属日期机制） */
export function commitDateRangeGroup(task){
  var g = dateRangeGroupFlags(task);
  if(!g) return;
  var dateEl = document.getElementById("cfDrDate");
  var startEl = document.getElementById("cfDrStart");
  var endEl = document.getElementById("cfDrEnd");
  if(store.ui.cfDateMode === "single"){
    setArg(task.id, g.single, getDateValue(dateEl));
    setArg(task.id, g.start, "");
    setArg(task.id, g.end, "");
  } else {
    setArg(task.id, g.start, getDateValue(startEl));
    setArg(task.id, g.end, getDateValue(endEl));
    setArg(task.id, g.single, "");
  }
}

export function resetDateRangeGroup(task){
  var g = dateRangeGroupFlags(task);
  if(!g) return;
  store.ui.cfDateMode = "single";
  var yest = _yesterdayStr();
  var dateEl = document.getElementById("cfDrDate");
  var startEl = document.getElementById("cfDrStart");
  var endEl = document.getElementById("cfDrEnd");
  setDateValue(dateEl, yest);
  setDateValue(startEl, "");
  setDateValue(endEl, "");
  var radios = document.querySelectorAll('input[name="cfDrMode"]');
  if(radios.forEach) radios.forEach(function(r){ r.checked = (r.value==="single"); });
  var pSingle = document.getElementById("cfDrSingle");
  var pRange = document.getElementById("cfDrRange");
  if(pSingle) pSingle.style.display = "";
  if(pRange) pRange.style.display = "none";
}

/* 自动导出：供其他模块导入的内部顶层符号 */
export { DANGER_TOGGLE, state };
