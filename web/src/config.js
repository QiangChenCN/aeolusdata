import { store, groupOf, taskById, countInGroup, producerOf, missingText, visibleTasks, taskState, argValue } from "./store.js";
import { api, savePrefs, loadPrefs, readTokens, withToken, ensureTeams } from "./api.js";
import { svg, esc, hexA, toast, debounce, viewHead } from "./ui.js";
import { TK, TK_MAP, RISK_LABEL, RISK_CLS, STATUS_CLS, STATUS_TXT, ICON } from "./tokens.js";
import { bus } from "./bus.js";
import { refreshLan, bindLanToggle, setArg, openSide, closeSide, askConfirm, closeConfirm, bindConfirmUI, lockScroll, unlockScroll } from "./behavior.js";
import { openArtifacts, viewRunLog } from "./runs.js";
const state = store.state;

import { commitParamsForm, fillDefaultToForm, dateRangeGroupFlags, getDateValue, _yesterdayStr, setDateValue, visibleParams, paramIsModified, renderDateRangeGroup, renderParamRow, closeAllGroupPickers, nodesBlock, _gpReap, cfDateMode, setCfDateMode } from "./task.js";
import { runTasks } from "./main.js";

export function commitDateRangeGroup(task){
  var g = dateRangeGroupFlags(task);
  if(!g) return;
  var dateEl = document.getElementById("cfDrDate");
  var startEl = document.getElementById("cfDrStart");
  var endEl = document.getElementById("cfDrEnd");
  if(cfDateMode === "single"){
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
  setCfDateMode("single");
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

export function cardTasksMod(task){
  var params = visibleParams(task);
  return params.some(function(p){ return paramIsModified(task, p); });
}

/* === 配置弹窗（与 .mask 独立 DOM）：单实例复用，cfCurrent 记当前任务 === */
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

export function renderHistoryView(host){
  host.appendChild(viewHead("运行记录", "最近 " + state.history.length + " 次执行，点任一行可看详情，或回看当时的完整日志", "clock", TK.neutral, ""));
  var box = document.createElement("div");
  box.className = "hlist";

  if(!state.history.length){
    var e = document.createElement("div");
    e.className = "estate";
    e.innerHTML = '<div class="e-ic">'+svg("clock")+'</div>'+
      '<div class="e-tt">还没有运行记录</div>'+
      '<div class="e-sub">运行任意任务后，这里会按时间倒序展示每次执行的日志与产物入口。</div>';
    box.appendChild(e); host.appendChild(box); return;
  }

  var head = document.createElement("div");
  head.className = "hrow hd-row";
  head.innerHTML = "<span>时间</span><span>任务</span><span>状态</span><span>耗时</span><span>诊断</span><span></span>";
  box.appendChild(head);

  state.history.forEach(function(h){
    var row = document.createElement("div");
    row.className = "hrow";
    row.style.cursor = "pointer";
    row.innerHTML = '<span class="tm">'+esc(h.start||"")+'</span>'+
      '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(h.name)+'</span>'+
      '<span class="st"><span class="badge '+(STATUS_CLS[h.status]||"b-stop")+'">'+(STATUS_TXT[h.status]||h.status)+'</span></span>'+
      '<span class="tm">'+(h.duration||0)+'s</span>'+
      '<span class="dgm">'+esc(h.error_kind||"")+'</span>';
    var act = document.createElement("span");
    act.className = "act";
    var b = document.createElement("button");
    b.textContent = "看日志";
    b.onclick = (function(entry){ return function(ev){ ev.stopPropagation(); viewRunLog(entry); }; })(h);
    act.appendChild(b);
    var ba = document.createElement("button");
    ba.textContent = "产物";
    ba.onclick = (function(tid){ return function(ev){ ev.stopPropagation(); openArtifacts(tid); }; })(h.task_id);
    act.appendChild(ba);
    row.appendChild(act);
    row.onclick = function(ev){ if(ev.target.closest(".act")) return; openRunDrawer(h); };
    box.appendChild(row);
  });
  host.appendChild(box);
}

/* A3 运行记录详情抽屉：点行滑出右侧抽屉，展示概要 + 日志预览 + 入口按钮（复用 .scrim 遮罩模式） */
export function openRunDrawer(h){
  var scrim = document.getElementById("runScrim");
  var dr = document.getElementById("runDrawer");
  if(!scrim || !dr) return;
  var stCls = STATUS_CLS[h.status] || "b-stop";
  var stTxt = STATUS_TXT[h.status] || h.status;
  var meta =
    '<div class="std-fields">'+
      '<div class="std-row"><span class="std-k">状态</span><span class="std-v"><span class="badge '+stCls+'">'+stTxt+'</span></span></div>'+
      '<div class="std-row"><span class="std-k">时间</span><span class="std-v">'+esc(h.start||"")+'</span></div>'+
      '<div class="std-row"><span class="std-k">耗时</span><span class="std-v">'+(h.duration||0)+'s</span></div>'+
      (h.error_kind ? '<div class="std-row"><span class="std-k">诊断</span><span class="std-v">'+esc(h.error_kind)+'</span></div>' : '')+
    '</div>';
  var preview = "";
  var lines = (h.runId && state.runs[h.runId]) ? state.runs[h.runId].lines : null;
  if(lines && lines.length){
    preview = '<div class="console" style="margin-top:var(--sp-12)">'+
      '<div class="cs-h"><b>日志预览</b><span class="sp"></span></div>'+
      '<div class="cs-body" style="height:220px">'+ lines.map(function(l){ return '<div class="ln">'+esc(l)+'</div>'; }).join("") +'</div></div>';
  }
  dr.querySelector(".rd-body").innerHTML = meta + preview;
  dr.querySelector(".rd-t").textContent = h.name || h.task_id;
  var acts = dr.querySelector(".rd-acts"); acts.innerHTML = "";
  var b1 = document.createElement("button"); b1.className = "btn-primary"; b1.style.flex = "1"; b1.textContent = "查看完整日志";
  b1.onclick = function(){ closeRunDrawer(); viewRunLog(h); };
  var b2 = document.createElement("button"); b2.className = "mini"; b2.style.flex = "1"; b2.textContent = "查看产物";
  b2.onclick = function(){ closeRunDrawer(); openArtifacts(h.task_id); };
  acts.appendChild(b1); acts.appendChild(b2);
  scrim.classList.add("show"); dr.classList.add("show");
}
export function closeRunDrawer(){
  var scrim = document.getElementById("runScrim");
  var dr = document.getElementById("runDrawer");
  if(scrim) scrim.classList.remove("show");
  if(dr) dr.classList.remove("show");
}

/* 自动导出：供其他模块导入的内部顶层符号 */
export { state };
