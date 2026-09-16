// 自动生成的模块头：统一依赖（未使用的导入会被打包器摇树移除）
import { store, groupOf, taskById, countInGroup, producerOf, missingText, visibleTasks, taskState, argValue } from "./store.js";
import { api, savePrefs, loadPrefs, readTokens, withToken } from "./api.js";
import { svg, esc, hexA, toast, debounce, viewHead } from "./ui.js";
import { TK, TK_MAP, RISK_LABEL, RISK_CLS, STATUS_CLS, STATUS_TXT, ICON } from "./tokens.js";
import { bus } from "./bus.js";
import { refreshLan, bindLanToggle, setArg, openSide, closeSide, askConfirm, closeConfirm, bindConfirmUI, lockScroll, unlockScroll } from "./behavior.js";
import { renderModalDiag, lineEl } from "./todo.js";
const state = store.state;

export function renderRunModal(){
  var rid = state.modalRunId;
  var run = rid ? state.runs[rid] : null;
  // 标题 + 状态点
  document.getElementById("mlTitle").textContent = run ? (run.name || "运行日志") : "运行日志";
  var dotCls = { running:TK.termOk, failed:TK.termBad, success:TK.termCmd,
                 stopped:TK.termWarn, queued:TK.termWarn }[run ? run.status : ""];
  document.getElementById("mlDot").style.background = dotCls || "var(--muted-2)";
  document.getElementById("mlStop").disabled = !(run && run.status==="running");
  // 命令
  var cmd = document.getElementById("mlCmd");
  if(run && run.cmd){ cmd.style.display="block"; cmd.textContent = "$ " + run.cmd; }
  else cmd.style.display = "none";
  // body 增量渲染
  var body = document.getElementById("mlBody");
  var empty = document.getElementById("mlEmpty");
  if(!run || !run.lines || run.lines.length===0){
    body.innerHTML = "";
    if(empty) body.appendChild(empty);
    renderModalDiag(run);
    return;
  }
  if(empty && empty.parentNode===body) body.removeChild(empty);
  if(state.modalRenderedRunId !== rid){
    body.innerHTML = ""; state.modalCount = 0; state.modalRenderedRunId = rid;
  }
  var done = state.modalCount || 0;
  for(var i=done;i<run.lines.length;i++){ body.appendChild(lineEl(run.lines[i])); }
  state.modalCount = run.lines.length;
  if(state.modalAutoScroll) body.scrollTop = body.scrollHeight;
  renderModalDiag(run);
}
export function openRunModal(runId){
  state.modalRunId = runId;
  // 提交后立即开弹窗：此时服务端已入队、但 run_start 尚未推来，run 对象还不存在。
  // 先建一个占位 run（排队中状态 + 一行提示），让面板立刻给出「已加入执行队列」反馈，
  // 而不是空白（旧占位写的是「点击运行后…」，已点过运行却仍显示它，造成 2-3 秒错觉）。
  // run_start 推来后，SSE 处理器会用真实 run 对象覆盖这里。
  if(!state.runs[runId]){
    state.runs[runId] = {
      run_id: runId, task_id: null, name: "运行日志",
      status: "queued", lines: ["已加入执行队列，等待脚本启动…"],
      cmd: "", startedAt: Date.now(), error_kind: null, error_advice: null
    };
  }
  // 解析 taskId 供弹窗内「产物」按钮使用（内存 run 或历史记录都可回溯）
  var run = state.runs[runId];
  var tid = run ? run.task_id : null;
  if(!tid){
    var hh = (state.history || []).filter(function(x){ return x.run_id === runId; })[0];
    tid = hh ? hh.task_id : null;
  }
  state.modalTaskId = tid;
  state.modalRenderedRunId = null;   // 强制整块重绘
  state.modalCount = 0;
  document.getElementById("logMask").className = "logmask show";
  renderRunModal();
  // SSE 兜底：弹窗瞬间立刻拉一次日志（不再等 SSE 把 run_start 推过来才显示）
  // 后续若 SSE 健康会自动接管；SSE 断线时 syncRunLog 自带轮询接管推送。
  syncRunLog(runId, true);
}

/* 弹窗日志兜底：拉一次 + 必要时自轮询。
   rid        —— 要拉/跟随的 run_id
   autoFollow —— true 时，若服务端该 run 仍在 running 且 SSE 不可靠，
                 就每 1 秒拉一次；run 结束或 SSE 已恢复则停。 */
export function syncRunLog(rid, autoFollow){
  if(!rid) return;
  api("/api/log?run_id=" + encodeURIComponent(rid)).then(function(res){
    if(!res || !res.ok) return;
    var cur = state.runs[rid] || {
      run_id: rid, task_id: null, name: "运行日志",
      status: "running", lines: [], cmd: "", startedAt: Date.now(),
      error_kind: null, error_advice: null
    };
    // 服务端此时若还没产生日志（run 仍在排队），res.lines 是 []（JS 中为真值），
    // 不能 "res.lines || cur.lines" 否则会把已显示给用户的占位行清空。
    // 仅当服务端确有日志内容时才用服务端数据覆盖。
    cur.lines = (res.lines && res.lines.length) ? res.lines : cur.lines;
    cur.status = res.status || cur.status;
    cur.error_kind = res.error_kind || cur.error_kind;
    cur.error_advice = res.error_advice || cur.error_advice;
    if(res.task_id) cur.task_id = res.task_id;
    if(res.name) cur.name = res.name;
    state.runs[rid] = cur;
    if(state.modalRunId===rid) renderRunModal();
    if(autoFollow && cur.status==="running" && state.sseBroken){
      setTimeout(function(){
        if(state.modalRunId===rid) syncRunLog(rid, true);
      }, 1000);
    }
  }).catch(function(){ /* 拉取失败不打断主流程；下次弹窗会再试 */ });
}
export function closeRunModal(){
  document.getElementById("logMask").className = "logmask";
  state.modalRunId = null;
}

/* 任务产物浏览器：拉该任务已生成的产物清单，左侧列表 + 右侧内联预览。
   图片 → <img>、HTML → <iframe>、文本/CSV/JSON → 拉取后塞 <pre> 内联；其余提示去新标签。
   全程在当前浏览器窗口内查看，不离开工作台、不强制下载。 */
export function openArtifacts(taskId){
  if(!taskId){ toast("无法确定任务，无法列出产物"); return; }
  document.getElementById("artTitle").textContent = "任务产物 · " + taskId;
  document.getElementById("artCur").textContent = "";
  document.getElementById("artNewTab").style.display = "none";
  document.getElementById("artPrev").innerHTML =
    '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>加载中…</div>';
  document.getElementById("artList").innerHTML = '<div class="empty">加载中…</div>';
  document.getElementById("artMask").className = "artmask show";
  api("/api/files?task_id=" + encodeURIComponent(taskId))
    .then(function(res){
      if(!res || !res.ok){ renderArtList([]); toast("读取产物失败"); return; }
      renderArtList(res.files || []);
    })
    .catch(function(e){ renderArtList([]); toast("读取产物失败：" + e); });
}
export function renderArtList(files){
  var list = document.getElementById("artList");
  list.innerHTML = "";
  if(!files.length){
    list.innerHTML = '<div class="empty">该任务暂无产物文件（运行一次生成后会出现在这里）</div>';
    return;
  }
  files.forEach(function(f){
    var it = document.createElement("div");
    it.className = "artitem";
    it.setAttribute("data-rel", f.rel);
    it.setAttribute("data-type", f.type);
    it.innerHTML = '<span class="nm">'+esc(f.name)+'</span>'+
                   '<span class="mt">'+esc(f.mtime)+'</span>'+
                   '<span class="ty">'+esc(f.type)+'</span>';
    it.onclick = function(){ selectArtifact(f.rel, f.type, f.name); };
    list.appendChild(it);
  });
  selectArtifact(files[0].rel, files[0].type, files[0].name);   // 自动预览第一个
}
export function selectArtifact(rel, type, name){
  var items = document.getElementById("artList").querySelectorAll(".artitem");
  items.forEach(function(it){ it.className = "artitem" + (it.getAttribute("data-rel")===rel ? " on":""); });
  document.getElementById("artCur").textContent = name || rel;
  var nt = document.getElementById("artNewTab");
  nt.href = withToken("/api/file?path=" + encodeURIComponent(rel));
  nt.style.display = "";
  var prev = document.getElementById("artPrev");
  var url = withToken("/api/file?path=" + encodeURIComponent(rel));
  var isTab = /\.(csv|tsv)$/i.test(rel);
  if(type==="image"){
    prev.innerHTML = '<img src="'+url+'" alt="'+esc(name)+'">';
  } else if(type==="html"){
    prev.innerHTML = '<iframe src="'+url+'" title="'+esc(name)+'"></iframe>';
  } else if(type==="sheet"){
    // xlsx / xls 表格控件：服务端解析成 JSON 后渲染
    prev.innerHTML = '<div class="artload">正在解析表格…</div>';
    api("/api/sheet?path="+encodeURIComponent(rel))
      .then(function(d){
        if(!d.ok){ prev.innerHTML = '<div class="aperr">'+esc(d.error||"解析失败")+'</div>'; return; }
        prev.innerHTML = renderSheets(d);
      })
      .catch(function(){ prev.innerHTML = '<div class="aperr">预览失败，请用「新标签打开」查看</div>'; });
  } else if((type==="text"||type==="other") && isTab){
    // CSV / TSV 表格化（前端纯 JS 解析，零依赖）
    prev.innerHTML = '<div class="artload">正在解析…</div>';
    fetchText(url).then(function(txt){
      var sep = /\.tsv$/i.test(rel) ? "\t" : ",";
      var grid = parseCSV(txt, sep);
      if(!grid || !grid.length){ prev.innerHTML = '<div class="empty">空文件</div>'; return; }
      var heads = grid[0], rows = grid.slice(1);
      prev.innerHTML = renderTable(heads, rows, name, txt.length);
    }).catch(function(){ prev.innerHTML = '<div class="aperr">预览失败，请用「新标签打开」查看</div>'; });
  } else if(type==="text" || type==="other"){
    // 其它文本（json/txt/md/log）仍用 <pre>，保留 GBK 兜底解码
    fetchText(url).then(function(txt){ prev.innerHTML = '<pre>'+esc(txt)+'</pre>'; })
      .catch(function(){ prev.innerHTML = '<div class="aperr">预览失败，请用「新标签打开」查看</div>'; });
  } else {
    prev.innerHTML = '<div class="empty">该类型（'+esc(type)+'）无法内联预览，请用「新标签打开」</div>';
  }
}
// 文本按编码稳健读取（BOM 优先 → UTF-8 → GBK → GB18030 兜底）
export function fetchText(url){
  return fetch(url).then(function(r){
    var hdrCT = r.headers.get("Content-Type") || "";
    var ce = /charset=([^;]+)/i.exec(hdrCT);
    var enc = ce ? ce[1].trim().toLowerCase() : "utf-8";
    return r.arrayBuffer().then(function(buf){
      var u8 = new Uint8Array(buf);
      if(u8.length>=3 && u8[0]===0xEF && u8[1]===0xBB && u8[2]===0xBF){
        return new TextDecoder("utf-8").decode(buf);
      }
      function tryDec(label, realEnc){
        try { return new TextDecoder(realEnc, {fatal:true}).decode(buf); }
        catch(e){ return null; }
      }
      return tryDec(enc, enc) || tryDec("utf-8","utf-8")
        || tryDec("gbk","gbk") || tryDec("gb18030","gb18030")
        || new TextDecoder("utf-8").decode(buf);
    });
  });
}
// 稳健 CSV/TSV 解析：支持引号包裹、字段内逗号/换行、双引号转义
export function parseCSV(text, sep){
  var useQuote = (sep !== "\t");
  var rows = [], row = [], field = "", i = 0, n = text.length, inq = false;
  while(i < n){
    var c = text[i];
    if(inq){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i += 2; continue; }
        inq = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if(useQuote && c === '"'){ inq = true; i++; continue; }
    if(c === sep){ row.push(field); field = ""; i++; continue; }
    if(c === '\r'){ i++; continue; }
    if(c === '\n'){ row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if(field.length > 0 || row.length > 0){ row.push(field); rows.push(row); }
  while(rows.length && rows[rows.length-1].length === 1 && rows[rows.length-1][0] === "") rows.pop();
  return rows;
}
export function isNum(v){
  return /^-?[\d,]+(\.\d+)?$/.test((v||"").trim());
}
export function fmtBytes(b){
  if(b == null) return "";
  if(b < 1024) return b + " B";
  if(b < 1048576) return (b/1024).toFixed(1) + " KB";
  return (b/1048576).toFixed(2) + " MB";
}
// ---- 表格应用：Tabulator（本地 vendor，MIT 许可，零外部依赖）----
export function toTabulatorData(headers, rows){
  var data = [], i, j, o;
  for(i=0;i<rows.length;i++){
    o = {};
    for(j=0;j<headers.length;j++){
      var v = rows[i][j];
      o["c"+j] = (v===undefined||v===null) ? "" : String(v);
    }
    data.push(o);
  }
  return data;
}
export function toTabulatorColumns(headers){
  return headers.map(function(h, idx){
    var t = (h===undefined||h===null||h==="") ? ("列"+(idx+1)) : String(h);
    return {
      title: t, field: "c"+idx, minWidth: 110, resizable: true,
      headerFilter: "input",
      formatter: function(cell){ return esc(cell.getValue()); }
    };
  });
}
export function mountTabulator(hostId, headers, rows){
  var host = document.getElementById(hostId);
  if(!host || host.classList.contains("tabulator") || host.dataset.tabInit) return; // 已初始化/初始化中则跳过
  host.dataset.tabInit = "1";
  /* Tabulator 仅「产物预览」用到 → 动态 import 懒加载，不拖累首屏
     （原为顶层 import，把整个表格库拽进主包）。 */
  import("tabulator-tables").then(function(mod){
    var T = mod.Tabulator || mod.default;
    var h = document.getElementById(hostId);
    if(!h || !h.dataset.tabInit) return;   // 异步加载期间宿主已被移除/重渲染
    new T("#"+hostId, {
      data: toTabulatorData(headers, rows),
      columns: toTabulatorColumns(headers),
      layout: "fitColumns",
      height: "100%",
      virtualDom: false,
      pagination: true,
      paginationSize: 50,
      paginationSizeSelector: [25, 50, 100, 200],
      movableColumns: true,
      tooltipsHeader: true,
      tooltips: function(cell){ var v = cell.getValue(); return (v && String(v).length>40) ? String(v) : false; },
      rowFormatter: function(row){
        var el = row.getElement();
        el.classList.remove("zebra");
        if(row.getPosition() % 2 === 1) el.classList.add("zebra");
      },
      placeholder: "（空表）"
    });
  }).catch(function(e){
    var h = document.getElementById(hostId);
    if(h) delete h.dataset.tabInit;
    console.error("[tabulator] 加载失败：", e);
  });
}
export function renderTable(heads, rows, name, bytes){
  var id = "tabhost_single";
  var cap = '<div class="arttbl-cap"><span>'+esc(name||'')+'</span>'
    + '<span class="meta">共 '+rows.length+' 行 · '+heads.length+' 列'
    + (bytes ? ' · '+fmtBytes(bytes) : '') + '</span></div>';
  setTimeout(function(){ mountTabulator(id, heads, rows); }, 0);
  return cap + '<div class="arttab-body"><div class="tabpane" id="'+id+'"></div></div>';
}
// xlsx/xls：单 sheet 直接渲染，多 sheet 顶部 tab 切换（懒加载初始化）
export function renderSheets(d){
  var sheets = d.sheets || [];
  if(!sheets.length) return '<div class="empty">无可解析的工作表</div>';
  var file = esc(d.file||'');
  var trunc = d.truncated ? ' · 已截断(超过5000行)' : '';
  if(sheets.length === 1){
    var s = sheets[0];
    var cap = '<div class="arttbl-cap"><span>'+file+'</span>'
      + '<span class="meta">共 '+s.nrows+' 行 · '+s.ncols+' 列'+trunc+'</span></div>';
    var id = "tabhost_0";
    setTimeout(function(){ mountTabulator(id, s.headers, s.rows); }, 0);
    return cap + '<div class="arttab-body"><div class="tabpane" id="'+id+'"></div></div>';
  }
  window.__artSheets = sheets;
  var tabs = '<div class="arttbl-tabs">'
    + sheets.map(function(s, idx){
        return '<button class="stab'+(idx===0?' on':'')+'" data-pane="pane_'+idx+'">'+esc(s.name)
          + ' <i>'+s.nrows+'行</i></button>';
      }).join('')
    + '</div>';
  var body = '<div class="arttab-body" id="arttabBody">'
    + sheets.map(function(s, idx){
        return '<div class="tabpane" id="pane_'+idx+'"'+(idx===0?'':' style="display:none"')+'><div class="tabhost" id="host_'+idx+'"></div></div>';
      }).join('')
    + '</div>';
  var capwrap = '<div class="arttbl-cap"><span>'+file+'</span><span class="meta">共 '+sheets.length+' 个工作表'+trunc+'</span></div>';
  setTimeout(function(){ mountTabulator("host_0", sheets[0].headers, sheets[0].rows); }, 0);
  return capwrap + tabs + body;
}
export function closeArtModal(){
  document.getElementById("artMask").className = "artmask";
}
export function fallbackCopy(text){
  try{
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position="fixed"; ta.style.opacity="0";
    document.body.appendChild(ta); ta.select();
    var ok = document.execCommand("copy");
    document.body.removeChild(ta);
    toast(ok ? "已复制日志" : "复制失败");
  }catch(e){ toast("复制失败"); }
}

/* 回看历史日志：复用已有的 /api/log 接口，仅展示，不改后端 */
export function viewRunLog(h){
  api("/api/log?run_id=" + encodeURIComponent(h.run_id)).then(function(res){
    if(!res || !res.ok){ toast("该次运行的日志已不在本机"); return; }
    state.runs[h.run_id] = {
      run_id: h.run_id, task_id: h.task_id, name: h.name, status: h.status,
      lines: res.lines || [], cmd: "", startedAt: Date.now(),
      error_kind: h.error_kind || null, error_advice: h.error_advice || null
    };
    openRunModal(h.run_id);   // 用模态框展示运行记录日志（而非切到抽屉）
  }).catch(function(){ toast("读取日志失败"); });
}

/* 自动导出：供其他模块导入的内部顶层符号 */
export { state };
