import { store, groupOf, taskById, countInGroup, producerOf, missingText, visibleTasks, taskState, argValue, applyTaskFilter } from "./store.js";
import { api, savePrefs, loadPrefs, readTokens, withToken, ensureTeams } from "./api.js";
import { svg, esc, hexA, toast, debounce, viewHead } from "./ui.js";
import { TK, TK_MAP, RISK_LABEL, RISK_CLS, STATUS_CLS, STATUS_TXT, ICON } from "./tokens.js";
import { bus } from "./bus.js";
import { refreshLan, bindLanToggle, setArg, openSide, closeSide, askConfirm, closeConfirm, bindConfirmUI, lockScroll, unlockScroll } from "./behavior.js";
import { skeletonCards } from "./home.js";
const state = store.state;
/* 视图层共享状态统一归 store.ui（单一归属）；此处取别名，既有 `_taskFilter.q` 等写法不变。
   taskViewMode 是标量且会被重新赋值，无法别名，统一走 store.ui.taskViewMode。 */
var _taskFilter = store.ui.taskFilter;
var _expandedGroups = store.ui.expandedGroups;

import { openRunModal, openArtifacts } from "./runs.js";
import { runTasks } from "./run.js";

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
/* ---------- 目标群选择器（Combobox：可输入 + 下拉联想） ----------
   聚焦未输入 → 最近使用的群；输入 → 防抖搜群（/api/groups），按匹配度降序；
   选中 → 隐藏域存 gid，输入框显示群名（用户只跟群名打交道）。
   手打了但没点选项 → 把原文存进隐藏域，交给脚本侧按群名解析，容错。 */
var GP_DEBOUNCE = 260;

/* ---- 浮层统一托管 ----
   下拉浮层不再挂在 combobox 里，而是 append 到 body 末尾并 position:fixed
   （与 #dpk 日期弹层同一套路）。这样它不受任何祖先 overflow 裁剪，
   能从配置弹窗里正常溢出、完整显示。
   代价：坐标要自己算，且弹窗/卡片重渲染时必须回收孤儿浮层，否则 body 里堆垃圾。 */
var _GP_ALL = [];          /* 所有活着的 combobox wrap（含已脱离文档的，靠 reap 回收） */
var _GP_BOUND = false;

/* 全局只绑一次：resize / 滚动（capture=true 才能收到弹窗内部滚动容器的 scroll）
   / mousedown（点浮层外关闭）。遍历 _GP_ALL 分发，不给每个实例单独绑。 */
export function _gpBindGlobal(){
  if(_GP_BOUND) return;
  _GP_BOUND = true;
  var pending = false;
  function repaintAll(){
    if(pending) return;
    pending = true;
    requestAnimationFrame(function(){
      pending = false;
      _GP_ALL.forEach(function(w){ if(w && w._place) w._place(); });
    });
  }
  window.addEventListener("resize", repaintAll);
  window.addEventListener("scroll", repaintAll, true);
  document.addEventListener("mousedown", function(ev){
    _GP_ALL.forEach(function(w){ if(w && w._onDocMouseDown) w._onDocMouseDown(ev); });
  }, true);
}

/* 回收已脱离文档的 combobox（卡片重渲染 / 弹窗重建都会产生孤儿浮层） */
export function _gpReap(){
  for(var i = _GP_ALL.length - 1; i >= 0; i--){
    var w = _GP_ALL[i];
    if(!w || !w.isConnected) { if(w && w._destroy) w._destroy(); }
  }
  for(var j = _MTP_ALL.length - 1; j >= 0; j--){
    var w = _MTP_ALL[j];
    if(!w || !w.isConnected) { if(w && w._destroy) w._destroy(); }
  }
}
/* 关闭并销毁全部浮层（弹窗关闭时调用，避免浮层残留在 body 上悬空显示） */
export function closeAllGroupPickers(){
  _GP_ALL.slice().forEach(function(w){ if(w && w._destroy) w._destroy(); });
  _MTP_ALL.slice().forEach(function(w){ if(w && w._destroy) w._destroy(); });
}

/* ============ 多选站点选择器（实时在线播报专用）============
   与 createGroupPicker 共享「浮层 fixed + body 末尾 + 集中托管」的做法，但走自己的样式：
     · 不搜群、不打字、不防抖——站点就 9 个，全展示，输入框只读
     · 多选：每行点击切换勾选（不关浮层）；浮层底部「全选 / 清空」快捷链接
     · 隐藏域存 "id1,id2,id3" 逗号分隔字符串（与 Python parse_teams_arg 直接对齐）
     · 「记住上一次」走现有 state.args + savePrefs 机制：弹窗提交 → setArg → savePrefs
       → 下次打开 argValue() 自动恢复，无须组件额外存储
   浮层自身由 _MTP_ALL 集中托管，与 _GP_ALL 走同一套 reap/全局绑定逻辑。 */
var _MTP_ALL = [];
var _MTP_BOUND = false;
export function _mtpBindGlobal(){
  if(_MTP_BOUND) return;
  _MTP_BOUND = true;
  var pending = false;
  function repaintAll(){
    if(pending) return;
    pending = true;
    requestAnimationFrame(function(){
      pending = false;
      _MTP_ALL.forEach(function(w){ if(w && w._place) w._place(); });
    });
  }
  window.addEventListener("resize", repaintAll);
  /* scroll 必须 capture：弹窗内部 .cf-body(overflow:auto) 也算滚动，capture 才能收到 */
  window.addEventListener("scroll", repaintAll, true);
  /* mousedown capture：点浮层外关闭；mousedown 而非 click——click 之前 input blur 会先关 */
  document.addEventListener("mousedown", function(ev){
    _MTP_ALL.forEach(function(w){ if(w && w._onDocMouseDown) w._onDocMouseDown(ev); });
  }, true);
}
export function createMultiTeamPicker(initVal, onChange){
  _mtpBindGlobal();
  var wrap = document.createElement("div");
  wrap.className = "mtp";

  var inp = document.createElement("input");
  inp.type = "text"; inp.className = "mtp-inp";
  inp.readOnly = true;                        /* 多选不允许打字，强制点开浮层 */
  inp.autocomplete = "off";
  inp.tabIndex = 0;

  var hid = document.createElement("input");
  hid.type = "hidden";

  var pop = document.createElement("div");
  pop.className = "mtp-pop"; pop.hidden = true;

  /* 选中集合（id 字符串）+ 站点数据源。
     teams 在**首次展开下拉时**才拉（ensureTeams），创建组件时可能还是空的，
     所以下面所有读 teams 的地方都先 syncTeams() 刷新一次快照。 */
  var selected = new Set();
  var nameById = {};                 // 已选 id → 名称（界面勾选时写入，供回显/回传用）
  (String(initVal || "")).split(",").map(function(s){return s.trim();})
    .forEach(function(x){
      if(!x) return;
      if(x.indexOf("=") > 0){        // 「id=名称」：界面提交的格式，名称随值一起持久化
        var i = x.indexOf("=");
        var k = x.slice(0, i).trim();
        nameById[k] = x.slice(i + 1).trim();
        selected.add(k);
      }else{
        selected.add(x);
      }
    });
  var teams = (state.teams && state.teams.teams) || [];
  var source = (state.teams && state.teams.source) || "unknown";
  var loading = false;               // 首次展开时的加载态

  /* 惰性加载后把闭包里的 teams/source 快照刷新到最新 */
  function syncTeams(){
    var st = state.teams;
    if(st && st.teams){ teams = st.teams; }
    if(st && st.source){ source = st.source; }
  }

  /* id → 名称：本地记录 > 站点列表 > 退化成 id 本身 */
  function nameOf(id){
    if(nameById[id]) return nameById[id];
    for(var i = 0; i < teams.length; i++){
      if(String(teams[i].id) === id){ nameById[id] = teams[i].name; return teams[i].name; }
    }
    return id;
  }

  /* 写入隐藏域 + 触发 onChange。
     值格式是 `id=名称,id=名称`——把名称一起带下去，Python 端就不用再打站点接口
     反查名字了（2026-09-08：跑任务阶段零站点请求）。 */
  function writeBack(){
    hid.value = Array.from(selected).map(function(id){
      return id + "=" + nameOf(id);
    }).join(",");
    if(onChange) onChange(hid.value);
  }

  /* 输入框摘要：「已选 3 / 9：站点A、站点B、站点C」，超长 tooltip 完整可见。
     站点列表还没加载出来时只报个数，不显示「/ 0」。 */
  function paintInp(){
    if(!selected.size){
      inp.value = "";
      inp.classList.add("is-empty");
      inp.placeholder = "留空将沿用上次选择的站点";
      inp.removeAttribute("title");
      return;
    }
    inp.classList.remove("is-empty");
    var names = [];
    selected.forEach(function(id){ names.push(nameOf(id)); });
    var txt = (teams.length ? "已选 " + selected.size + " / " + teams.length
                            : "已选 " + selected.size + " 个") + "： " + names.join("、");
    inp.value = txt;
    inp.title = txt;
  }

  /* 初始化时主动写一次隐藏域——多选 Combobox 不像单选那样「改时才写」，
     弹窗打开就要把已有选择回填到 hidden（commitParamsForm 从这里读）。 */
  writeBack();
  paintInp();

  /* 浮层渲染：警告条 + 站点列表 + 底部「全选 / 清空 + N/M」 */
  function paintList(){
    pop.innerHTML = "";
    if(loading){
      var ld = document.createElement("div");
      ld.className = "mtp-hint";
      var sp = document.createElement("span"); sp.className = "gp-spin";
      ld.appendChild(sp);
      ld.appendChild(document.createTextNode("正在加载站点…"));
      pop.appendChild(ld);
      return;
    }
    if(source === "fallback"){
      var w = document.createElement("div");
      w.className = "mtp-warn";
      w.textContent = "⚠ 站点列表获取失败，已用兜底清单（仅 3 站）。运行后只出这 3 站播报，其它站需风神登录态恢复后重开弹窗再选。";
      pop.appendChild(w);
    }
    if(!teams.length){
      var h = document.createElement("div");
      h.className = "mtp-hint";
      h.textContent = "暂无站点数据";
      pop.appendChild(h);
    }else{
      teams.forEach(function(t){
        var d = document.createElement("div");
        var id = String(t.id);
        d.className = "mtp-opt" + (selected.has(id) ? " on" : "");
        var ck = document.createElement("span"); ck.className = "ck";
        var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = t.name;
        var tid = document.createElement("span"); tid.className = "tid"; tid.textContent = "#" + t.id;
        d.appendChild(ck); d.appendChild(nm); d.appendChild(tid);
        /* 用 mousedown 而非 click：blur 会先关掉浮层，click 永远触发不到 */
        d.onmousedown = function(ev){
          ev.preventDefault();
          if(selected.has(id)) selected.delete(id); else selected.add(id);
          paintInp();
          paintList();
          writeBack();
        };
        pop.appendChild(d);
      });
    }
    /* 底部「全选 / 清空 + N/M」 */
    var bar = document.createElement("div");
    bar.className = "mtp-bar";
    var l = document.createElement("div"); l.className = "l";
    var sa = document.createElement("a"); sa.textContent = "全选";
    sa.onmousedown = function(ev){
      ev.preventDefault();
      teams.forEach(function(t){ selected.add(String(t.id)); });
      paintInp(); paintList(); writeBack();
    };
    var ca = document.createElement("a"); ca.textContent = "清空";
    ca.onmousedown = function(ev){
      ev.preventDefault();
      selected.clear();
      paintInp(); paintList(); writeBack();
    };
    l.appendChild(sa);
    l.appendChild(document.createTextNode(" / "));
    l.appendChild(ca);
    var r = document.createElement("div"); r.className = "r";
    r.textContent = selected.size + " / " + teams.length;
    bar.appendChild(l); bar.appendChild(r);
    pop.appendChild(bar);
  }

  /* 浮层定位（与单选 Combobox 同一套：fixed + 视口下/上 + max-height 自适应） */
  function place(){
    if(pop.hidden) return;
    var r = inp.getBoundingClientRect();
    var gap = 4, pad = 8;
    var vh = document.documentElement.clientHeight;
    var vw = document.documentElement.clientWidth;
    pop.style.width = Math.max(r.width, 200) + "px";
    pop.style.maxHeight = "";
    var ph = pop.offsetHeight || 0;
    var below = vh - r.bottom - gap - pad;
    var above = r.top - gap - pad;
    var up = (ph > below) && (above > below);
    var avail = Math.max(120, up ? above : below);
    pop.style.maxHeight = Math.min(264, avail) + "px";
    var h = pop.offsetHeight || Math.min(ph, avail);
    pop.style.top = (up ? Math.max(pad, r.top - gap - h) : (r.bottom + gap)) + "px";
    var left = r.left;
    if(left + pop.offsetWidth > vw - pad) left = Math.max(pad, vw - pop.offsetWidth - pad);
    if(left < pad) left = pad;
    pop.style.left = left + "px";
  }
  function show(){ pop.hidden = false; place(); }
  function close(){ pop.hidden = true; }
  function onDocMouseDown(ev){
    if(pop.hidden) return;
    var t = ev.target;
    if(pop.contains(t) || wrap.contains(t)) return;
    close();
  }
  wrap._place = place;
  wrap._onDocMouseDown = onDocMouseDown;
  wrap._destroy = function(){
    close();
    if(pop.parentNode) pop.parentNode.removeChild(pop);
    var i = _MTP_ALL.indexOf(wrap);
    if(i >= 0) _MTP_ALL.splice(i, 1);
  };

  /* 展开：站点列表在这里惰性拉取（仅首次），之后直接复用 state.teams。
     列表到位后要 repaint + 重新定位（浮层高度会从一行变成整列）。 */
  function openPop(){
    show();
    if(!state.teams && !loading){
      loading = true;
      paintList();                       // 先出「正在加载站点…」
      ensureTeams().then(function(){
        loading = false;
        syncTeams();
        paintInp(); paintList(); place();
      });
      return;
    }
    syncTeams();
    paintList();
  }

  /* 开/关统一由 mousedown 接管，不再同时监听 focus 和 click。

     原写法在**同一次点击**里会被触发两次：mousedown → focus（打开）→ click
     （因为已打开所以又关掉），表现为「浮层弹出后立刻收回，得再点一次」。
     首次展开要等 /api/teams 返回时尤其明显——用户看到的是闪一下就没了。

     这里 preventDefault 掉浏览器默认的聚焦行为，自己控制开关顺序，
     并用 lastClose 兜住 preventDefault 失效的浏览器（避免刚关就被 focus 重开）。 */
  var lastClose = 0;
  inp.onmousedown = function(ev){
    ev.preventDefault();
    if(pop.hidden){ openPop(); } else { close(); lastClose = Date.now(); }
    try{ inp.focus({preventScroll:true}); }catch(err){ inp.focus(); }
  };
  inp.onfocus = function(){
    /* 键盘 Tab 进来 → 自动展开（无障碍）；鼠标刚点关的别立刻重开 */
    if(pop.hidden && (Date.now() - lastClose) > 250) openPop();
  };
  inp.onkeydown = function(e){
    if(e.key === "Enter" || e.key === " "){
      e.preventDefault();
      if(pop.hidden){ openPop(); } else { close(); }
    }else if(e.key === "Escape"){
      if(!pop.hidden){ e.preventDefault(); close(); }
    }
  };

  wrap.appendChild(inp); wrap.appendChild(hid);
  document.body.appendChild(pop);
  _MTP_ALL.push(wrap);
  wrap._inp = inp; wrap._hid = hid;
  wrap._pop = pop;       /* 测试 / 调试用：pop 挂在 body 上，不在 wrap 子树里 */
  wrap._paintList = paintList;   /* 暴露给外部：测试、调试、热刷新 */
  wrap.setTaskId = function(){ /* 多选无 taskDefault 概念，留空以保持接口一致 */ };

  return wrap;
}

export function createGroupPicker(initVal, onChange){
  _gpBindGlobal();
  var wrap = document.createElement("div");
  wrap.className = "gp";

  var inp = document.createElement("input");
  inp.type = "text"; inp.className = "gp-inp";
  inp.placeholder = "搜索群名，留空则用任务的默认群";
  inp.autocomplete = "off";

  var hid = document.createElement("input");
  hid.type = "hidden";

  var pop = document.createElement("div");
  pop.className = "gp-pop"; pop.hidden = true;

  /* 输入框 + 下拉浮层。默认群标识不再挂在 combobox 控件后面（旧 defBtn 做法），
     改为跟随下拉里的群名、悬停时显示（见 paint 里的 gp-def）。 */


  /* 输入框 + 下拉浮层；popover 走 absolute 浮在 wrap 上 */
  var row = document.createElement("div"); row.className = "gp-row";
  row.appendChild(inp);
  wrap.appendChild(row); wrap.appendChild(hid);
  /* 浮层挂 body 末尾（不在 wrap 里）—— 见上方「浮层统一托管」注释 */
  document.body.appendChild(pop);
  _GP_ALL.push(wrap);

  /* hi = 当前激活（高亮）项的下标，-1 表示「没有激活项」。
     展开列表后一律从 -1 开始：不做任何预选，避免刚打开就莫名其妙高亮第一个群。
     激活只由两种用户动作产生——鼠标移到某行（paint 里的 onmouseenter）、按上下键。
     wantFirst：列表尚未展开时按下 ArrowDown，展开后直接高亮第一项（一次按键同时完成
     「展开 + 选中」，符合 combobox 的常规手感）；ArrowUp 展开则不预选。 */
  var rows = [], hi = -1, timer = null, seq = 0, vseq = 0, wantFirst = false;

  function close(){ pop.hidden = true; hi = -1; }

  /* 计算浮层坐标（fixed 定位，相对视口）：
     默认贴输入框下沿；下方空间不够且上方更宽裕则上翻；高度按可用空间收缩到
     [120px, 264px]；横向夹在视口内。paint 之后必须调一次（内容变则高度变）。 */
  function place(){
    if(pop.hidden) return;
    var r = inp.getBoundingClientRect();
    var gap = 4, pad = 8;
    var vh = document.documentElement.clientHeight;
    var vw = document.documentElement.clientWidth;
    pop.style.width = Math.max(r.width, 180) + "px";
    /* 第一遍：按 CSS 默认 max-height 量自然高度，用它决定朝下还是朝上 */
    pop.style.maxHeight = "";
    var ph = pop.offsetHeight || 0;
    var below = vh - r.bottom - gap - pad;
    var above = r.top - gap - pad;
    var up = (ph > below) && (above > below);
    var avail = Math.max(120, up ? above : below);
    pop.style.maxHeight = Math.min(264, avail) + "px";
    var h = pop.offsetHeight || Math.min(ph, avail);   /* 应用 max-height 后的真实高度 */
    pop.style.top = (up ? Math.max(pad, r.top - gap - h) : (r.bottom + gap)) + "px";
    var left = r.left;
    if(left + pop.offsetWidth > vw - pad) left = Math.max(pad, vw - pop.offsetWidth - pad);
    if(left < pad) left = pad;
    pop.style.left = left + "px";
  }
  /* 展开浮层的唯一入口：先显形再定位（隐藏元素量不到高度） */
  function show(){ pop.hidden = false; place(); }
  /* 点浮层与输入框之外的地方则关闭（浮层已不在 wrap 里，不能靠 blur 兜底） */
  function onDocMouseDown(ev){
    if(pop.hidden) return;
    var t = ev.target;
    if(pop.contains(t) || wrap.contains(t)) return;
    close();
  }
  wrap._place = place;
  wrap._onDocMouseDown = onDocMouseDown;
  wrap._destroy = function(){
    close();
    if(pop.parentNode) pop.parentNode.removeChild(pop);
    var i = _GP_ALL.indexOf(wrap);
    if(i >= 0) _GP_ALL.splice(i, 1);
  };

  /* 展开即展示最近群名列表：聚焦/点击控件时主动拉最近使用的群（issue 1）。 */
  function expandRecent(){
    if(!pop.hidden) return;
    loading("加载最近使用的群…");
    run("", true);
  }

  function paint(list, hint){
    pop.innerHTML = "";
    if(hint){
      var h = document.createElement("div"); h.className = "gp-hint";
      if(hint.spin){ var s = document.createElement("span"); s.className = "gp-spin"; h.appendChild(s); }
      h.appendChild(document.createTextNode(hint.text || ""));
      show(); return;
    }
    if(!list.length){
      var e = document.createElement("div"); e.className = "gp-hint";
      e.textContent = "没有匹配的群";
      pop.appendChild(e); show(); return;
    }
    var defId = defaultGid();
    list.forEach(function(g, i){
      var d = document.createElement("div"); d.className = "gp-opt" + (i === hi ? " on" : "");
      var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = g.title;
      d.appendChild(nm);
      /* 下拉展开时列的就是最近使用的群，再逐条打「最近」属于同义反复，已移除。
         仅搜索场景保留匹配度百分比——那才是用户判断命中准不准的有效信息。 */
      if(g.score && g.score < 100){
        var sc = document.createElement("span"); sc.className = "gp-sc";
        sc.textContent = g.score + "%"; d.appendChild(sc);
      }
      /* 默认标识：跟随对应群名，不再挂在 combobox 控件后面。
         已为默认 → 「默认」徽标常驻显示（它是状态，要让人一眼看出默认落在哪，见 CSS .is-def）；
         未设默认 → 「设为默认」是操作，仅在该行被激活（鼠标移入 / 键盘高亮）时才露出。 */
      var defTag = document.createElement("span");
      defTag.className = "gp-def" + (g.id === defId ? " is-def" : "");
      defTag.textContent = (g.id === defId) ? "默认" : "设为默认";
      defTag.title = (g.id === defId)
        ? ("已设为本任务默认群：" + g.title + "；点击可取消")
        : ("把 " + g.title + " 设为本任务的默认群");
      defTag.onmousedown = function(ev){
        ev.preventDefault(); ev.stopPropagation();   // 不触发 pick，只切默认
        toggleDefaultFor(g);
      };
      d.appendChild(defTag);
      /* 用 mousedown 而非 click：blur 会先关掉浮层，click 就永远触发不到 */
      d.onmousedown = function(ev){ ev.preventDefault(); pick(g); };
      /* 鼠标移到某行即激活该行：把 .on 从旧行搬到当前行并同步 hi。
         只改 class、不整表重绘——重绘会替换掉光标正下方的节点，hover 态会闪断。
         有了它，键盘高亮的行与鼠标悬停的行不会同时亮着（.on 全局唯一）。 */
      d.onmouseenter = function(){
        if(hi === i) return;
        var prev = pop.querySelector(".gp-opt.on");
        if(prev) prev.classList.remove("on");
        d.classList.add("on");
        hi = i;
      };
      pop.appendChild(d);
    });
    show();
  }

  function pick(g){
    inp.value = g.title || "";
    hid.value = g.id || "";
    close();
    try{
      api("/api/groups/used", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ id: g.id, title: g.title })
      });
    }catch(e){}
    if(onChange) onChange(hid.value);
  }

  function doSearch(q){
    var my = ++seq;
    // 注意：api() 已经返回解析好的 JSON 对象，不要再调 .json()（否则在已解析对象上
    // 调 .json() 抛 TypeError，被 catch 吞掉后永远显示「搜索失败」而非最近群名）。
    api("/api/groups?q=" + encodeURIComponent(q || ""))
      .then(function(j){
        if(my !== seq) return;               // 过期响应直接丢弃，避免快输时结果乱跳
        if(!j || j.ok === false){
          console.error("[目标群] 搜索接口返回异常：", j && j.error);
          rows = [];
          paint([], { text: "搜索失败，可直接输入群名（也可直接手打群名）" });
          return;
        }
        rows = j.groups || [];
        hi = (wantFirst && rows.length) ? 0 : -1;
        wantFirst = false;
        paint(rows);
      })
      .catch(function(e){
        if(my !== seq) return;
        console.error("[目标群] 搜索请求异常：", e);   // 真实异常打到控制台，不静默吞掉
        rows = [];
        paint([], { text: "搜索失败，可直接输入群名（也可直接手打群名）" });
      });
  }

  function run(q, now){
    if(timer) clearTimeout(timer);
    if(now) doSearch(q);
    else timer = setTimeout(function(){ doSearch(q); }, GP_DEBOUNCE);
  }

  function loading(text){ paint([], { spin: true, text: text }); }

  inp.onfocus = function(){
    /* 用户主动点控件时触发：选中文本便于覆盖输入、把光标挪到末尾便于继续追加，
       并直接展开最近群名列表（issue 1：展开即展示最近群名，不再等输入/方向键）。 */
    try{
      inp.select();
      var v = inp.value;
      if(v.length){
        inp.setSelectionRange(v.length, v.length);
      }
    }catch(e){ /* input 已失焦，不必强求 */ }
    expandRecent();
  };
  inp.oninput = function(){
    hid.value = inp.value;                   // 未选中：原文当群名，脚本侧解析
    if(!inp.value.trim()){ loading("加载最近使用的群…"); run("", true); return; }
    loading("搜索中…");
    run(inp.value);
  };
  inp.onblur = function(){
    setTimeout(close, 160);                  // 给 mousedown 选中留出时间
    var v = inp.value.trim();
    if(v && !hid.value) hid.value = v;
    if(!v) hid.value = "";
    if(onChange) onChange(hid.value);
  };
  inp.onkeydown = function(e){
    if(e.key === "ArrowDown" || e.key === "ArrowUp"){
      e.preventDefault();                    // 阻止光标在本框内跳动
      if(pop.hidden){                        // 列表未展开：先展开；下键顺带预选第一项
        wantFirst = (e.key === "ArrowDown");
        loading("加载最近使用的群…"); run("", true); return;
      }
      hi = (e.key === "ArrowDown") ? Math.min(hi + 1, rows.length - 1) : Math.max(hi - 1, 0);
      paint(rows);
    }else if(e.key === "Enter"){
      if(!pop.hidden && rows[hi]){ e.preventDefault(); pick(rows[hi]); }
    }else if(e.key === "Escape"){ close(); }
  };

  /* 初值回填：存的是 gid，显示要给群名。先占位 gid 不阻塞，反查到了再替换。 */
  wrap._setValue = function(v){
    var my = ++vseq;
    hid.value = v || "";
    if(!v){ inp.value = ""; return; }
    if(/^cid/.test(v)){
      inp.value = v;
      api("/api/groups?q=")
        .then(function(j){
          if(my !== vseq) return;
          var hit = (j.groups || []).filter(function(g){ return g.id === v; })[0];
          if(hit) inp.value = hit.title;
        }).catch(function(e){ console.error("[目标群] 反查群名失败：", e); });
    }else{
      inp.value = v;
    }
  };
  wrap._setValue(initVal);

  /* ---- 个人默认群（taskDefaultGroup[taskId] = gid）----
     · 打开弹窗时优先用它预填 gid，胜过出厂 default（"不要写死"的诉求）
     · 默认标识不再做成 combobox 后的按钮：改为下拉里跟随群名、悬停显示（见 paint）
     · 点列表里的「设为默认」/「默认」即可切换；setTaskId 仅记录 taskId 供默认判定 */
  var taskId = null;     /* 由 renderParamRow 在挂上 row 时通过 wrap.setTaskId() 注入 */
  function defaultGid(){
    return ((state.taskDefaultGroup || {})[taskId]) || "";
  }
  function toggleDefaultFor(g){
    if(!taskId || !g || !g.id) return;
    var cur = defaultGid();
    if(cur === g.id){
      delete state.taskDefaultGroup[taskId];
      toast("已取消本任务的默认群");
    }else{
      state.taskDefaultGroup[taskId] = g.id;
      toast("已设 " + (g.title || "该群") + " 为本任务的默认群");
      /* 顺手把这个群写到 Combobox 当前选中——避免设了默认后输入框还是空的，
         让人觉得"默认群没生效"。取消默认时不强行清空（用户可能还想保留当前选择）。 */
      inp.value = g.title || "";
      hid.value = g.id || "";
      if(onChange) onChange(hid.value);
    }
    savePrefs();
    paint(rows);   // 刷新当前列表里的默认标识（不依赖隐藏按钮）
  }





  wrap.setTaskId = function(id){ taskId = id; };
  wrap._inp = inp; wrap._hid = hid;


  return wrap;
}

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
/* 日期「单日 / 多日」二选一分组。
   当任务同时含 --date 与 --start-date/--end-date 时启用：用一组单选框切换，
   选「单日」只露一个日期框，选「多日」只露起止两个日期框；保存时按当前模式
   只写对应 flag，另一模式的 flag 清空，避免脚本同时收到单日 + 区间两套参数。 */
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
export { DANGER_TOGGLE, GP_DEBOUNCE, _GP_ALL, _GP_BOUND, _MTP_ALL, _MTP_BOUND, _dpkDocHandler, state };
