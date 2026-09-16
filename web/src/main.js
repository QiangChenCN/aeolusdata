"use strict";
import { TK, TK_MAP, RISK_LABEL, RISK_CLS, STATUS_CLS, STATUS_TXT, ICON } from "./tokens.js";
import { store, groupOf, taskById, countInGroup, producerOf, missingText, visibleTasks, taskState, argValue } from "./store.js";
import { api, readTokens, __API_TOKEN__, withToken, loadPrefs, savePrefs } from "./api.js";
import { svg, esc, hexA, toast, viewHead } from "./ui.js";
import { bus } from "./bus.js";
import { refreshLan, bindLanToggle, setArg, openSide, closeSide, askConfirm, closeConfirm, bindConfirmUI } from "./behavior.js";
import { renderHeader, renderNav, renderMain } from "./nav.js";
import { renderAttendPeriodView } from "./attend-period.js";
import { renderStandardView } from "./standard.js";
import { renderTaskView, commitParamsForm, fillDefaultToForm, _dpkState, _sessionDangerOK } from "./task.js";
import { openConfigDialog, closeConfigDialog, commitDateRangeGroup, resetDateRangeGroup, cfCurrent, closeRunDrawer } from "./config.js";
import { renderTodoView, loadTodo, todoReload, todoOpenCount, openTodoEditor, closeTodoEditor } from "./todo.js";
import { renderRunModal, openRunModal, openArtifacts, closeArtModal, mountTabulator, fallbackCopy, closeRunModal } from "./runs.js";
import { renderHomeView, skeletonCards } from "./home.js";
const state = store.state;

/* 统一刷新入口 —— 渲染函数之间禁止互调，全部由这里按序调度 */
function refreshAll(){
  renderHeader();
  renderNav();
  renderMain();
}

/* 刷新调度：把同一帧内的多次 refresh 请求合并成一次全量重绘。
   SSE 突发（run_start / queue / history…）或一次交互里多个模块同时 emit 时，
   各自立即重绘会连续重建 nav+main —— 既丢输入焦点/滚动位置又浪费。
   注：requestAnimationFrame 在标签页隐藏时自动暂停，天然做到「后台不重绘、回前台补一次」。 */
var _refreshQueued = false;
function scheduleRefresh(){
  if(_refreshQueued) return;
  _refreshQueued = true;
  requestAnimationFrame(function(){ _refreshQueued = false; refreshAll(); });
}



/* SSE 断线重连后，断线期间推送的日志已经收不到了，主动拉一次补齐 */
function syncCurrentLog(){
  var cur = state.current;
  if(!cur || !cur.run_id) return;
  var rid = cur.run_id;
  api("/api/log?run_id=" + encodeURIComponent(rid)).then(function(res){
    if(!res || !res.ok) return;
    var r = state.runs[rid];
    if(!r) return;
    if((res.lines || []).length > r.lines.length){
      r.lines = res.lines;
      if(state.modalRunId===rid) renderRunModal();
    }
  }).catch(function(){ /* 重连补日志失败不打断主流程 */ });
}

/* --- SSE --- */
/* 修：SSE 断线后必须主动重连 —— 否则用户点了运行看不到日志
   （页面以为 SSE 还活着，但 log/run_start/run_end 都收不到，
   日志模态框永远空白）。浏览器 EventSource 自带心跳重连，但 token
   错一次就 403 永久封死 —— 前端必须主动关 + 重新 new EventSource。
   重连用指数退避（3s 起步，封顶 30s），首次断线给 console.warn + toast
   明确告知，不再静默。 */
var _es = null;          // 当前 EventSource 句柄
var _sseAttempt = 0;     // 连续失败次数，用于指数退避
function _sseClose(){
  if(_es){ try{ _es.close(); }catch(e){} _es = null; }
}
function connect(){
  _sseClose();
  _sseAttempt++;
  _es = new EventSource(withToken("/api/events"));
  _es.onopen = function(){
    _sseAttempt = 0;
    state.connected = true;
    state.sseBroken = false;
    renderHeader();
    syncCurrentLog();                  // 重连后补齐断线期间缺失的日志
  };
  _es.onerror = function(){
    var first = state.connected;       // 仅在「刚断」时给一次告警，避免重复打扰
    state.connected = false;
    state.sseBroken = true;
    renderHeader();
    _sseClose();
    if(first){
      console.warn("[SSE] 连接已断开，3 秒后主动重连……");
      toast("SSE 连接已断开，正在重连……（运行日志可能延迟）");
    }
    var wait = Math.min(30000, 3000 + (_sseAttempt - 1) * 3000);
    setTimeout(function(){
      if(!_es) connect();
    }, wait);
  };
  _es.onmessage = function(ev){
    var d;
    try{ d = JSON.parse(ev.data); }catch(e){ return; }
    if(d.type==="log"){
      var r = state.runs[d.run_id];
      if(!r) return;
      r.lines.push(d.line);
      if(state.modalRunId===d.run_id) renderRunModal();
      return;
    }
    if(d.type==="run_start"){
      state.runs[d.run.run_id] = {
        run_id:d.run.run_id, task_id:d.run.task_id, name:d.run.name,
        status:"running", lines:[], cmd:d.run.cmd, startedAt:Date.now(),
        error_kind:null, error_advice:null
      };
      state.current = d.run;
      if(state.modalRunId){          // 弹窗已开：跟随切到当前任务（批量/流水线逐个显示）
        openRunModal(d.run.run_id);
      }
      scheduleRefresh();
      return;
    }
    if(d.type==="run_end"){
      var rr = state.runs[d.run.run_id];
      if(rr){
        rr.status = d.run.status;
        rr.error_kind = d.run.error_kind;
        rr.error_advice = d.run.error_advice;
      }
      state.current = null;
      /* 跑完归零：节点选择（begin/end）和配置参数都清掉。
         argValue 在 state.args[tid][flag] 拿不到值时会回落到 params[].default，
         所以下次点开/再跑这一任务，全部回到默认行为（默认全跑 + 默认参数）。
         has-mod 角标、节点面板边缘色、配置按钮高亮 都会同步收起。 */
      if(d.run && d.run.task_id && state.args[d.run.task_id]){
        state.args[d.run.task_id] = {};
        savePrefs();
      }
      if(state.modalRunId===d.run.run_id) renderRunModal();
      scheduleRefresh();
      loadState();
      return;
    }
    if(d.type==="todo"){
      /* 工作内容的变化（到点触发 / 执行完成 / 重试 / 别的标签页改了）。
         统一重载拿服务端最新状态，不在这里做增量拼接 —— 重复事项的推进、
         执行记录的状态都是服务端算好的，前端重画一遍最省心也最不容易错。 */
      todoReload();
      if(d.message && d.event && d.event !== "recovered" && d.event !== "changed"){
        toast(d.message);
      }
      return;
    }
    if(d.type==="queue"){
      state.queuedIds = d.queue.map(function(q){ return q.task_id; });
      scheduleRefresh();
      return;
    }
    if(d.type==="history"){
      state.history = d.history || [];
      state.last = {};
      state.history.forEach(function(h){
        if(!state.last[h.task_id]) state.last[h.task_id] = h;
      });
      scheduleRefresh();
      return;
    }
  };
}

/* --- Cookie 状态轮询（独立于 SSE 的只读探针） ---
 *
 * 策略（见 DESIGN.md §8.6）：
 *   · 基础周期 60s + 抖动 ±15s（避免多客户端同时探、也避免固定节拍被探活）
 *   · 页面 visible 时挂链：check → setTimeout(jitter) → check → ...
 *   · 页面 hidden 时立即摘链（clearTimeout + 不挂新链），且不发任何请求
 *   · hidden → visible 切换时先立即探一次（不等下一个周期）再挂链
 *   · beforeunload 摘链，避免关闭标签后回调里再撞 .cookieCap 已脱离 DOM
 *   · 与 SSE 解耦：SSE 断流不影响 cookie 轮询，cookie 探针失败不影响 SSE
 */
var COOKIE_POLL_BASE   = 60 * 1000;     // 基础 60 秒：cookie 失效是分钟级事件，秒级过密
var COOKIE_POLL_JITTER = 15 * 1000;     // 抖动 ±15 秒：4 邻拍错峰 + 反向探测难对齐
var COOKIE_POLL_MIN    =  5 * 1000;     // 兜底下限（防止抖动把周期算成负数）
function nextCookieDelay(){
  var j = (Math.random() * 2 - 1) * COOKIE_POLL_JITTER;
  return Math.max(COOKIE_POLL_MIN, COOKIE_POLL_BASE + j);
}

function checkCookieStatus(){
  return api("/api/cookies/status").then(function(res){
    if(res && res.ok){
      state.cookie = {
        status:     res.status,          // "valid" | "invalid" | "unknown"
        checked_at: res.checked_at,
        reason:     res.reason || null
      };
      state.quark = (res.quark && typeof res.quark === "object") ? res.quark : null;
    } else {
      // 接口层失败（如鉴权 403 / 服务端 500）：真实原因写进 reason + 打日志，不吞掉。
      var why = (res && res.error) ? String(res.error) : "接口返回空响应";
      console.error("[cookie] 状态接口返回非 ok：", res);
      state.cookie = { status: "unknown", checked_at: null,
                       reason: "状态接口异常：" + why, _net: true };
      state.quark = (res && res.quark && typeof res.quark === "object") ? res.quark : null;
    }
    renderHeader();
  }).catch(function(err){
    // 网络/解析失败（如 500 返回非 JSON，r.json() 抛错）：把真实异常打到控制台。
    console.error("[cookie] 状态请求异常：", err);
    state.cookie = { status: "unknown", checked_at: null,
                     reason: "状态请求失败：" + (err && err.message ? err.message : String(err)).slice(0, 120),
                     _net: true };
    renderHeader();
  });
}

function scheduleCookieCheck(){
  // 链式 setTimeout：每次只排下一次，避免固定 setInterval 抖动错不开
  if(!state.cookiePollActive) return;
  if(state.cookiePollHandle){ clearTimeout(state.cookiePollHandle); state.cookiePollHandle = null; }
  state.cookiePollHandle = setTimeout(function(){
    state.cookiePollHandle = null;
    if(!state.cookiePollActive) return;            // 摘链后又触发？直接放弃
    checkCookieStatus().finally(function(){
      // 只有仍然可见且未摘链时才继续排
      if(state.cookiePollActive && document.visibilityState === "visible"){
        scheduleCookieCheck();
      }
    });
  }, nextCookieDelay());
}

function startCookiePolling(){
  if(state.cookiePollActive) return;
  state.cookiePollActive = true;
  // 立即探一次（不等首轮 60s），再挂链
  checkCookieStatus().finally(function(){
    if(state.cookiePollActive && document.visibilityState === "visible"){
      scheduleCookieCheck();
    }
  });
}

function stopCookiePolling(){
  state.cookiePollActive = false;
  if(state.cookiePollHandle){
    clearTimeout(state.cookiePollHandle);
    state.cookiePollHandle = null;
  }
}

function onCookieVisibilityChange(){
  if(document.visibilityState === "visible"){
    // 切回前台：先探一次（用户可能刚刚切了浏览器，cookie 状态可能已变）再挂链
    if(!state.cookiePollActive) startCookiePolling();
    else { checkCookieStatus().finally(function(){ if(state.cookiePollActive) scheduleCookieCheck(); }); }
  } else {
    // 切到后台：摘链 + 取消已排的下一次
    if(state.cookiePollHandle){ clearTimeout(state.cookiePollHandle); state.cookiePollHandle = null; }
  }
}

document.addEventListener("visibilitychange", onCookieVisibilityChange);
// 关闭标签 / 刷新页面时摘链，防止回调撞上脱离 DOM 的元素
window.addEventListener("beforeunload", stopCookiePolling);
// 页面恢复（从 bfcache）时也兜底重启一次
window.addEventListener("pageshow", function(e){
  if(e.persisted && !state.cookiePollActive) startCookiePolling();
});

/* 站点列表：惰性拉取 + 进程内单例。

   2026-09-08 改：不再在页面启动时预拉（多数页面访问根本用不到站点选择器，
   白白多一个网络往返）。改为**首次展开多选下拉的瞬间**才拉一次：
   - 已加载过 → 直接复用 state.teams，不再打接口；
   - 正在加载 → 复用同一个 in-flight Promise（并发开多个弹窗只打一次）；
   - 失败 → state.teams 置为 fallback，浮层顶部出 ⚠ 提示，用户仍可重开再试。

   真正出数的那次（跑任务）已完全不打站点接口，见 jobs/attendance/attendance.py。 */


function loadState(){
  api("/api/state").then(function(s){
    if(!s || !s.ok){
      /* 鉴权失效（token 不匹配/页面陈旧）时明确提示，不要静默——否则表现为
         页面「能打开但数据空、点了运行没反应」，用户无从定位。 */
      if(s && s.error === "unauthorized"){
        toast("页面登录态已失效，请刷新页面（Ctrl/Cmd+Shift+R）");
        console.error("[state] 鉴权失效（unauthorized）：当前页面 token 与工作台服务不匹配，刷新即可恢复");
      }
      state.connected = false; renderHeader(); return;
    }
    state.registry = s.registry || state.registry;
    state.groups = (s.registry && s.registry.groups) || [];
    state.tasks  = (s.registry && s.registry.tasks)  || [];
    state.current = s.current;
    // 服务端会带上当前任务已有的日志，页面刷新后据此把丢失的输出补回来
    if(s.current && s.current.run_id && !state.runs[s.current.run_id]){
      state.runs[s.current.run_id] = {
        run_id:s.current.run_id, task_id:s.current.task_id, name:s.current.name,
        status:"running", lines:s.current_lines||[], cmd:s.current.cmd||"",
        startedAt:Date.now(), error_kind:null, error_advice:null
      };
    }
    state.history = s.history || [];
    state.queuedIds = s.queuedIds || [];
    state.last = s.last || {};
    state.connected = true;
    scheduleRefresh();
  }).catch(function(){ state.connected = false; renderHeader(); });
}

/* --- 事件绑定（DOM 就绪后一次性绑定） --- */
function bindEvents(){
  bindConfirmUI();   // 确认弹窗按钮接线（confirmCb 为 behavior.js 私有）
  document.getElementById("btnMenu").onclick = openSide;
  document.getElementById("btnSideClose").onclick = closeSide;
  document.getElementById("scrim").onclick = closeSide;

  /* --- 配置弹窗（任务卡片的可复用入口） ---
     保存/恢复默认/取消 三件事的最简交互：
     · 保存 = commitParamsForm 收集表单 → setArg 写 state.args → savePrefs 落盘 → refreshAll → close
     · 恢复默认 = fillDefaultToForm 仅改控件显示，不写 state（确认保存才会落盘）
     · 取消/关闭/点遮罩 = closeConfigDialog，不写 state
     注意 commit 走的是 task 自带的 params 列表，控件只是 viewport —— 单实例就能服务所有任务 */
  document.getElementById("cfClose").onclick = closeConfigDialog;
  document.getElementById("cfCancel").onclick = closeConfigDialog;
  document.getElementById("cfSave").onclick = function(){
    if(!cfCurrent) return;
    var t = cfCurrent;
    commitParamsForm(t, document.getElementById("cfBody"));
    commitDateRangeGroup(t);   /* 单日/多日分组：按当前模式只写对应 flag */
    closeConfigDialog();
    /* 摘要因 param 改动要重新展示 mod 角标；节点区间在改动 begin/end 后也会变 */
    scheduleRefresh();
    toast("「" + t.name + "」配置已保存");
  };
  document.getElementById("cfDefault").onclick = function(){
    if(!cfCurrent) return;
    fillDefaultToForm(cfCurrent, document.getElementById("cfBody"));
    resetDateRangeGroup(cfCurrent);   /* 单日/多日分组控件一并回到默认（单日、清空） */
  };
  document.getElementById("cfMask").onclick = function(e){
    if(e.target && e.target.id === "cfMask") closeConfigDialog();
  };
  // 工作内容（提醒事项）弹窗：点遮罩关闭。外壳是静态 DOM，内容与按钮由
  // openTodoEditor / openListEditor 动态填充，所以只在外壳上挂这一处。
  document.getElementById("tdMask").onclick = function(e){
    if(e.target && e.target.id === "tdMask") closeTodoEditor();
  };

  /* --- 运行日志弹窗 --- */
  document.getElementById("mlClose").onclick = closeRunModal;
  document.getElementById("logMask").onclick = function(e){
    if(e.target && e.target.id === "logMask") closeRunModal();
  };
  // 运行日志弹窗内「产物」按钮 + 产物浏览器关闭
  document.getElementById("mlArt").onclick = function(){ openArtifacts(state.modalTaskId); };
  document.getElementById("artClose").onclick = closeArtModal;
  document.getElementById("artMask").onclick = function(e){
    if(e.target && e.target.id === "artMask") closeArtModal();
  };
  // 产物表格多 sheet 切换（动态生成，用 document 委托）
  document.addEventListener("click", function(e){
    var b = e.target && e.target.closest ? e.target.closest(".stab") : null;
    if(!b) return;
    if(!window.__artSheets) return;
    var paneId = b.getAttribute("data-pane");
    if(!paneId) return;
    var body = document.getElementById("arttabBody");
    if(body){
      body.querySelectorAll(".tabpane").forEach(function(p){ p.style.display = (p.id===paneId)?"":"none"; });
      body.parentElement.querySelectorAll(".stab").forEach(function(x){ x.className = "stab" + (x===b ? " on" : ""); });
      var idx = parseInt(paneId.split("_").pop(), 10);
      var host = document.getElementById("host_"+idx);
      if(host && !host.querySelector(".tabulator")){
        var s = window.__artSheets && window.__artSheets[idx];
        if(s) mountTabulator("host_"+idx, s.headers, s.rows);
      }
    }
  });
  document.getElementById("mlStop").onclick = function(){
    var run = state.modalRunId ? state.runs[state.modalRunId] : null;
    if(!run || run.status!=="running") return;
    var n = state.queuedIds.length;
    askConfirm("终止当前任务",
      "将强制结束正在运行的进程及其子进程" +
      (n ? "，并取消队列中尚未开始的 " + n + " 个任务" : "") + "。",
      "注意：已经开始执行的任务无法回滚（已发出的钉钉消息也撤不回）。", function(){
        api("/api/stop", { method:"POST", headers:{"Content-Type":"application/json"},
          body:"{}" }).then(function(){ toast("已发送终止指令"); });
      });
  };
  document.getElementById("mlAuto").onclick = function(){
    state.modalAutoScroll = !state.modalAutoScroll;
    document.getElementById("mlAutoTxt").textContent = state.modalAutoScroll ? "自动" : "手动";
    this.style.color = state.modalAutoScroll ? "" : "var(--brand)";
    this.style.borderColor = state.modalAutoScroll ? "" : "var(--brand)";
    if(state.modalAutoScroll){
      var b = document.getElementById("mlBody");
      b.scrollTop = b.scrollHeight;
    }
  };
  document.getElementById("mlCopy").onclick = function(){
    var run = state.modalRunId ? state.runs[state.modalRunId] : null;
    if(!run || !run.lines.length){ toast("没有日志可复制"); return; }
    var text = run.lines.join("\n");
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){ toast("已复制日志"); },
        function(){ fallbackCopy(text); });
    } else fallbackCopy(text);
  };
  document.getElementById("mlDl").onclick = function(){
    if(!state.modalRunId){ toast("没有可下载的日志"); return; }
    window.location.href = withToken("/api/download?run_id=" + encodeURIComponent(state.modalRunId));
  };

  document.addEventListener("keydown", function(e){
    if(e.key!=="Escape") return;
    /* 日期浮层开着时，Esc 只归它：这里若照旧 closeConfigDialog()，会把配置弹窗连带关掉，
       用户在弹窗里点的日期 / 填的参数全丢。picker 自己有 Esc 处理器负责收起自己。 */
    if(_dpkState) return;
    closeConfirm(); closeSide(); closeConfigDialog(); closeRunModal(); closeArtModal(); closeTodoEditor();
  });
}

/* --- 启动 --- */
function syncHeaderHeight(){
  // 左侧导航是 sticky 定位，需要精确知道顶栏实际高度（字体/换行会让它变化）
  var hd = document.querySelector("header");
  if(hd && hd.offsetHeight){
    document.documentElement.style.setProperty("--layout-hd", hd.offsetHeight + "px");
  }
}
function init(){
  readTokens();
  loadPrefs();
  loadTodo();          // 工作内容（提醒事项）独立持久化，与任务参数偏好分开存
  /* 首屏占位骨架（D2）：loadState 是异步的，先给 viewHost 一个骨架，避免首屏空白闪一下 */
  var _vh = document.getElementById("viewHost");
  if(_vh) skeletonCards(_vh, 4);
  bindEvents();
  /* 功能模块通过 bus.emit("refresh") 请求重渲染（导航切换 / 数据更新 / todo 变更等），
     统一在此订阅 —— 模块化提取时该订阅曾丢失，导致点击导航只改 state 不重绘。 */
  bus.on("refresh", refreshAll);
  syncHeaderHeight();
  window.addEventListener("resize", syncHeaderHeight);
  state.sseBroken = false;  // SSE 状态旗标：true = 已断，重连中
  loadState();
  /* 站点列表不再启动期预拉：改为首次展开多选下拉时惰性拉一次（见 ensureTeams）。
     这样打开工作台 / 运行其它任务都不会多出站点接口的往返。 */
  connect();
  startCookiePolling();
  bindLanToggle();
  refreshLan();
  /* A3 运行记录详情抽屉：关闭逻辑（遮罩 / 关闭按钮 / Esc） */
  var _rs = document.getElementById("runScrim");
  if(_rs){
    _rs.addEventListener("click", closeRunDrawer);
    var _rx = document.getElementById("runDrawerX");
    if(_rx) _rx.addEventListener("click", closeRunDrawer);
    document.addEventListener("keydown", function(e){
      if(e.key === "Escape" && _rs.classList.contains("show")) closeRunDrawer();
    });
  }
  setInterval(function(){
    if(!state.connected) loadState();
  }, 8000);
}

if(document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", init);
}else{
  init();
}

/* 自动导出：供其他模块导入的内部顶层符号 */
export { COOKIE_POLL_BASE, COOKIE_POLL_JITTER, COOKIE_POLL_MIN, _es, _sseAttempt, _sseClose, bindEvents, checkCookieStatus, connect, init, loadState, nextCookieDelay, onCookieVisibilityChange, refreshAll, scheduleRefresh, scheduleCookieCheck, startCookiePolling, state, stopCookiePolling, syncCurrentLog, syncHeaderHeight };
