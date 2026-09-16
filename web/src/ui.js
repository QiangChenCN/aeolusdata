// ui.js —— 纯展示工具（svg / esc / hexA / toast / debounce），无业务依赖（仅 tokens）
import { ICON, TK } from "./tokens.js";

export function svg(icon, cls){
  return '<svg class="' + (cls||"ic") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
         'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICON[icon]||"") + '</svg>';
}

export function esc(s){
  return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
export function hexA(hex,a){
  var h = String(hex).replace("#","");
  if(h.length===3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  var n = parseInt(h,16);
  return "rgba("+((n>>16)&255)+","+((n>>8)&255)+","+(n&255)+","+a+")";
}

var toastTimer = null;
export function toast(msg){
  var t = document.getElementById("toast");
  if(!t) return;
  t.textContent = msg; t.className = "toast show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ t.className = "toast"; }, 2600);
}

export function debounce(fn, ms){
  var h = null;
  return function(){
    var ctx = this, args = arguments;
    clearTimeout(h);
    h = setTimeout(function(){ fn.apply(ctx, args); }, ms || 200);
  };
}

export function viewHead(title, sub, icon, color, rightHtml){
  var h = document.createElement("div");
  h.className = "view-h";
  h.innerHTML = '<div class="vh-ic" style="background:'+hexA(color,.12)+';color:'+color+'">'+svg(icon)+'</div>'+
                '<div><b>'+esc(title)+'</b>'+(sub?'<div class="vh-sub">'+esc(sub)+'</div>':'')+'</div>'+
                '<div class="sp"></div>'+(rightHtml||"");
  return h;
}

/* 自动导出：供其他模块导入的内部顶层符号 */
export { toastTimer };
