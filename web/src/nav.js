import { store, groupOf, taskById, countInGroup, producerOf, missingText, visibleTasks, taskState, argValue } from "./store.js";
import { api, savePrefs, loadPrefs, readTokens, withToken, ensureTeams } from "./api.js";
import { svg, esc, hexA, toast, debounce, viewHead } from "./ui.js";
import { TK, TK_MAP, RISK_LABEL, RISK_CLS, STATUS_CLS, STATUS_TXT, ICON } from "./tokens.js";
import { bus } from "./bus.js";
import { refreshLan, bindLanToggle, setArg, openSide, closeSide, askConfirm, closeConfirm, bindConfirmUI, lockScroll, unlockScroll } from "./behavior.js";
import { _gpReap, renderTaskView } from "./task.js";
import { renderHistoryView } from "./config.js";
const state = store.state;

import { renderAttendPeriodView } from "./attend-period.js";
import { renderStandardView } from "./standard.js";
import { renderHomeView } from "./home.js";
import { renderTodoView, todoOpenCount } from "./todo.js";

/* ================= 渲染层（互不调用，统一由 refreshAll 调度） ================= */
export function renderHeader(){
  var full, short, dot;
  if(state.connected === true)      { dot = "on";  full = "工作台服务已连接"; short = "服务已连接"; }
  else if(state.connected === false){ dot = "off"; full = "工作台服务已断开"; short = "服务已断开"; }
  else                              { dot = "";    full = "正在连接服务";     short = "连接中"; }
  // 文案必须点名连接对象（本地工作台服务），不能只说「已连接」——见 DESIGN.md §8.5。
  // 窄屏（≤1000px）放不下长文案，切 .st-short 短版，对象词「服务」仍保留。
  document.getElementById("connDot").className = ("dot " + dot).trim();
  document.getElementById("connTxt").textContent = full;
  document.getElementById("connTxtS").textContent = short;
  // Cookie 有效性胶囊（只读探针，由轮询函数 checkCookieStatus 填 state.cookie）
  var c = state.cookie;
  var cFull, cShort, cDot, cTitle;
  if(c === null){
    cDot = ""; cFull = "Cookie 待校验"; cShort = "校验中";
    cTitle = "尚未发起校验。页面打开时每 60s±15s 自动探一次；可见性恢复时立即刷一次。";
  } else if(c.status === "valid"){
    cDot = "on"; cFull = "Cookie 有效"; cShort = "有效";
    cTitle = "风神会话仍可用（探针 validToken 返回 200）。最近一次校验：" + (c.checked_at || "—");
  } else if(c.status === "invalid"){
    cDot = "off"; cFull = "Cookie 已失效"; cShort = "已失效";
    cTitle = "探针 validToken 返回 401，风神会话已失效（多因浏览器活跃顶掉脚本会话）。需要重新登录才能继续跑需要 cookie 的任务。最近一次校验：" + (c.checked_at || "—");
  } else {
    // 真实探针 unknown 显示「未知」；接口/网络层失败（_net）显示「校验异常」明确区分，不把错误伪装成「未知」。
    cDot = ""; cFull = "Cookie 状态未知"; cShort = c._net ? "校验异常" : "未知";
    cTitle = (c.reason || "未知原因") + "（最近一次校验：" + (c.checked_at || "—") + "）";
  }
  document.getElementById("cookieDot").className = ("dot " + cDot).trim();
  document.getElementById("cookieTxt").textContent = cFull;
  document.getElementById("cookieTxtS").textContent = cShort;
  document.getElementById("cookieCap").setAttribute("title", cTitle);

  // Quark DA cookie 胶囊（只读探针，由轮询函数 checkCookieStatus 填 state.quark）
  var q = state.quark;
  var qFull, qShort, qDot, qTitle;
  if(q === null){
    qDot = ""; qFull = "Quark 待校验"; qShort = "校验中";
    qTitle = "尚未发起校验。页面打开时每 60s±15s 自动探一次；可见性恢复时立即刷一次。";
  } else if(q.status === "valid"){
    qDot = "on"; qFull = "Quark 有效"; qShort = "有效";
    qTitle = "Quark DA cookie 存活（FbiSiteAction 探针放行）。"
             + (q.age_hours != null ? "缓存约 " + q.age_hours.toFixed(1) + " 小时前。" : "")
             + "最近校验：" + (q.checked_at || "—");
  } else if(q.status === "invalid"){
    qDot = "off"; qFull = "Quark 已失效"; qShort = "已失效";
    qTitle = "FbiSiteAction 探针被踢回 HTML 登录页，Quark DA cookie 已失效（需重兑）。"
             + "触发装备点亮等 Quark 任务会自动重登重兑。最近校验：" + (q.checked_at || "—");
  } else if(q.status === "nocache"){
    qDot = ""; qFull = "Quark 未兑换"; qShort = "未兑换";
    qTitle = (q.reason || "尚未兑换 Quark DA cookie")
             + "（跑一次装备点亮等 Quark 任务后会产生缓存）。";
  } else {
    qDot = ""; qFull = "Quark 状态未知"; qShort = q._net ? "校验异常" : "未知";
    qTitle = (q.reason || "未知原因") + "（最近校验：" + (q.checked_at || "—") + "）";
  }
  document.getElementById("quarkDot").className = ("dot " + qDot).trim();
  document.getElementById("quarkTxt").textContent = qFull;
  document.getElementById("quarkTxtS").textContent = qShort;
  document.getElementById("quarkCap").setAttribute("title", qTitle);

  // 顶栏只有「标题 + 服务状态 + cookie 状态 + 操作按钮」，不再挂副标题：
  // 部署路径属于服务器细节，任务总数在各视图标题里已有，两处都不放在顶栏——见 DESIGN.md §8.5。
}

/* --- 左侧导航：扁平条目（任务分组 + 运行记录），无分组小标题 --- */
/* --- 左侧导航：一级（首页 / 任务中心 / 数据看板 / 工作内容） + 二级（业务分组 + 运行记录） ---
   业务分组与「运行记录」整体收进「任务中心」的二级，一级只保留四类入口，侧栏不再随分组数量无限变长。
   二级仍用 kind:"tasks"(分组) / kind:"history"(运行记录) + id，与既有任务视图、批量执行栏、日志弹窗完全兼容，无需改动。 */
export function navSections(){
  // 菜单用应景图标（Lucide ISC 协议；与 ICON 字典条目同名）；
  // 未在表里的分组降级为 grid，保持旧观感不出错。
  var GROUP_ICONS = {
    attendance: "user-check",     // 排班考勤：打卡签到
    task      : "store",          // 商站任务：店铺
    equip     : "lightbulb",      // 装备点亮：灯泡
    delivery  : "truck",          // 运单处理：货车
    unsat     : "msg-warn",       // 不满意单（含违规申诉）：对话气泡+警告
    tool      : "wrench"          // 其他工具：扳手
  };
  /* 注：「数据看板」不是业务分组，不在此表——它是与「任务中心」平级的一级导航项，
     图标在下面 items.push 处直接指定 "chart"。 */
  var items = [];

  // 1) 首页
  items.push({ kind:"home", id:"", name:"首页", icon:"house", color:TK.brand });

  // 2) 任务中心（一级容器）→ 二级挂「全部任务」+ 各业务分组
  var subs = [{ kind:"tasks", id:"all", name:"全部任务", icon:"grid",
                count:state.tasks.length, color:TK.brand }];
  state.groups.forEach(function(g){
    subs.push({ kind:"tasks", id:g.id, name:g.name, icon:GROUP_ICONS[g.id] || "grid",
                count:countInGroup(g.id), color:g.color });
  });
  /* 运行记录：同样是「任务中心」下的二级入口（kind:"history"），与业务分组平级。
     设计上把它收进任务中心，而非一级平铺，避免侧栏顶层随入口数膨胀。 */
  subs.push({ kind:"history", id:"", name:"运行记录", icon:"clock",
              count:state.history.length, color:TK.neutral });
  items.push({ kind:"hub", id:"", name:"任务中心", icon:"layers",
               count:state.tasks.length, color:TK.brand, children:subs });

  /* 3) 数据看板：一级容器，与「任务中心」平级，下面挂各看板子页（如标准达成）。
        它不是任务容器，不带 count 计数；颜色走 TK.cyan。点父项会展开并落到第一个子页。 */
  var dashSubs = [
    { kind:"standard", id:"", name:"标准达成", icon:"target", color:TK.cyan },
    { kind:"attendPeriod", id:"", name:"时段出勤", icon:"calendar-clock", color:TK.cyan }
  ];
  items.push({ kind:"dash", id:"dash", name:"数据看板", icon:"chart",
               color:TK.cyan, children:dashSubs });

  // 4) 工作内容（提醒事项），计数 = 未完成条数
  items.push({ kind:"todo", id:"", name:"工作内容", icon:"list-checks",
               count:todoOpenCount(), color:TK.brand });

  return items;
}

/* 手风琴：展开某一个带 children 的一级菜单，同时收起其它所有带 children 的一级菜单。
   保证「同时只有一个一级菜单展开」。 */
export function navExpandOnly(kind){
  navSections().forEach(function(o){
    if(o.children && o.children.length) state.navOpen[o.kind] = (o.kind === kind);
  });
}

/* 某个导航项（或它的任意子项）下是否有任务正在跑 */
export function navBusy(it){
  if(!state.current) return false;
  function idsOf(c){
    if(c.kind !== "tasks") return [];
    return c.id==="all" ? state.tasks.map(function(t){ return t.id; })
                        : state.tasks.filter(function(t){ return t.group===c.id; })
                                     .map(function(t){ return t.id; });
  }
  if(idsOf(it).indexOf(state.current.task_id) >= 0) return true;
  if(it.children) return it.children.some(function(c){
    return idsOf(c).indexOf(state.current.task_id) >= 0;
  });
  return false;
}

export function renderNav(){
  var box = document.getElementById("navBox");
  box.innerHTML = "";
  navSections().forEach(function(it){
    var hasSub   = !!(it.children && it.children.length);
    var open     = hasSub && state.navOpen[it.kind] === true;   // 手风琴：只有显式展开才算展开
    var selfOn   = !hasSub && state.nav.kind===it.kind && state.nav.id===it.id;
    var parentOn = hasSub && it.children.some(function(c){
      return state.nav.kind===c.kind && state.nav.id===c.id;
    });

    var b = document.createElement("button");
    b.className = "nv" + (selfOn?" on":"") + (parentOn?" parent-on":"") +
                  (hasSub?" has-sub":"") + (open?" open":"");
    b.innerHTML = svg(it.icon) + '<span class="nm">'+esc(it.name)+'</span>' +
                  (navBusy(it) ? '<span class="nv-dot" style="background:var(--info)"></span>' : '') +
                  (it.count!=null ? '<span class="ct">'+it.count+'</span>' : '') +
                  (hasSub ? svg("arrow","ic nv-arw") : '');
    b.onclick = function(){
      if(hasSub){
        var willOpen = !state.navOpen[it.kind];   // 当前未显式展开 → 即将展开
        if(willOpen){
          navExpandOnly(it.kind);                 // 展开自己 + 收起其它（手风琴）
          if(!parentOn){                          // 当前不在它的子树内 → 落第一个子视图
            var first = it.children[0];
            state.nav = { kind:first.kind, id:first.id };
            savePrefs(); bus.emit("refresh"); closeSide();
          }else{                                  // 纯展开：窄屏保持抽屉，方便继续点二级
            savePrefs(); bus.emit("refresh");
          }
        }else{                                    // 当前已展开 → 收起自己
          state.navOpen[it.kind] = false;
          savePrefs(); bus.emit("refresh");
        }
      }else{
        state.nav = { kind:it.kind, id:it.id };
        savePrefs(); bus.emit("refresh"); closeSide();
      }
    };
    box.appendChild(b);

    if(hasSub && open){
      var subs = document.createElement("div");
      subs.className = "nv-subs";
      it.children.forEach(function(c){
        var con = (state.nav.kind===c.kind && state.nav.id===c.id);
        var sb = document.createElement("button");
        sb.className = "nv-sub" + (con?" on":"");
        sb.innerHTML = svg(c.icon,"ic ic-sm") + '<span class="nm">'+esc(c.name)+'</span>' +
                       (navBusy({kind:c.kind,id:c.id}) ?
                         '<span class="nv-dot" style="background:var(--info)"></span>' : '') +
                       (c.count!=null ? '<span class="ct">'+c.count+'</span>' : '');
        sb.onclick = function(){
          state.nav = { kind:c.kind, id:c.id };
          savePrefs(); bus.emit("refresh"); closeSide();
        };
        subs.appendChild(sb);
      });
      box.appendChild(subs);
    }
  });
}

/* --- 内容区：按导航切换，内部排版自由 --- */
/* 内容区滚动容器（#viewHost 的最近可滚动祖先，通常是 main.main） */
function _scrollParent(el){
  var p = el && el.parentElement;
  while(p){
    var oy = getComputedStyle(p).overflowY;
    if(oy === "auto" || oy === "scroll") return p;
    p = p.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

/* 上次渲染的视图键：用于区分「切视图」与「同视图内重绘」 */
var _lastViewKey = null;

export function renderMain(){
  var host = document.getElementById("viewHost");
  _gpReap();                 /* 卡片里的 combobox 会被这次重渲染丢弃，先回收它们的孤儿浮层 */
  /* 全量重绘会重建 DOM：切视图时回到顶部；同一视图内重绘（SSE / 数据更新）时
     保留输入焦点/光标与滚动位置 —— 否则正在搜索的输入框会失焦、光标归零、列表跳回顶部。 */
  var key = state.nav.kind + "|" + state.nav.id;
  var sameView = (key === _lastViewKey);
  var scroller = _scrollParent(host);
  var scrollTop = (sameView && scroller) ? scroller.scrollTop : 0;
  var focusId = null, selS = null, selE = null;
  if(sameView){
    var ae = document.activeElement;
    if(ae && ae.id && host.contains(ae)){
      focusId = ae.id;
      if(typeof ae.selectionStart === "number"){ selS = ae.selectionStart; selE = ae.selectionEnd; }
    }
  }
  host.innerHTML = "";
  if(state.nav.kind==="home")         renderHomeView(host);
  else if(state.nav.kind==="todo")    renderTodoView(host);
  else if(state.nav.kind==="tasks")   renderTaskView(host);
  else if(state.nav.kind==="standard") renderStandardView(host);
  else if(state.nav.kind==="attendPeriod") renderAttendPeriodView(host);
  else if(state.nav.kind==="history") renderHistoryView(host);
  else renderTaskView(host);   // 兜底（hub / logs 等旧导航值统一回落到任务视图）
  _lastViewKey = key;
  if(scroller) scroller.scrollTop = scrollTop;
  if(focusId){
    var el = document.getElementById(focusId);
    if(el && el.focus){
      el.focus();
      if(selS != null && typeof el.setSelectionRange === "function"){
        try{ el.setSelectionRange(selS, selE); }catch(e){ /* 非文本输入，忽略 */ }
      }
    }
  }
}

/* 自动导出：供其他模块导入的内部顶层符号 */
export { state };
