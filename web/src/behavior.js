// behavior.js —— 行为层（交互行为工具）：滚动锁、确认弹窗、侧栏、参数落盘
// 依赖：store（state.args 等）、api（接口/偏好）、ui（toast/esc）
import { store } from "./store.js";
import { api, savePrefs } from "./api.js";
import { toast, esc } from "./ui.js";

const state = store.state;

export function setArg(tid, flag, val){
  if(!state.args[tid]) state.args[tid] = {};
  state.args[tid][flag] = val;
  savePrefs();
}

export function openSide(){
  document.getElementById("side").className = "side open";
  document.getElementById("scrim").className = "scrim show";
}
export function closeSide(){
  document.getElementById("side").className = "side";
  document.getElementById("scrim").className = "scrim";
}

/* 模态框打开时锁定背景滚动（含 iOS 兜底：position:fixed+记录位置），关闭后按嵌套深度恢复 */
var _scrollLockDepth = 0;
var _scrollLockY = 0;
export function lockScroll(){
  if(_scrollLockDepth === 0){
    _scrollLockY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
    var b = document.body;
    b.style.position = "fixed";
    b.style.top = (-_scrollLockY) + "px";
    b.style.left = "0";
    b.style.right = "0";
    b.style.width = "100%";
  }
  _scrollLockDepth++;
}
export function unlockScroll(){
  if(_scrollLockDepth <= 0) return;
  _scrollLockDepth--;
  if(_scrollLockDepth === 0){
    var b = document.body;
    b.style.position = "";
    b.style.top = "";
    b.style.left = "";
    b.style.right = "";
    b.style.width = "";
    window.scrollTo(0, _scrollLockY);
  }
}

/* 用 MutationObserver 统一接管 4 个模态框的打开/关闭，自动锁/解锁背景滚动，
   避免在每个 open/close 里散落调用导致遗漏或重复计数。
   必须在 DOM 全部解析后安装（本脚本位于 logMask/artMask 之前），否则后者 observe 不到 */
export function installScrollLockObserver(){
  var ids = ["mask","cfMask","logMask","artMask"];
  var obs = new MutationObserver(function(muts){
    muts.forEach(function(m){
      var t = m.target;
      if(ids.indexOf(t.id) < 0) return;
      var had = m.oldValue ? m.oldValue.split(" ").indexOf("show") >= 0 : false;
      var has = t.classList.contains("show");
      if(had !== has){
        if(has && !had) lockScroll();
        else if(!has && had) unlockScroll();
      }
    });
  });
  ids.forEach(function(id){
    var el = document.getElementById(id);
    if(el) obs.observe(el, {attributes:true, attributeFilter:["class"], attributeOldValue:true});
  });
}
if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", installScrollLockObserver);
else installScrollLockObserver();

/* --- 确认弹窗（回调式，避免出现悬空 Promise） --- */
var confirmCb = null;
var confirmCancelCb = null;   /* 取消 / 点遮罩 / Esc 时触发（用于把危险开关拨回去） */
var _confirmAnchor = null;    /* #mask 原位占位符，关闭后按它归位 */

/* 危险弹窗置顶：z-index 令牌只解决「同一层叠上下文内」的先后，
   一旦 #mask 被塞进某个新层叠上下文（祖先有 transform / filter / opacity 等），
   再高的 z-index 也盖不住外部元素。所以打开时把 DOM 挂到 body 末尾，关闭时归位。 */
function hoistConfirm(){
  var el = document.getElementById("mask");
  if(!el) return;
  if(el.parentNode === document.body && el === document.body.lastElementChild) return; // 已在最上层
  if(!_confirmAnchor){
    _confirmAnchor = document.createComment(" mask-anchor ");
    el.parentNode.insertBefore(_confirmAnchor, el);
  }
  document.body.appendChild(el);
}
function restoreConfirm(){
  var el = document.getElementById("mask");
  if(!el || !_confirmAnchor) return;
  if(_confirmAnchor.parentNode) _confirmAnchor.parentNode.insertBefore(el, _confirmAnchor);
  else document.body.appendChild(el);
  if(_confirmAnchor.parentNode) _confirmAnchor.parentNode.removeChild(_confirmAnchor);
  _confirmAnchor = null;
}

export function askConfirm(title, body, sub, cb, onCancel){
  document.getElementById("mTitle").innerHTML =
    '<svg class="ic" viewBox="0 0 24 24" style="color:var(--err)"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'+esc(title);
  document.getElementById("mBody").textContent = body;
  var s = document.getElementById("mSub");
  if(sub){ s.style.display=""; s.textContent = sub; } else s.style.display="none";
  confirmCb = cb;
  confirmCancelCb = onCancel || null;
  hoistConfirm();
  document.getElementById("mask").className = "mask show";
}
export function closeConfirm(){
  /* 只有「取消 / 点遮罩 / Esc」走这里才会触发 onCancel；
     「确认执行」按钮走自己的内联清理，不会误触发取消回调。 */
  var cbc = confirmCancelCb;
  confirmCb = null; confirmCancelCb = null;
  document.getElementById("mask").className = "mask";
  restoreConfirm();
  if(cbc) cbc();
}

/* 确认弹窗按钮接线（confirmCb 为模块私有，故在此统一绑定，供 bindEvents 调用） */
export function bindConfirmUI(){
  document.getElementById("mCancel").onclick = closeConfirm;
  document.getElementById("mOk").onclick = function(){
    var cb = confirmCb;
    confirmCb = null; confirmCancelCb = null;      /* 内联清理：不走 closeConfirm，避免触发 onCancel */
    document.getElementById("mask").className = "mask";
    restoreConfirm();
    if(cb) cb();
  };
  document.getElementById("mask").onclick = function(e){
    if(e.target && e.target.id==="mask") closeConfirm();
  };
}

/* 自动导出：供其他模块导入的内部顶层符号 */
export { _confirmAnchor, _scrollLockDepth, _scrollLockY, confirmCancelCb, confirmCb, hoistConfirm, restoreConfirm, state };
