// admin.js —— 系统设置控制台（RBAC 前端配置模块）
// 四个分区：个人(改密) / 账号管理 / 角色权限 / 密码策略。
// 交互形式：分区用顶部标签页切换；列表+行内操作（编辑/重置密码/删除/启用禁用）；
// 新增/编辑用模态弹窗（表单）；删除用全局确认弹窗；数据校验前端+后端双重把关。
// 权限控制：导航入口仅管理员可见；账号/角色/策略三区前端对非管理员隐藏，
//          且服务端对每个接口按角色权限点二次校验（纵深防御）。
import "./admin.css";
import { store } from "./store.js";
import { TK } from "./tokens.js";
import { api, getSessionUser } from "./api.js";
import { svg, esc, hexA, toast, viewHead, emptyHtml } from "./ui.js";
import { askConfirm } from "./behavior.js";

const state = store.state;

// 模块级视图状态（viewHost 整段重建时保持当前标签）
var _tab = "profile";
var _users = [], _roles = [], _catalog = [], _allPerms = [], _policy = {};
var _dataPerms = { users: [], rules: {}, all_teams: [] };

function me(){ return getSessionUser() || {}; }
function isAdmin(){ return me().role === "admin"; }
function roleLabel(name){
  return name === "admin" ? "管理员"
       : name === "operator" ? "运营"
       : name === "viewer" ? "只读" : name;
}
function roleColor(name){
  return name === "admin" ? TK.err : name === "operator" ? TK.info : TK.neutral;
}

/* ================= 渲染入口 ================= */
export function renderAdminView(host){
  host.innerHTML = "";
  var admin = isAdmin();
  // 个人页右上角：锚点按钮 —— 平滑滚动并聚焦到改密表单
  var jumpHtml = (_tab === "profile")
    ? '<button class="am-btn am-pri" id="pwJump" type="button">' + svg("pencil", "ic ic-sm") + '<span>立即修改</span></button>'
    : "";
  var head = viewHead("系统设置", admin ? "账号 · 角色权限 · 密码策略"
                              : "修改登录密码", "shield-alert", TK.err, jumpHtml);
  host.appendChild(head);
  if(_tab === "profile"){
    var jb = head.querySelector("#pwJump");
    if(jb) jb.onclick = function(){
      var el = document.getElementById("pwOld");
      if(!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(function(){ try{ el.focus(); }catch(e){} }, 250);
    };
  }

  // 标签页
  var tabs = [["profile", "个人", "key"]];
  if(admin){
    tabs.push(["accounts", "账号管理", "users"]);
    tabs.push(["roles", "角色权限", "shield"]);
    tabs.push(["policy", "密码策略", "sliders"]);
    tabs.push(["dataperm", "数据权限", "layers"]);
  }
  var bar = document.createElement("div");
  bar.className = "am-tabs";
  tabs.forEach(function(t){
    var b = document.createElement("button");
    b.className = "am-tab" + (_tab === t[0] ? " on" : "");
    b.innerHTML = svg(t[2], "ic ic-sm") + "<span>" + esc(t[1]) + "</span>";
    b.onclick = function(){ _tab = t[0]; renderAdminView(host); };
    bar.appendChild(b);
  });
  host.appendChild(bar);

  var body = document.createElement("div");
  body.className = "am-body";
  body.id = "amBody";
  host.appendChild(body);

  loadAll(body);
}

function loadAll(body){
  if(isAdmin()){
    // 用 allSettled：单个接口失败（如旧版后端缺 /api/data-perms）不应拖垮其他管理面板
    Promise.allSettled([ api("/api/admin/users"), api("/api/admin/roles"), api("/api/policy"), api("/api/data-perms") ])
      .then(function(r){
        if(r[0].status === "fulfilled") _users = (r[0].value && r[0].value.users) || [];
        if(r[1].status === "fulfilled"){
          _roles = (r[1].value && r[1].value.roles) || [];
          _catalog = (r[1].value && r[1].value.catalog) || [];
          _allPerms = (r[1].value && r[1].value.all_perms) || [];
        }
        if(r[2].status === "fulfilled") _policy = (r[2].value && r[2].value.policy) || {};
        if(r[3].status === "fulfilled") _dataPerms = (r[3].value) || { users: [], rules: {}, all_teams: [] };
        else toast("数据权限接口暂不可用（后端需为最新版）");
        _renderTab(body);
      });
  } else {
    api("/api/policy").then(function(r){ _policy = (r && r.policy) || {}; })
      .catch(function(){})
      .then(function(){ _renderTab(body); });
  }
}

function _renderTab(body){
  body = body || document.getElementById("amBody");
  if(!body) return;
  body.innerHTML = "";
  if(_tab === "profile")  _renderProfile(body);
  else if(_tab === "accounts") _renderAccounts(body);
  else if(_tab === "roles")   _renderRoles(body);
  else if(_tab === "policy")  _renderPolicy(body);
  else if(_tab === "dataperm") _renderDataPerm(body);
}

/* ================= 通用：模态弹窗 ================= */
function openModal(title, bodyHtml, onMount, okText){
  var mask = document.createElement("div");
  mask.className = "am-mask";
  mask.innerHTML = '<div class="am-modal" role="dialog" aria-modal="true">'
    + '<div class="am-mhd"><b>' + esc(title) + '</b>'
    + '<button class="am-x" type="button" aria-label="关闭">' + svg("close") + '</button></div>'
    + '<div class="am-mbd">' + bodyHtml + '</div>'
    + '<div class="am-mft"><button class="am-btn am-ghost" type="button" data-act="cancel">取消</button>'
    + '<button class="am-btn am-pri" type="button" data-act="ok">' + esc(okText || "保存") + '</button></div>'
    + '</div>';
  document.body.appendChild(mask);
  var api = {
    close: function(){ mask.remove(); document.removeEventListener("keydown", onKey); },
    okBtn: mask.querySelector('[data-act="ok"]'),
    mbd: mask.querySelector(".am-mbd"),
    err: function(msg){ var e = mask.querySelector(".am-err"); if(e){ e.textContent = msg || ""; e.style.display = msg ? "" : "none"; } }
  };
  function onKey(e){ if(e.key === "Escape") api.close(); }
  document.addEventListener("keydown", onKey);
  mask.addEventListener("click", function(e){ if(e.target === mask) api.close(); });
  mask.querySelector(".am-x").onclick = api.close;
  mask.querySelector('[data-act="cancel"]').onclick = api.close;
  if(onMount) onMount(api);
  var fi = api.mbd.querySelector("input,select,textarea");
  if(fi) setTimeout(function(){ fi.focus(); }, 30);
  return api;
}

function field(label, controlHtml, hint){
  return '<label class="am-f"><span class="am-fl">' + esc(label) + '</span>'
    + '<span class="am-fc">' + controlHtml
    + (hint ? '<span class="am-fh">' + esc(hint) + '</span>' : '') + '</span></label>';
}

/* 竖排字段（标签在上、控件占满）——用于窄栏分组卡，避免右侧留白 */
function fieldV(label, controlHtml, hint){
  return '<div class="am-fv"><span class="am-fl">' + esc(label) + '</span>'
    + controlHtml + (hint ? '<span class="am-fh">' + esc(hint) + '</span>' : '') + '</div>';
}

/* 分组卡（标题 + 内容） */
function gcard(title, inner){
  return '<div class="am-gcard"><div class="am-gcard-h">' + esc(title) + '</div>'
    + '<div class="am-gcard-b">' + inner + '</div></div>';
}

/* 卡片分区头：图标 + 标题 + 描述 */
function cardHead(icon, title, sub){
  return '<div class="am-chd"><span class="am-chd-ic">' + svg(icon, "ic") + '</span>'
    + '<div class="am-chd-tx"><div class="am-chd-t">' + esc(title) + '</div>'
    + (sub ? '<div class="am-chd-s">' + esc(sub) + '</div>' : '') + '</div></div>';
}

/* 布尔设置项：开关行（替代裸复选框更符合设置页惯例） */
function swRow(text, id, on, hint){
  return '<div class="am-swrow"><span class="am-swrow-tx"><span class="am-swrow-t">' + esc(text) + '</span>'
    + (hint ? '<span class="am-swrow-h">' + esc(hint) + '</span>' : '') + '</span>'
    + '<label class="am-sw"><input type="checkbox" id="' + id + '"' + (on ? " checked" : "") + '>'
    + '<span class="am-sw-tr"><span class="am-sw-kn"></span></span></label></div>';
}

/* 首字母头像 */
function avatar(username, color){
  return '<span class="am-avatar" style="background:' + color + '">' + esc((username || "?").slice(0, 1)) + '</span>';
}

/* ================= 分区一：个人（改密） ================= */
function _renderProfile(body){
  var p = _policy || {};
  var minLen = p.min_length || 8;
  var u = me();

  // 简要密码要求（新密码框激活时以浮层展示）
  var comp = [];
  if(p.require_upper) comp.push("大写");
  if(p.require_lower) comp.push("小写");
  if(p.require_digit) comp.push("数字");
  if(p.require_symbol) comp.push("符号");
  var brief = [];
  brief.push("长度需 " + minLen + "–" + (p.max_length || 64) + " 位");
  brief.push(comp.length ? ("须包含 " + comp.join("、")) : "不限制大小写、数字、符号");
  if(p.prevent_reuse) brief.push("不得复用最近 " + p.prevent_reuse + " 次旧密码");
  if(p.breach_check) brief.push("不得使用常见泄露口令");
  if(p.max_age_days) brief.push("每 " + p.max_age_days + " 天需更换");

  var box = document.createElement("div");
  box.className = "am-card";
  box.innerHTML = cardHead("key", "个人", "账号信息与登录密码")
    + '<div class="am-pcols">'
    + '<div class="am-gcard"><div class="am-gcard-h">修改登录密码</div><div class="am-gcard-b">'
    + fieldV("原密码", '<input id="pwOld" type="password" class="am-in" autocomplete="current-password">')
    + '<div class="am-fv am-pwd"><span class="am-fl">新密码</span>'
    + '<input id="pwNew" type="password" class="am-in" autocomplete="new-password">'
    + '<span class="am-fh">至少 ' + minLen + ' 位</span>'
    + '<div class="am-pwd-pop" role="tooltip"><div class="am-pwd-pop-h">密码要求</div>'
    + '<ul>' + brief.map(function(t){ return '<li>' + esc(t) + '</li>'; }).join("") + '</ul></div></div>'
    + fieldV("确认新密码", '<input id="pwNew2" type="password" class="am-in" autocomplete="new-password">')
    + '<div class="am-err" style="display:none"></div>'
    + '<div class="am-row"><button id="pwSave" class="am-btn am-pri">保存新密码</button></div>'
    + '</div></div>'
    + gcard("账号信息",
        '<div class="am-kvrow"><span class="am-kv-k">当前账号</span><span class="am-kv-v">' + esc(u.user || "—") + '</span></div>'
        + '<div class="am-kvrow"><span class="am-kv-k">角色</span><span class="am-kv-v">' + esc(roleLabel(u.role)) + '</span></div>'
        + '<div class="am-kvrow"><span class="am-kv-k">密码最短长度</span><span class="am-kv-v">' + minLen + ' 位</span></div>')
    + '</div>';
  body.appendChild(box);

  // 新密码框激活（聚焦）时弹出简要要求，失焦 / Esc 收起
  var pwdWrap = box.querySelector(".am-pwd");
  var pwdInp = box.querySelector("#pwNew");
  if(pwdWrap && pwdInp){
    pwdInp.addEventListener("focus", function(){ pwdWrap.classList.add("am-open"); });
    pwdInp.addEventListener("blur", function(){ pwdWrap.classList.remove("am-open"); });
    pwdInp.addEventListener("keydown", function(e){ if(e.key === "Escape") pwdWrap.classList.remove("am-open"); });
  }

  box.querySelector("#pwSave").onclick = function(){
    var oldP = box.querySelector("#pwOld").value;
    var newP = box.querySelector("#pwNew").value;
    var newP2 = box.querySelector("#pwNew2").value;
    var err = box.querySelector(".am-err");
    if(!oldP || !newP){ err.textContent = "请填写原密码与新密码"; err.style.display = ""; return; }
    if(newP.length < minLen){ err.textContent = "新密码至少 " + minLen + " 位"; err.style.display = ""; return; }
    if(newP !== newP2){ err.textContent = "两次输入的新密码不一致"; err.style.display = ""; return; }
    err.style.display = "none";
    var btn = this; btn.disabled = true; btn.textContent = "保存中…";
    api("/api/account/change-pw", { method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ old_password: oldP, new_password: newP }) })
      .then(function(r){
        if(r && r.ok){ toast("密码已修改"); box.querySelector("#pwOld").value=""; box.querySelector("#pwNew").value=""; box.querySelector("#pwNew2").value=""; }
        else { err.textContent = (r && r.error) || "修改失败"; err.style.display = ""; }
      })
      .catch(function(){ err.textContent = "网络错误，请重试"; err.style.display = ""; })
      .then(function(){ btn.disabled = false; btn.textContent = "保存新密码"; });
  };
}

/* ================= 分区二：账号管理 ================= */
function _renderAccounts(body){
  var box = document.createElement("div");
  box.className = "am-card";
  var head = document.createElement("div");
  head.className = "am-ch";
  head.innerHTML = cardHead("users", "账号列表", "共 " + _users.length + " 个账号 · 可改角色 / 重置密码 / 禁用");
  var add = document.createElement("button");
  add.className = "am-btn am-pri"; add.innerHTML = svg("plus","ic ic-sm") + "<span>新增账号</span>";
  add.onclick = openAddUser;
  head.appendChild(add);
  box.appendChild(head);

  if(!_users.length){
    box.insertAdjacentHTML("beforeend", emptyHtml("inbox", "暂无账号，点击右上角「新增账号」创建"));
    body.appendChild(box);
    return;
  }

  var wrap = document.createElement("div");
  wrap.className = "am-tblwrap";
  var table = document.createElement("table");
  table.className = "am-tbl";
  table.innerHTML = '<thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>创建时间</th><th class="am-ta-r">操作</th></tr></thead>';
  var tb = document.createElement("tbody");
  _users.forEach(function(u){
    var tr = document.createElement("tr");
    var st = u.disabled ? '<span class="am-b b-warn">已禁用</span>'
            : u.locked ? '<span class="am-b b-err">已锁定</span>'
            : '<span class="am-b b-ok">正常</span>';
    var roled = '<span class="am-role" style="background:' + hexA(roleColor(u.role), .14) + ';color:' + roleColor(u.role) + '">' + esc(roleLabel(u.role)) + '</span>';
    tr.innerHTML = '<td><span class="am-user">' + avatar(u.username, roleColor(u.role))
      + '<span class="am-user-n">' + esc(u.username) + '</span>'
      + (u.must_change ? ' <span class="am-b b-warn" title="建议尽快修改密码">待改密</span>' : '') + '</span></td>'
      + '<td>' + roled + '</td><td>' + st + '</td>'
      + '<td>' + esc(u.created_at || "—") + '</td>';
    var ops = document.createElement("td");
    ops.className = "am-ta-r am-ops";
    var bEdit = mkBtn("编辑", "am-ghost", function(){ openEditUser(u); });
    var bPw = mkBtn("重置密码", "am-ghost", function(){ openResetPw(u); });
    var bDel = mkBtn("删除", "am-danger", function(){ confirmDeleteUser(u); });
    ops.appendChild(bEdit); ops.appendChild(bPw); ops.appendChild(bDel);
    tr.appendChild(ops);
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  wrap.appendChild(table);
  box.appendChild(wrap);
  body.appendChild(box);
}

function mkBtn(txt, cls, fn){
  var b = document.createElement("button");
  b.className = "am-btn " + cls; b.textContent = txt;
  b.onclick = fn; return b;
}

function roleOptionsHtml(sel){
  return _roles.map(function(r){
    return '<option value="' + esc(r.name) + '"' + (r.name === sel ? " selected" : "") + '>' + esc(roleLabel(r.name)) + '</option>';
  }).join("");
}

function openAddUser(){
  var m = openModal("新增账号",
    field("用户名", '<input id="uName" class="am-in" maxlength="32" placeholder="不含空格与 / \\">')
    + field("角色", '<select id="uRole" class="am-in">' + roleOptionsHtml("viewer") + '</select>')
    + field("密码", '<input id="uPw" type="password" class="am-in" autocomplete="new-password">', "至少 " + ((_policy&&_policy.min_length)||8) + " 位")
    + field("确认密码", '<input id="uPw2" type="password" class="am-in" autocomplete="new-password">')
    + '<div class="am-err" style="display:none"></div>',
    function(modal){
      modal.okBtn.onclick = function(){
        var name = modal.mbd.querySelector("#uName").value.trim();
        var role = modal.mbd.querySelector("#uRole").value;
        var pw = modal.mbd.querySelector("#uPw").value;
        var pw2 = modal.mbd.querySelector("#uPw2").value;
        if(!name){ return modal.err("用户名不能为空"); }
        if(pw.length < ((_policy&&_policy.min_length)||8)) return modal.err("密码至少 " + ((_policy&&_policy.min_length)||8) + " 位");
        if(pw !== pw2) return modal.err("两次密码不一致");
        modal.okBtn.disabled = true;
        api("/api/admin/user", { method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ username:name, password:pw, role:role }) })
          .then(function(r){
            if(r && r.ok){ toast("已创建账号：" + name); modal.close(); reload(); }
            else modal.err((r && r.error) || "创建失败");
          })
          .catch(function(){ modal.err("网络错误"); })
          .then(function(){ modal.okBtn.disabled = false; });
      };
    });
}

function openEditUser(u){
  var m = openModal("编辑账号 · " + u.username,
    field("角色", '<select id="uRole" class="am-in">' + roleOptionsHtml(u.role) + '</select>')
    + field("账号状态", '<label class="am-chk"><input id="uEn" type="checkbox" ' + (u.disabled ? "" : "checked") + '> 启用（取消勾选即禁用该账号）</label>')
    + '<div class="am-err" style="display:none"></div>',
    function(modal){
      modal.okBtn.onclick = function(){
        var role = modal.mbd.querySelector("#uRole").value;
        var disabled = !modal.mbd.querySelector("#uEn").checked;
        modal.okBtn.disabled = true;
        api("/api/admin/user/update", { method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ username:u.username, role:role, disabled:disabled }) })
          .then(function(r){
            if(r && r.ok){ toast("已保存"); modal.close(); reload(); }
            else modal.err((r && r.error) || "保存失败");
          })
          .catch(function(){ modal.err("网络错误"); })
          .then(function(){ modal.okBtn.disabled = false; });
      };
    });
}

function openResetPw(u){
  var m = openModal("重置密码 · " + u.username,
    '<p class="am-tip">管理员代重置，无需原密码。该用户下次登录将使用新密码。</p>'
    + field("新密码", '<input id="rPw" type="password" class="am-in" autocomplete="new-password">', "至少 " + ((_policy&&_policy.min_length)||8) + " 位")
    + field("确认新密码", '<input id="rPw2" type="password" class="am-in" autocomplete="new-password">')
    + '<div class="am-err" style="display:none"></div>',
    function(modal){
      modal.okBtn.onclick = function(){
        var pw = modal.mbd.querySelector("#rPw").value;
        var pw2 = modal.mbd.querySelector("#rPw2").value;
        if(pw.length < ((_policy&&_policy.min_length)||8)) return modal.err("密码至少 " + ((_policy&&_policy.min_length)||8) + " 位");
        if(pw !== pw2) return modal.err("两次密码不一致");
        modal.okBtn.disabled = true;
        api("/api/admin/user/reset-pw", { method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ username:u.username, password:pw }) })
          .then(function(r){
            if(r && r.ok){ toast("密码已重置"); modal.close(); reload(); }
            else modal.err((r && r.error) || "重置失败");
          })
          .catch(function(){ modal.err("网络错误"); })
          .then(function(){ modal.okBtn.disabled = false; });
      };
    });
}

function confirmDeleteUser(u){
  askConfirm("删除账号", "确认删除用户「" + u.username + "」？删除后该账号立即失去登录权限。",
    "此操作不可撤销。", function(){
      api("/api/admin/user/delete", { method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ username:u.username }) })
        .then(function(r){
          if(r && r.ok) toast("已删除账号：" + u.username);
          else toast((r && r.error) || "删除失败");
          reload();
        })
        .catch(function(){ toast("网络错误"); });
    });
}

/* ================= 分区三：角色权限 ================= */
function _renderRoles(body){
  var box = document.createElement("div");
  box.className = "am-card";
  var head = document.createElement("div");
  head.className = "am-ch";
  head.innerHTML = cardHead("shield", "角色与权限", "选择左侧角色进行权限分配；权限可多层继承，内置管理员锁定不可编辑");
  var add = document.createElement("button");
  add.className = "am-btn am-pri"; add.innerHTML = svg("plus","ic ic-sm") + "<span>新建角色</span>";
  add.onclick = openNewRole;
  head.appendChild(add);
  box.appendChild(head);

  if(!_roles.length){
    box.insertAdjacentHTML("beforeend", emptyHtml("shield", "暂无角色"));
    body.appendChild(box);
    return;
  }

  var wrap = document.createElement("div");
  wrap.className = "am-roles";
  var list = document.createElement("div");
  list.className = "am-role-list";
  _roles.forEach(function(r){
    var card = document.createElement("button");
    card.className = "am-role-card" + (_selRole === r.name ? " on" : "");
    var permTxt = r.all ? "全部权限（内置）" : (r.perms.length + " 项有效权限" + (r.parents && r.parents.length ? "（含继承）" : ""));
    card.innerHTML = '<div class="am-rc-n">' + esc(roleLabel(r.name)) + (r.builtin ? ' <span class="am-b b-neutral">内置</span>' : '') + '</div>'
      + '<div class="am-rc-d">' + esc(permTxt) + '</div>'
      + (r.parents && r.parents.length ? '<div class="am-rc-p">继承：' + r.parents.map(roleLabel).map(esc).join("、") + '</div>' : '');
    card.onclick = function(){ _selRole = r.name; _renderTab(); };
    list.appendChild(card);
  });
  wrap.appendChild(list);

  var editor = document.createElement("div");
  editor.className = "am-role-editor";
  wrap.appendChild(editor);
  box.appendChild(wrap);
  body.appendChild(box);

  _renderRoleEditor(editor);
}

var _selRole = null;
function _currentRole(){ return _roles.filter(function(r){ return r.name === _selRole; })[0] || _roles[0]; }

function _renderRoleEditor(editor){
  var r = _currentRole();
  if(!r){ editor.innerHTML = '<p class="am-tip">暂无角色</p>'; return; }
  editor.innerHTML = "";

  if(r.all && r.locked){
    editor.innerHTML = '<div class="am-h4">' + esc(roleLabel(r.name)) + '（内置管理员）</div>'
      + '<p class="am-tip">该角色拥有全部权限，已锁定不可编辑。其它角色可继承它以获得全部权限。</p>';
    return;
  }

  var h = document.createElement("div");
  h.className = "am-h4";
  h.innerHTML = esc(roleLabel(r.name)) + (r.builtin ? ' <span class="am-b b-neutral">内置</span>' : ' <span class="am-b b-neutral">自定义</span>');
  editor.appendChild(h);

  // 继承父角色
  var parentsWrap = document.createElement("div");
  parentsWrap.className = "am-sub";
  parentsWrap.innerHTML = '<div class="am-sub-t">继承父角色（自动获得其父角色的权限，可多层）</div>';
  var others = _roles.filter(function(x){ return x.name !== r.name; });
  others.forEach(function(o){
    var lab = document.createElement("label");
    lab.className = "am-chk";
    var cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = o.name; cb.checked = (r.parents || []).indexOf(o.name) >= 0;
    cb.className = "am-parent";
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(" " + roleLabel(o.name)));
    parentsWrap.appendChild(lab);
  });
  editor.appendChild(parentsWrap);

  // 权限分配（按分组复选框）
  var permWrap = document.createElement("div");
  permWrap.className = "am-sub";
  permWrap.innerHTML = '<div class="am-sub-t">权限分配（本角色显式授予，不含继承）</div>';
  var groups = {};
  _catalog.forEach(function(c){ (groups[c.group] = groups[c.group] || []).push(c); });
  Object.keys(groups).forEach(function(g){
    var gdiv = document.createElement("div");
    gdiv.className = "am-pgrp";
    gdiv.innerHTML = '<div class="am-pgrp-t"><span>' + esc(g) + '</span>'
      + '<span class="am-pgrp-acts"><button type="button" data-all="1">全选</button><button type="button" data-none="1">清空</button></span></div>';
    groups[g].forEach(function(c){
      var lab = document.createElement("label");
      lab.className = "am-chk";
      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.value = c.perm; cb.checked = (r.explicit_perms || []).indexOf(c.perm) >= 0;
      cb.className = "am-perm";
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(" " + c.label));
      gdiv.appendChild(lab);
    });
    gdiv.querySelector('[data-all]').onclick = function(){
      gdiv.querySelectorAll(".am-perm").forEach(function(cb){ cb.checked = true; });
    };
    gdiv.querySelector('[data-none]').onclick = function(){
      gdiv.querySelectorAll(".am-perm").forEach(function(cb){ cb.checked = false; });
    };
    permWrap.appendChild(gdiv);
  });
  editor.appendChild(permWrap);

  // 有效权限摘要
  var eff = effectiveClient(r);
  var sum = document.createElement("div");
  sum.className = "am-sub";
  sum.innerHTML = '<div class="am-sub-t">有效权限（显式 + 继承，共 ' + eff.length + ' 项）</div>'
    + '<div class="am-chips">' + eff.map(function(p){ return '<span class="am-chip">' + esc(permLabel(p)) + '</span>'; }).join("") + '</div>';
  editor.appendChild(sum);

  // 操作
  var foot = document.createElement("div");
  foot.className = "am-row";
  var save = mkBtn("保存", "am-pri", function(){ saveRole(r); });
  foot.appendChild(save);
  if(!r.builtin && !r.locked){
    var del = mkBtn("删除角色", "am-danger", function(){ confirmDeleteRole(r); });
    foot.appendChild(del);
  }
  editor.appendChild(foot);
}

function permLabel(p){
  for(var i=0;i<_catalog.length;i++) if(_catalog[i].perm===p) return _catalog[i].label;
  return p;
}
function effectiveClient(r){
  var set = {};
  (r.explicit_perms || []).forEach(function(p){ set[p] = 1; });
  (r.parents || []).forEach(function(par){
    var pr = _roles.filter(function(x){ return x.name === par; })[0];
    if(pr) pr.perms.forEach(function(p){ set[p] = 1; });
  });
  return Object.keys(set);
}

function saveRole(r){
  var editor = document.querySelector(".am-role-editor");
  if(!editor) return;
  var perms = [], parents = [];
  editor.querySelectorAll(".am-perm").forEach(function(cb){ if(cb.checked) perms.push(cb.value); });
  editor.querySelectorAll(".am-parent").forEach(function(cb){ if(cb.checked) parents.push(cb.value); });
  api("/api/admin/role/update", { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ name:r.name, perms:perms, parents:parents }) })
    .then(function(res){
      if(res && res.ok){ toast("角色「" + roleLabel(r.name) + "」已保存"); reload(); }
      else toast((res && res.error) || "保存失败");
    })
    .catch(function(){ toast("网络错误"); });
}

function openNewRole(){
  var m = openModal("新建角色",
    field("角色名", '<input id="nName" class="am-in" maxlength="24" placeholder="不含空格与 / \\">')
    + '<div class="am-err" style="display:none"></div>',
    function(modal){
      modal.okBtn.onclick = function(){
        var name = modal.mbd.querySelector("#nName").value.trim();
        if(!name) return modal.err("角色名不能为空");
        modal.okBtn.disabled = true;
        api("/api/admin/role", { method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ name:name, perms:[], parents:[] }) })
          .then(function(r){
            if(r && r.ok){ toast("已创建角色：" + name); modal.close(); _selRole = name; reload(); }
            else modal.err((r && r.error) || "创建失败");
          })
          .catch(function(){ modal.err("网络错误"); })
          .then(function(){ modal.okBtn.disabled = false; });
      };
    });
}

function confirmDeleteRole(r){
  var children = _roles.filter(function(x){ return (x.parents||[]).indexOf(r.name) >= 0; });
  var inUse = _users.filter(function(u){ return u.role === r.name; }).length;
  if(children.length){ return toast("角色「" + roleLabel(r.name) + "」仍被其它角色继承，无法删除"); }
  if(inUse){ return toast("仍有 " + inUse + " 个账号使用该角色，无法删除"); }
  askConfirm("删除角色", "确认删除角色「" + roleLabel(r.name) + "」？",
    "自定义角色，删除后不可恢复。", function(){
      api("/api/admin/role/delete", { method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ name:r.name }) })
        .then(function(res){
          if(res && res.ok){ toast("已删除角色：" + roleLabel(r.name)); if(_selRole===r.name) _selRole=null; reload(); }
          else toast((res && res.error) || "删除失败");
        })
        .catch(function(){ toast("网络错误"); });
    });
}

/* ================= 分区四：密码策略 ================= */
function _renderPolicy(body){
  var p = _policy || {};
  var box = document.createElement("div");
  box.className = "am-card";
  box.innerHTML = cardHead("sliders", "密码策略", "遵循 NIST SP 800-63B：以长度为主、不强制复杂度、不强制定期改密")
    + '<div class="am-pcols">'
    + '<div class="am-gcard"><div class="am-gcard-h">长度与复杂度</div><div class="am-gcard-b">'
    + '<div class="am-pair">'
    + fieldV("最小长度", '<input id="pMin" type="number" min="1" max="64" class="am-in am-w" value="' + (p.min_length||8) + '">')
    + fieldV("最大长度", '<input id="pMax" type="number" min="1" max="128" class="am-in am-w" value="' + (p.max_length||64) + '">')
    + '</div>'
    + swRow("要求至少一个大写字母", "pUp", p.require_upper, "默认关（符合 NIST）")
    + swRow("要求至少一个小写字母", "pLo", p.require_lower)
    + swRow("要求至少一个数字", "pDi", p.require_digit)
    + swRow("要求至少一个符号", "pSy", p.require_symbol)
    + '</div></div>'
    + '<div class="am-pstack">'
    + gcard("有效期与复用",
        '<div class="am-pair">'
        + fieldV("最长有效期(天)", '<input id="pAge" type="number" min="0" class="am-in am-w" value="' + (p.max_age_days||0) + '">', "0 = 不过期")
        + fieldV("禁止复用最近(次)", '<input id="pReuse" type="number" min="0" max="20" class="am-in am-w" value="' + (p.prevent_reuse||0) + '">', "0 = 不限制")
        + '</div>')
    + gcard("防爆破与体验",
        swRow("拒绝常见泄露口令", "pBreach", p.breach_check, "离线弱口令库")
        + '<div class="am-pair">'
        + fieldV("锁定阈值(次)", '<input id="pAtt" type="number" min="0" class="am-in am-w" value="' + (p.lockout_attempts||5) + '">', "0 = 不锁定")
        + fieldV("锁定时长(分)", '<input id="pLock" type="number" min="1" class="am-in am-w" value="' + (p.lockout_minutes||15) + '">')
        + '</div>'
        + swRow("允许在密码框粘贴", "pPaste", p.allow_paste, "NIST 建议允许"))
    + '</div>'
    + '</div>'
    + '<div class="am-err" style="display:none"></div>'
    + '<div class="am-row"><button id="pSave" class="am-btn am-pri">保存策略</button></div>';
  body.appendChild(box);

  box.querySelector("#pSave").onclick = function(){
    function num(id){ var v = parseInt(box.querySelector(id).value, 10); return isNaN(v) ? 0 : v; }
    var patch = {
      min_length: num("#pMin"), max_length: num("#pMax"),
      require_upper: box.querySelector("#pUp").checked,
      require_lower: box.querySelector("#pLo").checked,
      require_digit: box.querySelector("#pDi").checked,
      require_symbol: box.querySelector("#pSy").checked,
      max_age_days: num("#pAge"), prevent_reuse: num("#pReuse"),
      breach_check: box.querySelector("#pBreach").checked,
      lockout_attempts: num("#pAtt"), lockout_minutes: num("#pLock"),
      allow_paste: box.querySelector("#pPaste").checked,
    };
    var err = box.querySelector(".am-err");
    if(patch.min_length > patch.max_length){ err.textContent = "最小长度不能大于最大长度"; err.style.display = ""; return; }
    err.style.display = "none";
    var btn = this; btn.disabled = true; btn.textContent = "保存中…";
    api("/api/policy", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(patch) })
      .then(function(r){
        if(r && r.ok){ toast("密码策略已保存"); _policy = (r.policy) || _policy; }
        else { err.textContent = (r && r.error) || "保存失败"; err.style.display = ""; }
      })
      .catch(function(){ err.textContent = "网络错误"; err.style.display = ""; })
      .then(function(){ btn.disabled = false; btn.textContent = "保存策略"; });
  };
}

/* ================= 分区五：数据权限（站点隔离） ================= */
function _dpTeamName(id){
  var all = (_dataPerms.all_teams) || [];
  for(var i = 0; i < all.length; i++){
    if(String(all[i].id) === String(id)) return all[i].name || id;
  }
  return id;
}

function _renderDataPerm(body){
  var box = document.createElement("div");
  box.className = "am-card";
  box.innerHTML = cardHead("layers", "数据权限（站点隔离）", "按用户限定可查看的站点，授权可落在「业务线 / 城市 / 站点」任一层级，向下展开到站点")
    + '<p class="am-tip">默认「全部站点」= 不限制；管理员始终可见全部，且不会被锁死。</p>';

  // 组织 / 城市配置卡片
  var orgCard = document.createElement("div");
  orgCard.className = "am-subcard";
  var blCnt = (_dataPerms.business_lines || []).length;
  var cityCnt = (_dataPerms.cities || []).length;
  var ungrpCnt = (_dataPerms.ungrouped || []).length;
  var teamCnt = (_dataPerms.all_teams || []).length;
  var dnsTxt = (_dataPerms.default_new_site === "include") ? "自动纳入" : "不自动纳入（最小权限）";
  var srcTxt = _dataPerms.teams_source === "cache" ? "上次获取的明细（风神暂不可用）"
    : (_dataPerms.teams_source === "none") ? "无（风神未取到且无历史明细）" : "风神";
  orgCard.innerHTML = '<div class="am-subhead"><span>组织 / 业务线 / 城市</span>'
    + '<span class="am-submeta">' + blCnt + ' 个业务线 · ' + cityCnt + ' 个城市 · ' + teamCnt + ' 个站点 · ' + ungrpCnt + ' 个未分组</span></div>'
    + '<p class="am-tip">站点清单来自<b>' + srcTxt + '</b>（自动同步，无需手录）；把城市归入业务线、站点归入城市即可授权。新站点默认策略：<b>' + dnsTxt + '</b>，未归类的新站点会出现在「未分组」等待归类。</p>';
  orgCard.appendChild(mkBtn("编辑组织 / 业务线 / 城市", "am-ghost", openOrgEditor));
  box.appendChild(orgCard);

  if(!(_dataPerms.users || []).length){
    box.insertAdjacentHTML("beforeend", emptyHtml("inbox", "暂无账号"));
    body.appendChild(box);
    return;
  }
  var wrap = document.createElement("div");
  wrap.className = "am-tblwrap";
  var table = document.createElement("table");
  table.className = "am-tbl";
  table.innerHTML = '<thead><tr><th>用户名</th><th>角色</th><th>数据范围</th>'
    + '<th>可见站点</th><th class="am-ta-r">操作</th></tr></thead>';
  var tb = document.createElement("tbody");
  var rules = _dataPerms.rules || {};
  (_dataPerms.users || []).forEach(function(u){
    var rule = rules[u.username] || { scope: "all", teams: [], cities: [], business_lines: [] };
    var sc = rule.scope || "all";
    var scopeCell = sc === "business_lines" ? '<span class="am-b b-info">按业务线</span>'
      : sc === "cities" ? '<span class="am-b b-info">按城市</span>'
      : sc === "teams" ? '<span class="am-b b-info">指定站点</span>'
      : '<span class="am-b b-ok">全部站点</span>';
    var visCell;
    if(sc === "business_lines"){
      visCell = (rule.business_lines || []).join("、") + "（业务线）" || "—";
    } else if(sc === "cities"){
      visCell = (rule.cities || []).join("、") + "（城市）" || "—";
    } else if(sc === "teams"){
      visCell = (rule.teams || []).map(function(t){ return esc(_dpTeamName(t)); }).join("、") || "—";
    } else {
      visCell = "全部";
    }
    var tr = document.createElement("tr");
    tr.innerHTML = '<td><span class="am-user">' + avatar(u.username, roleColor(u.role))
      + '<span class="am-user-n">' + esc(u.username) + '</span></span></td>'
      + '<td>' + esc(roleLabel(u.role)) + '</td>'
      + '<td>' + scopeCell + '</td>'
      + '<td>' + visCell + '</td>';
    var ops = document.createElement("td");
    ops.className = "am-ta-r am-ops";
    ops.appendChild(mkBtn("编辑", "am-ghost", function(){ openEditDataPerm(u, rule); }));
    if(sc !== "all" || (rule.teams && rule.teams.length) || (rule.cities && rule.cities.length)){
      ops.appendChild(mkBtn("重置", "am-danger", function(){ confirmResetDataPerm(u); }));
    }
    tr.appendChild(ops);
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  wrap.appendChild(table);
  box.appendChild(wrap);
  body.appendChild(box);
}

function openEditDataPerm(u, rule){
  var scope = (rule.scope === "business_lines" || rule.scope === "cities" || rule.scope === "teams") ? rule.scope : "all";
  var sel = (rule.teams || []).map(String);
  var citiesSel = (rule.cities || []);
  var blSel = (rule.business_lines || []);
  var inherit = !!rule.inherit_new;
  var teamsHtml = (_dataPerms.all_teams || []).map(function(t){
    var on = sel.indexOf(String(t.id)) >= 0 ? " checked" : "";
    return '<label class="am-chk am-tchk"><input type="checkbox" value="' + esc(t.id) + '"' + on + '> '
      + esc(t.name || t.id) + '</label>';
  }).join("");
  var citiesHtml = (_dataPerms.cities || []).map(function(c){
    var on = citiesSel.indexOf(c) >= 0 ? " checked" : "";
    return '<label class="am-chk am-cchk"><input type="checkbox" value="' + esc(c) + '"' + on + '> '
      + esc(c) + '</label>';
  }).join("");
  var blHtml = (_dataPerms.business_lines || []).map(function(b){
    var on = blSel.indexOf(b) >= 0 ? " checked" : "";
    return '<label class="am-chk am-blchk"><input type="checkbox" value="' + esc(b) + '"' + on + '> '
      + esc(b) + '</label>';
  }).join("");
  var m = openModal("数据权限 · " + u.username,
    '<div class="am-scope">'
    + '<label class="am-radio"><input type="radio" name="dpScope" value="all"' + (scope === "all" ? " checked" : "") + '> 全部站点（不限制）</label>'
    + '<label class="am-radio"><input type="radio" name="dpScope" value="business_lines"' + (scope === "business_lines" ? " checked" : "") + '> 按业务线</label>'
    + '<label class="am-radio"><input type="radio" name="dpScope" value="cities"' + (scope === "cities" ? " checked" : "") + '> 按城市</label>'
    + '<label class="am-radio"><input type="radio" name="dpScope" value="teams"' + (scope === "teams" ? " checked" : "") + '> 指定站点</label>'
    + '</div>'
    + '<div class="am-blgrid am-fld"><div class="am-fldlabel">业务线</div>' + (blHtml || '<span class="am-tip">暂无业务线，请先在「编辑组织 / 业务线 / 城市」中归类</span>') + '</div>'
    + '<div class="am-citygrid am-fld"><div class="am-fldlabel">城市</div>' + (citiesHtml || '<span class="am-tip">暂无城市，请先在「编辑组织 / 业务线 / 城市」中归类</span>') + '</div>'
    + '<div class="am-tgrid am-fld"><div class="am-fldlabel">站点</div>' + (teamsHtml || '<span class="am-tip">无可选站点</span>') + '</div>'
    + '<label class="am-chk am-inherit"><input type="checkbox" id="dpInherit"' + (inherit ? " checked" : "") + '> 新节点自动纳入（选中城市 → 同业务线其他城市；选中站点 → 同城市兄弟站点）</label>'
    + '<p class="am-tip am-dp-hint" style="display:none"></p>'
    + '<div class="am-err" style="display:none"></div>',
    function(modal){
      // 依赖字段联动：按业务线 / 按城市 / 指定站点 三选一，其余组置灰（置灰而非隐藏）
      function sync(){
        var sc = modal.mbd.querySelector('input[name="dpScope"]:checked');
        var scVal = sc ? sc.value : "all";
        var blGrid = modal.mbd.querySelector(".am-blgrid");
        var cityGrid = modal.mbd.querySelector(".am-citygrid");
        var teamGrid = modal.mbd.querySelector(".am-tgrid");
        var hint = modal.mbd.querySelector(".am-dp-hint");
        blGrid.classList.toggle("am-disabled", scVal !== "business_lines");
        blGrid.querySelectorAll("input").forEach(function(c){ c.disabled = scVal !== "business_lines"; });
        cityGrid.classList.toggle("am-disabled", scVal !== "cities");
        cityGrid.querySelectorAll("input").forEach(function(c){ c.disabled = scVal !== "cities"; });
        teamGrid.classList.toggle("am-disabled", scVal !== "teams");
        teamGrid.querySelectorAll("input").forEach(function(c){ c.disabled = scVal !== "teams"; });
        if(scVal === "all"){ hint.textContent = "已选「全部站点」，业务线 / 城市 / 站点勾选已禁用。"; hint.style.display = ""; }
        else if(scVal === "business_lines"){ hint.textContent = "按业务线授权：所选业务线下全部城市与站点（含后续新增）自动可见。"; hint.style.display = ""; }
        else if(scVal === "cities"){ hint.textContent = "按城市授权：所选城市下的全部站点（含后续新增）自动可见。"; hint.style.display = ""; }
        else { hint.style.display = "none"; }
      }
      modal.mbd.querySelectorAll('input[name="dpScope"]').forEach(function(rd){ rd.addEventListener("change", sync); });
      sync();

      modal.okBtn.onclick = function(){
        var sc = modal.mbd.querySelector('input[name="dpScope"]:checked');
        var scVal = sc ? sc.value : "all";
        var teams = [], cities = [], business_lines = [];
        if(scVal === "teams") modal.mbd.querySelectorAll(".am-tgrid input:checked").forEach(function(c){ teams.push(c.value); });
        if(scVal === "cities") modal.mbd.querySelectorAll(".am-citygrid input:checked").forEach(function(c){ cities.push(c.value); });
        if(scVal === "business_lines") modal.mbd.querySelectorAll(".am-blgrid input:checked").forEach(function(c){ business_lines.push(c.value); });
        if(scVal === "business_lines" && !business_lines.length) return modal.err("请至少选择一个业务线");
        if(scVal === "cities" && !cities.length) return modal.err("请至少选择一个城市");
        if(scVal === "teams" && !teams.length) return modal.err("请至少选择一个站点");
        var inherit_new = modal.mbd.querySelector("#dpInherit").checked;
        modal.okBtn.disabled = true;
        api("/api/data-perms", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: u.username, scope: scVal, teams: teams, cities: cities, business_lines: business_lines, inherit_new: inherit_new }) })
          .then(function(r){
            if(r && r.ok){ toast("已保存数据权限"); modal.close(); reload(); }
            else modal.err((r && r.error) || "保存失败");
          })
          .catch(function(){ modal.err("网络错误"); })
          .then(function(){ modal.okBtn.disabled = false; });
      };
    });
}

function openOrgEditor(){
  var allTeams = (_dataPerms.all_teams || []);       // [{id, name}]
  var org = _dataPerms.org || {};                     // {city: [{id, name}]}
  var blOfCity = _dataPerms.bl_of_city || {};         // {city: 业务线 或 ""}
  var bls = (_dataPerms.business_lines || []);        // [业务线名...]
  var dns = (_dataPerms.default_new_site === "include") ? "include" : "exclude";

  function teamChecksHtml(teamIds){
    return allTeams.map(function(t){
      var on = teamIds.indexOf(String(t.id)) >= 0 ? " checked" : "";
      return '<label class="am-chk am-tchk"><input type="checkbox" value="' + esc(t.id) + '"' + on + '> '
        + esc(t.name || t.id) + '</label>';
    }).join("");
  }
  function cityRowHtml(city, teamObjs){
    var teamIds = (teamObjs || []).map(function(t){ return String(t.id); });
    return '<div class="am-orgrow">'
      + '<div class="am-orgrow-h"><input class="am-in am-cityname" value="' + esc(city) + '" placeholder="城市名">'
      + '<button class="am-btn am-danger am-delcity" type="button">删除</button></div>'
      + '<div class="am-tgrid">' + (teamChecksHtml(teamIds) || '<span class="am-tip">无可选站点</span>') + '</div></div>';
  }
  function blBlockHtml(bl, citiesList){
    var cs = citiesList.map(function(c){ return cityRowHtml(c, org[c] || []); }).join("");
    return '<div class="am-blblock">'
      + '<div class="am-bl-h"><input class="am-in am-blname" value="' + esc(bl || "") + '" placeholder="业务线 / 事业部名">'
      + '<button class="am-btn am-danger am-delbl" type="button">删除事业部</button></div>'
      + (cs || '<div class="am-tip">该业务线暂未配置城市</div>')
      + '<button class="am-btn am-ghost am-addcity" type="button">+ 添加城市</button></div>';
  }

  // 初始结构：每个业务线一块；未归属任何业务线的城市放进「未分配事业部」块
  var blocks = bls.map(function(bl){
    var cities = Object.keys(org).filter(function(c){ return (blOfCity[c] || "") === bl; }).map(function(c){ return c; });
    return blBlockHtml(bl, cities);
  });
  var unassigned = Object.keys(org).filter(function(c){ return !(blOfCity[c] || ""); });
  if(unassigned.length){
    blocks.push(blBlockHtml("", unassigned));
  }
  var m = openModal("组织 / 业务线 / 城市配置",
    '<div id="orgBox">' + (blocks.join("") || '<div class="am-tip">尚未配置业务线 / 城市，点击下方「添加事业部」。</div>') + '</div>'
    + '<button class="am-btn am-ghost" id="orgAddBl" type="button">+ 添加事业部</button>'
    + '<div class="am-scope" style="margin-top:10px"><span class="am-fldlabel">新站点默认策略</span>'
    + '<label class="am-radio"><input type="radio" name="dns" value="exclude"' + (dns === "exclude" ? " checked" : "") + '> 不自动纳入（最小权限，需先归类）</label>'
    + '<label class="am-radio"><input type="radio" name="dns" value="include"' + (dns === "include" ? " checked" : "") + '> 自动纳入（新站点对所有受限用户可见）</label>'
    + '</div>'
    + '<div class="am-err" style="display:none"></div>',
    function(modal){
      var box = modal.mbd.querySelector("#orgBox");
      function bindCityRow(row){
        row.querySelector(".am-delcity").onclick = function(){ row.remove(); };
      }
      function appendCity(blk){
        var tmp = document.createElement("div");
        tmp.innerHTML = cityRowHtml("", []);
        var row = tmp.firstChild;
        bindCityRow(row);
        blk.insertBefore(row, blk.querySelector(".am-addcity"));
      }
      function bindBlock(blk){
        blk.querySelector(".am-delbl").onclick = function(){ blk.remove(); };
        blk.querySelector(".am-addcity").onclick = function(){ appendCity(blk); };
      }
      box.querySelectorAll(".am-blblock").forEach(function(blk){
        bindBlock(blk);
        blk.querySelectorAll(".am-orgrow").forEach(bindCityRow);
      });
      modal.mbd.querySelector("#orgAddBl").onclick = function(){
        var tmp = document.createElement("div");
        tmp.innerHTML = blBlockHtml("", []);
        var blk = tmp.firstChild;
        bindBlock(blk);
        box.appendChild(blk);
      };
      modal.okBtn.onclick = function(){
        var business_lines_map = {}, cities_map = {}, seenCity = {}, okRows = true;
        box.querySelectorAll(".am-blblock").forEach(function(blk){
          var blName = (blk.querySelector(".am-blname").value || "").trim();
          if(blName && !business_lines_map[blName]) business_lines_map[blName] = [];
          blk.querySelectorAll(".am-orgrow").forEach(function(row){
            var cn = (row.querySelector(".am-cityname").value || "").trim();
            if(!cn){ return; }
            if(seenCity[cn]){ okRows = false; return; }
            seenCity[cn] = 1;
            var ts = [];
            row.querySelectorAll(".am-tgrid input:checked").forEach(function(c){ ts.push(c.value); });
            cities_map[cn] = ts;
            if(blName) business_lines_map[blName].push(cn);
          });
        });
        if(!okRows) return modal.err("城市名不可重复（同一城市只能归属一个事业部）");
        var dnsVal = (modal.mbd.querySelector('input[name="dns"]:checked') || {}).value || "exclude";
        modal.okBtn.disabled = true;
        api("/api/data-perms", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "set_org", cities: cities_map, business_lines: business_lines_map, default_new_site: dnsVal }) })
          .then(function(r){
            if(r && r.ok){ toast("已保存组织 / 业务线 / 城市"); modal.close(); reload(); }
            else modal.err((r && r.error) || "保存失败");
          })
          .catch(function(){ modal.err("网络错误"); })
          .then(function(){ modal.okBtn.disabled = false; });
      };
    });
}

function confirmResetDataPerm(u){
  askConfirm("重置数据权限", "将「" + u.username + "」的数据权限恢复为默认（全部站点）？",
    "该用户之后将可查看全部站点数据。", function(){
      api("/api/data-perms", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: u.username, action: "delete" }) })
        .then(function(r){ if(r && r.ok) toast("已重置为默认（全部站点）"); else toast((r && r.error) || "失败"); reload(); })
        .catch(function(){ toast("网络错误"); });
    });
}

/* ================= 数据刷新 ================= */
function reload(){
  var body = document.getElementById("amBody");
  if(body) loadAll(body);
  // 同步导航/顶栏无需刷新；仅本视图重拉
}

/* 自动导出 */
export { _tab };
