// standard-settings.js —— 「标准达成」视图里的「系统设置」页（等级标准设置）与团队/等级标准配置。
// 从 standard.js 拆出（原 834-1475 行）：与骑手表 / 站点报表等主视图逻辑相互独立，单独成文件更好维护。
// 共享状态 _std 归 store.ui.std（单一归属），故 standard.js 与本模块之间无循环依赖
// —— standard.js 单向 import 本模块的 _stdRenderSettings()。
import { store } from "./store.js";
import { api } from "./api.js";
import { svg, esc, toast, debounce } from "./ui.js";
import { TK } from "./tokens.js";
const state = store.state;
const _std = store.ui.std;   /* 与 standard.js 共享同一份视图状态 */

/* 保存参与站点（POST teams-config） */
export function _stdSaveTeams(ids){
  return api("/api/standard/teams-config", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({teams: ids})
  });
}

/* ===== 参与站点 ↔ 等级标准 联动 =====
   设计：两侧各自只做原子写；联动在前端编排。任何一侧的「同步写」都走 _stdSaveTeams 直写，
   不触发对方的用户提交逻辑，避免 A→B→A 死循环。
   注：原「参与站点」独立 UI 已于 2026-09-10 移除；随之成为死代码的
   _stdRenderTeamsConfig / _stdRenderTeamsSummary / _stdOpenTeamPicker、
   以及只为它们服务的 _stdGradeCache / _stdOpenGradeEditorFor / _stdGradeHasConfigured
   已于 2026-09-16 删除（完整实现见 git 历史）。现有联动只剩单向：
   新增/删除站点标准 → 自动同步 teams-config。 */
/* 删除某站本月等级标准，并同步从「参与站点」移除该站（幂等、不触发对方提交逻辑） */
export function _stdDeleteGradeStandard(tid, mo){
  return api("/api/standard/grade-standards", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({team_id:tid, month:mo, action:"delete"})
  }).then(function(r){
    return _stdRemoveTeamFromConfig(tid).then(function(){ return r; });
  });
}

/* 确保某站在「参与站点」中（不在则追加）。仅原子写，不弹编辑器、不做联动 diff */
export function _stdEnsureTeamInConfig(tid){
  tid = String(tid);
  return api("/api/standard/teams-config").then(function(tc){
    var cur = (tc&&tc.teams||[]).map(String);
    if(cur.indexOf(tid)>=0) return {ok:true, unchanged:true};
    return _stdSaveTeams(cur.concat(tid));
  });
}

/* 确保某站不在「参与站点」中（在则移除）。仅原子写 */
export function _stdRemoveTeamFromConfig(tid){
  tid = String(tid);
  return api("/api/standard/teams-config").then(function(tc){
    var cur = (tc&&tc.teams||[]).map(String);
    if(cur.indexOf(tid)<0) return {ok:true, unchanged:true};
    return _stdSaveTeams(cur.filter(function(s){ return s!==tid; }));
  });
}


export function _stdSettingsCurrentMonth(){
  var d=new Date(); return d.getFullYear()+"-"+("0"+(d.getMonth()+1)).slice(-2);
}
export function _stdRenderSettings(host, opts){
  // 「系统设置」tab：等级标准设置（按 站点×月份 配置 5 档单量 + 时长阈值）。
  // 参与站点（全量刷新 / 数据生成范围）已并入等级标准——新增/删除站点标准即自动同步 teams-config，不再单独维护 UI。
  // 历史月份（≠ 当前月）仅支持查看：禁用「管理 / 新增」并提示；页面顶部为月份 + 站点搜索筛选栏。
  opts = opts || {};
  host.innerHTML="";

  // ===== 全局月份控制器：系统设置页最顶部，统一控制整页所有月份相关数据（含门槛值/封顶值）=====
  var gTop=document.createElement("div"); gTop.className="st-gs-global-topbar";
  gTop.innerHTML='<div class="ctrl"><label for="gsMonth">月份</label><input type="month" id="gsMonth"></div>';
  host.appendChild(gTop);
  var monthEl=gTop.querySelector("#gsMonth");
  monthEl.value=_stdSettingsCurrentMonth();

  var h3=document.createElement("h3"); h3.textContent="标准目标设置"; host.appendChild(h3);

  // 页面顶部统一栏：站点搜索 + 管理（新增能力已并入管理：选未配置站点即视为新增）
  var top=document.createElement("div"); top.className="st-gs-topbar";
  top.innerHTML=
    '<div class="left">'+
      '<input id="gsSearch" class="st-gs-search" type="text" placeholder="搜索站点名称 / ID…">'+
    '</div>'+
    '<div class="right">'+
      '<button id="gsManage" class="st-btn-secondary">管理</button>'+
    '</div>';
  host.appendChild(top);
  var searchEl=top.querySelector("#gsSearch");

  // 历史月份提示条（仅查看，不可改/删）
  var histBanner=document.createElement("div"); histBanner.className="std-banner warn"; histBanner.style.display="none";
  host.appendChild(histBanner);

  // 历史月份守卫：非当前月禁用「管理」并提示「仅查看」
  function syncHist(){
    var hist = monthEl.value !== _stdSettingsCurrentMonth();
    var m=top.querySelector("#gsManage");
    if(hist){
      m.disabled=true;
      histBanner.style.display="block";
      histBanner.textContent="ⓘ 历史月份（"+monthEl.value+"）仅支持查看，不可修改或删除";
    } else {
      m.disabled=false;
      histBanner.style.display="none";
    }
  }

  var status=document.createElement("div"); status.id="gsStatus"; status.className="std-banner"; status.style.display="none";
  host.appendChild(status);

  var tblHost=document.createElement("div"); host.appendChild(tblHost);

  // ===== 门槛值 / 封顶值（全局百分比；录入/校验/保存与「标准目标设置」一致）=====
  // 站点维度报表按「门槛人数=规模目标×门槛值(向上取整)」「封顶人数=规模目标×封顶值(向下取整)」逐站计算；
  // 留空 = 未设置，对应单元格显示「未设置」（悬停 title 显示完整「未设置门槛值 / 未设置封顶值」）。
  var tcSec=document.createElement("div"); tcSec.className="st-gs-thresh";
  tcSec.innerHTML=
    '<h3>门槛值 / 封顶值</h3>'+
    '<div class="st-gs-thresh-desc">全局生效：站点维度报表将按「门槛人数=规模目标×门槛值(向上取整)」「封顶人数=规模目标×封顶值(向下取整)」逐站计算。留空表示未设置；封顶值允许超过 100%（如 110% 表示规模目标×1.1）。</div>'+
    '<div class="st-gs-thresh-row">'+
      '<label class="st-ge-field"><span class="lab">门槛值(%)</span><input type="number" id="thThresh" min="0" max="100" step="0.1" placeholder="未设置"></label>'+
      '<label class="st-ge-field"><span class="lab">封顶值(%)</span><input type="number" id="thCap" min="0" step="0.1" placeholder="未设置"></label>'+
      '<button id="thSave" class="st-btn-primary">保存</button>'+
    '</div>'+
    '<div class="st-ge-msg" id="thMsg" style="display:none"></div>';
  host.appendChild(tcSec);
  var thThreshEl=tcSec.querySelector("#thThresh");
  var thCapEl=tcSec.querySelector("#thCap");
  var thSaveBtn=tcSec.querySelector("#thSave");
  var thMsgEl=tcSec.querySelector("#thMsg");
  function _thLoad(){
    var mo=monthEl.value || _stdSettingsCurrentMonth();
    api("/api/standard/thresholds?month="+encodeURIComponent(mo)).then(function(j){
      if(j&&j.ok!==false){
        thThreshEl.value=(j.threshold_pct!=null)?j.threshold_pct:"";
        thCapEl.value=(j.cap_pct!=null)?j.cap_pct:"";
      }
    }).catch(function(){});
  }
  _thLoad();
  function _thChkThreshold(v){
    if(v==="") return {v:null};
    var n=parseFloat(v);
    if(isNaN(n)||n<0||n>100) return {err:"请输入 0~100 之间的数值，或留空表示未设置"};
    return {v:n};
  }
  function _thChkCap(v){
    if(v==="") return {v:null};
    var n=parseFloat(v);
    if(isNaN(n)||n<0) return {err:"请输入 >=0 的数值，或留空表示未设置"};
    return {v:n};
  }
  thSaveBtn.addEventListener("click", function(){
    var rt=_thChkThreshold(thThreshEl.value.trim()), rc=_thChkCap(thCapEl.value.trim());
    if(rt.err){ thMsgEl.style.display="block"; thMsgEl.className="st-ge-msg err"; thMsgEl.textContent="✗ 门槛值："+rt.err; return; }
    if(rc.err){ thMsgEl.style.display="block"; thMsgEl.className="st-ge-msg err"; thMsgEl.textContent="✗ 封顶值："+rc.err; return; }
    thSaveBtn.disabled=true; thMsgEl.style.display="block"; thMsgEl.className="st-ge-msg"; thMsgEl.textContent="保存中…";
    api("/api/standard/thresholds", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({threshold_pct: rt.v, cap_pct: rc.v, month: monthEl.value || _stdSettingsCurrentMonth()})
    }).then(function(r){
      thSaveBtn.disabled=false;
      if(r&&r.ok){ thMsgEl.className="st-ge-msg ok"; thMsgEl.textContent="✓ 已保存"; _std.rptRows=null; }   // 失效报表缓存，下次进站点维度重算
      else { thMsgEl.className="st-ge-msg err"; thMsgEl.textContent="✗ 保存失败："+((r&&r.error)||"未知错误"); }
    }).catch(function(e){
      thSaveBtn.disabled=false; thMsgEl.className="st-ge-msg err"; thMsgEl.textContent="✗ 保存失败："+esc(String(e));
    });
  });

  var lastData=null;        // 缓存最近一次拉取结果，供编辑器预填
  var nameMap=Object.assign({}, _std.names||{});  // 站点名映射（先取全局，再补全量目录）

  function load(){
    syncHist();   // 历史月份：禁用管理/新增 + 提示条
    var mo=monthEl.value || _stdSettingsCurrentMonth();
    status.style.display="none";
    tblHost.innerHTML='<div class="std-table-loader"><span class="dots"><i></i><i></i><i></i></span><div class="txt">加载标准目标…</div></div>';
    // 先补全站点名，再拉数据（保证表格显示真实站点名；按月独立存储）
    api("/api/standard/teams-config").then(function(tc){
      (tc&&tc.all||[]).forEach(function(p){ if(p.id!=null) nameMap[String(p.id)] = p.name || nameMap[String(p.id)]; });
    }).catch(function(){}).then(function(){
      api("/api/standard/grade-standards?month="+encodeURIComponent(mo))
        .then(function(j){
          if(!j||!j.ok){ tblHost.innerHTML='<div class="st-gs-empty">加载失败：'+esc(j&&j.error||"未知错误")+'</div>'; return; }
          lastData=j;
          renderTable(j);
        })
        .catch(function(e){
          tblHost.innerHTML='<div class="st-gs-empty">加载失败：'+esc(String(e))+'</div>';
        });
    });
  }

  function renderTable(j){
    tblHost.innerHTML="";
    var teams=Object.keys(j.teams||{});
    if(!teams.length){
      tblHost.innerHTML='<div class="st-gs-empty">无站点数据</div>'; return;
    }
    var wrap=document.createElement("div"); wrap.className="st-gs-scroll";
    var table=document.createElement("table"); table.className="st-gs-table";
    // 表头：第一行分组（单量/时长各跨 5 列），第二行明细（标准1~5）
    var thead=document.createElement("thead");
    thead.innerHTML=
      '<tr>'+
        '<th class="corner" rowspan="2">站点</th>'+
        '<th class="grp" colspan="5">单量阈值（单 · 全天有效）</th>'+
        '<th class="grp" colspan="5">时长阈值（小时 · 全天有效在线）</th>'+
      '</tr>'+
      '<tr>'+
        '<th>标准1</th><th>标准2</th><th>标准3</th><th>标准4</th><th>标准5</th>'+
        '<th>标准1</th><th>标准2</th><th>标准3</th><th>标准4</th><th>标准5</th>'+
      '</tr>';
    table.appendChild(thead);
    var tbody=document.createElement("tbody");
    teams.forEach(function(tid){
      var rec=j.teams[tid];
      var name=nameMap[tid] || (_std.names&&_std.names[tid]) || ("team "+tid);
      var tr=document.createElement("tr"); tr.setAttribute("data-tid",tid); tr.setAttribute("data-name",name);
      tr.innerHTML=
        '<td class="name">'+esc(name)+'<span class="tid">'+esc(tid)+'</span></td>'+
        rec.order.slice(0,5).map(function(v){return '<td>'+esc(String(v))+'</td>';}).join("")+
        rec.duration_h.slice(0,5).map(function(v){return '<td>'+esc(String(v))+'</td>';}).join("");
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    tblHost.appendChild(wrap);

    // 搜索过滤（按名称 / ID 实时过滤行）
    searchEl.oninput=function(){
      var q=(searchEl.value||"").trim().toLowerCase();
      tbody.querySelectorAll("tr").forEach(function(r){
        var t=((r.getAttribute("data-name")||"")+" "+(r.getAttribute("data-tid")||"")).toLowerCase();
        var hit=!q||t.indexOf(q)>=0;
        r.style.display=hit?"":"none";
      });
    };
  }

  // ===== 单站编辑器弹窗（管理即涵盖新增：选已配置站点=编辑/删除，选未配置站点=新增）=====
  function openEditor(scope, presetId, onClose, forced){
    forced = !!forced;
    var mo=monthEl.value || _stdSettingsCurrentMonth();
    var mask=document.createElement("div"); mask.className="st-modal-mask";
    var modal=document.createElement("div"); modal.className="st-modal";
    var titleTxt = scope==="add" ? (forced ? "新增站点标准目标（必填）" : "新增站点标准目标") : "管理标准目标";
    // 强制模式（参与站点新增后自动弹出）：移除 × / 取消按钮，禁止跳过或关闭
    var xBtnHtml = forced ? '' : '<button class="st-modal-x" title="关闭">&times;</button>';
    var cancelBtnHtml = forced ? '' : '<button class="st-btn-ghost" data-act="cancel">取消</button>';
    modal.innerHTML=
      '<div class="st-modal-head"><div><div class="t">'+titleTxt+'</div>'+
      '<div class="sub">按月份独立存储，本月 '+esc(mo)+'</div></div>'+
      xBtnHtml+'</div>'+
      '<div class="st-modal-body">'+
        '<div class="st-ge-field"><label>站点</label>'+
          '<div class="st-ge-combo"><input class="st-ge-combo-input" type="text" placeholder="搜索并选择站点（名称 / ID）" autocomplete="off">'+
          '<div class="st-ge-combo-list"></div></div></div>'+
        '<div class="st-ge-month">生效月份：<b>'+esc(mo)+'</b>（与表格当前月份一致，不可跨月）</div>'+
        '<div class="st-ge-sep">单量阈值（单 · 全天有效）</div>'+
        '<div class="st-ge-grid" data-kind="order"></div>'+
        '<div class="st-ge-sep">时长阈值（小时 · 全天有效在线）</div>'+
        '<div class="st-ge-grid" data-kind="dur"></div>'+
        '<div class="st-ge-msg"></div>'+
      '</div>'+
      '<div class="st-modal-foot"><span class="hint"></span>'+
        '<div class="btns">'+
          (scope==="manage" ? '<button class="st-btn-danger" data-act="delete" disabled>删除</button>' : '')+
          cancelBtnHtml+
          '<button class="st-btn-primary" data-act="save">保存</button>'+
        '</div></div>';
    mask.appendChild(modal);
    document.body.appendChild(mask);

    var xBtn=modal.querySelector(".st-modal-x");
    var cancelBtn=modal.querySelector('[data-act="cancel"]');
    var saveBtn=modal.querySelector('[data-act="save"]');
    var delBtn=modal.querySelector('[data-act="delete"]');
    var comboInput=modal.querySelector(".st-ge-combo-input");
    var comboList=modal.querySelector(".st-ge-combo-list");
    var msg=modal.querySelector(".st-ge-msg");
    var orderGrid=modal.querySelector('[data-kind="order"]');
    var durGrid=modal.querySelector('[data-kind="dur"]');
    var footHint=modal.querySelector(".st-modal-foot .hint");

    // 构造 5 单量 + 5 时长 输入框
    var orderInputs=[], durInputs=[];
    for(var i=0;i<5;i++){
      var lab=document.createElement("label"); lab.className="col"; lab.innerHTML='<span>标准'+(i+1)+'</span>';
      var inp=document.createElement("input"); inp.type="number"; inp.min="0"; inp.step="1"; inp.value="0";
      lab.appendChild(inp); orderGrid.appendChild(lab); orderInputs.push(inp);
    }
    for(var k=0;k<5;k++){
      var lab2=document.createElement("label"); lab2.className="col"; lab2.innerHTML='<span>标准'+(k+1)+'</span>';
      var inp2=document.createElement("input"); inp2.type="number"; inp2.min="0"; inp2.max="24"; inp2.step="0.5"; inp2.value="0";
      lab2.appendChild(inp2); durGrid.appendChild(lab2); durInputs.push(inp2);
    }

    // 候选站点：管理即涵盖新增——列出全量站点目录，cfg=true 本月已配置（可编辑/删除），
    // cfg=false 未配置（选中即视为新增，保存即创建）。已移除独立「新增」入口。
    var candidates=[];
    var cfgSet={};
    if(lastData&&lastData.configured_ids){ lastData.configured_ids.forEach(function(t){ cfgSet[String(t)]=1; }); }
    api("/api/standard/teams-config").then(function(tc){
      var all=(tc&&tc.all)||[];
      all.forEach(function(p){
        var id=String(p.id);
        candidates.push({id:id, name:p.name||id, cfg:!!cfgSet[id]});
      });
      if(!candidates.length){ footHint.textContent="全量站点目录为空，可直接输入站点 ID"; }
      else { footHint.textContent="选择已配置站点可编辑/删除；选择未配置站点即视为新增"; }
      renderCombo(); applyPreset();
    }).catch(function(e){ footHint.textContent="站点目录加载失败："+esc(String(e)); renderCombo(); applyPreset(); });

    function renderCombo(){
      comboList.innerHTML="";
      candidates.forEach(function(c){
        var it=document.createElement("div"); it.className="st-ge-combo-item";
        it.innerHTML=esc(c.name)+'<span class="tid">'+esc(c.id)+'</span>'+(c.cfg?'':'<span class="tag-new">未配置</span>');
        it.addEventListener("mousedown", function(e){ e.preventDefault(); selectSite(c.id); });
        comboList.appendChild(it);
      });
    }

    // 联动入口：参与站点新增后，自动预选该站并弹编辑器（presetId 由外部传入）
    function applyPreset(){
      if(forced){
        footHint.textContent="⚠ 必填步骤：请填写标准目标并保存后方可继续，不可取消或关闭";
        footHint.style.color="var(--warn, #B9770E)";
        footHint.style.fontWeight="600";
      }
      if(!presetId) return;
      var pid=String(presetId);
      for(var n=0;n<candidates.length;n++){
        if(candidates[n].id===pid){ selectSite(pid); break; }
      }
    }

    function selectSite(id){
      var f=null; for(var n=0;n<candidates.length;n++){ if(candidates[n].id===id){ f=candidates[n]; break; } }
      comboInput.value = f? (f.name+" ("+f.id+")") : id;
      comboList.classList.remove("open");
      var rec = (lastData&&lastData.teams) ? lastData.teams[id] : null;
      var ord = rec? rec.order : [0,0,0,0,0];
      var dur = rec? rec.duration_h : [0,0,0,0,0];
      for(var i=0;i<5;i++) orderInputs[i].value = (ord[i]!=null? ord[i] : 0);
      for(var k=0;k<5;k++) durInputs[k].value = (dur[k]!=null? dur[k] : 0);
      msg.textContent=""; msg.className="st-ge-msg";
      var isCfg = !!(lastData && lastData.configured_ids && lastData.configured_ids.indexOf(String(id))>=0);
      if(isCfg){
        if(delBtn) delBtn.disabled=false;            // 已配置：可编辑 + 可删除
        footHint.textContent="已配置站点：可修改阈值或删除";
        footHint.style.color=""; footHint.style.fontWeight="";
      } else {
        if(delBtn) delBtn.disabled=true;             // 未配置：选中即新增，不可删除
        footHint.textContent="未配置站点：保存即视为新增，创建该站 "+mo+" 标准目标";
        footHint.style.color="var(--brand,#FF5000)"; footHint.style.fontWeight="600";
      }
    }

    comboInput.addEventListener("mousedown", function(){ if(candidates.length) comboList.classList.add("open"); });
    comboInput.addEventListener("focus", function(){ if(candidates.length) comboList.classList.add("open"); });
    comboInput.addEventListener("input", function(){
      var q=comboInput.value.trim().toLowerCase();
      comboList.classList.add("open");
      Array.prototype.forEach.call(comboList.children, function(it){
        var t=it.textContent.toLowerCase();
        it.style.display = (!q || t.indexOf(q)>=0) ? "" : "none";
      });
    });
    comboInput.addEventListener("blur", function(){ setTimeout(function(){ comboList.classList.remove("open"); }, 150); });

    function resolveSiteId(){
      var raw=comboInput.value.trim();
      if(!raw) return "";
      for(var n=0;n<candidates.length;n++){
        var c=candidates[n];
        if((c.name+" ("+c.id+")")===raw || c.name===raw || c.id===raw) return c.id;
      }
      var m=raw.match(/\(([^)]+)\)\s*$/);
      if(m) return m[1].trim();
      return raw;  // 直接作为站点 ID（新增场景支持手输）
    }

    function doSave(){
      var tid=resolveSiteId();
      if(!tid){ msg.className="st-ge-msg err"; msg.textContent="请先选择或输入站点"; return; }
      var order=orderInputs.map(function(i){ return Math.max(0, parseInt(i.value||"0",10)||0); });
      var dur=durInputs.map(function(i){ var v=parseFloat(i.value||"0"); if(isNaN(v)||v<0) v=0; if(v>24) v=24; return v; });
      if(forced){
        var _zs = order.reduce(function(a,b){return a+b;},0) + dur.reduce(function(a,b){return a+b;},0);
        if(_zs===0){ msg.className="st-ge-msg err"; msg.textContent="请至少填写一项标准目标（单量或时长阈值），不可留空提交"; return; }
      }
      saveBtn.disabled=true; msg.className="st-ge-msg"; msg.textContent="保存中…";
      api("/api/standard/grade-standards", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({team_id:tid, month:mo, order:order, duration_h:dur})
      }).then(function(r){
        saveBtn.disabled=false;
        if(r&&r.ok){ msg.className="st-ge-msg ok"; msg.textContent="✓ 已保存（"+tid+" · "+mo+"）"; _stdEnsureTeamInConfig(tid); load(); closeModal(); }
        else { msg.className="st-ge-msg err"; msg.textContent="✗ 保存失败："+((r&&r.error)||"未知错误"); }
      }).catch(function(e){
        saveBtn.disabled=false; msg.className="st-ge-msg err"; msg.textContent="✗ 保存失败："+esc(String(e));
      });
    }

    // 管理：删除某站本月等级标准（同时同步移出「参与站点」）
    function doDelete(){
      var tid=resolveSiteId();
      if(!tid){ msg.className="st-ge-msg err"; msg.textContent="请先选择站点"; return; }
      if(!window.confirm("确定删除站点 "+tid+" 在 "+mo+" 的标准目标？\n（将同步移出参与站点范围 teams-config）")) return;
      delBtn.disabled=true; msg.className="st-ge-msg"; msg.textContent="删除中…";
      _stdDeleteGradeStandard(tid, mo).then(function(r){
        delBtn.disabled=false;
        if(r&&r.ok){ msg.className="st-ge-msg ok"; msg.textContent="✓ 已删除（"+tid+" · "+mo+"）"; load(); closeModal(); }
        else { msg.className="st-ge-msg err"; msg.textContent="✗ 删除失败："+((r&&r.error)||"未知错误"); }
      }).catch(function(e){
        delBtn.disabled=false; msg.className="st-ge-msg err"; msg.textContent="✗ 删除失败："+esc(String(e));
      });
    }

    function closeModal(){ document.removeEventListener("keydown", onKey); if(mask.parentNode) mask.parentNode.removeChild(mask); if(typeof onClose==="function") onClose(); }
    function onKey(e){ if(!forced && e.key==="Escape") closeModal(); }
    if(xBtn) xBtn.addEventListener("click", closeModal);
    if(cancelBtn) cancelBtn.addEventListener("click", closeModal);
    mask.addEventListener("click", function(e){ if(!forced && e.target===mask) closeModal(); });
    saveBtn.addEventListener("click", doSave);
    if(delBtn) delBtn.addEventListener("click", doDelete);
    document.addEventListener("keydown", onKey);
  }


  top.querySelector("#gsManage").addEventListener("click", function(){ if(monthEl.value!==_stdSettingsCurrentMonth()) return; openEditor("manage"); });

  monthEl.addEventListener("change", function(){ syncHist(); load(); _thLoad(); });
  load();
}
