// pickers.js —— 任务参数表单里的选择控件（浮层统一 append 到 body + position:fixed，集中托管回收）：
//   · createGroupPicker      目标群选择器（可输入 + 下拉联想）
//   · createMultiTeamPicker  多选站点选择器
//   以及两套全局托管/回收机制 _gp* / _mtp*（_gpReap 负责清掉已脱离文档的孤儿浮层）。
// 从 task.js 拆出（原 404-1020 行）。task.js 反向导入 createGroupPicker / createMultiTeamPicker /
// _gpReap / closeAllGroupPickers 使用。
import { store, argValue, taskById } from "./store.js";
import { api, loadPrefs, savePrefs, ensureTeams } from "./api.js";
import { svg, esc, toast } from "./ui.js";
const state = store.state;

/* ---------- 目标群选择器（Combobox：可输入 + 下拉联想） ----------
   聚焦未输入 → 最近使用的群；输入 → 防抖搜群（/api/groups），按匹配度降序；
   选中 → 隐藏域存 gid，输入框显示群名（用户只跟群名打交道）。
   手打了但没点选项 → 把原文存进隐藏域，交给脚本侧按群名解析，容错。 */
var GP_DEBOUNCE = 260;

/* ---- 浮层统一托管 ----
   下拉浮层不再挂在 combobox 里，而是 append 到 body 末尾并 position:fixed
   （与 #dpk 日期弹层同一套路）。这样它不受任何祖先 overflow 裁剪，
   能从配置弹窗里正常溢出、完整显示。
   代价：坐标要自己算，且弹窗/卡片重渲染时必须回收孤儿浮层，否则 body 里堆垃圾。 */
var _GP_ALL = [];          /* 所有活着的 combobox wrap（含已脱离文档的，靠 reap 回收） */
var _GP_BOUND = false;

/* 全局只绑一次：resize / 滚动（capture=true 才能收到弹窗内部滚动容器的 scroll）
   / mousedown（点浮层外关闭）。遍历 _GP_ALL 分发，不给每个实例单独绑。 */
export function _gpBindGlobal(){
  if(_GP_BOUND) return;
  _GP_BOUND = true;
  var pending = false;
  function repaintAll(){
    if(pending) return;
    pending = true;
    requestAnimationFrame(function(){
      pending = false;
      _GP_ALL.forEach(function(w){ if(w && w._place) w._place(); });
    });
  }
  window.addEventListener("resize", repaintAll);
  window.addEventListener("scroll", repaintAll, true);
  document.addEventListener("mousedown", function(ev){
    _GP_ALL.forEach(function(w){ if(w && w._onDocMouseDown) w._onDocMouseDown(ev); });
  }, true);
}

/* 回收已脱离文档的 combobox（卡片重渲染 / 弹窗重建都会产生孤儿浮层） */
export function _gpReap(){
  for(var i = _GP_ALL.length - 1; i >= 0; i--){
    var w = _GP_ALL[i];
    if(!w || !w.isConnected) { if(w && w._destroy) w._destroy(); }
  }
  for(var j = _MTP_ALL.length - 1; j >= 0; j--){
    var w = _MTP_ALL[j];
    if(!w || !w.isConnected) { if(w && w._destroy) w._destroy(); }
  }
}
/* 关闭并销毁全部浮层（弹窗关闭时调用，避免浮层残留在 body 上悬空显示） */
export function closeAllGroupPickers(){
  _GP_ALL.slice().forEach(function(w){ if(w && w._destroy) w._destroy(); });
  _MTP_ALL.slice().forEach(function(w){ if(w && w._destroy) w._destroy(); });
}

/* ============ 多选站点选择器（实时在线播报专用）============
   与 createGroupPicker 共享「浮层 fixed + body 末尾 + 集中托管」的做法，但走自己的样式：
     · 不搜群、不打字、不防抖——站点就 9 个，全展示，输入框只读
     · 多选：每行点击切换勾选（不关浮层）；浮层底部「全选 / 清空」快捷链接
     · 隐藏域存 "id1,id2,id3" 逗号分隔字符串（与 Python parse_teams_arg 直接对齐）
     · 「记住上一次」走现有 state.args + savePrefs 机制：弹窗提交 → setArg → savePrefs
       → 下次打开 argValue() 自动恢复，无须组件额外存储
   浮层自身由 _MTP_ALL 集中托管，与 _GP_ALL 走同一套 reap/全局绑定逻辑。 */
var _MTP_ALL = [];
var _MTP_BOUND = false;
export function _mtpBindGlobal(){
  if(_MTP_BOUND) return;
  _MTP_BOUND = true;
  var pending = false;
  function repaintAll(){
    if(pending) return;
    pending = true;
    requestAnimationFrame(function(){
      pending = false;
      _MTP_ALL.forEach(function(w){ if(w && w._place) w._place(); });
    });
  }
  window.addEventListener("resize", repaintAll);
  /* scroll 必须 capture：弹窗内部 .cf-body(overflow:auto) 也算滚动，capture 才能收到 */
  window.addEventListener("scroll", repaintAll, true);
  /* mousedown capture：点浮层外关闭；mousedown 而非 click——click 之前 input blur 会先关 */
  document.addEventListener("mousedown", function(ev){
    _MTP_ALL.forEach(function(w){ if(w && w._onDocMouseDown) w._onDocMouseDown(ev); });
  }, true);
}
export function createMultiTeamPicker(initVal, onChange){
  _mtpBindGlobal();
  var wrap = document.createElement("div");
  wrap.className = "mtp";

  var inp = document.createElement("input");
  inp.type = "text"; inp.className = "mtp-inp";
  inp.readOnly = true;                        /* 多选不允许打字，强制点开浮层 */
  inp.autocomplete = "off";
  inp.tabIndex = 0;

  var hid = document.createElement("input");
  hid.type = "hidden";

  var pop = document.createElement("div");
  pop.className = "mtp-pop"; pop.hidden = true;

  /* 选中集合（id 字符串）+ 站点数据源。
     teams 在**首次展开下拉时**才拉（ensureTeams），创建组件时可能还是空的，
     所以下面所有读 teams 的地方都先 syncTeams() 刷新一次快照。 */
  var selected = new Set();
  var nameById = {};                 // 已选 id → 名称（界面勾选时写入，供回显/回传用）
  (String(initVal || "")).split(",").map(function(s){return s.trim();})
    .forEach(function(x){
      if(!x) return;
      if(x.indexOf("=") > 0){        // 「id=名称」：界面提交的格式，名称随值一起持久化
        var i = x.indexOf("=");
        var k = x.slice(0, i).trim();
        nameById[k] = x.slice(i + 1).trim();
        selected.add(k);
      }else{
        selected.add(x);
      }
    });
  var teams = (state.teams && state.teams.teams) || [];
  var source = (state.teams && state.teams.source) || "unknown";
  var loading = false;               // 首次展开时的加载态

  /* 惰性加载后把闭包里的 teams/source 快照刷新到最新 */
  function syncTeams(){
    var st = state.teams;
    if(st && st.teams){ teams = st.teams; }
    if(st && st.source){ source = st.source; }
  }

  /* id → 名称：本地记录 > 站点列表 > 退化成 id 本身 */
  function nameOf(id){
    if(nameById[id]) return nameById[id];
    for(var i = 0; i < teams.length; i++){
      if(String(teams[i].id) === id){ nameById[id] = teams[i].name; return teams[i].name; }
    }
    return id;
  }

  /* 写入隐藏域 + 触发 onChange。
     值格式是 `id=名称,id=名称`——把名称一起带下去，Python 端就不用再打站点接口
     反查名字了（2026-09-08：跑任务阶段零站点请求）。 */
  function writeBack(){
    hid.value = Array.from(selected).map(function(id){
      return id + "=" + nameOf(id);
    }).join(",");
    if(onChange) onChange(hid.value);
  }

  /* 输入框摘要：「已选 3 / 9：站点A、站点B、站点C」，超长 tooltip 完整可见。
     站点列表还没加载出来时只报个数，不显示「/ 0」。 */
  function paintInp(){
    if(!selected.size){
      inp.value = "";
      inp.classList.add("is-empty");
      inp.placeholder = "留空将沿用上次选择的站点";
      inp.removeAttribute("title");
      return;
    }
    inp.classList.remove("is-empty");
    var names = [];
    selected.forEach(function(id){ names.push(nameOf(id)); });
    var txt = (teams.length ? "已选 " + selected.size + " / " + teams.length
                            : "已选 " + selected.size + " 个") + "： " + names.join("、");
    inp.value = txt;
    inp.title = txt;
  }

  /* 初始化时主动写一次隐藏域——多选 Combobox 不像单选那样「改时才写」，
     弹窗打开就要把已有选择回填到 hidden（commitParamsForm 从这里读）。 */
  writeBack();
  paintInp();

  /* 浮层渲染：警告条 + 站点列表 + 底部「全选 / 清空 + N/M」 */
  function paintList(){
    pop.innerHTML = "";
    if(loading){
      var ld = document.createElement("div");
      ld.className = "mtp-hint";
      var sp = document.createElement("span"); sp.className = "gp-spin";
      ld.appendChild(sp);
      ld.appendChild(document.createTextNode("正在加载站点…"));
      pop.appendChild(ld);
      return;
    }
    if(source === "fallback"){
      var w = document.createElement("div");
      w.className = "mtp-warn";
      w.textContent = "⚠ 站点列表获取失败，已用兜底清单（仅 3 站）。运行后只出这 3 站播报，其它站需风神登录态恢复后重开弹窗再选。";
      pop.appendChild(w);
    }
    if(!teams.length){
      var h = document.createElement("div");
      h.className = "mtp-hint";
      h.textContent = "暂无站点数据";
      pop.appendChild(h);
    }else{
      teams.forEach(function(t){
        var d = document.createElement("div");
        var id = String(t.id);
        d.className = "mtp-opt" + (selected.has(id) ? " on" : "");
        var ck = document.createElement("span"); ck.className = "ck";
        var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = t.name;
        var tid = document.createElement("span"); tid.className = "tid"; tid.textContent = "#" + t.id;
        d.appendChild(ck); d.appendChild(nm); d.appendChild(tid);
        /* 用 mousedown 而非 click：blur 会先关掉浮层，click 永远触发不到 */
        d.onmousedown = function(ev){
          ev.preventDefault();
          if(selected.has(id)) selected.delete(id); else selected.add(id);
          paintInp();
          paintList();
          writeBack();
        };
        pop.appendChild(d);
      });
    }
    /* 底部「全选 / 清空 + N/M」 */
    var bar = document.createElement("div");
    bar.className = "mtp-bar";
    var l = document.createElement("div"); l.className = "l";
    var sa = document.createElement("a"); sa.textContent = "全选";
    sa.onmousedown = function(ev){
      ev.preventDefault();
      teams.forEach(function(t){ selected.add(String(t.id)); });
      paintInp(); paintList(); writeBack();
    };
    var ca = document.createElement("a"); ca.textContent = "清空";
    ca.onmousedown = function(ev){
      ev.preventDefault();
      selected.clear();
      paintInp(); paintList(); writeBack();
    };
    l.appendChild(sa);
    l.appendChild(document.createTextNode(" / "));
    l.appendChild(ca);
    var r = document.createElement("div"); r.className = "r";
    r.textContent = selected.size + " / " + teams.length;
    bar.appendChild(l); bar.appendChild(r);
    pop.appendChild(bar);
  }

  /* 浮层定位（与单选 Combobox 同一套：fixed + 视口下/上 + max-height 自适应） */
  function place(){
    if(pop.hidden) return;
    var r = inp.getBoundingClientRect();
    var gap = 4, pad = 8;
    var vh = document.documentElement.clientHeight;
    var vw = document.documentElement.clientWidth;
    pop.style.width = Math.max(r.width, 200) + "px";
    pop.style.maxHeight = "";
    var ph = pop.offsetHeight || 0;
    var below = vh - r.bottom - gap - pad;
    var above = r.top - gap - pad;
    var up = (ph > below) && (above > below);
    var avail = Math.max(120, up ? above : below);
    pop.style.maxHeight = Math.min(264, avail) + "px";
    var h = pop.offsetHeight || Math.min(ph, avail);
    pop.style.top = (up ? Math.max(pad, r.top - gap - h) : (r.bottom + gap)) + "px";
    var left = r.left;
    if(left + pop.offsetWidth > vw - pad) left = Math.max(pad, vw - pop.offsetWidth - pad);
    if(left < pad) left = pad;
    pop.style.left = left + "px";
  }
  function show(){ pop.hidden = false; place(); }
  function close(){ pop.hidden = true; }
  function onDocMouseDown(ev){
    if(pop.hidden) return;
    var t = ev.target;
    if(pop.contains(t) || wrap.contains(t)) return;
    close();
  }
  wrap._place = place;
  wrap._onDocMouseDown = onDocMouseDown;
  wrap._destroy = function(){
    close();
    if(pop.parentNode) pop.parentNode.removeChild(pop);
    var i = _MTP_ALL.indexOf(wrap);
    if(i >= 0) _MTP_ALL.splice(i, 1);
  };

  /* 展开：站点列表在这里惰性拉取（仅首次），之后直接复用 state.teams。
     列表到位后要 repaint + 重新定位（浮层高度会从一行变成整列）。 */
  function openPop(){
    show();
    if(!state.teams && !loading){
      loading = true;
      paintList();                       // 先出「正在加载站点…」
      ensureTeams().then(function(){
        loading = false;
        syncTeams();
        paintInp(); paintList(); place();
      });
      return;
    }
    syncTeams();
    paintList();
  }

  /* 开/关统一由 mousedown 接管，不再同时监听 focus 和 click。

     原写法在**同一次点击**里会被触发两次：mousedown → focus（打开）→ click
     （因为已打开所以又关掉），表现为「浮层弹出后立刻收回，得再点一次」。
     首次展开要等 /api/teams 返回时尤其明显——用户看到的是闪一下就没了。

     这里 preventDefault 掉浏览器默认的聚焦行为，自己控制开关顺序，
     并用 lastClose 兜住 preventDefault 失效的浏览器（避免刚关就被 focus 重开）。 */
  var lastClose = 0;
  inp.onmousedown = function(ev){
    ev.preventDefault();
    if(pop.hidden){ openPop(); } else { close(); lastClose = Date.now(); }
    try{ inp.focus({preventScroll:true}); }catch(err){ inp.focus(); }
  };
  inp.onfocus = function(){
    /* 键盘 Tab 进来 → 自动展开（无障碍）；鼠标刚点关的别立刻重开 */
    if(pop.hidden && (Date.now() - lastClose) > 250) openPop();
  };
  inp.onkeydown = function(e){
    if(e.key === "Enter" || e.key === " "){
      e.preventDefault();
      if(pop.hidden){ openPop(); } else { close(); }
    }else if(e.key === "Escape"){
      if(!pop.hidden){ e.preventDefault(); close(); }
    }
  };

  wrap.appendChild(inp); wrap.appendChild(hid);
  document.body.appendChild(pop);
  _MTP_ALL.push(wrap);
  wrap._inp = inp; wrap._hid = hid;
  wrap._pop = pop;       /* 测试 / 调试用：pop 挂在 body 上，不在 wrap 子树里 */
  wrap._paintList = paintList;   /* 暴露给外部：测试、调试、热刷新 */
  wrap.setTaskId = function(){ /* 多选无 taskDefault 概念，留空以保持接口一致 */ };

  return wrap;
}

export function createGroupPicker(initVal, onChange){
  _gpBindGlobal();
  var wrap = document.createElement("div");
  wrap.className = "gp";

  var inp = document.createElement("input");
  inp.type = "text"; inp.className = "gp-inp";
  inp.placeholder = "搜索群名，留空则用任务的默认群";
  inp.autocomplete = "off";

  var hid = document.createElement("input");
  hid.type = "hidden";

  var pop = document.createElement("div");
  pop.className = "gp-pop"; pop.hidden = true;

  /* 输入框 + 下拉浮层。默认群标识不再挂在 combobox 控件后面（旧 defBtn 做法），
     改为跟随下拉里的群名、悬停时显示（见 paint 里的 gp-def）。 */


  /* 输入框 + 下拉浮层；popover 走 absolute 浮在 wrap 上 */
  var row = document.createElement("div"); row.className = "gp-row";
  row.appendChild(inp);
  wrap.appendChild(row); wrap.appendChild(hid);
  /* 浮层挂 body 末尾（不在 wrap 里）—— 见上方「浮层统一托管」注释 */
  document.body.appendChild(pop);
  _GP_ALL.push(wrap);

  /* hi = 当前激活（高亮）项的下标，-1 表示「没有激活项」。
     展开列表后一律从 -1 开始：不做任何预选，避免刚打开就莫名其妙高亮第一个群。
     激活只由两种用户动作产生——鼠标移到某行（paint 里的 onmouseenter）、按上下键。
     wantFirst：列表尚未展开时按下 ArrowDown，展开后直接高亮第一项（一次按键同时完成
     「展开 + 选中」，符合 combobox 的常规手感）；ArrowUp 展开则不预选。 */
  var rows = [], hi = -1, timer = null, seq = 0, vseq = 0, wantFirst = false;

  function close(){ pop.hidden = true; hi = -1; }

  /* 计算浮层坐标（fixed 定位，相对视口）：
     默认贴输入框下沿；下方空间不够且上方更宽裕则上翻；高度按可用空间收缩到
     [120px, 264px]；横向夹在视口内。paint 之后必须调一次（内容变则高度变）。 */
  function place(){
    if(pop.hidden) return;
    var r = inp.getBoundingClientRect();
    var gap = 4, pad = 8;
    var vh = document.documentElement.clientHeight;
    var vw = document.documentElement.clientWidth;
    pop.style.width = Math.max(r.width, 180) + "px";
    /* 第一遍：按 CSS 默认 max-height 量自然高度，用它决定朝下还是朝上 */
    pop.style.maxHeight = "";
    var ph = pop.offsetHeight || 0;
    var below = vh - r.bottom - gap - pad;
    var above = r.top - gap - pad;
    var up = (ph > below) && (above > below);
    var avail = Math.max(120, up ? above : below);
    pop.style.maxHeight = Math.min(264, avail) + "px";
    var h = pop.offsetHeight || Math.min(ph, avail);   /* 应用 max-height 后的真实高度 */
    pop.style.top = (up ? Math.max(pad, r.top - gap - h) : (r.bottom + gap)) + "px";
    var left = r.left;
    if(left + pop.offsetWidth > vw - pad) left = Math.max(pad, vw - pop.offsetWidth - pad);
    if(left < pad) left = pad;
    pop.style.left = left + "px";
  }
  /* 展开浮层的唯一入口：先显形再定位（隐藏元素量不到高度） */
  function show(){ pop.hidden = false; place(); }
  /* 点浮层与输入框之外的地方则关闭（浮层已不在 wrap 里，不能靠 blur 兜底） */
  function onDocMouseDown(ev){
    if(pop.hidden) return;
    var t = ev.target;
    if(pop.contains(t) || wrap.contains(t)) return;
    close();
  }
  wrap._place = place;
  wrap._onDocMouseDown = onDocMouseDown;
  wrap._destroy = function(){
    close();
    if(pop.parentNode) pop.parentNode.removeChild(pop);
    var i = _GP_ALL.indexOf(wrap);
    if(i >= 0) _GP_ALL.splice(i, 1);
  };

  /* 展开即展示最近群名列表：聚焦/点击控件时主动拉最近使用的群（issue 1）。 */
  function expandRecent(){
    if(!pop.hidden) return;
    loading("加载最近使用的群…");
    run("", true);
  }

  function paint(list, hint){
    pop.innerHTML = "";
    if(hint){
      var h = document.createElement("div"); h.className = "gp-hint";
      if(hint.spin){ var s = document.createElement("span"); s.className = "gp-spin"; h.appendChild(s); }
      h.appendChild(document.createTextNode(hint.text || ""));
      show(); return;
    }
    if(!list.length){
      var e = document.createElement("div"); e.className = "gp-hint";
      e.textContent = "没有匹配的群";
      pop.appendChild(e); show(); return;
    }
    var defId = defaultGid();
    list.forEach(function(g, i){
      var d = document.createElement("div"); d.className = "gp-opt" + (i === hi ? " on" : "");
      var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = g.title;
      d.appendChild(nm);
      /* 下拉展开时列的就是最近使用的群，再逐条打「最近」属于同义反复，已移除。
         仅搜索场景保留匹配度百分比——那才是用户判断命中准不准的有效信息。 */
      if(g.score && g.score < 100){
        var sc = document.createElement("span"); sc.className = "gp-sc";
        sc.textContent = g.score + "%"; d.appendChild(sc);
      }
      /* 默认标识：跟随对应群名，不再挂在 combobox 控件后面。
         已为默认 → 「默认」徽标常驻显示（它是状态，要让人一眼看出默认落在哪，见 CSS .is-def）；
         未设默认 → 「设为默认」是操作，仅在该行被激活（鼠标移入 / 键盘高亮）时才露出。 */
      var defTag = document.createElement("span");
      defTag.className = "gp-def" + (g.id === defId ? " is-def" : "");
      defTag.textContent = (g.id === defId) ? "默认" : "设为默认";
      defTag.title = (g.id === defId)
        ? ("已设为本任务默认群：" + g.title + "；点击可取消")
        : ("把 " + g.title + " 设为本任务的默认群");
      defTag.onmousedown = function(ev){
        ev.preventDefault(); ev.stopPropagation();   // 不触发 pick，只切默认
        toggleDefaultFor(g);
      };
      d.appendChild(defTag);
      /* 用 mousedown 而非 click：blur 会先关掉浮层，click 就永远触发不到 */
      d.onmousedown = function(ev){ ev.preventDefault(); pick(g); };
      /* 鼠标移到某行即激活该行：把 .on 从旧行搬到当前行并同步 hi。
         只改 class、不整表重绘——重绘会替换掉光标正下方的节点，hover 态会闪断。
         有了它，键盘高亮的行与鼠标悬停的行不会同时亮着（.on 全局唯一）。 */
      d.onmouseenter = function(){
        if(hi === i) return;
        var prev = pop.querySelector(".gp-opt.on");
        if(prev) prev.classList.remove("on");
        d.classList.add("on");
        hi = i;
      };
      pop.appendChild(d);
    });
    show();
  }

  function pick(g){
    inp.value = g.title || "";
    hid.value = g.id || "";
    close();
    try{
      api("/api/groups/used", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ id: g.id, title: g.title })
      });
    }catch(e){}
    if(onChange) onChange(hid.value);
  }

  function doSearch(q){
    var my = ++seq;
    // 注意：api() 已经返回解析好的 JSON 对象，不要再调 .json()（否则在已解析对象上
    // 调 .json() 抛 TypeError，被 catch 吞掉后永远显示「搜索失败」而非最近群名）。
    api("/api/groups?q=" + encodeURIComponent(q || ""))
      .then(function(j){
        if(my !== seq) return;               // 过期响应直接丢弃，避免快输时结果乱跳
        if(!j || j.ok === false){
          console.error("[目标群] 搜索接口返回异常：", j && j.error);
          rows = [];
          paint([], { text: "搜索失败，可直接输入群名（也可直接手打群名）" });
          return;
        }
        rows = j.groups || [];
        hi = (wantFirst && rows.length) ? 0 : -1;
        wantFirst = false;
        paint(rows);
      })
      .catch(function(e){
        if(my !== seq) return;
        console.error("[目标群] 搜索请求异常：", e);   // 真实异常打到控制台，不静默吞掉
        rows = [];
        paint([], { text: "搜索失败，可直接输入群名（也可直接手打群名）" });
      });
  }

  function run(q, now){
    if(timer) clearTimeout(timer);
    if(now) doSearch(q);
    else timer = setTimeout(function(){ doSearch(q); }, GP_DEBOUNCE);
  }

  function loading(text){ paint([], { spin: true, text: text }); }

  inp.onfocus = function(){
    /* 用户主动点控件时触发：选中文本便于覆盖输入、把光标挪到末尾便于继续追加，
       并直接展开最近群名列表（issue 1：展开即展示最近群名，不再等输入/方向键）。 */
    try{
      inp.select();
      var v = inp.value;
      if(v.length){
        inp.setSelectionRange(v.length, v.length);
      }
    }catch(e){ /* input 已失焦，不必强求 */ }
    expandRecent();
  };
  inp.oninput = function(){
    hid.value = inp.value;                   // 未选中：原文当群名，脚本侧解析
    if(!inp.value.trim()){ loading("加载最近使用的群…"); run("", true); return; }
    loading("搜索中…");
    run(inp.value);
  };
  inp.onblur = function(){
    setTimeout(close, 160);                  // 给 mousedown 选中留出时间
    var v = inp.value.trim();
    if(v && !hid.value) hid.value = v;
    if(!v) hid.value = "";
    if(onChange) onChange(hid.value);
  };
  inp.onkeydown = function(e){
    if(e.key === "ArrowDown" || e.key === "ArrowUp"){
      e.preventDefault();                    // 阻止光标在本框内跳动
      if(pop.hidden){                        // 列表未展开：先展开；下键顺带预选第一项
        wantFirst = (e.key === "ArrowDown");
        loading("加载最近使用的群…"); run("", true); return;
      }
      hi = (e.key === "ArrowDown") ? Math.min(hi + 1, rows.length - 1) : Math.max(hi - 1, 0);
      paint(rows);
    }else if(e.key === "Enter"){
      if(!pop.hidden && rows[hi]){ e.preventDefault(); pick(rows[hi]); }
    }else if(e.key === "Escape"){ close(); }
  };

  /* 初值回填：存的是 gid，显示要给群名。先占位 gid 不阻塞，反查到了再替换。 */
  wrap._setValue = function(v){
    var my = ++vseq;
    hid.value = v || "";
    if(!v){ inp.value = ""; return; }
    if(/^cid/.test(v)){
      inp.value = v;
      api("/api/groups?q=")
        .then(function(j){
          if(my !== vseq) return;
          var hit = (j.groups || []).filter(function(g){ return g.id === v; })[0];
          if(hit) inp.value = hit.title;
        }).catch(function(e){ console.error("[目标群] 反查群名失败：", e); });
    }else{
      inp.value = v;
    }
  };
  wrap._setValue(initVal);

  /* ---- 个人默认群（taskDefaultGroup[taskId] = gid）----
     · 打开弹窗时优先用它预填 gid，胜过出厂 default（"不要写死"的诉求）
     · 默认标识不再做成 combobox 后的按钮：改为下拉里跟随群名、悬停显示（见 paint）
     · 点列表里的「设为默认」/「默认」即可切换；setTaskId 仅记录 taskId 供默认判定 */
  var taskId = null;     /* 由 renderParamRow 在挂上 row 时通过 wrap.setTaskId() 注入 */
  function defaultGid(){
    return ((state.taskDefaultGroup || {})[taskId]) || "";
  }
  function toggleDefaultFor(g){
    if(!taskId || !g || !g.id) return;
    var cur = defaultGid();
    if(cur === g.id){
      delete state.taskDefaultGroup[taskId];
      toast("已取消本任务的默认群");
    }else{
      state.taskDefaultGroup[taskId] = g.id;
      toast("已设 " + (g.title || "该群") + " 为本任务的默认群");
      /* 顺手把这个群写到 Combobox 当前选中——避免设了默认后输入框还是空的，
         让人觉得"默认群没生效"。取消默认时不强行清空（用户可能还想保留当前选择）。 */
      inp.value = g.title || "";
      hid.value = g.id || "";
      if(onChange) onChange(hid.value);
    }
    savePrefs();
    paint(rows);   // 刷新当前列表里的默认标识（不依赖隐藏按钮）
  }





  wrap.setTaskId = function(id){ taskId = id; };
  wrap._inp = inp; wrap._hid = hid;


  return wrap;
}
