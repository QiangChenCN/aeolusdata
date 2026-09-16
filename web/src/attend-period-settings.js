// attend-period-settings.js —— 时段出勤 ·「系统设置」面板：
//   月份控制器 + 时段配置表（增删改 / 拖拽排序 / 时间选择弹窗）+ 站点管理（多选 combobox）。
// 由 attend-period.js 的 renderAttendPeriodView 内嵌函数 _apRenderSettings 外提而来（原 659-1264 行），
// 使 attend-period.js 只保留「时段有效 / 站点数据 / 骑手明细」三个看板 tab。
import { store } from "./store.js";
import { api } from "./api.js";
import { svg, esc, toast } from "./ui.js";
const state = store.state;

export function _apRenderSettings(pane, fillTeams){
    pane.innerHTML = "";
    var sec = document.createElement("div"); sec.className = "ap-settings";
    sec.innerHTML =
      '<div class="ap-set-card">'+
        '<div class="ap-set-head">'+
          '<div>'+
            '<h3>时段设置</h3>'+
            '<div class="desc">时段区间采用<b>左闭右开 [开始, 结束)</b>：开始含、结束不含。各列含义：<b>时段时长</b> = 结束−开始（区间总时长，自动计算）；<b>时长要求</b> = 该时段内骑手需达成的有效在线时长（考核目标值，可编辑）；<b>单量要求</b> = 该时段需完成的单量；<b>时段权重</b> = 该时段用于加权计算的百分比系数（0–100，如 100 表示 100%）。</div>'+
          '</div>'+
        '</div>'+
        '<div class="ap-month-bar">'+
          '<button id="apMonthTrigger" class="ap-month-trigger" type="button"><span class="ic">📅</span><span id="apMonthLabel">—</span><span class="caret">▾</span></button>'+
          '<span id="apMonthHint" class="ap-month-hint"></span>'+
          '<div id="apMonthPopup" class="ap-month-popup" role="dialog" aria-label="选择月份">'+
            '<div class="ap-mp-head">'+
              '<button id="apMpPrev" class="ap-mp-nav" type="button" title="上一月">‹</button>'+
              '<span id="apMpLabel" class="ap-mp-label">—</span>'+
              '<button id="apMpNext" class="ap-mp-nav" type="button" title="下一月">›</button>'+
            '</div>'+
            '<div id="apMpGrid" class="ap-mp-grid"></div>'+
          '</div>'+
        '</div>'+
        '<div id="apPeriodTableWrap" class="ap-table-wrap">'+
          '<div class="std-table-loader"><span class="dots"><i></i><i></i><i></i></span><div class="txt">加载时段配置…</div></div>'+
        '</div>'+
        '<div class="ap-period-foot" id="apPeriodFoot" style="display:none">'+
          '<button type="button" id="apPeriodAdd" class="ap-btn ap-btn-add">+ 添加时段</button>'+
          '<button type="button" id="apPeriodSave" class="ap-btn-save" disabled>保存配置</button>'+
          '<span id="apPeriodFootHint" class="ap-month-hint"></span>'+
        '</div>'+
      '</div>';
    pane.appendChild(sec);
    // ---- 站点管理 卡片（系统设置 → 站点管理）----
    (function(){
      var card = document.createElement("div");
      card.className = "ap-set-card";
      card.id = "apTeamsCard";
      card.innerHTML =
        '<div class="ap-set-head"><div>'+
          '<h3>站点管理</h3>'+
          '<div class="desc">设定时段出勤看板（时段有效 / 骑手明细等）的<b>站点下拉候选范围</b>。框内为当前已选站点，点右上角「管理」勾选 / 增删站点；保存后看板即以此为口径（默认仍单站下钻，不自动跨站合并）。</div>'+
        '</div></div>'+
        '<div class="ap-teams-box" id="apTeamsBox">'+
          '<div class="ap-teams-box-head">'+
            '<span class="ap-teams-box-title" id="apTeamsBoxTitle">已选站点 <b>0</b> 个</span>'+
            '<button type="button" id="apTeamsManage" class="ap-btn ap-btn-sm">管理</button>'+
          '</div>'+
          '<div class="ap-teams-chips" id="apTeamsChips"></div>'+
          '<div class="ap-teams-box-hint">点击「管理」打开弹窗，在搜索多选框中勾选 / 移除站点；保存后下方各 tab 的下拉同步更新。</div>'+
        '</div>'+
        '<div class="ap-set-foot"><span class="ap-set-msg" id="apTeamsMsg"></span></div>';
      sec.appendChild(card);

      var boxTitle = card.querySelector("#apTeamsBoxTitle");
      var chipsEl = card.querySelector("#apTeamsChips");
      var manageBtn = card.querySelector("#apTeamsManage");
      var msgEl = card.querySelector("#apTeamsMsg");

      var ts, tsEdit;   // 实际指向持久单例 modal._apts（modal 就绪后绑定，见下方）。避免切 tab 重渲染时闭包捕获过期状态。
      function tsMsg(cls, txt){ msgEl.textContent = txt||""; msgEl.className = "ap-set-msg"+(cls?(" "+cls):""); }
      function tsName(id){ id=String(id); for(var i=0;i<ts.all.length;i++){ if(String(ts.all[i].id)===id) return ts.all[i].name||id; } return id; }

      function boxRender(){
        var ids = Object.keys(ts.selected).filter(function(k){ return ts.selected[k]; });
        boxTitle.innerHTML = '已选站点 <b>'+ids.length+'</b> 个';
        if(!ids.length){ chipsEl.innerHTML = '<span class="ap-teams-chips-empty">暂无已选站点，点「管理」添加</span>'; return; }
        chipsEl.innerHTML = ids.map(function(id){
          return '<span class="ap-teams-chip">'+esc(tsName(id))+'</span>';
        }).join("");
      }
      function tsLoad(){
        tsMsg("", "加载中…");
        api("/api/attend-period/teams").then(function(j){
          ts.all = (j && j.all) || [];
          ts.selected = {};
          (j && j.teams || []).forEach(function(id){ ts.selected[String(id)] = true; });
          tsMsg("", "");
          boxRender();
        }).catch(function(e){ tsMsg("err", "加载失败："+String(e)); });
      }

      // ---- 弹窗 + 多选 combobox ----
      var modal = document.getElementById("apTeamsModal");
      if(!modal){
        modal = document.createElement("div");
        modal.id = "apTeamsModal";
        modal.className = "ap-modal-mask";
        modal.style.display = "none";
        modal.innerHTML =
          '<div class="ap-modal" role="dialog" aria-modal="true">'+
            '<div class="ap-modal-head"><h3>管理站点</h3><button type="button" class="ap-modal-x" id="apTeamsModalClose">×</button></div>'+
            '<div class="ap-modal-body">'+
              '<div class="ap-combo" id="apTeamCombo">'+
                '<div class="ap-combo-box" id="apComboBox">'+
                  '<span class="ap-combo-ph" id="apComboPh">选择站点…</span>'+
                '</div>'+
                '<div class="ap-combo-panel" id="apComboPanel">'+
                  '<input type="text" id="apComboSearch" class="ap-combo-search" placeholder="搜索站点名称 / ID…" autocomplete="off">'+
                  '<div class="ap-combo-opts" id="apComboOpts"></div>'+
                  '<div class="ap-combo-foot">'+
                    '<button type="button" id="apComboAll" class="ap-btn ap-btn-sm">全选</button>'+
                    '<button type="button" id="apComboClear" class="ap-btn ap-btn-sm">清空</button>'+
                    '<span class="ap-combo-count" id="apComboCount"></span>'+
                    '<button type="button" id="apComboRefresh" class="ap-btn ap-btn-sm" style="margin-left:auto">刷新列表</button>'+
                  '</div>'+
                '</div>'+
              '</div>'+
            '</div>'+
            '<div class="ap-modal-foot">'+
              '<button type="button" id="apTeamsCancel" class="ap-btn">取消</button>'+
              '<button type="button" id="apTeamsSave" class="ap-btn ap-btn-primary">保存</button>'+
            '</div>'+
          '</div>';
        document.body.appendChild(modal);
      }
      var combo = modal.querySelector("#apTeamCombo");
      var comboBox = modal.querySelector("#apComboBox");
      var searchEl = modal.querySelector("#apComboSearch");
      var optsEl = modal.querySelector("#apComboOpts");
      var countEl = modal.querySelector("#apComboCount");
      var panel = document.getElementById("apComboPanel");   // 见 openPanel：会被移出弹窗挂到 body，故用 id 取而非 modal.querySelector
      // 把可变状态挂到持久单例 modal 上：各次「切 tab 重渲染」都别名到同一份对象，且只原地改不重赋值变量，
      // 保证只绑一次的弹窗处理器（保存/勾选）与每次渲染的 openModal/comboRender 操作的是同一状态，避免「选了没生效」。
      var _apts = modal._apts || (modal._apts = { ts: { all: [], selected: {} }, tsEdit: {} });
      ts = _apts.ts; tsEdit = _apts.tsEdit;
      modal._boxRender = boxRender;   // 保存后用「当前渲染」的 boxRender 刷新可见 chips（而非首次闭包那份可能已脱离 DOM 的）

      function comboRender(){
        var selIds = Object.keys(tsEdit).filter(function(k){ return tsEdit[k]; });
        if(!selIds.length){ comboBox.innerHTML = '<span class="ap-combo-ph">选择站点…</span>'; }
        else {
          comboBox.innerHTML = selIds.map(function(id){
            return '<span class="ap-combo-chip" data-id="'+esc(id)+'"><b>'+esc(tsName(id))+'</b><i class="ap-combo-x" data-id="'+esc(id)+'">×</i></span>';
          }).join("");
        }
        var kw = (searchEl.value||"").trim().toLowerCase();
        var list = ts.all.filter(function(t){
          if(!kw) return true;
          return (String(t.name||"").toLowerCase().indexOf(kw)>=0) || (String(t.id).toLowerCase().indexOf(kw)>=0);
        });
        if(!list.length){ optsEl.innerHTML = '<div class="ap-combo-empty">无匹配站点</div>'; }
        else {
          optsEl.innerHTML = list.map(function(t){
            var id = String(t.id);
            var on = tsEdit[id] ? " on" : "";
            return '<div class="ap-combo-opt'+on+'" data-id="'+esc(id)+'">'+
              '<span class="ap-combo-ck"></span>'+
              '<span>'+esc(t.name||id)+'</span>'+
              '<span class="ap-combo-oid">'+esc(id)+'</span>'+
            '</div>';
          }).join("");
        }
        countEl.textContent = '已选 '+selIds.length+' / 共 '+ts.all.length+' 个';
      }
      function placePanel(){
        var r = comboBox.getBoundingClientRect();
        panel.style.left = r.left + "px";
        panel.style.width = (r.width - 2) + "px";
        var ph = panel.offsetHeight || 340;
        var availBelow = window.innerHeight - r.bottom - 8;
        if(availBelow < ph && (r.top - 8) > ph){
          panel.style.top = "auto";
          panel.style.bottom = (window.innerHeight - r.top + 6) + "px";
        } else {
          panel.style.top = (r.bottom + 6) + "px";
          panel.style.bottom = "auto";
        }
      }
      function openPanel(){
        combo.classList.add("open");
        document.body.appendChild(panel);   // 移出弹窗 → 不再被 .ap-modal(overflow:hidden) 裁剪
        panel.classList.add("show");
        placePanel();
        searchEl.focus();
      }
      function closePanel(){ combo.classList.remove("open"); panel.classList.remove("show"); }
      function openModal(){
        for(var _k in tsEdit) delete tsEdit[_k];   // 原地清空（不重赋值变量，保持别名到持久单例）
        Object.keys(ts.selected).forEach(function(k){ tsEdit[k] = true; });
        searchEl.value = "";
        comboRender();
        modal.style.display = "flex";
      }
      function closeModal(){ modal.style.display = "none"; closePanel(); }

      manageBtn.addEventListener("click", openModal);   // manageBtn 每次 render 为新元素，需每次绑定
      // 弹窗(modal)是持久单例，监听器只绑一次，避免切 tab 重渲染时重复绑定导致「开→关」相互抵消
      if(!modal._wired){
        modal.querySelector("#apTeamsModalClose").addEventListener("click", closeModal);
        modal.querySelector("#apTeamsCancel").addEventListener("click", closeModal);
        modal.addEventListener("click", function(e){ if(e.target === modal) closeModal(); });
        comboBox.addEventListener("click", function(e){
          var x = e.target.closest(".ap-combo-x");
          if(x){ var id = x.getAttribute("data-id"); tsEdit[id] = false; comboRender(); return; }
          if(combo.classList.contains("open")) closePanel(); else openPanel();
        });
        optsEl.addEventListener("click", function(e){
          var opt = e.target.closest(".ap-combo-opt"); if(!opt) return;
          var id = opt.getAttribute("data-id");
          tsEdit[id] = !tsEdit[id];
          comboRender();
        });
        searchEl.addEventListener("input", comboRender);
        modal.querySelector("#apComboAll").addEventListener("click", function(){ ts.all.forEach(function(t){ tsEdit[String(t.id)] = true; }); comboRender(); });
        modal.querySelector("#apComboClear").addEventListener("click", function(){ ts.all.forEach(function(t){ tsEdit[String(t.id)] = false; }); comboRender(); });
        modal.querySelector("#apComboRefresh").addEventListener("click", function(){
          tsMsg("", "刷新中…");
          api("/api/teams").then(function(){ api("/api/attend-period/teams").then(function(j){
            ts.all = (j && j.all) || []; tsMsg("", ""); comboRender();
          }).catch(function(e){ tsMsg("err","刷新失败："+String(e)); }); }).catch(function(e){ tsMsg("err","刷新失败："+String(e)); });
        });
        document.addEventListener("click", function(e){
          if(panel.classList.contains("show") && !combo.contains(e.target) && !panel.contains(e.target)) closePanel();
        });
        window.addEventListener("scroll", function(){ if(panel.classList.contains("show")) placePanel(); }, true);
        window.addEventListener("resize", function(){ if(panel.classList.contains("show")) placePanel(); });
        modal.querySelector("#apTeamsSave").addEventListener("click", function(){
          var ids = Object.keys(tsEdit).filter(function(k){ return tsEdit[k]; });
          if(!ids.length){ tsMsg("err", "请至少选择 1 个站点"); return; }
          var saveBtn = modal.querySelector("#apTeamsSave");
          saveBtn.disabled = true; tsMsg("", "保存中…");
          api("/api/attend-period/teams", {
            method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({teams: ids})
          }).then(function(r){
            saveBtn.disabled = false;
            if(r && r.ok){
              ts.selected = {}; ids.forEach(function(id){ ts.selected[id] = true; });
              (modal._boxRender || boxRender)(); closeModal();
              if(typeof fillTeams === "function"){ ["apTeam","apRiderTeam"].forEach(function(sid){ var el=document.getElementById(sid); if(el) fillTeams(el); }); }
              tsMsg("ok", "✓ 已保存，已选 "+ids.length+" 个站点");
            } else { tsMsg("err", "✗ 保存失败："+((r&&r.error)||"未知错误")); }
          }).catch(function(e){ saveBtn.disabled=false; tsMsg("err", "✗ 保存失败："+String(e)); });
        });
        modal._wired = true;
      }

      tsLoad();
    })();
    var wrap = sec.querySelector("#apPeriodTableWrap");
    var saveBtn = sec.querySelector("#apPeriodSave");
    var addBtn = sec.querySelector("#apPeriodAdd");
    var footEl = sec.querySelector("#apPeriodFoot");
    var footHint = sec.querySelector("#apPeriodFootHint");
    var labelEl = sec.querySelector("#apMonthLabel");
    var hintEl = sec.querySelector("#apMonthHint");
    var trigger = sec.querySelector("#apMonthTrigger");
    var popup = sec.querySelector("#apMonthPopup");
    var mpPrev = sec.querySelector("#apMpPrev");
    var mpNext = sec.querySelector("#apMpNext");
    var mpLabel = sec.querySelector("#apMpLabel");
    var mpGrid = sec.querySelector("#apMpGrid");
    var mpFocus = null;

    var state = { month: null, periods: [], editable: false, editRow: null, dirty: false };

    function updateFoot(){
      if(!footEl) return;
      footEl.style.display = state.editable ? "" : "none";
      if(saveBtn) saveBtn.disabled = !state.dirty;
      if(footHint){
        footHint.textContent = state.dirty ? "有未保存改动，记得点「保存配置」" : "";
        footHint.className = "ap-month-hint" + (state.dirty ? " err" : "");
      }
    }

    function fmtLabel(m){ var p = (m||"").split("-"); return p.length===2 ? (p[0]+"年"+p[1]+"月") : (m||"—"); }
    function shiftMonth(m, delta){
      if(!m) return null;
      var p = m.split("-"), y = +p[0], mo = +p[1];
      var d = new Date(y, mo-1+delta, 1);
      var yy = d.getFullYear(), mm = ("0"+(d.getMonth()+1)).slice(-2);
      return yy+"-"+mm;
    }
    function setNavDisabled(dis){ trigger.disabled = dis; }
    function closePopup(){ popup.style.display = "none"; trigger.classList.remove("open"); }
    function openPopup(){
      if(state.editRow !== null) return;
      mpFocus = state.month || mpFocus;
      renderPopup();
      popup.style.display = "block"; trigger.classList.add("open");
    }
    function renderPopup(){
      if(!mpFocus) mpFocus = (function(){ var d=new Date(); return d.getFullYear()+"-"+("0"+(d.getMonth()+1)).slice(-2); })();
      var p = mpFocus.split("-"), y = +p[0], mo = +p[1];
      mpLabel.textContent = y+"年"+("0"+mo).slice(-2)+"月";
      var cells = [];
      for(var i=1;i<=12;i++){
        var mm = ("0"+i).slice(-2);
        var val = y+"-"+mm;
        var cls = "ap-mp-cell";
        if(val === state.month) cls += " selected";
        if(val === mpFocus) cls += " focus";
        cells.push('<div class="'+cls+'" data-m="'+val+'">'+mm+"月</div>");
      }
      mpGrid.innerHTML = cells.join("");
    }
    function fmtDur(v){
      if(v===null||v===undefined||v==="") return "—";
      var n = Number(v); if(isNaN(n)) return "—";
      return (Math.round(n*100)/100).toString();
    }
    function computeDur(s, e){
      if(!/^\d{1,2}:\d{2}$/.test(s) || !/^\d{1,2}:\d{2}$/.test(e)) return "—";
      var a = s.split(":"), b = e.split(":");
      var m = (b[0]*60 + b[1]*1) - (a[0]*60 + a[1]*1);
      if(m <= 0) m += 1440;          // 支持跨日（如 22:00-00:00）
      return (Math.round(m/60*100)/100).toString();
    }

    function renderTable(){
      var rows = state.periods;
      var html = '<table class="ap-table ap-period-table"><thead><tr>'+
        '<th class="ap-drag-col" title="拖动排序">☰</th><th>开始时间</th><th>结束时间</th><th>时段名称</th><th>时段时长(小时)</th><th>时长要求（小时）</th><th>单量要求</th><th>时段权重（%）</th><th class="ap-act-col">操作</th>'+
        '</tr></thead><tbody>';
      rows.forEach(function(r, idx){
        var editing = (state.editRow === idx);
        if(editing){
          html += '<tr data-idx="'+idx+'">'+
            '<td class="ap-drag-cell"></td>'+
            '<td><button type="button" class="ap-time-cell ap-period-start" data-idx="'+idx+'" data-field="start">'+esc(r.start)+'</button></td>'+
            '<td><button type="button" class="ap-time-cell ap-period-end" data-idx="'+idx+'" data-field="end">'+esc(r.end)+'</button></td>'+
            '<td><input type="text" class="ap-period-name" value="'+esc(r.name)+'" placeholder="时段名称"></td>'+
            '<td class="ap-dur ap-period-dur-auto">'+fmtDur(r.period_duration_h)+'</td>'+
            '<td><input type="number" class="ap-period-req" value="'+esc(String(r.effective_online_req_h))+'" min="0" step="0.1"></td>'+
            '<td><input type="number" class="ap-period-orders" value="'+esc(String(r.orders))+'" min="0" step="1"></td>'+
            '<td><input type="number" class="ap-period-weight" value="'+esc(String(r.weight))+'" min="0" max="100" step="1"></td>'+
            '<td><div class="ap-row-act">'+
              '<button type="button" class="ap-row-done" data-idx="'+idx+'">完成</button>'+
              '<button type="button" class="ap-row-cancel" data-idx="'+idx+'">取消</button>'+
              '<button type="button" class="ap-row-del danger" data-idx="'+idx+'">删除</button>'+
            '</div></td>'+
          '</tr>';
        } else {
          html += '<tr data-idx="'+idx+'"'+(state.editable && state.editRow===null ? ' draggable="true"' : '')+'>'+
            '<td class="ap-drag-cell" title="拖动调整顺序"><span class="ap-grip">⠿</span></td>'+
            '<td class="ap-ro">'+esc(r.start)+'</td>'+
            '<td class="ap-ro">'+esc(r.end)+'</td>'+
            '<td class="ap-ro">'+esc(r.name)+'</td>'+
            '<td class="ap-ro ap-period-dur-auto">'+fmtDur(r.period_duration_h)+'</td>'+
            '<td class="ap-ro">'+fmtDur(r.effective_online_req_h)+'</td>'+
            '<td class="ap-ro">'+esc(String(r.orders))+'</td>'+
            '<td class="ap-ro">'+(r.weight==null?"—":r.weight+"%")+'</td>'+
            '<td><div class="ap-row-act">'+
              (state.editable ? '<button type="button" class="ap-row-edit" data-idx="'+idx+'">编辑</button>' : '')+
            '</div></td>'+
          '</tr>';
        }
      });
      html += '</tbody></table>';
      wrap.innerHTML = html;
    }
    // 行内编辑：点时间格开弹窗；点行操作按钮（编辑/完成/取消/删除）
    wrap.addEventListener("click", function(e){
      var btn = e.target.closest ? e.target.closest(".ap-time-cell") : null;
      if(btn && state.editRow !== null){
        var cur = (btn.textContent||"").trim();
        openTimePicker(cur, function(val){
          btn.textContent = val;
          var tr = btn.closest("tr");
          var s = (tr.querySelector(".ap-period-start").textContent||"").trim();
          var en = (tr.querySelector(".ap-period-end").textContent||"").trim();
          var durCell = tr.querySelector(".ap-dur");
          if(durCell) durCell.textContent = computeDur(s, en);
        });
        return;
      }
      var act = e.target.closest ? e.target.closest(".ap-row-edit,.ap-row-done,.ap-row-cancel,.ap-row-del") : null;
      if(!act) return;
      var idx = parseInt(act.getAttribute("data-idx"),10);
      if(act.classList.contains("ap-row-edit")){
        state.editRow = idx; renderTable();
      } else if(act.classList.contains("ap-row-cancel")){
        var cr = state.periods[idx];
        if(cr && cr._new){ state.periods.splice(idx,1); }
        state.editRow = null; renderTable();
      } else if(act.classList.contains("ap-row-done")){
        var tr2 = act.closest("tr");
        var s2 = (tr2.querySelector(".ap-period-start").textContent||"").trim();
        var e2 = (tr2.querySelector(".ap-period-end").textContent||"").trim();
        var dur2 = computeDur(s2, e2);
        state.periods[idx] = {
          start: s2, end: e2, name: tr2.querySelector(".ap-period-name").value.trim(),
          orders: tr2.querySelector(".ap-period-orders").value,
          effective_online_req_h: tr2.querySelector(".ap-period-req").value,
          weight: tr2.querySelector(".ap-period-weight").value,
          period_duration_h: (dur2==="—"?null:parseFloat(dur2)), _new: false
        };
        state.editRow = null; state.dirty = true; renderTable(); updateFoot();
      } else if(act.classList.contains("ap-row-del")){
        if(confirm("确认删除该时段？此操作需点「保存配置」后生效。")){
          state.periods.splice(idx,1); state.editRow = null; state.dirty = true; renderTable(); updateFoot();
        }
      }
    });

    // 拖拽排序（原生 HTML5 DnD）：仅 read+editable 行可拖；dragover 实时插入指示线；落盘需点「保存配置」
    var dragSrc = -1, dragOverTr = null, dragBefore = true;
    function _clearDropMarks(){
      if(dragOverTr){ dragOverTr.classList.remove("ap-drop-before","ap-drop-after"); dragOverTr = null; }
    }
    wrap.addEventListener("dragstart", function(e){
      var tr = e.target.closest ? e.target.closest("tr[data-idx]") : null;
      if(!tr || tr.getAttribute("draggable") !== "true") return;
      if(e.target.closest && e.target.closest(".ap-row-act")){ e.preventDefault(); return; }  // 操作区不触发拖拽
      dragSrc = parseInt(tr.getAttribute("data-idx"),10);
      tr.classList.add("ap-dragging");
      try{ e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(dragSrc)); }catch(_){}
    });
    wrap.addEventListener("dragover", function(e){
      if(dragSrc < 0) return;
      var tr = e.target.closest ? e.target.closest("tr[data-idx]") : null;
      if(!tr || tr.getAttribute("data-idx") === String(dragSrc)){ e.preventDefault(); return; }
      e.preventDefault();
      if(dragOverTr && dragOverTr !== tr){ dragOverTr.classList.remove("ap-drop-before","ap-drop-after"); }
      var rect = tr.getBoundingClientRect();
      dragBefore = (e.clientY - rect.top) < rect.height/2;
      tr.classList.toggle("ap-drop-before", dragBefore);
      tr.classList.toggle("ap-drop-after", !dragBefore);
      dragOverTr = tr;
      try{ e.dataTransfer.dropEffect = "move"; }catch(_){}
    });
    wrap.addEventListener("drop", function(e){
      if(dragSrc < 0) return;
      var tr = e.target.closest ? e.target.closest("tr[data-idx]") : null;
      if(!tr) return;
      e.preventDefault();
      var ti = parseInt(tr.getAttribute("data-idx"),10);
      _clearDropMarks();
      if(ti !== dragSrc){
        var arr = state.periods, item = arr[dragSrc];
        var to = dragBefore ? ti : ti + 1;
        arr.splice(dragSrc, 1);
        if(dragSrc < to) to -= 1;
        arr.splice(to, 0, item);
        state.dirty = true; renderTable(); updateFoot();
      }
      dragSrc = -1;
    });
    wrap.addEventListener("dragend", function(e){
      var tr = e.target.closest ? e.target.closest("tr[data-idx]") : null;
      if(tr) tr.classList.remove("ap-dragging");
      _clearDropMarks();
      dragSrc = -1;
    });

    var _tp = null;   // 时间弹窗单例：同一次设置 tab 渲染内只建一次 DOM，避免重复创建/监听器叠加
    function openTimePicker(initial, onConfirm){
      if(!_tp){
        var back = document.createElement("div");
        back.className = "ap-time-backdrop";
        back.innerHTML =
          '<div class="ap-time-modal" role="dialog" aria-label="选择时间">'+
            '<div class="ap-time-head">选择时间</div>'+
            '<div class="ap-time-cols"><div class="ap-time-indicator"></div>'+
              '<div class="ap-time-col" id="apTimeH"></div>'+
              '<div class="ap-time-sep">:</div>'+
              '<div class="ap-time-col" id="apTimeM"></div>'+
            '</div>'+
            '<div class="ap-time-foot">'+
              '<button type="button" class="ap-time-cancel">取消</button>'+
              '<button type="button" class="ap-time-ok">确定</button>'+
            '</div>'+
          '</div>';
        document.body.appendChild(back);
        var colH = back.querySelector("#apTimeH"), colM = back.querySelector("#apTimeM");
        function fill(col, max){
          var items = [];
          for(var i=0;i<=max;i++){ var v=("0"+i).slice(-2); items.push('<div class="ap-time-item" data-v="'+v+'">'+v+'</div>'); }
          col.innerHTML = items.join("");
        }
        fill(colH, 23); fill(colM, 59);
        var sel = {h:"00", m:"00"};
        function mark(col, v){ col.querySelectorAll(".ap-time-item").forEach(function(it){ it.classList.toggle("sel", it.getAttribute("data-v")===v); }); }
        function scrollTo(col, v){ var it = col.querySelector('.ap-time-item[data-v="'+v+'"]'); if(it) col.scrollTop = it.offsetTop - (col.clientHeight - it.clientHeight)/2; }
        colH.addEventListener("click", function(e){ var it=e.target.closest(".ap-time-item"); if(!it) return; sel.h=it.getAttribute("data-v"); mark(colH, sel.h); scrollTo(colH, sel.h); });
        colM.addEventListener("click", function(e){ var it=e.target.closest(".ap-time-item"); if(!it) return; sel.m=it.getAttribute("data-v"); mark(colM, sel.m); scrollTo(colM, sel.m); });
        function close(){ if(back.parentNode) back.parentNode.removeChild(back); }
        back.querySelector(".ap-time-cancel").addEventListener("click", close);
        back.querySelector(".ap-time-ok").addEventListener("click", function(){ close(); if(_tp && _tp.onConfirm) _tp.onConfirm(sel.h+":"+sel.m); });
        back.addEventListener("click", function(e){ if(e.target===back) close(); });
        _tp = { back: back, colH: colH, colM: colM, sel: sel, mark: mark, scrollTo: scrollTo, onConfirm: null };
      }
      _tp.onConfirm = onConfirm;
      var parts = (initial||"00:00").split(":");
      var h0 = parseInt(parts[0],10)||0, m0 = parseInt(parts[1],10)||0;
      _tp.sel.h = ("0"+h0).slice(-2); _tp.sel.m = ("0"+m0).slice(-2);
      _tp.mark(_tp.colH, _tp.sel.h); _tp.mark(_tp.colM, _tp.sel.m);
      requestAnimationFrame(function(){ _tp.scrollTo(_tp.colH, _tp.sel.h); _tp.scrollTo(_tp.colM, _tp.sel.m); });
      if(!_tp.back.parentNode) document.body.appendChild(_tp.back);
    }
    function applyMode(){
      labelEl.textContent = fmtLabel(state.month);
      setNavDisabled(false);   // 行内编辑不再锁导航
      closePopup();
      if(!state.editable){
        showHint("", "历史月份（只读）");
      } else {
        showHint("", state.dirty ? "有未保存改动" : "");
      }
      renderTable();
      updateFoot();
    }

    function showHint(cls, txt){
      hintEl.textContent = txt || "";
      hintEl.className = "ap-month-hint" + (cls ? " "+cls : "");
    }

    function loadMonth(m){
      if(!m) return;
      if(state.dirty){
        if(!confirm("有未保存的时段改动，切换月份将丢失这些改动，确认切换？")) return;
      }
      state.month = m;
      state.editRow = null; state.dirty = false;
      api("/api/attend-period/config?month="+encodeURIComponent(m)).then(function(j){
        if(j && j.ok !== false && Array.isArray(j.periods)){
          state.periods = j.periods.map(function(p){ var x=Object.assign({},p); x._new=false; return x; });
          state.editable = !!j.editable;
          mpFocus = m;
          applyMode();
        } else {
          wrap.innerHTML = '<div class="ap-err">加载失败：'+(j && j.error ? esc(j.error) : "未知错误")+'</div>';
        }
      }).catch(function(e){
        wrap.innerHTML = '<div class="ap-err">加载失败：'+esc(String(e))+'</div>';
      });
    }

    // 「+ 添加时段」：追加一行空白时段并直接进入该行编辑态（行内编辑，不再锁全表）
    addBtn.addEventListener("click", function(){
      if(!state.editable) return;
      state.periods.push({start:"", end:"", name:"", orders:0, weight:100,
                          period_duration_h:null, effective_online_req_h:0, _new:true});
      state.editRow = state.periods.length - 1; renderTable();
    });

    saveBtn.addEventListener("click", function(){
      if(!state.editable || !state.dirty) return;
      var periods = state.periods.filter(function(p){
        return !(p.name === "" && p.start === "" && p.end === "");
      }).map(function(p){ var x=Object.assign({},p); delete x._new; return x; });
      if(periods.length === 0){
        footHint.textContent = "✗ 请至少保留一个有效时段"; footHint.className = "ap-month-hint err";
        return;
      }
      saveBtn.disabled = true; footHint.textContent = "保存中…"; footHint.className = "ap-month-hint";
      api("/api/attend-period/config", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({month: state.month, periods: periods})
      }).then(function(r){
        saveBtn.disabled = false;
        if(r && r.ok){
          state.periods = (Array.isArray(r.periods) ? r.periods : periods).map(function(p){ var x=Object.assign({},p); x._new=false; return x; });
          state.editable = !!r.editable;
          state.dirty = false; applyMode();
          footHint.textContent = "✓ 已保存"; footHint.className = "ap-month-hint ok";
        } else {
          footHint.textContent = "✗ 保存失败："+((r && r.error) || "未知错误"); footHint.className = "ap-month-hint err";
        }
      }).catch(function(e){
        saveBtn.disabled = false;
        footHint.textContent = "✗ 保存失败："+esc(String(e)); footHint.className = "ap-month-hint err";
      });
    });

    mpPrev.addEventListener("click", function(){ mpFocus = shiftMonth(mpFocus, -1); renderPopup(); });
    mpNext.addEventListener("click", function(){ mpFocus = shiftMonth(mpFocus, 1); renderPopup(); });
    mpGrid.addEventListener("click", function(e){
      var cell = e.target.closest ? e.target.closest(".ap-mp-cell") : null; if(!cell) return;
      var m = cell.getAttribute("data-m"); closePopup();
      if(m && m !== state.month) loadMonth(m); else mpFocus = m;
    });
    trigger.addEventListener("click", function(e){
      e.stopPropagation();
      if(popup.style.display === "block") closePopup(); else openPopup();
    });
    if(!window.__apMonthDocClick){
      window.__apMonthDocClick = function(e){
        var pp = document.getElementById("apMonthPopup");
        var tg = document.getElementById("apMonthTrigger");
        if(pp && pp.style.display === "block" && !pp.contains(e.target) && e.target !== tg && !(tg && tg.contains(e.target)))
          pp.style.display = "none";
      };
      document.addEventListener("click", window.__apMonthDocClick);
    }

    // 初始化：先拉月份列表填充下拉，再载入当前月
    api("/api/attend-period/months").then(function(j){
      if(j && Array.isArray(j.months) && j.months.length){
        loadMonth(j.current || j.months[0]);
      } else {
        api("/api/attend-period/config").then(function(c){
          if(c && c.month) loadMonth(c.month);
        }).catch(function(e){
          wrap.innerHTML = '<div class="ap-err">加载失败：'+esc(String(e))+'</div>';
        });
      }
    }).catch(function(e){
      wrap.innerHTML = '<div class="ap-err">月份列表加载失败：'+esc(String(e))+'</div>';
    });
  }

