// api.js —— 接口客户端、访问令牌、偏好持久化
// 依赖：store（读写 state.args 等）、ui（toast 错误兜底）、tokens（TK_MAP）
import { store } from "./store.js";
import { toast } from "./ui.js";
import { TK, TK_MAP } from "./tokens.js";

export const LS_KEY = "wb_fengshen_hub_v1";

/* ---- 设计令牌读取 ----
   真值定义在 server/tokens.css，这里启动时读一次并缓存。
   样式表没加载出来时退回同值兜底，保证配色不塌（值与 tokens.css 保持一致）。 */
function readTokens(){
  var cs = window.getComputedStyle(document.documentElement);
  /* 令牌层是 --brand -> var(--c-brand) 的两级映射。多数浏览器取自定义属性时
     会直接返回代换后的值，但并非所有引擎都会（jsdom 就原样返回 var(...)）。
     这里补一层解析，保证拿到的一定是可用色值。 */
  function deref(v, depth){
    if(!v) return "";
    var m = /^\s*var\(\s*(--[\w-]+)\s*\)\s*$/.exec(v);
    if(m && depth < 5) return deref(cs.getPropertyValue(m[1]), depth + 1);
    return v;
  }
  Object.keys(TK_MAP).forEach(function(k){
    var v = deref(cs.getPropertyValue(TK_MAP[k]), 0);
    if(v && v.trim() && v.indexOf("var(") < 0) TK[k] = v.trim();
  });
}

function loadPrefs(){
  var state = store.state;
  try{
    var raw = localStorage.getItem(LS_KEY);
    if(!raw) return;
    var p = JSON.parse(raw);
    state.args = p.args || {};
    state.taskDefaultGroup = p.taskDefaultGroup || {};
    state.autoScroll = p.autoScroll !== false;
    // 一级菜单展开状态：逐键合并，未记录的键沿用默认值
    //（以后新增带子项的一级菜单，不会因旧存档里没这个键而一进来就是折叠的）
    if(p.navOpen && typeof p.navOpen === "object"){
      Object.keys(p.navOpen).forEach(function(k){ state.navOpen[k] = !!p.navOpen[k]; });
    }
    // 兼容旧版持久化的 filter：映射到新的导航结构
    if(p.nav && p.nav.kind){
      state.nav = { kind:p.nav.kind, id:p.nav.id || "" };
    }else if(p.filter && p.filter !== "all"){
      state.nav = { kind:"tasks", id:p.filter };
    }
    /* 一次性迁移（2026-09-16）：首页改造成数据大屏后设为默认落地页。
       老存档里存的是「上次停留的视图」，会盖掉新默认值 —— 这里强制切一次，
       之后标记落盘、尊重用户自己的选择（不反复抢焦点）。 */
    if(p.homeDefault !== 1){
      state.nav = { kind:"home", id:"" };
    }
    state.homeDefault = 1;
    // 手风琴约束：防止旧存档里残留多个一级菜单同时为展开态
    var _open = Object.keys(state.navOpen).filter(function(k){ return state.navOpen[k] === true; });
    if(_open.length > 1){ _open.slice(1).forEach(function(k){ state.navOpen[k] = false; }); }
  }catch(e){ /* 首次打开或数据损坏，忽略 */ }
}
function savePrefs(){
  var state = store.state;
  try{
    localStorage.setItem(LS_KEY, JSON.stringify({
      nav: state.nav, navOpen: state.navOpen, args: state.args,
      taskDefaultGroup: state.taskDefaultGroup,
      homeDefault: state.homeDefault || 0
    }));
  }catch(e){}
}

/* RBAC：会话令牌登录后存入 sessionStorage，所有请求经 X-Token 头 / ?token= 携带。
   不再依赖服务端注入到页面的全局 token（避免公网暴露时 token 泄露到 HTML 源码）。 */
var WB_TOKEN_KEY = "wb_token", WB_USER_KEY = "wb_user";
export function getToken(){ try{ return sessionStorage.getItem(WB_TOKEN_KEY) || ""; }catch(e){ return ""; } }
export function getSessionUser(){ try{ return JSON.parse(sessionStorage.getItem(WB_USER_KEY) || "null"); }catch(e){ return null; } }
export function setSession(token, user, role){ try{ sessionStorage.setItem(WB_TOKEN_KEY, token); sessionStorage.setItem(WB_USER_KEY, JSON.stringify({user:user, role:role})); }catch(e){} }
export function clearSession(){ try{ sessionStorage.removeItem(WB_TOKEN_KEY); sessionStorage.removeItem(WB_USER_KEY); }catch(e){} }

function withToken(u){ var t = getToken(); return u + (u.indexOf("?")>=0 ? "&" : "?") + "token=" + encodeURIComponent(t); }

/* 未授权回调：由 main.js 注册为弹出登录框；api 在收到 401 时调用 */
var onUnauthorized = null;
export function setUnauthorizedHandler(fn){ onUnauthorized = fn; }

function api(path, opts){
  opts = opts || {};
  var t = getToken();
  opts.headers = Object.assign({}, opts.headers, { "X-Token": t || "" });
  return fetch(path, opts)
    .then(function(r){
      if(r.status === 401){
        if(typeof onUnauthorized === "function") onUnauthorized();
        throw new Error("HTTP 401 未授权");
      }
      if(!r.ok){ throw new Error("HTTP " + r.status + " " + (r.statusText || "")); }
      return r.json();
    })
    .catch(function(err){
      // P0：统一错误兜底，消除静默失败；仍 rethrow 保留调用方 .catch 能力
      var msg = (err && err.message) ? err.message : String(err);
      toast("请求失败：" + msg);
      throw err;
    });
}

/* 登录：POST /api/auth/login → 成功写入会话；返回 Promise<{token,user,role}> */
export function login(username, password){
  return fetch("/api/auth/login", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({username:username, password:password})
  }).then(function(r){
    return r.json().then(function(j){ return {status:r.status, body:j}; });
  }).then(function(res){
    if(res.status === 200 && res.body && res.body.ok){
      setSession(res.body.token, res.body.user, res.body.role);
      return res.body;
    }
    throw new Error((res.body && res.body.error) || "登录失败");
  });
}

/* 登出：POST /api/auth/logout（带当前令牌），之后清本地会话 */
export function logout(){
  var t = getToken();
  return fetch("/api/auth/logout", {
    method:"POST", headers:{"Content-Type":"application/json", "X-Token": t || ""},
    body: "{}"
  }).finally(function(){ clearSession(); });
}

export { readTokens, loadPrefs, savePrefs, withToken, api };

export var _TEAMS_PROMISE = null;
export function ensureTeams(){
  /* 只要拉过（哪怕结果是 fallback）就复用，不再打第二次——「一次」是硬要求。
     想强制刷新只能刷新页面（后端 /api/teams 另有 5 分钟 TTL 兜底）。 */
  var state = store.state;
  if(state.teams) return Promise.resolve(state.teams);
  if(_TEAMS_PROMISE) return _TEAMS_PROMISE;      // 合并并发请求
  _TEAMS_PROMISE = api("/api/teams").then(function(j){
    state.teams = j || {teams:[], source:"unknown"};
    return state.teams;
  }).catch(function(e){
    console.error("[teams] 拉取失败：", e);
    state.teams = {teams:[], source:"fallback"};
    return state.teams;
  }).then(function(r){ _TEAMS_PROMISE = null; return r; });
  return _TEAMS_PROMISE;
}

