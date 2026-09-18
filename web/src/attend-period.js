import { store, groupOf, taskById, countInGroup, producerOf, missingText, visibleTasks, taskState, argValue } from "./store.js";
import { api, savePrefs, loadPrefs, readTokens, withToken, ensureTeams } from "./api.js";
import { svg, esc, hexA, toast, debounce, viewHead } from "./ui.js";
import { TK, TK_MAP, RISK_LABEL, RISK_CLS, STATUS_CLS, STATUS_TXT, ICON } from "./tokens.js";
import { bus } from "./bus.js";
import { setArg, openSide, closeSide, askConfirm, closeConfirm, bindConfirmUI, lockScroll, unlockScroll } from "./behavior.js";
import "./attend-period.css";   /* 时段出勤样式（原 _apEnsureStyle 运行时注入 <style>，改为静态引入） */
import { _apRenderSettings } from "./attend-period-settings.js";   /* 系统设置面板（已外提为独立模块） */
import { FALLBACK_TEAM_ID, FALLBACK_TEAMS } from "./teams.js";   /* 站点兜底清单（与后端 teams_config.TEAM_NAMES 同步） */
const state = store.state;

/* 时段出勤（一级菜单「数据看板」→ 子页「时段出勤」）。
   顶部并列 Tab（时段有效 / 时段准确 / 时段有单 / 系统设置）切换，
   「时段有效」已实现实时数据，「系统设置」为配置接入占位，其余为数据空态占位。 */
var _ap = { mode:"valid", sortKey:"rate", sortDir:"desc" };   // valid / accurate / order / settings；sortKey/sortDir = 骑手明细表头排序状态
/* 骑手明细：客户端过滤状态（跨重渲染保持，不重发请求） */
var _apRiderData = null;
var _apRiderFilter = { q:"", onlyFail:false };

// 统一数据源缓存（站点数据 + 骑手明细 共用）：单一「查询」写入，两视图均从此渲染 → 同快照、一致。
var _apDataset = null;
var LS_DS_KEY = "attendPeriod_dataset_v1";
export function _apSaveDatasetCache(){
  if(!_apDataset) return;
  try{
    localStorage.setItem(LS_DS_KEY, JSON.stringify({
      dataset: _apDataset, viewTeam: _ap.team, savedAt: Date.now()
    }));
  }catch(e){ /* 隐私模式 / 配额超限时静默忽略 */ }
}
export function _apLoadDatasetCache(){
  if(_apDataset) return true;
  try{
    var raw = localStorage.getItem(LS_DS_KEY);
    if(!raw) return false;
    var c = JSON.parse(raw);
    if(!c || !c.dataset) return false;
    _apDataset = c.dataset;
    if(c.viewTeam) _ap.team = c.viewTeam;
    _apRiderData = (_apDataset.rider_detail) || null;   // 骑手明细视图从同一份数据集派生
    return true;
  }catch(e){ return false; }
}

export function _apEmptyState(title, sub, icon){
  return '<div class="ap-empty">'+
    '<div class="ap-empty-ic">'+svg(icon||"calendar-clock")+'</div>'+
    '<div class="ap-empty-title">'+esc(title)+'</div>'+
    '<div class="ap-empty-sub">'+esc(sub)+'</div>'+
    '<div class="ap-empty-zone">表格渲染区 · 后续真实数据将在此展示（按站点 / 时段逐行）</div>'+
  '</div>';
}

export function renderAttendPeriodView(host){
  host.appendChild(viewHead("时段出勤",
    "站点维度按系统设置时段（含全天）展开：「站点数据」合并展示时段有效 / 排班准确 / 排班出勤 / 时段满足四项，另含「骑手明细」与「系统设置」。",
    "calendar-clock", TK.cyan));

  var wrap = document.createElement("div"); wrap.className = "ap-wrap";

  // 顶部并列 Tab 栏
  var apTabs = document.createElement("div"); apTabs.className = "ap-tabs";
  apTabs.innerHTML =
    '<button class="ap-tab" data-m="station">站点数据</button>'+
    '<button class="ap-tab" data-m="rider">骑手明细</button>'+
    '<button class="ap-tab" data-m="settings">系统设置</button>';
  wrap.appendChild(apTabs);

  // 内容区（默认仅首个可见，其余隐藏）
  var stationHost   = document.createElement("div"); stationHost.className   = "ap-pane"; wrap.appendChild(stationHost);
  var riderHost     = document.createElement("div"); riderHost.className     = "ap-pane"; riderHost.style.display     = "none"; wrap.appendChild(riderHost);
  var settingsHost  = document.createElement("div"); settingsHost.className  = "ap-pane"; settingsHost.style.display  = "none"; wrap.appendChild(settingsHost);

  host.appendChild(wrap);

  function _apToday(){
    var d = new Date(); var p = function(n){ return (n<10?"0":"")+n; };
    return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());
  }
  function _apNum(v){ return (v==null)?"—":v; }
  function _apRateBadge(rate){
    if(rate===null||rate===undefined) return '<span class="ap-badge none">—</span>';
    var cls = rate>=100?"ok":(rate>=80?"warn":"bad");
    return '<span class="ap-badge '+cls+'">'+rate.toFixed(1)+'%</span>';
  }

  // ---- 站点下拉填充（复用标准达成已拉取的 _std.teams，失败回退三站 + /api/teams）----
  function _apFillTeams(sel, forceAll){
    // 以「站点管理」已选站点列表为下拉候选范围（与标准达成 _std.teams 全量目录解耦）
    api("/api/attend-period/teams").then(function(j){
      var ids = (j && j.teams) || [];
      var nameMap = {};
      (j && j.all || []).forEach(function(t){ nameMap[String(t.id)] = t.name; });
      if(!ids.length) ids = [FALLBACK_TEAM_ID];   // 兜底：绝不空白
      sel.innerHTML = "";
      var allOpt = document.createElement("option");
      allOpt.value = "__all__"; allOpt.textContent = "全部站点"; sel.appendChild(allOpt);
      ids.forEach(function(id){
        id = String(id);
        var o = document.createElement("option"); o.value = id; o.textContent = nameMap[id] || id; sel.appendChild(o);
      });
      // 默认选中：forceAll（站点数据 tab）= 始终「全部站点」，确保每次加载/刷新即显示全部；
      //          其余 tab = 沿用上次选择（含「全部站点」），否则落到首个已选站点
      if(forceAll){ _ap.team = "__all__"; }
      else {
        var inSet = (String(_ap.team) === "__all__") || ids.indexOf(String(_ap.team)) >= 0;
        if(!inSet && ids.length){ _ap.team = ids[0]; }
      }
      if(_ap.team && sel.querySelector('option[value="'+_ap.team+'"]')) sel.value = _ap.team;
    }).catch(function(){
      // 兜底渲染：forceAll 时优先保证「全部站点」选项存在，避免异常态下仍落到具体站点
      sel.innerHTML = (forceAll ? '<option value="__all__">全部站点</option>' : '') +
        '<option value="' + FALLBACK_TEAM_ID + '">' + (FALLBACK_TEAMS.find(function(t){ return String(t.id) === FALLBACK_TEAM_ID; }) || {}).name + '</option>';
      if(_ap.team) sel.value = _ap.team;
    });
  }

  // ---- 时段有效：渲染表格 ----
  function _apRenderValidTable(j){
    var isAll = (j && j.team === "__all__");
    var body = document.getElementById("apValidBody");
    if(!body) return;
    if(!j || !j.ok){ body.innerHTML = '<div class="ap-err">加载失败：'+(j&&j.error?esc(j.error):"未知错误")+'</div>'; return; }
    if(j.need_refresh){ body.innerHTML = _apEmptyState("时段有效","请点「查询」拉取实时数据。", "clock"); return; }
    var rows = j.rows||[];
    if(!rows.length){ body.innerHTML = _apEmptyState("时段有效", isAll?"所选站点当日无排班时段数据。":"该日期无排班时段数据。", "clock"); return; }
    var s = j.summary||{};
    var html = '<div class="ap-cards">'+
      '<div class="ap-card"><div class="k">有效出勤率(整体)</div><div class="v cyan">'+(s.rate!=null?s.rate.toFixed(1)+'%':"—")+'</div></div>'+
      '<div class="ap-card"><div class="k">实时在线(合计)</div><div class="v">'+_apNum(s.online)+'</div></div>'+
      '<div class="ap-card"><div class="k">排班目标(合计)</div><div class="v">'+_apNum(s.target)+'</div></div>'+
      '<div class="ap-card"><div class="k">缺勤(合计)</div><div class="v">'+_apNum(s.absent)+'</div></div>'+
    '</div>';
    // 全量站点：分站概览（仅 valid_all 返回 per_site）
    if(j.per_site && j.per_site.length){
      html += '<div style="margin:12px 0 6px;font-weight:600;color:#0f172a;font-size:14px">分站概览 · 共 '+j.per_site.length+' 站</div>';
      html += '<div style="overflow-x:auto"><table class="ap-table ap-subtable"><thead><tr>'+
        '<th>站点</th><th class="num">时段数</th><th class="num">排班目标</th><th class="num">实时在线</th>'+
        '<th class="num">缺勤</th><th class="center">有效出勤率</th></tr></thead><tbody>';
      j.per_site.forEach(function(site){
        var ss = site.summary||{};
        html += '<tr><td>'+esc(site.teamName||site.team)+'</td>'+
          '<td class="num">'+(ss.period_count!=null?ss.period_count:"—")+'</td>'+
          '<td class="num">'+_apNum(ss.target)+'</td>'+
          '<td class="num">'+_apNum(ss.online)+'</td>'+
          '<td class="num">'+_apNum(ss.absent)+'</td>'+
          '<td class="center">'+_apRateBadge(ss.rate)+'</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '<div style="overflow-x:auto"><table class="ap-table"><thead><tr>'+
      '<th>时段</th><th>时段区间</th>'+
      '<th class="num">排班目标</th><th class="num">实际排班</th>'+
      '<th class="num">实时在线</th><th class="num">缺勤</th>'+
      '<th class="center">有效出勤率</th><th class="num">有效在线时长</th>'+
      '</tr></thead><tbody>';
    rows.forEach(function(r){
      var slot = '<div class="ap-slot">'+esc(r.time_name||String(r.time_code))+'</div>';
      var range = '<div class="ap-range">'+(r.start_time||"")+' - '+(r.end_time||"")+'</div>';
      var on = (r.online==null)?"—":r.online;
      var absent = (r.absent==null)?"—":r.absent;
      var dur = r.error ? '<span class="ap-badge bad" title="'+esc(r.error)+'">拉取失败</span>' : (r.valid_dur||"0");
      html += '<tr>'+
        '<td>'+slot+'</td><td>'+range+'</td>'+
        '<td class="num">'+_apNum(r.target)+'</td>'+
        '<td class="num">'+_apNum(r.scheduled)+'</td>'+
        '<td class="num">'+on+'</td>'+
        '<td class="num">'+absent+'</td>'+
        '<td class="center">'+_apRateBadge(r.rate)+'</td>'+
        '<td class="num">'+dur+'</td>'+
      '</tr>';
    });
    html += '</tbody></table></div>';
    if(j.data_note){ html += '<div style="margin:8px 0;padding:6px 10px;border-left:3px solid #f59e0b;background:#fffbeb;color:#92400e;font-size:13px;border-radius:4px">'+esc(j.data_note)+'</div>'; }
    html += '<div class="ap-note">数据为实时考勤快照（'+(j.fetched_at||"")+'），非历史累计；在线骑手按 workStatus ∉ {小休,下线} 计。</div>';
    body.innerHTML = html;
    var meta = document.getElementById("apMeta");
    if(meta) meta.textContent = (j.teamName||j.team)+" · "+j.date+" · 已加载";
  }

  function _apLoadValid(){
    var sel = document.getElementById("apTeam");
    var dateEl = document.getElementById("apDate");
    var btn = document.getElementById("apQuery");
    var meta = document.getElementById("apMeta");
    if(sel) _ap.team = sel.value;
    if(dateEl) _ap.date = dateEl.value || _apToday();
    if(btn) btn.disabled = true;
    if(meta) meta.textContent = "加载中…";
    var q = "team="+encodeURIComponent(_ap.team)+"&start="+encodeURIComponent(_ap.date)+"&refresh=1";
    api("/api/attend-period/valid?"+q).then(function(j){ _apRenderValidTable(j); })
      .catch(function(e){ var b=document.getElementById("apValidBody"); if(b) b.innerHTML='<div class="ap-err">请求失败：'+esc(String(e))+'</div>'; if(meta) meta.textContent=""; })
      .then(function(){ if(btn) btn.disabled=false; });
  }

  function _apRenderValid(pane){
    pane.innerHTML = "";
    var bar = document.createElement("div"); bar.className = "ap-bar";
    bar.innerHTML =
      '<label>站点<select id="apTeam"></select></label>'+
      '<label>日期<input type="date" id="apDate"></label>'+
      '<button id="apQuery" class="ap-btn">查询</button>'+
      '<span class="ap-meta" id="apMeta"></span>';
    pane.appendChild(bar);
    var body = document.createElement("div"); body.id = "apValidBody"; pane.appendChild(body);
    var sel = document.getElementById("apTeam");
    var dateEl = document.getElementById("apDate");
    var btn = document.getElementById("apQuery");
    if(dateEl) dateEl.value = _ap.date || _apToday();
    _apFillTeams(sel);
    if(sel && _ap.team) sel.value = _ap.team;
    if(btn) btn.addEventListener("click", _apLoadValid);
    body.innerHTML = _apEmptyState("时段有效",
      "按时段展示各站点有效出勤：有效出勤人数、有效在线时长、有效出勤率（实时快照）。点「查询」拉取实时数据。", "clock");
  }

  // ---- 站点数据：合并原 时段有效/时段准确/时段有单 三 tab，竖向 4 张卡片 ----
  function _apLoadStation(){
    // 站点数据 与 骑手明细 共用统一数据源：点「查询」即触发 _apFetchDataset（__all__ 一次拉取），
    // 写入同一缓存；本 tab 仅设置过滤站点并从缓存渲染，不单独打接口。
    var sel = document.getElementById("apStationTeam");
    if(sel) _ap.team = sel.value;
    _apFetchDataset(true);
  }

  function _apRenderStation(pane){
    pane.innerHTML = "";
    // 刷新页面 / Tab 重载时：优先用统一数据源缓存展示已获取的考勤数据，绝不自动发起请求（与骑手明细一致）
    if(!_apDataset) _apLoadDatasetCache();
    var bar = document.createElement("div"); bar.className = "ap-bar";
    bar.innerHTML =
      '<label>站点<select id="apStationTeam"></select></label>'+
      '<button id="apStationQuery" class="ap-btn">查询</button>'+
      '<span class="ap-meta" id="apStationMeta"></span>';
    pane.appendChild(bar);
    var body = document.createElement("div"); body.id = "apStationBody"; pane.appendChild(body);
    var sel = document.getElementById("apStationTeam");
    var btn = document.getElementById("apStationQuery");
    // 站点数据 tab：默认选中「全部站点」，每次加载/刷新均自动显示全部站点
    _apFillTeams(sel, true);
    if(sel && _ap.team) sel.value = _ap.team;
    if(btn) btn.addEventListener("click", _apLoadStation);
    // 切换站点：仅从统一缓存重渲染，绝不触发数据拉取（与骑手明细切站点一致）
    if(sel) sel.addEventListener("change", function(){ _ap.team = sel.value; _apRenderStationFromCache(); });
    if(_apDataset && _apDataset.station_data){ _apRenderStationFromCache(); }
    else {
      body.innerHTML = _apEmptyState("站点数据",
        "合并展示各站点「时段有效 / 排班准确 / 排班出勤 / 时段满足」四项，按系统设置时段（含全天）展开。点「查询」拉取实时数据。", "clock");
    }
  }

  // 4 张卡片：每张卡片 = 站点ID/站点名称 + 2 个指标组（达成率 + 合并「分子/分母」列），每组按所有时段（含全天、全天列第一）展开为列
  var _AP_STATION_CARDS = [
    {title:"时段有效", groups:[
      {k:"rate",label:"时段达成率",pct:true},
      {k:"achieved",label:"达标/目标",den:"target",numLabel:"时段达标人数",denLabel:"时段目标人数"}]},
    {title:"排班准确", groups:[
      {k:"rate",label:"排班准确率",pct:true,num:"achieved",den:"scheduled"},
      {k:"achieved",label:"达标/排班",den:"scheduled",numLabel:"时段达标人数",denLabel:"时段排班人数"}]},
    {title:"排班出勤", groups:[
      {k:"rate",label:"排班出勤率",pct:true,num:"order",den:"scheduled"},
      {k:"order",label:"有单/排班",den:"scheduled",numLabel:"时段排班且有单人数",denLabel:"时段排班人数"}]},
    {title:"时段满足", groups:[
      {k:"rate",label:"时段满足率",pct:true,num:"order",den:"target"},
      {k:"order",label:"有单/目标",den:"target",numLabel:"时段有单骑手数",denLabel:"时段目标人数"}]}
  ];

  function _apStationCard(card, periods, rows){
    var np = periods.length;
    var th1 = '<th rowspan="2" class="ap-col-id">站点ID</th><th rowspan="2" class="ap-col-name">站点名称</th>';
    var th2 = "";
    card.groups.forEach(function(g){
      var tip = g.den ? (' title="'+g.numLabel+' / '+g.denLabel+'"') : '';
      th1 += '<th colspan="'+np+'" class="ap-grp"'+tip+'>'+esc(g.label)+'</th>';
      periods.forEach(function(p){
        var ph = p.is_full_day ? '<span class="ap-fd">全天</span>' : esc(p.time_name||p.time_code);
        th2 += '<th class="ap-pcol">'+ph+'</th>';
      });
    });
    var trs = rows.map(function(r){
      var m = r.metrics||{};
      var tds = '<td class="ap-col-id">'+esc(r.team_id)+'</td><td class="ap-col-name">'+esc(r.team_name||r.team_id)+'</td>';
      card.groups.forEach(function(g){
        periods.forEach(function(p){
          var cell = m[p.time_code]||{};
          var v = cell[g.k];
          if(g.pct){
            var rv = (g.num!=null && g.den!=null) ? ((cell[g.den]>0 && cell[g.num]!=null) ? (cell[g.num]/cell[g.den]*100) : 0) : v;
            tds += '<td class="center">'+_apRateBadge(rv)+'</td>';
          }
          else if(g.den){
            // 合并列：分子/分母（如 时段达标人数/时段目标人数 = 6/4）
            var den = cell[g.den];
            if(v==null||den==null){ tds += '<td class="ap-combo">—</td>'; }
            else {
              var tip = ' title="'+g.numLabel+' '+v+' / '+g.denLabel+' '+den+'"';
              tds += '<td class="ap-combo"'+tip+'><span class="ap-cn">'+v+'</span><span class="ap-slash">/</span><span class="ap-cd">'+den+'</span></td>';
            }
          }
          else { tds += '<td class="num">'+_apNum(v)+'</td>'; }
        });
      });
      return '<tr>'+tds+'</tr>';
    }).join("");
    return '<div class="ap-station-card"><div class="ap-station-card-h">'+esc(card.title)+'</div>'+
      '<div class="ap-table-wrap"><table class="ap-table ap-station-table">'+
      '<thead><tr>'+th1+'</tr><tr>'+th2+'</tr></thead><tbody>'+trs+'</tbody></table></div></div>';
  }

  // 渲染后实测首列（站点ID）实际宽度，写入 --ap-id-w，使冻结的「站点名称」列
  // 据此做正确的 sticky left 偏移（不再写死 56px）。4 张卡片首列内容一致，测一次即可。
  function _apFixStationSticky(){
    var body = document.getElementById("apStationBody");
    if(!body) return;
    var tbl = body.querySelector(".ap-station-table");
    if(!tbl) return;
    var idCell = tbl.querySelector(".ap-col-id");
    if(!idCell) return;
    var w = idCell.offsetWidth || 64;
    body.style.setProperty("--ap-id-w", w + "px");
  }

  function _apRenderStationData(j){
    var body = document.getElementById("apStationBody");
    if(!body) return;
    if(!j || !j.ok){ body.innerHTML = '<div class="ap-err">加载失败：'+(j&&j.error?esc(j.error):"未知错误")+'</div>'; return; }
    if(j.need_refresh){ body.innerHTML = _apEmptyState("站点数据","请点「查询」拉取实时数据。", "clock"); return; }
    var periods = j.periods||[];
    var rows = j.rows||[];
    if(!periods.length){ body.innerHTML = _apEmptyState("站点数据","系统设置无时段配置。", "clock"); return; }
    if(!rows.length){ body.innerHTML = _apEmptyState("站点数据","所选站点当日无数据。", "clock"); return; }
    var html = "";
    _AP_STATION_CARDS.forEach(function(card){ html += _apStationCard(card, periods, rows); });
    body.innerHTML = html;
    // 列宽不再写死：各列按内容自适应；冻结首列（站点ID）渲染后实测宽度，
    // 写入 CSS 变量 --ap-id-w 供「站点名称」列做正确的 sticky left 偏移。
    _apFixStationSticky();
    if(j.data_note){ html += '<div style="margin:8px 0;padding:6px 10px;border-left:3px solid #f59e0b;background:#fffbeb;color:#92400e;font-size:13px;border-radius:4px">'+esc(j.data_note)+'</div>'; }
    var meta = document.getElementById("apStationMeta");
    if(meta) meta.textContent = (j.teamName||j.team)+" · "+j.date+" · 已加载";
  }

  // 站点数据从统一缓存渲染：按当前 _ap.team 过滤行（__all__ 数据集已含全部站点）。
  function _apRenderStationFromCache(){
    var body = document.getElementById("apStationBody");
    if(!body) return;
    if(!_apDataset || !_apDataset.station_data){
      body.innerHTML = _apEmptyState("站点数据","请点「查询」拉取实时数据。", "clock");
      var m0 = document.getElementById("apStationMeta"); if(m0) m0.textContent="";
      return;
    }
    var sd = _apDataset.station_data;
    var rows = sd.rows || [];
    if(_ap.team && _ap.team !== "__all__"){
      rows = rows.filter(function(r){ return String(r.team_id) === String(_ap.team); });
    }
    _apRenderStationData({ok:true, periods:sd.periods, rows:rows,
                          teamName:sd.teamName, date:sd.date, data_note:sd.data_note});
    var meta = document.getElementById("apStationMeta");
    if(meta) meta.textContent = (sd.teamName||"")+" · "+sd.date+" · 已加载";
  }

  // 单一入口：拉取统一数据源（__all__ 一次 compute/站），写入同一缓存；两视图均从此渲染。
  // refresh=true 才实时拉取；两 tab 的「查询」按钮都走这里 → 一次刷新同时同步两处数据。
  function _apFetchDataset(refresh){
    _ap.date = _apToday();
    var btnR = document.getElementById("apRiderQuery");
    var btnS = document.getElementById("apStationQuery");
    var metaR = document.getElementById("apRiderMeta");
    var metaS = document.getElementById("apStationMeta");
    if(btnR) btnR.disabled = true;
    if(btnS) btnS.disabled = true;
    if(metaR) metaR.textContent = "";
    if(metaS) metaS.textContent = "加载中…";
    var q = "team=__all__&start="+encodeURIComponent(_ap.date)+"&refresh="+(refresh?1:0);
    api("/api/attend-period/dataset?"+q).then(function(j){
       if(j && j.need_refresh){ _apDataset = null; _apRiderData = null; }
       else if(j && j.dataset){ _apDataset = j.dataset; _apRiderData = (_apDataset.rider_detail) || null; _apSaveDatasetCache(); }
       _apRenderRiderGrid();
       _apRenderStationFromCache();
    }).catch(function(e){
       var b=document.getElementById("apRiderBody"); if(b) b.innerHTML='<div class="ap-err">请求失败：'+esc(String(e))+'</div>';
       var bs=document.getElementById("apStationBody"); if(bs) bs.innerHTML='<div class="ap-err">请求失败：'+esc(String(e))+'</div>';
    }).then(function(){
       if(btnR) btnR.disabled=false; if(btnS) btnS.disabled=false;
    });
  }

  // ---- 骑手明细：骑手 × 时段 达标矩阵（排班目标 + 实时考勤）----
  function _apTeamName(team){
    // 从已缓存的骑手数据中反查站点显示名（仅用于 meta 标签，无网络请求）
    var rows = (_apRiderData && _apRiderData.rows) || [];
    for(var i=0;i<rows.length;i++){ if(String(rows[i].team_id)===String(team)) return rows[i].team_name||team; }
    return team;
  }
  // 加载动画（请求发起→返回期间持续展示，纯动画无文字，约占表格区域 1/4 并居中）
  function _apRiderLoading(){
    return '<div class="ap-rider-loading">'+
      '<div class="ap-rider-spinner"></div>'+
      '<div class="ap-rider-pulse"></div>'+
    '</div>';
  }
  // 无数据 / 占位：纯图标、无文字
  function _apRiderEmptyGlyph(icon){
    return '<div class="ap-rider-empty"><div class="ap-empty-ic">'+svg(icon||"user-check")+'</div></div>';
  }
  function _apLoadRider(){
    // 骑手明细 与 站点数据 共用统一数据源：点「查询」即触发 _apFetchDataset（__all__ 一次拉取），
    // 写入同一缓存；本视图从 _apDataset.rider_detail 派生，不单独打接口。
    _apFetchDataset(true);
  }

  function _riderOrders(r){ var s=0; var cs=r.cells||{}; for(var k in cs){ var c=cs[k]; if(c&&c.scheduled) s+=(c.orders||0); } return s; }
  function _riderOnline(r){ var s=0; var cs=r.cells||{}; for(var k in cs){ var c=cs[k]; if(c&&c.scheduled) s+=(c.online_sec||0); } return s; }
  function _apRiderDetailHtml(r, periods){
    var rowsHtml = periods.map(function(pd){
      var c = r.cells[pd.time_code];
      if(!c || !c.scheduled){
        return '<div class="apd-row apd-rest"><span class="apd-t">'+esc(pd.time_name||pd.time_code)+'</span><span class="apd-v">无排班</span></div>';
      }
      var na = (c.achieved!==true && c.achieved!==false);
      var badge = na? '<span class="ap-badge none">未配置</span>' : (c.achieved===true? '<span class="ap-badge ok">达标</span>' : '<span class="ap-badge bad">未达标</span>');
      return '<div class="apd-row"><span class="apd-t">'+esc(pd.time_name||pd.time_code)+' <small>'+(pd.start_time||"")+'–'+(pd.end_time||"")+'</small></span>'+
        '<span class="apd-v">单量 '+(c.orders||0)+' / '+pd.orders_req+' ｜ 在线 '+(c.online_sec!=null?Math.round(c.online_sec/60)+'分':'—')+' / '+pd.online_req_h+'h</span>'+ badge+'</div>';
    }).join("");
    return '<div class="apd"><div class="apd-head">'+esc(r.rider_name||r.rider_id)+' · 各时段明细（共 '+periods.length+' 个时段）</div>'+rowsHtml+'</div>';
  }
  function _apSwitchRiderTeam(){
    var sel = document.getElementById("apRiderTeam");
    if(!sel) return;
    _ap.team = sel.value;
    // 关键：切换站点仅用已缓存的数据（_apRiderData）重渲染对应站点明细，绝不发起任何 HTTP 请求
    _apRenderRiderGrid();
  }
  // ---- 骑手明细排序：统一排序状态 + 表头点击切换（前端内存排序，零网络）----
  // 列定义：type 决定比较方式，defDir 为该列首次点击的默认方向，get(r) 取用于比较的原始值
  var _AP_RIDER_COLS = {
    rid:   {type:'str',  defDir:'asc',  get:function(r){ return String(r.rider_id); }},
    rname: {type:'str',  defDir:'asc',  get:function(r){ return r.rider_name||""; }},
    site:  {type:'str',  defDir:'asc',  get:function(r){ return r.team_name||""; }},
    rate:  {type:'num',  defDir:'desc', get:function(r){ return (r._passedRate==null)? null : r._passedRate/100; }},
    fd:    {type:'bool', defDir:'desc', get:function(r){ return r.full_day_achieved===true?1:(r.full_day_achieved===false?-1:0); }}
  };
  function _apPeriodDate(jdate, t){
    if(!jdate || !t) return null;
    var m = /^(\d{1,2}):(\d{2})$/.exec(t);
    if(!m) return null;
    var d = new Date(jdate + 'T' + ('0'+m[1]).slice(-2) + ':' + m[2] + ':00');
    return isNaN(d.getTime()) ? null : d;
  }
  // 达标率按「已过的排班时段」重算：仅 end<=now 的已排班时段计入（分母=已过的排班时段，分子=其中达标时段）
  function _apPassedRate(r, periods, now){
    var den = 0, num = 0;
    periods.forEach(function(pd){
      var pe = pd._end;
      if(pe && now < pe) return;                 // 时段未结束 → 不计入
      var c = r.cells && r.cells[pd.time_code];
      if(!c || !c.scheduled) return;             // 无排班 → 不计
      den++; if(c.achieved === true) num++;
    });
    return den ? Math.round(num/den*100) : null;
  }
  function _apFindCol(key){
    if(key && key.indexOf('p:')===0){          // 时段列：p:<time_code>
      var tc = key.slice(2);
      return { type:'period', defDir:'desc', get:function(r){
        var c = r.cells && r.cells[tc];
        if(!c || !c.scheduled) return null;     // 无排班 → 置底
        return c.achieved===true?1:(c.achieved===false?-1:0);
      }};
    }
    return _AP_RIDER_COLS[key] || null;
  }
  function _apSortCmp(a,b){
    var col = _apFindCol(_ap.sortKey);
    if(!col) return 0;
    var va = col.get(a), vb = col.get(b);
    var dir = (_ap.sortDir==='asc')?1:-1;
    if(va==null && vb==null) return 0;
    if(va==null) return 1;     // 空值始终置底（升/降序一致），排序稳定
    if(vb==null) return -1;
    if(col.type==='str') return String(va).localeCompare(String(vb),'zh')*dir;
    return (va-vb)*dir;        // num / bool / period
  }
  function _apSortableTh(key,label,cls,title){
    var active = (_ap.sortKey===key);
    var aria = active ? (' aria-sort="'+(_ap.sortDir==='asc'?'ascending':'descending')+'"') : '';
    var ic = active ? ('<span class="ap-sort-ic">'+(_ap.sortDir==='asc'?'▲':'▼')+'</span>') : '';
    return '<th class="'+(cls||'')+'" data-sort="'+key+'"'+aria+' title="'+esc(title||label)+'">'+esc(label)+ic+'</th>';
  }
  function _apToggleSort(key){
    if(_ap.sortKey===key){ _ap.sortDir = (_ap.sortDir==='asc'?'desc':'asc'); }
    else { var col=_apFindCol(key); _ap.sortKey=key; _ap.sortDir = (col && col.defDir)?col.defDir:'asc'; }
  }
  function _apRiderHeadClick(e){   // 事件委托：仅绑定一次（容器 #apRiderBody 常驻）
    var el = e.target;
    while(el && el!==this && !(el.tagName==='TH' && el.getAttribute('data-sort'))){ el = el.parentNode; }
    if(!el || el.tagName!=='TH' || !el.getAttribute('data-sort')) return;
    _apToggleSort(el.getAttribute('data-sort'));
    _apRenderRiderGrid();
  }
  /* ============ 骑手明细：虚拟滚动（窗口化） ============
     长列表（全部站点视图可达上千骑手 × 十几列）若一次性 innerHTML 整表，
     每次搜索键入/排序都会重建数千 DOM，卡顿明显。这里做窗口化：仅渲染可视区 + 上下 overscan，
     滚动时只重建 tbody（容器不重建 → scrollTop 保持）。展开明细 / 小列表仍整表渲染，避免 spacer 高度误差。 */
  var WINDOW_THRESHOLD = 100;   // 超过该骑手数才窗口化；少则整表（避免小列表滚动抖动）
  var OVERSCAN = 8;             // 可视区上下额外渲染行数，防快速滚动露白
  var _apRiderView = null;      // 计算缓存：{ rows, periods, j, isViewAll, viewTeam, totalRiders }
  var _apRiderViewDirty = true; // 数据/筛选/排序变化 → 需重算
  var _apRowH = 38;             // 主行估算高度（首绘后实测校准）
  var _apExpandedRid = null;    // 当前展开行（手风琴：单一）
  var _apScrollAttached = false;
  var _apScrollRAF = false;
  var _apHeadSig = "";          // 表头签名，滚动时不变则跳过 thead 重绘（防抖动）

  /* 重算（重）：过滤 + 排序 + 达标率，仅在数据/筛选/排序变化时触发 */
  function _apComputeRiderRows(){
    var j = _apRiderData;
    if(!j || !j.rows){
      _apRiderView = { rows:[], periods:[], j:j||null, isViewAll:true, viewTeam:_ap.team, totalRiders:0 };
      _apRiderViewDirty = false; return;
    }
    var now = new Date();
    var periods = j.periods || [];
    var jdate = j.date || _apToday();
    periods.forEach(function(pd){
      pd._start = _apPeriodDate(jdate, pd.start_time);
      pd._end = _apPeriodDate(jdate, pd.end_time);
      if(pd._start && pd._end && pd._end <= pd._start){ pd._end = new Date(pd._end.getTime() + 86400000); }
    });
    (j.rows||[]).forEach(function(r){ r._passedRate = _apPassedRate(r, periods, now); });
    var isViewAll = !_ap.team || _ap.team === "__all__";
    var viewRows = isViewAll ? j.rows : j.rows.filter(function(r){ return String(r.team_id) === String(_ap.team); });
    var q = (_apRiderFilter.q||"").trim().toLowerCase();
    var rows = viewRows.slice();
    if(q) rows = rows.filter(function(r){ return (r.rider_name||"").toLowerCase().indexOf(q)>=0 || String(r.rider_id).toLowerCase().indexOf(q)>=0; });
    if(_apRiderFilter.onlyFail) rows = rows.filter(function(r){ return r._passedRate != null && r._passedRate < 100; });
    rows.sort(_apSortCmp);
    _apRiderView = { rows:rows, periods:periods, j:j, isViewAll:isViewAll, viewTeam:_ap.team, totalRiders:viewRows.length };
    _apRiderViewDirty = false;
  }

  /* 表头 HTML（<tr>…</tr>） */
  function _apRiderHeadHtml(periods){
    var html = '<tr>'+
      _apSortableTh('rid','骑手ID','sticky-col ap-rid')+
      _apSortableTh('rname','骑手姓名','sticky-col ap-rname')+
      _apSortableTh('site','所属站点','sticky-col ap-site-col')+
      _apSortableTh('rate','达标率','center','按达标率排序（点击表头切换升/降序）')+
      _apSortableTh('fd','全天','center','按全天达标状态排序（点击表头切换升/降序）');
    periods.forEach(function(pd){
      var title = (pd.time_name||String(pd.time_code))+'：'+(pd.start_time||"")+' - '+(pd.end_time||"");
      if(pd.configured){ title += ' ｜ 单量≥'+pd.orders_req+'，时长≥'+pd.online_req_h+'h'; }
      else { title += ' ｜ 未配置达标规则'; }
      if(pd.error){ title += ' ｜ 考勤拉取失败'; }
      var active = (_ap.sortKey==='p:'+pd.time_code);
      var aria = active ? (' aria-sort="'+(_ap.sortDir==='asc'?'ascending':'descending')+'"') : '';
      var ic = active ? ('<span class="ap-sort-ic">'+(_ap.sortDir==='asc'?'▲':'▼')+'</span>') : '';
      html += '<th class="center" data-sort="p:'+pd.time_code+'"'+aria+' title="'+esc(title)+'">'+esc(pd.time_name||String(pd.time_code))+
        '<div class="ap-th-range">'+(pd.start_time||"")+'–'+(pd.end_time||"")+'</div>'+ic+'</th>';
    });
    return html + '</tr>';
  }

  /* 单行 HTML（含展开明细行；仅当该行被展开时追加；窗口化模式下 _apExpandedRid 必为空故不追加） */
  function _apRiderRowHtml(r, periods, idx){
    var colspanN = periods.length + 5;
    var rate = r._passedRate;
    var rateCls = rate==null? "na" : (rate>=100? "ok":"warn"); if(rate!=null && rate<80) rateCls="bad";
    var fdCls, fdGlyph, fdSub, fdTitle;
    if(!r.full_day_configured){ fdCls="na"; fdGlyph="?"; fdSub="未配置"; fdTitle="系统设置中未配置全天标准"; }
    else if(r.full_day_achieved === true){ fdCls="ok"; fdGlyph="✓"; fdSub=(r.full_day_orders_req?(r.full_day_orders+" / "+r.full_day_orders_req):"—"); fdTitle="全天达标：单量 "+r.full_day_orders+" / "+r.full_day_orders_req+"，有效在线 "+r.full_day_online_h+"h / "+r.full_day_online_req_h+"h"; }
    else if(r.full_day_achieved === false){ fdCls="bad"; fdGlyph="✗"; fdSub=(r.full_day_orders_req?(r.full_day_orders+" / "+r.full_day_orders_req):"—"); fdTitle="全天未达标：单量 "+r.full_day_orders+" / "+r.full_day_orders_req+"，有效在线 "+r.full_day_online_h+"h / "+r.full_day_online_req_h+"h"; }
    else { fdCls="na"; fdGlyph="?"; fdSub="—"; fdTitle=""; }
    var now = new Date();
    var open = (r.rider_id === _apExpandedRid);
    var html = '<tr class="ap-rider-row '+(idx%2? "ap-odd":"ap-even")+(open? " ap-row-open":"")+'" data-rid="'+esc(r.rider_id)+'">'+
      '<td class="sticky-col ap-rid">'+esc(r.rider_id)+'</td>'+
      '<td class="sticky-col ap-rname">'+esc(r.rider_name||"—")+'</td>'+
      '<td class="sticky-col ap-site-col">'+esc(r.team_name||"—")+'</td>'+
      '<td class="center"><div class="ap-rate"><div class="ap-rate-bar ap-rate-'+rateCls+'" style="width:'+(rate==null?0:rate)+'%"></div>'+
        '<span class="ap-rate-txt">'+(rate==null?'—':rate+'%')+'</span></div></td>'+
      '<td class="center ap-cell ap-cell-'+fdCls+'" title="'+esc(fdTitle)+'">'+
        '<span class="ap-glyph">'+fdGlyph+'</span><span class="ap-cell-sub">'+esc(fdSub)+'</span></td>';
    periods.forEach(function(pd){
      var c = r.cells[pd.time_code];
      if(!c || !c.scheduled){ html += '<td class="center ap-cell-rest" title="该时段无排班">·</td>'; return; }
      if(pd._start && now < pd._start){ html += '<td class="center ap-cell ap-cell-future" title="尚未开始（排班 '+esc(pd.start_time||"")+'–'+esc(pd.end_time||"")+'）">未开始</td>'; return; }
      var detail = '单量 '+_apNum(c.orders)+' / 要求 '+pd.orders_req+'；有效在线 '+
        (c.online_sec!=null? Math.round(c.online_sec/60)+'分':'—')+' / 要求 '+pd.online_req_h+'h';
      var cellCls, glyph, running = (pd._end && now < pd._end);
      if(c.achieved===true){ cellCls="ok"; glyph="✓"; }
      else if(c.achieved===false){ cellCls="bad"; glyph="✗"; }
      else { cellCls="na"; glyph="?"; }
      var ratio = pd.orders_req? ((c.orders||0)+'/'+pd.orders_req) : '—';
      html += '<td class="center ap-cell ap-cell-'+cellCls+(running?' ap-cell-now':'')+'" title="'+esc(detail)+(running?'（进行中）':'')+'">'+
        '<span class="ap-glyph">'+glyph+'</span><span class="ap-cell-sub">'+ratio+'</span></td>';
    });
    html += '</tr>';
    if(open){
      html += '<tr class="ap-rider-detail" data-drid="'+esc(r.rider_id)+'"><td class="sticky-col" colspan="'+colspanN+'">'+
        _apRiderDetailHtml(r, periods)+'</td></tr>';
    }
    return html;
  }

  /* 确保滚动外壳（.ap-rider-scroll > table > thead/tbody#apRiderTbody）存在；不存在则重建并绑定滚动监听 */
  function _apEnsureRiderShell(body, v, colspanN){
    var scroll = body.querySelector(".ap-rider-scroll");
    if(!scroll){
      body.innerHTML = '<div class="ap-rider-scroll"><table class="ap-table ap-rider-table"><thead></thead><tbody id="apRiderTbody"></tbody></table></div>';
      scroll = body.querySelector(".ap-rider-scroll");
      if(!_apScrollAttached){ body.addEventListener("scroll", _apOnRiderScroll, true); _apScrollAttached = true; }
      _apHeadSig = "";   // 强制重绘 thead
    }
    var note = body.querySelector("#apRiderNote");
    if(!note){ note = document.createElement("div"); note.id = "apRiderNote"; body.appendChild(note); }
    note.innerHTML = (v.j && v.j.data_note) ? ('<div style="margin:8px 0;padding:6px 10px;border-left:3px solid #f59e0b;background:#fffbeb;color:#92400e;font-size:13px;border-radius:4px">'+esc(v.j.data_note)+'</div>') : "";
  }

  function _apRiderMeta(v){
    var meta = document.getElementById("apRiderMeta");
    if(meta){
      var viewLabel = v.isViewAll ? "全部站点" : _apTeamName(v.viewTeam);
      meta.textContent = viewLabel + " · " + (v.j.date||"") + " · 已加载 " + v.totalRiders + " 名骑手（缓存）";
    }
  }

  /* 滚动虚拟化：仅窗口化模式下，按 scrollTop 重算可视区并只重建 tbody（容器不重建 → scrollTop 保持） */
  function _apOnRiderScroll(e){
    var t = e.target;
    if(!t || !t.classList || !t.classList.contains("ap-rider-scroll")) return;
    if(_apRiderViewDirty || !_apRiderView) return;
    var total = _apRiderView.rows.length;
    if(_apExpandedRid || total <= WINDOW_THRESHOLD) return;
    if(_apScrollRAF) return;
    _apScrollRAF = true;
    requestAnimationFrame(function(){ _apScrollRAF = false; _apPaintRiderGrid(); });
  }

  /* 轻量绘制：数据未就绪才重算；否则按窗口化/整表渲染 tbody，保留 scrollTop */
  function _apPaintRiderGrid(){
    var body = document.getElementById("apRiderBody");
    if(!body) return;
    if(_apRiderViewDirty || !_apRiderView) _apComputeRiderRows();
    var v = _apRiderView;
    var j = v.j;
    if(!j) return;
    if(!j.ok){ body.innerHTML = '<div class="ap-err">加载失败：'+(j.error?esc(j.error):"未知错误")+'</div>'; return; }
    if(j.need_refresh){ body.innerHTML = _apRiderEmptyGlyph("user-check"); return; }
    if(!v.periods.length){ body.innerHTML = _apRiderEmptyGlyph("user-check"); return; }

    var colspanN = v.periods.length + 5;
    var total = v.rows.length;
    _apEnsureRiderShell(body, v, colspanN);
    var scroll = body.querySelector(".ap-rider-scroll");
    var thead = scroll.querySelector("thead");
    var tbody = scroll.querySelector("#apRiderTbody");

    if(!total){
      thead.innerHTML = _apRiderHeadHtml(v.periods); _apHeadSig = _ap.sortKey+"|"+_ap.sortDir+"|"+v.periods.length;
      tbody.innerHTML = '<tr><td class="ap-empty-row" colspan="'+colspanN+'">无匹配骑手</td></tr>';
      _apRiderMeta(v); return;
    }

    var sig = _ap.sortKey + "|" + _ap.sortDir + "|" + v.periods.length;
    if(sig !== _apHeadSig){ thead.innerHTML = _apRiderHeadHtml(v.periods); _apHeadSig = sig; }

    var windowed = !_apExpandedRid && total > WINDOW_THRESHOLD;
    if(!windowed){
      var html = "";
      for(var i=0;i<total;i++){ html += _apRiderRowHtml(v.rows[i], v.periods, i); }
      tbody.innerHTML = html;
    } else {
      var ch = scroll.clientHeight || 600;
      var vis = Math.ceil(ch / _apRowH) + 1;
      var top = scroll.scrollTop || 0;
      var start = Math.max(0, Math.floor(top / _apRowH) - OVERSCAN);
      var end = Math.min(total - 1, start + vis + 2*OVERSCAN);
      var sTop = '<tr class="ap-spacer"><td colspan="'+colspanN+'" style="height:'+(start*_apRowH)+'px;padding:0;border:0;line-height:0;font-size:0"></td></tr>';
      var mid = "";
      for(var i=start;i<=end;i++){ mid += _apRiderRowHtml(v.rows[i], v.periods, i); }
      var sBot = '<tr class="ap-spacer"><td colspan="'+colspanN+'" style="height:'+((total-1-end)*_apRowH)+'px;padding:0;border:0;line-height:0;font-size:0"></td></tr>';
      tbody.innerHTML = sTop + mid + sBot;
    }
    var fr = tbody.querySelector(".ap-rider-row");
    if(fr){ var h = fr.offsetHeight; if(h>0) _apRowH = h; }
    _apRiderMeta(v);
  }

  /* 公开入口：数据/筛选/排序变化 → 标记重算后绘制 */
  function _apRenderRiderGrid(){ _apRiderViewDirty = true; _apPaintRiderGrid(); }

  /* 行点击：手风琴展开/收起（事件委托，容器常驻故只绑一次） */
  function _apOnRiderRowClick(e){
    var tr = (e.target && e.target.closest) ? e.target.closest(".ap-rider-row") : null;
    if(!tr || !tr.getAttribute) return;
    var rid = tr.getAttribute("data-rid");
    if(!rid) return;
    _apExpandedRid = (_apExpandedRid === rid) ? null : rid;
    _apPaintRiderGrid();   // 展开/收起切换窗口化↔整表，无需重算数据
  }

  function _apRenderRider(pane){
    pane.innerHTML = "";
    var bar = document.createElement("div"); bar.className = "ap-bar ap-rider-bar";
    bar.innerHTML =
      '<label>站点<select id="apRiderTeam"></select></label>'+
      '<input type="search" id="apRiderSearch" class="ap-in" placeholder="搜索姓名 / ID" aria-label="搜索骑手">'+
      '<button id="apRiderQuery" class="ap-btn">查询</button>'+
      '<span class="ap-meta" id="apRiderMeta"></span>'+
      '<span class="ap-rider-tools">'+
        '<label class="ap-chk"><input type="checkbox" id="apRiderOnlyFail"> 仅看未达标</label>'+
      '</span>';
    pane.appendChild(bar);
    var body = document.createElement("div"); body.id = "apRiderBody"; pane.appendChild(body);
    var sel = document.getElementById("apRiderTeam");
    var btn = document.getElementById("apRiderQuery");
    var qEl = document.getElementById("apRiderSearch");
    var onlyFailEl = document.getElementById("apRiderOnlyFail");
    // 刷新页面 / 路由切换 / Tab 重载时：优先用统一数据源缓存展示已获取的考勤数据，绝不自动发起请求
    if(!_apDataset) _apLoadDatasetCache();
    if(_apDataset) _apRiderData = (_apDataset.rider_detail) || null;
    _apFillTeams(sel, true);
    if(sel && _ap.team) sel.value = _ap.team;
    if(btn) btn.addEventListener("click", _apLoadRider);
    // 关键：切换站点仅从缓存重渲染，绝不触发数据拉取；只有「查询」按钮才会拉取并生成看板
    if(sel) sel.addEventListener("change", _apSwitchRiderTeam);
    function reGrid(){ _apRenderRiderGrid(); }
    if(qEl) qEl.addEventListener("input", debounce(function(){ _apRiderFilter.q = qEl.value; reGrid(); }, 120));
    // 表头点击排序（事件委托，容器常驻故只绑一次）：点击切换升/降序，零网络
    if(body) body.addEventListener("click", _apRiderHeadClick);
    if(body) body.addEventListener("click", _apOnRiderRowClick);
    if(onlyFailEl){ onlyFailEl.checked = _apRiderFilter.onlyFail; onlyFailEl.addEventListener("change", function(){ _apRiderFilter.onlyFail = onlyFailEl.checked; reGrid(); }); }
    if(_apRiderData) _apRenderRiderGrid();
    else body.innerHTML = _apRiderEmptyGlyph("user-check");
  }

  // ---- 系统设置：各时段时长 / 单量要求配置（与标准达成系统设置同样的加载-编辑-保存逻辑）----
  function _apSwitchTab(mode){
    apTabs.querySelectorAll(".ap-tab").forEach(function(x){ x.classList.remove("on"); });
    var btn = apTabs.querySelector('.ap-tab[data-m="'+mode+'"]');
    if(btn) btn.classList.add("on");
    _ap.mode = mode;
    stationHost.style.display  = mode==="station"  ? "" : "none";
    riderHost.style.display    = mode==="rider"    ? "" : "none";
    settingsHost.style.display = mode==="settings" ? "" : "none";
    if(mode==="station")  _apRenderStation(stationHost);
    if(mode==="rider")    _apRenderRider(riderHost);
    if(mode==="settings") _apRenderSettings(settingsHost, _apFillTeams);
    try{ localStorage.setItem("attendPeriod_last_tab", mode); }catch(e){}
  }

  apTabs.querySelectorAll(".ap-tab").forEach(function(b){
    b.addEventListener("click", function(){ _apSwitchTab(b.getAttribute("data-m")); });
  });

  // 默认进入：优先读上次选择，否则默认「站点数据」
  var last = null;
  try{ last = localStorage.getItem("attendPeriod_last_tab"); }catch(e){}
  _apSwitchTab(last==="rider" || last==="settings" ? last : "station");
}

/* 说明：标准达成视图的样式（原 _stdEnsureStyle）与 _stdYMD / _stdTableLoader 已迁出 —
   样式落到 web/src/standard.css，两个小工具函数并入 standard.js。
   本文件只承载「时段出勤」视图。 */

/* 自动导出：供其他模块导入的内部顶层符号 */
export { LS_DS_KEY, _ap, _apDataset, _apRiderData, _apRiderFilter, state };
