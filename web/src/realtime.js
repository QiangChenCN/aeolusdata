// realtime.js —— 数据看板 → 二级菜单「实时数据」
// 两个标签页：
//   · 实时数据：按「系统设置」所选站点展示运营概览卡片（达成率/出勤/达标等），每 30s 轮询刷新。
//   · 系统设置：站点多选（列表来自 /api/teams，后端已按当前用户过滤），所选存后端按账号同步。
// 数据权限（纵深防御，三层）：
//   1) 站点列表 /api/teams 后端按 allowed_team_ids 过滤，前端只看到有权限的站；
//   2) 保存所选站点时后端越权站点不落库；
//   3) 拉取概览时每个站点请求经 _enforce_team_scope 校验，越权返回 403 前端不显示。
import { api } from "./api.js";
import { esc, toast } from "./ui.js";
import "./realtime.css";

var _tab = "data";       // "data" | "settings"
var _pollTimer = null;   // 实时数据轮询句柄
var _teams = [];         // 可见站点 [{id,name}]（来自 /api/teams）
var _selected = [];      // 当前用户所选站点 id（来自后端 /api/realtime/selection）
var _loaded = false;     // 是否已加载过站点清单 + 已选（仅首次）

export function renderRealtimeView(host){
  if(_pollTimer){ clearInterval(_pollTimer); _pollTimer = null; }   // 进入本视图先清旧轮询
  host.innerHTML = "";
  var root = document.createElement("div");
  root.id = "rtRoot";
  root.className = "rt-view";
  root.innerHTML =
    '<div class="rt-tabs">' +
      '<button class="rt-tab" data-tab="data">实时数据</button>' +
      '<button class="rt-tab" data-tab="settings">系统设置</button>' +
    '</div>' +
    '<div class="rt-body" id="rtBody"></div>';
  host.appendChild(root);

  root.querySelectorAll(".rt-tab").forEach(function(b){
    b.onclick = function(){
      _tab = b.getAttribute("data-tab");
      root.querySelectorAll(".rt-tab").forEach(function(x){
        x.classList.toggle("on", x.getAttribute("data-tab") === _tab);
      });
      renderBody();
    };
  });

  if(!_loaded){ loadTeamsAndSelection(); _loaded = true; }
  root.querySelectorAll(".rt-tab").forEach(function(x){
    x.classList.toggle("on", x.getAttribute("data-tab") === _tab);
  });
  renderBody();
}

/* 切 tab 时停止轮询；离开实时数据视图由 renderRealtimeView 入口统一清理 */
function renderBody(){
  var body = document.getElementById("rtBody");
  if(!body) return;
  if(_pollTimer){ clearInterval(_pollTimer); _pollTimer = null; }
  if(_tab === "settings") renderSettings(body);
  else renderData(body);
}

/* 首次进入加载站点清单 + 已选（只拉一次，切 tab 不重复） */
function loadTeamsAndSelection(){
  Promise.all([
    api("/api/teams").catch(function(){ return {teams:[]}; }),
    api("/api/realtime/selection").catch(function(){ return {teams:[]}; })
  ]).then(function(res){
    _teams = (res[0] && res[0].teams) || [];
    _selected = (res[1] && res[1].teams) || [];
    var body = document.getElementById("rtBody");
    if(!body) return;
    if(_tab === "settings") renderSettings(body);
    else renderData(body);
  });
}

/* ---- 系统设置：站点多选 + 保存 ---- */
function renderSettings(body){
  body.innerHTML =
    '<div class="rt-set-hint">选择要查看实时数据的站点（仅显示你有权限的站点）：</div>' +
    '<div class="rt-team-grid" id="rtTeamGrid"></div>' +
    '<div class="rt-actions">' +
      '<button class="rt-save" id="rtSave">保存所选站点</button>' +
      '<span class="rt-save-msg" id="rtSaveMsg"></span>' +
    '</div>';
  var grid = body.querySelector("#rtTeamGrid");
  if(!_teams.length){
    grid.innerHTML = '<div class="rt-loading">加载站点列表中…</div>';
  } else {
    paintTeamGrid(grid);
  }
  var saveBtn = body.querySelector("#rtSave");
  saveBtn.onclick = function(){
    var sel = Array.prototype.slice.call(grid.querySelectorAll("input:checked"))
      .map(function(i){ return i.value; });
    saveBtn.disabled = true;
    api("/api/realtime/selection", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ teams: sel })
    }).then(function(j){
      saveBtn.disabled = false;
      var msg = body.querySelector("#rtSaveMsg");
      if(j && j.ok){ _selected = sel; msg.textContent = "已保存（" + sel.length + " 个站点）"; toast("已保存所选站点"); }
      else { msg.textContent = (j && j.error) ? j.error : "保存失败"; }
    }).catch(function(e){
      saveBtn.disabled = false;
      body.querySelector("#rtSaveMsg").textContent = "保存失败：" + e.message;
    });
  };
}

function paintTeamGrid(grid){
  grid.innerHTML = "";
  _teams.forEach(function(t){
    var id = String(t.id != null ? t.id : t);
    var name = (t.name != null ? t.name : t);
    var label = document.createElement("label");
    label.className = "rt-team-item";
    label.innerHTML = '<input type="checkbox" value="' + esc(id) + '"' +
      (_selected.indexOf(id) >= 0 ? " checked" : "") + '/> <span>' + esc(name) + '</span>';
    grid.appendChild(label);
  });
}

/* ---- 实时数据：按所选站点展示概览卡片 ---- */
function renderData(body){
  body.innerHTML = '<div class="rt-grid" id="rtDataGrid"></div>';
  loadOverview(body);
  // 每 30s 重读最新落盘数据（用户在「标准达成」点「刷新数据」后，本页自动更新）
  _pollTimer = setInterval(function(){
    var root = document.getElementById("rtRoot");
    if(!root){ if(_pollTimer){ clearInterval(_pollTimer); _pollTimer = null; } return; }
    if(_tab === "data") loadOverview(document.getElementById("rtBody"));
  }, 30000);
}

function loadOverview(body){
  var grid = body.querySelector("#rtDataGrid");
  if(!grid) return;
  if(!_selected.length){
    grid.innerHTML = '<div class="rt-empty">尚未选择站点。请到「系统设置」选择要查看的站点。</div>';
    return;
  }
  grid.innerHTML = '<div class="rt-loading">加载实时数据…</div>';
  // 逐站请求单站 station-report（不受「参与站点配置」限制；越权站 403 由前端忽略）
  Promise.all(_selected.map(function(tid){
    return api("/api/standard/station-report?team=" + encodeURIComponent(tid))
      .then(function(j){
        if(!j || !j.ok) return { team_id: tid, team_name: j && j.teamName, no_data: true };
        var rows = j.rows || [];
        if(rows.length) return rows[0];
        return { team_id: tid, team_name: j.teamName, no_data: true };
      })
      .catch(function(){ return { team_id: tid, no_data: true }; });
  })).then(function(rows){
    paintCards(grid, rows);
  });
}

function paintCards(grid, rows){
  if(!rows.length){
    grid.innerHTML = '<div class="rt-empty">所选站点暂无数据。</div>';
    return;
  }
  grid.innerHTML = "";
  rows.forEach(function(r){
    var card = document.createElement("div");
    card.className = "rt-card";
    var name = r.team_name || r.team_id;
    if(r.no_data || r.need_refresh || r.data_status === "no_data" || r.scale_target == null){
      card.innerHTML = '<div class="rt-card-h">' + esc(name) + '</div>' +
        '<div class="rt-empty" style="padding:8px 0">该站暂无数据，请先在「标准达成」点「刷新数据」</div>';
      grid.appendChild(card);
      return;
    }
    var rate = (r.achieved_rate != null) ? (r.achieved_rate.toFixed(1) + "%") : "—";
    var attended = (r.attended_num != null) ? r.attended_num
                 : (r.rider_with_order != null ? r.rider_with_order : "—");
    card.innerHTML =
      '<div class="rt-card-h">' + esc(name) + '</div>' +
      rtRow("规模目标", r.scale_target) +
      rtRow("实际出勤", attended) +
      rtRow("达标人数", r.achieved_num) +
      rtRow("达成率", rate, "rt-rate") +
      rtRow("未达标", r.unachieved_num) +
      rtRow("预计可达标", r.expected_achievable_num);
    grid.appendChild(card);
  });
}

function rtRow(label, val, cls){
  var v = (val == null || val === "") ? "—" : val;
  return '<div class="rt-card-row"><span>' + esc(label) + '</span><b' +
    (cls ? ' class="' + cls + '"' : '') + '>' + esc(v) + '</b></div>';
}
