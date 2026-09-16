import { store, groupOf, taskById, countInGroup, producerOf, missingText, visibleTasks, taskState, argValue } from "./store.js";
import { api, savePrefs, loadPrefs, readTokens, withToken, ensureTeams } from "./api.js";
import { svg, esc, hexA, toast, viewHead } from "./ui.js";
import { TK, TK_MAP, RISK_LABEL, RISK_CLS, STATUS_CLS, STATUS_TXT, ICON } from "./tokens.js";
import { bus } from "./bus.js";
import { refreshLan, bindLanToggle, setArg, openSide, closeSide, askConfirm, closeConfirm, bindConfirmUI, lockScroll, unlockScroll } from "./behavior.js";
import "./standard.css";   /* 标准达成视图样式（原 _stdEnsureStyle 运行时注入 <style>，改为静态引入） */
const state = store.state;

/* 标准达成视图状态（原误放在 attend-period.js；仅本模块使用 → 归位到唯一使用者） */
var _std = { teams:[], names:{}, team:"__all__", start:"", end:"", mode:"station",
  rider:"",            // 骑手筛选："" = 全部骑手；切站点时自动重置
  riderPool:[],        // 骑手候选池（最近一次 riders 接口返回的 rows 精简版）
  sort:{key:null,dir:0}, // 表头排序：{key=列名, dir:1 升序 / -1 降序 / 0 默认}
  page:1,              // 骑手表当前页码（切站点 / 切骑手 / 重新查询时归 1）
  pageSize:20          // 骑手表每页条数（10/15/20/25/30 可选，默认 20）
};
var _STD_ALL_TEAM = "__all__";             // 站点下拉「全部站点」的 value（后端合并取数）
var _stdCoolKey = "stdQueryCooldownV1";    // 查询按钮冷却的存储键
/* _stdFillRiders 是视图设置函数内的闭包，模块级的 _stdRenderRiders 引用不到它；
   用模块级引用承接，加载完骑手后据此刷新下拉输入框（原先靠 typeof 守卫成了静默空操作）。 */
var _stdRiderFill = null;

/* 日期 → YYYY-MM-DD（原在 attend-period.js，随标准达成视图归位） */
function _stdYMD(d){ var y=d.getFullYear(),m=("0"+(d.getMonth()+1)).slice(-2),g=("0"+d.getDate()).slice(-2); return y+"-"+m+"-"+g; }
/* 表格区大 Loading 占位（原在 attend-period.js） */
function _stdTableLoader(text, sub){
  return '<div class="std-table-loader"><span class="dots"><i></i><i></i><i></i></span>'+
         '<div class="txt">'+esc(text||"加载中…")+'</div>'+
         (sub?('<div class="sub">'+esc(sub)+'</div>'):'')+'</div>';
}

export function renderStandardView(host){
  // 默认当天（无日期选择框），仅看今日实时数据
  if(!_std.start){ var t=new Date(); _std.start=_stdYMD(t); _std.end=_stdYMD(t); }

  host.appendChild(viewHead("标准达成", "", "target", TK.cyan));

  var wrap=document.createElement("div"); wrap.className="std-wrap";

  var bar=document.createElement("div"); bar.className="std-bar";
  bar.innerHTML =
    '<label>站点<div class="std-combo" id="stdTeamCombo"><input id="stdTeam" class="std-team-pick" type="text" placeholder="搜索站点名称 / ID…" autocomplete="off"><div class="std-combo-list" id="stdTeamList"></div></div></label>'+
    '<label>骑手<div class="std-combo" id="stdRiderCombo"><input id="stdRider" class="std-rider-pick" type="text" placeholder="搜索骑手姓名 / ID…" autocomplete="off"><div class="std-combo-list" id="stdRiderList"></div></div></label>'+
    '<label>达成标准<select id="stdAchieved"><option value="">全部</option><option value="未达标">未达标</option><option value="标准1">标准1</option><option value="标准2">标准2</option><option value="标准3">标准3</option><option value="标准4">标准4</option><option value="标准5">标准5</option></select></label>'+
    '<label>在线状态<select id="stdOnline"><option value="">全部</option><option value="在线">在线</option><option value="小休">小休</option><option value="下线">下线</option><option value="申请下线">申请下线</option><option value="申请小休">申请小休</option></select></label>'+
    '<label>预计达标<select id="stdEst"><option value="">全部</option><option value="已达标">已达标</option><option value="轻松达成">轻松达成</option><option value="有望达成">有望达成</option><option value="达成困难">达成困难</option><option value="不可达标">不可达标</option></select></label>'+
    '<button class="std-btn" id="stdGo">刷新数据</button>';
  wrap.appendChild(bar);
  // 该筛选框（站点 / 骑手 / 刷新按钮）仅在「骑手维度」展示与生效
  bar.style.display = "none";

  host.appendChild(wrap);

  // 子维度切换：站点维度（默认）/ 骑手维度 / 系统设置
  var stdTabs=document.createElement("div"); stdTabs.className="std-tabs";
  stdTabs.innerHTML=
    '<button class="std-tab" data-m="station"><svg class="t-ic" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></svg>站点维度</button>'+
    '<button class="std-tab" data-m="rider"><svg class="t-ic" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4.5 20c.6-4 3.8-6 7.5-6s6.9 2 7.5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>骑手维度</button>'+
    '<button class="std-tab" data-m="settings"><svg class="t-ic" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9 19 19M19 5l-2.1 2.1M7.1 16.9 5 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>系统设置</button>';
  wrap.insertBefore(stdTabs, wrap.firstChild);
  var riderHost=document.createElement("div"); riderHost.className="std-rider"; riderHost.style.display="none";
  wrap.appendChild(riderHost);
  var settingsHost=document.createElement("div"); settingsHost.className="std-settings"; settingsHost.style.display="none";
  wrap.appendChild(settingsHost);
  var reportHost=document.createElement("div"); reportHost.className="std-report"; reportHost.style.display="none";
  wrap.appendChild(reportHost);
  function _stdSwitchTab(mode){
    stdTabs.querySelectorAll(".std-tab").forEach(function(x){ x.classList.remove("on"); });
    var btn=stdTabs.querySelector('.std-tab[data-m="'+mode+'"]');
    if(btn) btn.classList.add("on");
    _std.mode = mode;   // 记录当前维度，查询按钮据此决定刷哪个视图
    var showR = mode==="rider", showS = mode==="settings";
    // 工具条（站点筛选 + 刷新按钮）在「站点维度」与「骑手维度」均显示；「系统设置」隐藏
    if(bar) bar.style.display = (showR || mode==="station") ? "" : "none";
    // 骑手专属控件（骑手下拉 / 达成标准 / 在线状态 / 预计达标）仅在骑手维度显示，避免站点态 IA 割裂
    if(bar){ bar.querySelectorAll(".std-rider-pick, #stdAchieved, #stdOnline, #stdEst").forEach(function(el){
      var lb = el.closest ? el.closest("label") : null; if(lb) lb.style.display = showR ? "" : "none"; }); }
    riderHost.style.display = showR?"":"none";
    settingsHost.style.display = showS?"":"none";
    reportHost.style.display = (mode==="station")?"":"none";
    // 切维度：只用落盘原始三源本地重算（refresh=0），绝不实时拉取
    if(showR){ fillTeams(); _stdRenderRiders(riderHost, false); }
    else if(showS){ _stdRenderSettings(settingsHost, {}); }   // 标准目标设置（单一区块；参与站点已并入标准目标联动）
    else { _stdRenderReport(reportHost); }   // 站点维度 = 数据报表（16 列）
    try{ localStorage.setItem("standard_last_tab", mode); }catch(e){}
  }
  stdTabs.querySelectorAll(".std-tab").forEach(function(b){
    b.addEventListener("click", function(){ _stdSwitchTab(b.getAttribute("data-m")); });
  });

  function _stdRenderReport(host){
    host.innerHTML='<div class="std-loading"><span class="dots"><i></i><i></i><i></i></span>报表计算中…</div>';
    // 与骑手维度 _stdRenderRiders 对称：必须传 start/end（=_std.start），
    // 否则后端默认用 today_ymd()（服务器当天）读三源；当 _std.start 与服务器当天不一致
    // （页面跨午夜未重载等）时会读不到刷新写入的数据，导致站点维度空白而骑手维度正常。
    api("/api/standard/station-report?team="+encodeURIComponent(_std.team)+
        "&start="+encodeURIComponent(_std.start)+"&end="+encodeURIComponent(_std.end)).then(function(j){
      if(!j || j.ok===false){
        host.innerHTML='<div class="std-banner" style="display:block">报表加载失败：'+esc((j&&j.error)||"未知错误")+'</div>';
        return;
      }
      var rows=j.rows||[];
      if(!rows.length){
        host.innerHTML='<div class="std-banner" style="display:block">'+(j.data_note||"暂无数据，请先在标准达成点「刷新数据」拉取今日数据")+'</div>';
        return;
      }
      _std.rptRows = rows;            // 缓存全量行，排序无需重新拉取
      _std.rptNote = j.data_note || "";
      _stdRenderReportBody(host);
    }).catch(function(e){
      host.innerHTML='<div class="std-banner" style="display:block">请求失败：'+esc(String(e))+'</div>';
    });
  }

  /* 站点报表：从缓存行(_std.rptRows)重渲染，含表头排序交互；不重新拉取。
     排序状态存 _std.rptSort（与骑手维度 _std.sort 隔离），三态：默认→升→降→默认。 */
  function _stdRenderReportBody(host){
    var rows=_std.rptRows||[];
    /* 紧凑短表头（显示文案）：缩短列宽以消除横向滚动条；完整列名见下一行 headFull（挂 title 悬停可见） */
    var head=['站点ID','站点名称','规模','排班','排班满足率','有单骑手','出勤满足','门槛','封顶','达标','达标率','未达标','预计可达','预计达标率','尖峰'];
    var headFull=['站点ID','站点名称','规模目标','排班人数','排班满足率','有单骑手数','出勤满足率','门槛人数','封顶人数','达标人数','达标率','未达标人数','预计可达标人数','预计可达标率','尖峰激励'];
    var cols=['team_id','team_name','scale_target','scheduled_num','schedule_rate','rider_with_order','attend_rate','threshold_count','cap_count','achieved_num','achieved_rate','unachieved_num','expected_achievable_num','expected_achievable_rate','peak_incentive'];
    var pctIdx={4:1,6:1,10:1,13:1,14:1};   // 排班满足率/出勤满足率/达标率/预计可达标率/尖峰激励 为百分比徽标列
    var sortState=_std.rptSort||(_std.rptSort={key:null,dir:0});
    var srows=_stdSortRows(rows, sortState.key, sortState.dir);
    /* 顶层 KPI 概要：由缓存行本地计算，零额外请求（参与站点 / 平均达标率 / 未达标站点） */
    var _sumN=rows.length, _sumRate=0, _sumRateN=0, _sumBad=0;
    rows.forEach(function(r){
      var ar=r.achieved_rate;
      if(typeof ar==="number"){ _sumRate+=ar; _sumRateN++; if(ar<100) _sumBad++; }
    });
    var _avg = _sumRateN ? Math.round(_sumRate/_sumRateN) : null;
    var _sumCls = _avg==null?"":(_avg>=100?"ok":(_avg>=90?"warn":"bad"));
    var summaryHtml='<div class="std-summary">'+
      '<div class="ss"><span class="ss-k">参与站点</span><span class="ss-v">'+_sumN+'</span></div>'+
      '<div class="ss"><span class="ss-k">平均达标率</span><span class="ss-v '+_sumCls+'">'+( _avg==null?'—':_avg+'%')+'</span></div>'+
      '<div class="ss"><span class="ss-k">未达标站点</span><span class="ss-v '+(_sumBad?'bad':'ok')+'">'+_sumBad+'</span></div>'+
      '</div>';
    var html='<div class="std-table-wrap"><table class="std-table std-report-table"><thead><tr>';
    head.forEach(function(h,i){
      var k=cols[i];
      var st=(sortState.key===k)?(sortState.dir||0):0;
      var cls="std-th-sortable"+(pctIdx[i]?" col-pct":"")+(st>0?" on asc":(st<0?" on desc":""));
      html+='<th class="'+cls+'" data-k="'+esc(k)+'" title="'+esc(headFull[i]||h)+' · 点击排序：升序 → 降序 → 默认">'+
        '<span class="th-in">'+esc(h)+_stdSortIcon(st)+'</span></th>';
    });
    html+='</tr></thead><tbody>';
    srows.forEach(function(r){
      // 展开态按 team_id 记（排序会重排行序，不能用行索引做 key）
      var tid=String(r.team_id||r.team_name||"");
      var open=!!(_std.expanded||{})[tid];
      html+='<tr class="std-exp-row'+(open?' on':'')+'" data-tid="'+esc(tid)+'" tabindex="0" role="button"'+
        ' aria-expanded="'+(open?'true':'false')+'" title="点击展开 / 收起该站点明细（Enter / Esc）">';
      cols.forEach(function(c,i){
        var v=r[c];
        var pre=(i===0)?'<span class="std-exp-ico">›</span>':'';
        if(pctIdx[i]){ html+='<td class="col-pct">'+_stdRateBadge(v)+'</td>'; }
        else if(c==='threshold_count'){
          html+=(v===null||v===undefined)
            ? '<td class="muted-col" title="未设置门槛值">未设置</td>'
            : '<td>'+esc(v)+'</td>';
        }
        else if(c==='cap_count'){
          html+=(v===null||v===undefined)
            ? '<td class="muted-col" title="未设置封顶值">未设置</td>'
            : '<td>'+esc(v)+'</td>';
        }
        else { html+='<td>'+pre+(v===null||v===undefined?'—':esc(v))+'</td>'; }
      });
      html+='</tr>';
      if(open) html+=_stdExpPanel(r, cols.length);
    });
    html+='</tbody></table></div>';
    // 页脚行：左=数据备注（如有），右=「收起展开行」（手风琴模式下最多一个展开行，故不再显示数量）
    var _noteHtml = _std.rptNote ? '<span class="srf-note">'+esc(_std.rptNote)+'</span>' : '';
    var _expN=0; for(var _ek in (_std.expanded||{})){ if(_std.expanded[_ek]) _expN++; }
    var _collapseHtml = _expN ? '<button class="std-std-link" id="stdCollapseAll" type="button">收起展开行</button>' : '';
    html+='<div class="std-report-foot">'+_noteHtml+_collapseHtml+'</div>';
    host.innerHTML = summaryHtml + html;
    var thead=host.querySelector(".std-report-table thead");
    if(thead){ thead.addEventListener("click", function(ev){
      var th=ev.target.closest?ev.target.closest("th.std-th-sortable"):null;
      if(!th) return;
      _stdSortToggleRpt(th.getAttribute("data-k"));
      _stdRenderReportBody(host);   // 用缓存行重渲染，不重新拉取
    }); }
    /* 原「查看各标准人数明细」弹窗入口已移除：该信息现由行内展开面板逐站承载 */
    var cBtn=host.querySelector("#stdCollapseAll");
    if(cBtn){ cBtn.addEventListener("click", function(){ _std.expanded={}; _stdRenderReportBody(host); }); }
    // 行内展开：整行点击切换展开/收起；行内按钮/链接不触发展开（避免与「查看该站骑手」冲突）
    var tbody=host.querySelector(".std-report-table tbody");
    if(tbody){
      tbody.addEventListener("click", function(ev){
        var el=ev.target;
        var act=(el&&el.closest)?el.closest("a,button"):null;
        if(act){
          if(act.classList && act.classList.contains("std-exp-jump")){
            var jt=act.getAttribute("data-jump");
            if(jt){                                  // 深钻：切到骑手维度并预填该站（本地重算，零上游请求）
              _std.team=jt; _std.page=1; _std.rider=""; _std.riderPool=[];
              if(typeof _stdFillTeamInput==="function") _stdFillTeamInput();
              _stdSwitchTab("rider");
            }
          }
          return;
        }
        var tr=(el&&el.closest)?el.closest("tr.std-exp-row"):null;
        if(!tr) return;
        var tid=tr.getAttribute("data-tid")||"";
        var wasOpen=!!(_std.expanded||{})[tid];
        _std.expanded={};                      // 手风琴：同一时间只允许一个数据行展开
        if(!wasOpen) _std.expanded[tid]=true;  // 点已展开行=收起；点其它行=收起旧的、展开新的
        _stdRenderReportBody(host);                  // 用缓存行重渲染，不重新拉取
      });
      tbody.addEventListener("keydown", function(ev){
        if(ev.key==="Escape"){ _std.expanded={}; _stdRenderReportBody(host); return; }
        var tr=(ev.target&&ev.target.closest)?ev.target.closest("tr.std-exp-row"):null;
        if(!tr) return;
        if(ev.key==="Enter"||ev.key===" "){ ev.preventDefault(); tr.click(); }
      });
    }
  }
  /* 行内展开面板：内容全部取自 _std.rptRows 已有字段（build_one 已算好 std1~5 / 达标构成 /
     门槛封顶），即时渲染、零请求；「查看该站骑手」跳骑手维度并预填该站。 */
  function _stdExpPanel(r, ncol){
    var s1=r.std1||0,s2=r.std2||0,s3=r.std3||0,s4=r.std4||0,s5=r.std5||0;
    var tot=s1+s2+s3+s4+s5;
    function kv(label,val,cls){
      var txt=(val===null||val===undefined)?'—':esc(val);
      return '<span>'+esc(label)+' <b'+(cls?' class="'+cls+'"':'')+'>'+txt+'</b></span>';
    }
    var g1='<div class="std-exp-g"><div class="g-t">各标准达成人数</div><div class="g-v">'+
      kv('标准1',s1)+kv('标准2',s2)+kv('标准3',s3)+kv('标准4',s4)+kv('标准5',s5)+
      kv('合计',tot,'tot')+'</div></div>';
    var g2='<div class="std-exp-g"><div class="g-t">达标构成</div><div class="g-v">'+
      kv('达标',r.achieved_num)+kv('未达标',r.unachieved_num)+
      kv('预计可达标',r.expected_achievable_num)+
      kv('门槛人数',(r.threshold_count===null||r.threshold_count===undefined)?'未设置':r.threshold_count)+
      kv('封顶人数',(r.cap_count===null||r.cap_count===undefined)?'未设置':r.cap_count)+
      '</div></div>';
    var tid=String(r.team_id||"");
    var more=tid?('<div class="std-exp-more"><button type="button" class="std-std-link std-exp-jump"'+
      ' data-jump="'+esc(tid)+'">查看该站骑手 ›</button></div>'):'';
    return '<tr class="std-exp-panel"><td colspan="'+ncol+'"><div class="std-exp-wrap">'+
      g1+g2+more+'</div></td></tr>';
  }
  /* 「各标准达成人数明细」弹窗（_stdShowStdModal）已移除：该信息由行内展开面板承载 */
  function _stdSortToggleRpt(k){
    if(!k) return;
    var st=_std.rptSort||(_std.rptSort={key:null,dir:0});
    if(st.key!==k){ st.key=k; st.dir=1; return; }              // 换列：从头(升序)
    st.dir=(st.dir===1)?-1:((st.dir===-1)?0:1);                // 同列：升→降→默认
    if(st.dir===0) st.key=null;
  }

  var sel=bar.querySelector("#stdTeam");
  var selRider=bar.querySelector("#stdRider");
  var selAchieved=bar.querySelector("#stdAchieved");
  var selOnline=bar.querySelector("#stdOnline");
  var selEst=bar.querySelector("#stdEst");
  var selTeamList=bar.querySelector("#stdTeamList");
  var selTeamCombo=bar.querySelector("#stdTeamCombo");
  var _stdTeamData=[];   // 当前站点候选（已按 configured_ids 过滤，不含「全部站点」）

  function _stdRenderTeamList(kw){
    if(!selTeamList) return;
    kw=(kw||"").trim().toLowerCase();
    selTeamList.innerHTML="";
    var allMatch=!kw || "全部站点".indexOf(kw)>=0;
    if(allMatch){
      var all=document.createElement("div"); all.className="std-combo-item"; all.textContent="全部站点";
      if(String(_std.team)===_STD_ALL_TEAM) all.classList.add("active");
      all.addEventListener("mousedown", function(e){ e.preventDefault(); _stdPickTeam(_STD_ALL_TEAM); });
      selTeamList.appendChild(all);
    }
    var matched=_stdTeamData.filter(function(t){
      if(!kw || allMatch) return true;   // 关键词匹配「全部站点」时，真实站点应全部列出
      return (t.name||"").toLowerCase().indexOf(kw)>=0 || String(t.id).toLowerCase().indexOf(kw)>=0;
    });
    if(!matched.length && !allMatch){ var e=document.createElement("div"); e.className="std-combo-empty"; e.textContent="无匹配站点"; selTeamList.appendChild(e); }
    matched.forEach(function(t){
      var it=document.createElement("div"); it.className="std-combo-item";
      if(String(t.id)===String(_std.team)) it.classList.add("active");
      it.innerHTML=esc(t.name)+'<span class="sub">'+esc(t.id)+'</span>';
      it.addEventListener("mousedown", function(e){ e.preventDefault(); _stdPickTeam(String(t.id)); });
      selTeamList.appendChild(it);
    });
  }
  function _stdPickTeam(id){
    _std.team=id||_STD_ALL_TEAM; _std.page=1;
    selTeamCombo.classList.remove("open");
    _stdFillTeamInput();
    // 站点变更 → 已选骑手立即失效，重置为「全部骑手」
    _std.rider=""; _std.riderPool=[];
    if(selRider) selRider.value="";
    if(typeof _stdFillRiders==="function") _stdFillRiders();
    if(_std.mode==="rider") _stdRenderRiders(riderHost, false);
    else if(_std.mode==="station") _stdRenderReport(reportHost);   // 站点维度：切换站点即按缓存重算报表
  }
  function _stdFillTeamInput(){
    if(!sel) return;
    if(String(_std.team)===_STD_ALL_TEAM){ sel.value="全部站点"; }
    else {
      var rec=null; for(var i=0;i<_stdTeamData.length;i++){ if(String(_stdTeamData[i].id)===String(_std.team)){ rec=_stdTeamData[i]; break; } }
      sel.value=rec?(rec.name||rec.id):"全部站点";
    }
  }
  function fillTeams(){
    // 骑手维度：站点下拉仅展示已设置标准目标的站点（由「标准目标设置」configured_ids 决定）
    var mo=(_std.start||_stdYMD(new Date())).slice(0,7);
    api("/api/standard/grade-standards?month="+encodeURIComponent(mo)).then(function(gs){
      var cfgSet={}; (gs&&gs.configured_ids||[]).forEach(function(id){ cfgSet[String(id)]=1; });
      var list=(_std.teams||[]).filter(function(t){ return cfgSet[String(t.id)]; });
      if(!list.length) list=[{id:"917521130",name:"东莞市黄江镇站-UB"},
        {id:"917521136",name:"东莞市长安万科站-UB"},{id:"917521139",name:"东莞市大岭山大学城站-UB"}];
      _stdTeamData=list;
      var found=String(_std.team)===_STD_ALL_TEAM || list.some(function(t){ return String(t.id)===String(_std.team); });
      if(!found){ _std.team=_STD_ALL_TEAM; }
      list.forEach(function(t){ _std.names[t.id]=t.name; });
      _std.names[_STD_ALL_TEAM]="全部站点";
      _stdFillTeamInput(); _stdRenderTeamList("");
      if(typeof _stdFillRiders==="function") _stdFillRiders();
    }).catch(function(){
      var list=_std.teams.length?_std.teams:[{id:"917521130",name:"东莞市黄江镇站-UB"},
        {id:"917521136",name:"东莞市长安万科站-UB"},{id:"917521139",name:"东莞市大岭山大学城站-UB"}];
      _stdTeamData=list;
      var found=String(_std.team)===_STD_ALL_TEAM || list.some(function(t){ return String(t.id)===String(_std.team); });
      if(!found){ _std.team=_STD_ALL_TEAM; }
      list.forEach(function(t){ _std.names[t.id]=t.name; });
      _std.names[_STD_ALL_TEAM]="全部站点";
      _stdFillTeamInput(); _stdRenderTeamList("");
      if(typeof _stdFillRiders==="function") _stdFillRiders();
    });
  }
  fillTeams();
  api("/api/teams").then(function(j){ if(j&&j.teams&&j.teams.length){ _std.teams=j.teams;
    j.teams.forEach(function(t){_std.names[t.id]=t.name;}); fillTeams(); } }).catch(function(){});

  if(sel){
    sel.addEventListener("focus", function(){ selTeamCombo.classList.add("open"); _stdRenderTeamList(""); });
    sel.addEventListener("mousedown", function(){ selTeamCombo.classList.add("open"); _stdRenderTeamList(""); });
    sel.addEventListener("input", function(){ selTeamCombo.classList.add("open"); _stdRenderTeamList(sel.value); });
    sel.addEventListener("blur", function(){ setTimeout(function(){ selTeamCombo.classList.remove("open"); }, 120); });
    sel.addEventListener("keydown", function(e){
      if(e.key!=="ArrowDown" && e.key!=="ArrowUp" && e.key!=="Enter") return;
      e.preventDefault();
      var items=selTeamList.querySelectorAll(".std-combo-item:not(.std-combo-empty)");
      var idx=-1; for(var i=0;i<items.length;i++){ if(items[i].classList.contains("active")){ idx=i; break; } }
      if(e.key==="Enter"){ if(items[idx]) items[idx].dispatchEvent(new MouseEvent("mousedown",{bubbles:true})); return; }
      if(e.key==="ArrowDown"){ idx=(idx+1)%items.length; }
      else if(e.key==="ArrowUp"){ idx=(idx-1+items.length)%items.length; }
      items.forEach(function(it){ it.classList.remove("active"); });
      if(items[idx]) items[idx].classList.add("active");
    });
  }
  if(selTeamCombo) document.addEventListener("click", function(e){ if(!selTeamCombo.contains(e.target)) selTeamCombo.classList.remove("open"); });

  /* ---------- 骑手筛选（combobox，与「站点」联动，支持搜索）----------
     数据源：最近一次 /api/standard/riders 返回的 rows（_std.riderPool），天然只含当前站点的骑手。
     · 选中具体站点 → 只展示 team_id === 该站点的骑手；「全部站点」→ 跨站并集（带站点名前缀）。
     · 候选池为空（如当天尚未落盘）时，展开即触发一次落盘重算拉取，避免下拉永远为空。
     · 联动：切换 / 清空站点 → 已选骑手自动重置为「全部骑手」。 */
  var selRiderList=bar.querySelector("#stdRiderList");
  var selRiderCombo=bar.querySelector("#stdRiderCombo");
  function _stdCurRiderList(){
    var pool=_std.riderPool||[];
    var allMode = String(_std.team)===_STD_ALL_TEAM;
    var teamStr = allMode?"":(_std.team?String(_std.team):"");
    return { list: pool.filter(function(r){
      if(!teamStr) return true;
      return String(r.team==null?"":r.team)===teamStr;
    }), teamStr: teamStr };
  }
  function _stdRenderRiderList(kw){
    if(!selRiderList) return;
    var c=_stdCurRiderList(); var list=c.list, teamStr=c.teamStr;
    kw=(kw||"").trim().toLowerCase();
    selRiderList.innerHTML="";
    var matched=list.filter(function(r){
      if(!kw) return true;
      var label=(teamStr||!r.teamName)?(r.name||r.id):(r.teamName+" · "+(r.name||r.id));
      return (label||"").toLowerCase().indexOf(kw)>=0 || String(r.id).toLowerCase().indexOf(kw)>=0;
    });
    if(!matched.length){ var e=document.createElement("div"); e.className="std-combo-empty"; e.textContent="无匹配骑手"; selRiderList.appendChild(e); }
    matched.forEach(function(r){
      var it=document.createElement("div"); it.className="std-combo-item";
      if(String(r.id)===String(_std.rider)) it.classList.add("active");
      var name=(teamStr||!r.teamName)?(r.name||r.id):(r.teamName+" · "+(r.name||r.id));
      it.innerHTML=esc(name)+'<span class="sub">'+esc(r.id)+'</span>';
      it.addEventListener("mousedown", function(e){ e.preventDefault(); _stdPickRider(String(r.id)); });
      selRiderList.appendChild(it);
    });
  }
  function _stdPickRider(id){
    _std.rider=id||""; _std.page=1;
    selRiderCombo.classList.remove("open");
    _stdFillRiders();
    if(_std.mode==="rider") _stdRenderRiders(riderHost, false);
  }
  function _stdFillRiders(){
    if(!selRider) return;
    var c=_stdCurRiderList(); var list=c.list, teamStr=c.teamStr;
    var cur=_std.rider||"", curRec=null;
    for(var i=0;i<list.length;i++){ if(String(list[i].id)===String(cur)){ curRec=list[i]; break; } }
    if(!curRec && cur) _std.rider="";   // 已选骑手不在当前站点列表 → 回落全部
    if(curRec){ selRider.value=(teamStr||!curRec.teamName)?(curRec.name||curRec.id):(curRec.teamName+" · "+(curRec.name||curRec.id)); }
    else { selRider.value=""; }
    _stdRenderRiderList("");
  }
  _stdFillRiders();
  _stdRiderFill = _stdFillRiders;   /* 暴露给 _stdRenderRiders（跨函数作用域）刷新下拉 */
  if(selRider){
    selRider.addEventListener("focus", function(){
      selRiderCombo.classList.add("open");
      if(!(_std.riderPool||[]).length && _std.mode==="rider"){ _stdRenderRiders(riderHost, false); }  // 候选池空则先拉一次
      _stdRenderRiderList("");
    });
    selRider.addEventListener("mousedown", function(){
      selRiderCombo.classList.add("open");
      if(!(_std.riderPool||[]).length && _std.mode==="rider"){ _stdRenderRiders(riderHost, false); }  // 候选池空则先拉一次
      _stdRenderRiderList("");
    });
    selRider.addEventListener("input", function(){ selRiderCombo.classList.add("open"); _stdRenderRiderList(selRider.value); });
    selRider.addEventListener("blur", function(){ setTimeout(function(){
      selRiderCombo.classList.remove("open");
      if(selRider.value.trim()==="" && _std.rider){ _std.rider=""; _std.page=1; if(_std.mode==="rider") _stdRenderRiders(riderHost, false); }
    }, 120); });
    selRider.addEventListener("keydown", function(e){
      if(e.key==="Escape"){ selRider.value=""; _std.rider=""; _std.page=1; selRiderCombo.classList.remove("open"); if(_std.mode==="rider") _stdRenderRiders(riderHost, false); return; }
      if(e.key!=="ArrowDown" && e.key!=="ArrowUp" && e.key!=="Enter") return;
      e.preventDefault();
      var items=selRiderList.querySelectorAll(".std-combo-item:not(.std-combo-empty)");
      var idx=-1; for(var i=0;i<items.length;i++){ if(items[i].classList.contains("active")){ idx=i; break; } }
      if(e.key==="Enter"){ if(items[idx]) items[idx].dispatchEvent(new MouseEvent("mousedown",{bubbles:true})); return; }
      if(e.key==="ArrowDown"){ idx=(idx+1)%items.length; }
      else if(e.key==="ArrowUp"){ idx=(idx-1+items.length)%items.length; }
      items.forEach(function(it){ it.classList.remove("active"); });
      if(items[idx]) items[idx].classList.add("active");
    });
  }
  if(selRiderCombo) document.addEventListener("click", function(e){ if(!selRiderCombo.contains(e.target)) selRiderCombo.classList.remove("open"); });

  // 达成标准 / 在线状态 / 预计达标 筛选：纯前端过滤，不触发实时请求
  function _stdApplyFilters(){
    _std.filterAchieved = selAchieved ? selAchieved.value : "";
    _std.filterOnline   = selOnline   ? selOnline.value   : "";
    _std.filterEst      = selEst      ? selEst.value      : "";
    _std.page=1;
    if(_std.mode==="rider") _stdRenderRiders(riderHost, false);
  }
  if(selAchieved) selAchieved.addEventListener("change", _stdApplyFilters);
  if(selOnline)   selOnline.addEventListener("change", _stdApplyFilters);
  if(selEst)      selEst.addEventListener("change", _stdApplyFilters);

  bar.querySelector("#stdGo").addEventListener("click",function(){ _stdGo(); });
  function _stdGo(){
    var goBtn = bar.querySelector("#stdGo");
    if(_stdQuerying) return;                             // 请求进行中，忽略二次触发
    var left0 = _stdCoolLeft();
    if(left0 > 0){ _stdBtnCool(goBtn, left0); return; }   // 冷却中：只校正显示，不发请求
    _std.page=1;                                         // 数据集变了 → 回第 1 页（排序规则保留）
    // 查询按钮 = 唯一允许实时拉取的入口（refresh=1）；按当前维度刷对应视图。
    // 点击瞬间即进 60s 冷却；后端另有服务端频控兜底，返回 429 会再校正剩余秒数。
    _stdCoolMark(60);
    _stdQuerying = true;
    goBtn.disabled = true; goBtn.textContent = "刷新中…";
    var done = function(){
      _stdQuerying = false;
      _stdBtnCool(goBtn, _stdCoolLeft());   // 按当前剩余秒数启动 / 恢复倒计时
    };
    // 全量刷新：一次拉完「参与站点」配置里的**所有**站点（后台任务 + 进度轮询）。
    // 完成后用落盘数据本地重算重渲染当前视图（refresh=0，零上游请求）。
    var _refHost = _std.mode==="rider" ? riderHost : (_std.mode==="settings" ? settingsHost : reportHost);
    _stdRefreshAll(_refHost, function(ok, info){
      done();
      // 刷新是全量共享的：一次 refresh-all 已同时生成「站点维度 + 骑手维度」数据
      // （两者共用同一份原始三源 orders/sched/att，获取已共用）。因此刷新后两个数据
      // tab 一并重算重渲染，切到任意 tab 都直接展示最新数据，无需各自再点一次刷新。
      _stdRenderReport(reportHost);            // 站点维度：读原始三源本地重算
      _stdRenderRiders(riderHost, false);      // 骑手维度：读原始三源本地重算（与站点维度同源）
      if(_std.mode==="settings"){ _stdRenderSettings(settingsHost, {}); }
      // 异常场景明确提示（横幅插在 host 容器之外，避免被重渲染覆盖）：
      // 启动失败/频控/网络异常 → 立即报；部分站点失败 → 完成后报，不阻断成功站点展示。
      if(info && info.error){
        _stdBannerTop(_refHost, "刷新未执行："+info.error);
      } else if(info && info.failed && info.failed.length){
        var names=info.failed.map(function(f){
          return (f.name||f.id)+"（"+(f.error||"未知原因")+"）";
        });
        _stdBannerTop(_refHost, "刷新完成，但有 "+info.failed.length+" 个站点失败："+names.join("；"));
      } else {
        _stdBannerTop(_refHost, "");           // 清掉上一轮可能残留的失败横幅
      }
    });
  }
  // 首屏：恢复上次选中的 tab（默认站点维度），再按对应维度渲染
  var savedMode="station";
  try{ savedMode=localStorage.getItem("standard_last_tab")||"station"; }catch(e){}
  if(["station","rider","settings"].indexOf(savedMode)<0) savedMode="station";
  _stdSwitchTab(savedMode);

  // 刷新页面后按 localStorage 时间戳恢复冷却（倒计时不丢）
  var _left0 = _stdCoolLeft();
  if(_left0 > 0) _stdBtnCool(bar.querySelector("#stdGo"), _left0);
}

/* ============ 「查询（实时数据已刷新）」60s 冷却 —— 前端层 ============
   与后端 /api/standard/* 的 60s 频控互为双保险：
     · 前端层负责体验：点击即置灰 + 「Ns 后重试」倒计时，到期时间戳存
       localStorage，刷新页面可恢复；请求进行中用 _stdQuerying 挡二次触发。
     · 后端层以服务端时间为准（不信任前端传参）；返回 code=RATE_LIMITED
       时前端用 retry_after 校正本地倒计时，两端状态对齐。 */
var _stdCoolTimer = null;      // 倒计时 interval 句柄（_stdCoolKey 声明见文件上方 _std 旁）
var _stdQuerying = false;      // 查询请求进行中，用于挡住二次触发

export function _stdCoolLeft(){
  try{
    var until = parseInt(localStorage.getItem(_stdCoolKey) || "0", 10);
    var left = Math.ceil((until - Date.now()) / 1000);
    return left > 0 ? left : 0;
  }catch(e){ return 0; }
}
export function _stdCoolMark(sec){
  try{ localStorage.setItem(_stdCoolKey, String(Date.now() + Math.max(0, sec|0) * 1000)); }catch(e){}
}
export function _stdCoolClear(){
  try{ localStorage.removeItem(_stdCoolKey); }catch(e){}
}

/* 在 host 容器之前插入一条刷新状态横幅（失败/部分站点失败）。
   插在 host 外部（parentNode 中 host 的前面），这样 host 被重渲染 innerHTML 覆盖时横幅不丢；
   text 传空 → 仅清除上一条横幅（成功刷新时调用以清残留）。 */
export function _stdBannerTop(host, text){
  if(!host || !host.parentNode) return;
  var p=host.parentNode;
  var old=p.querySelector(".std-refresh-banner");
  if(old && old.parentNode) old.parentNode.removeChild(old);
  if(!text) return;
  var d=document.createElement("div");
  d.className="std-banner std-refresh-banner";
  d.style.display="block";
  d.style.background="rgba(196,74,44,.10)";
  d.style.color="#C44A2C";
  d.style.marginBottom="10px";
  d.textContent=text;
  p.insertBefore(d, host);
}

/* 把按钮切到冷却态：置灰 + 每秒刷新「Ns 后重试」，归零自动恢复可点击。 */
export function _stdBtnCool(btn, sec){
  if(!btn) return;
  if(_stdCoolTimer){ clearInterval(_stdCoolTimer); _stdCoolTimer = null; }
  var left = (sec === undefined || sec === null) ? _stdCoolLeft() : (sec|0);
  if(left > 0) _stdCoolMark(left);
  function tick(){
    if(left <= 0){
      if(_stdCoolTimer){ clearInterval(_stdCoolTimer); _stdCoolTimer = null; }
      _stdCoolClear();
      btn.disabled = false;
      btn.textContent = "刷新数据";
      btn.title = "";
      return;
    }
    btn.disabled = true;
    btn.textContent = left + "s 后重试";
    btn.title = "实时数据已刷新 60 秒内只能点一次（避免触发上游限流）";
    left -= 1;
  }
  tick();
  if(left >= 0) _stdCoolTimer = setInterval(tick, 1000);
}

export function _stdRateBadge(rate){
  if(rate===null||rate===undefined) return '<span class="rate rate-none">—</span>';
  var rt=rate/100;
  var cls= rt>=1.0?"rate-ok":(rt>=0.9?"rate-warn":"rate-bad");
  return '<span class="rate '+cls+'">'+rate+'%</span>';
}

/* ============ 骑手维度表头排序 ============
   三态循环：默认(0) → 升序(1) → 降序(-1) → 默认(0)。
   排序状态存 _std.sort（不是 DOM），因此切站点 / 切骑手 / 重新查询后
   都会沿用同一规则；后端不做排序（口径单一来源 = 前端展示层）。 */
export function _stdSortToggle(k){
  if(!k) return;
  var st=_std.sort||(_std.sort={key:null,dir:0});
  if(st.key!==k){ st.key=k; st.dir=1; return; }         // 换列：从头开始（升序）
  st.dir = (st.dir===1) ? -1 : ((st.dir===-1) ? 0 : 1); // 同列：升 → 降 → 默认
  if(st.dir===0) st.key=null;
}
export function _stdSortIcon(dir){
  // dir: 1 升序（上三角高亮） / -1 降序（下三角高亮） / 0 默认（两个三角都半透明）
  return '<svg class="sort-ic" viewBox="0 0 8 13" width="8" height="13" aria-hidden="true">'+
    '<path class="up" d="M4 0.6 L7.6 5 L0.4 5 Z"/>'+
    '<path class="dn" d="M4 12.4 L0.4 8 L7.6 8 Z"/></svg>';
}
export function _stdSortRows(rows, key, dir){
  if(!key || !dir) return rows;
  return rows.slice().sort(function(a,b){
    var va=a[key], vb=b[key];
    if(key==="achieved_label"){
      // 「达成标准」列显示的是等级（标准1…标准5 / 未达标），按等级数值 level 排序。
      // 未排班骑手与排班骑手同一套判定标准（老板 2026-09-09 确认），不单列、不恒排末位。
      va=(a.grade)?a.grade.level:null;
      vb=(b.grade)?b.grade.level:null;
    }
    // 空值（未排班的 None / 空串）恒排末位，不随方向翻转，避免"无数据"混进首尾
    var na=(va===null||va===undefined||va===""), nb=(vb===null||vb===undefined||vb==="");
    if(na&&nb) return 0;
    if(na) return 1;
    if(nb) return -1;
    var fa=parseFloat(va), fb=parseFloat(vb);
    if(!isNaN(fa)&&!isNaN(fb)) return (fa-fb)*dir;      // 数值列：按数值比
    return String(va).localeCompare(String(vb),"zh-Hans-CN")*dir;  // 文本列：中文拼音序
  });
}

/* 全天在线时长展示：分钟数 → 「07小时19分钟」（两位补零，列名不再带单位）。
   None / 空（未排班无考勤）→ 「—」，保持与其余缺失值展示一致。 */
export function _stdFmtHm(v){
  if(v===null||v===undefined||v==="") return "—";
  var m=Math.round(parseFloat(v));
  if(isNaN(m)) return "—";
  var h=Math.floor(m/60), mm=m%60;
  return (h<10?"0":"")+h+"小时"+(mm<10?"0":"")+mm+"分钟";
}
/* 「达成标准」列 = 骑手当前命中的等级（后端 grade.name 为标准1..标准5 / 未定级）。
   展示口径：标准1 … 标准5 原样输出，未定级（没够到标准1）统一叫「未达标」。 */
export function _stdGradeLabel(r){
  var n=(r&&r.grade&&r.grade.name)||"";
  if(!n||n==="未定级") return "未达标";
  return n;
}

/* 分页器：上一页 / 页码窗口（首页与末页常驻，中间只显示当前页 ±2）/ 下一页 + 计数。
   点页码只改 _std.page 再重渲染 —— refresh 语义沿用调用方（非 refresh = 本地重算，零上游请求），
   所以翻页不会重新拉取数据，也不会触碰排序状态。 */
export function _stdPager(page, pages, total, host, refresh){
  var box=document.createElement("div"); box.className="std-pager";
  function mk(label, p, cls, dis){
    var b=document.createElement("button"); b.type="button";
    b.className="pg"+(cls?(" "+cls):""); b.textContent=label;
    if(dis) b.disabled=true;
    else b.addEventListener("click", function(){ _std.page=p; _stdRenderRiders(host, refresh); });
    return b;
  }
  box.appendChild(mk("上一页", Math.max(1,page-1), "", page<=1));
  var win=[], i;
  for(i=1;i<=pages;i++){ if(i===1||i===pages||Math.abs(i-page)<=2) win.push(i); }
  var last=0;
  win.forEach(function(n){
    if(last && n-last>1){ var d=document.createElement("span"); d.className="pg dots"; d.textContent="…"; box.appendChild(d); }
    box.appendChild(mk(String(n), n, n===page?"on":"", false));
    last=n;
  });
  box.appendChild(mk("下一页", Math.min(pages,page+1), "", page>=pages));

  // 每页条数下拉（10/15/20/25/30，默认 20）
  var selWrap=document.createElement("span"); selWrap.className="pg-info pg-size";
  selWrap.appendChild(document.createTextNode("共 "+total+" 条 · 每页 "));
  var sel=document.createElement("select"); sel.className="pg-size-select";
  [10,15,20,25,30].forEach(function(n){
    var opt=document.createElement("option"); opt.value=n; opt.textContent=n; opt.selected=(n===_std.pageSize);
    sel.appendChild(opt);
  });
  sel.addEventListener("change", function(){
    _std.pageSize=parseInt(sel.value,10);
    _std.page=1;
    _stdRenderRiders(host, refresh);
  });
  selWrap.appendChild(sel);
  selWrap.appendChild(document.createTextNode(" 条 · 第 "+page+"/"+pages+" 页"));
  box.appendChild(selWrap);

  return box;
}

/* 全量刷新：POST /api/standard/refresh-all 启动后台任务（逐个参与站点拉三源 + 生成结果），
   再每 2s 轮询 /api/standard/refresh-all-status 直到完成。
   之所以不用同步等待：多站点运单翻页走随机节奏防限流，全量要好几分钟，
   同步请求必然超时；后台任务还能让失败站点单独标出来，不拖垮其它站。
   视觉：表格区域显示大尺寸 loading，取代原来的进度条。 */
export function _stdRefreshAll(tableHost, cb){
  /* 全量刷新：POST /api/standard/refresh-all 启动后台任务（逐个参与站点拉三源 + 生成结果），
     再每 2s 轮询 /api/standard/refresh-all-status。
     之所以不用同步等待：多站点运单翻页走随机节奏防限流，全量要好几分钟，
     同步请求必然超时；后台任务还能让失败站点单独标出来，不拖垮其它站。
     视觉：表格区域显示大尺寸 loading，取代原来的进度条。 */
  tableHost.innerHTML = _stdTableLoader("正在刷新全量数据…", "按站点顺序拉取三源数据，请稍候");
  api("/api/standard/refresh-all", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({start:_std.start||"", end:_std.end||""})
  }).then(function(j){
    if(j && j.code==="RATE_LIMITED"){                     // 服务端频控：校正本地倒计时
      var w=parseInt(j.retry_after||60,10); _stdCoolMark(w);
      cb&&cb(false,{error:"刷新过于频繁，请 "+w+" 秒后再试"}); return;
    }
    if(j && j.code==="BUSY"){ cb&&cb(false,{error:j.error||"已有刷新任务在运行"}); return; }
    if(!j || !j.ok){ cb&&cb(false,{error:(j&&j.error)||"刷新启动失败"}); return; }
    var timer=setInterval(function(){
      api("/api/standard/refresh-all-status").then(function(r){
        var st=(r&&r.status)||{};
        if(!st.running){
          clearInterval(timer);
          // 逐站失败明细（refresh_all._STATE.error = [{id,name,error}]）：不再静默吞掉
          var fails=st.error||[];
          cb&&cb(true, fails.length?{failed:fails}:null);
        }
      }).catch(function(){});   // 单次轮询失败不中断，下个周期继续
    }, 2000);
  }).catch(function(e){ cb&&cb(false,{error:"网络异常，刷新未执行："+String(e)}); });
}

export function _stdRenderRiders(host, refresh, done){
  refresh = !!refresh;
  host.innerHTML=_stdTableLoader("数据加载中…");
  var url="/api/standard/riders?team="+encodeURIComponent(_std.team)+
    "&start="+encodeURIComponent(_std.start)+"&end="+encodeURIComponent(_std.end)+
    (refresh?"&refresh=1":"");
  api(url).then(function(j){
    if(j&&j.code==="RATE_LIMITED"){   // 后端频控：用服务端剩余秒数校正本地倒计时
      var w = parseInt(j.retry_after||60, 10);
      _stdCoolMark(w);
      host.innerHTML='<div class="std-banner" style="display:block">'+esc(j.error || ("请 "+w+" 秒后再试"))+'</div>';
      return; }
    if(j&&j.need_refresh){
      host.innerHTML='<div class="std-banner" style="display:block">今日尚无落盘数据，请点「查询（实时数据已刷新）」拉取</div>';
      return; }
    if(!j||!j.ok||!j.rows||!j.rows.length){
      host.innerHTML='<div class="std-banner" style="display:block">'+
        ("无骑手数据（接口异常或当日无排班）："+(j&&j.error?esc(j.error):""))+'</div>';
      return; }
    var bn=document.createElement("div"); bn.className="std-banner"; bn.style.display="block";
    if(j.source==="cache"){ bn.style.background="rgba(89,107,120,.10)"; bn.style.color="#5A6B78";
      // 缓存路径：实时数据未刷新，展示落盘数据的实际生成时间（与 backend achievement/rider 的 cache_time 同源）
      bn.textContent="实时数据未刷新 · 缓存："+esc(j.cache_time||"未知")+" · 点刷新数据按钮获取实时数据"; }
    else if(j.source==="live"){ bn.style.background="rgba(15,157,88,.10)"; bn.style.color="#0F9D58";
      bn.textContent="实时数据已刷新 · 全天口径"+
        (j.att_time_name?("（考勤取数时段："+esc(j.att_time_name)+"）"):""); }
    else if(j.error){ bn.textContent="实时数据已刷新失败："+esc(j.error||""); }
    // 「达成标准」= 骑手命中的等级（标准一…标准五 / 未达标），与末尾「等级」列重复，已合并，不再单列 grade_name。
    var cols=[["骑手ID","rider_id"],["骑手姓名","rider_name"],["站点","team_name"],
      ["全天有效单量","valid_orders"],["全天有效时长","valid_online_min"],
      ["达成标准","achieved_label"],["单量差值","next_level_order_gap"],
      ["时长差值","prev_level_duration_gap"],["在线状态","online_status"],
      ["预计达标","est_achievable_label"],["全天单量","full_day_orders"],
      ["全天在线时长","full_day_online_min"]];

    // 骑手候选池：供筛选下拉使用（每次渲染后刷新，天然只含本次查询站点的骑手）
    _std.riderPool=(j.rows||[]).map(function(r){
      return {id:r.rider_id, name:r.rider_name, team:r.team_id, teamName:r.team_name};
    });
    if(typeof _stdRiderFill==="function") _stdRiderFill();

    // 骑手筛选：选中具体骑手时只看他一行；「全部骑手」(_std.rider 为空) 不过滤
    var rows=(j.rows||[]).slice();
    if(_std.rider) rows=rows.filter(function(r){
      return String(r.rider_id)===String(_std.rider); });

    // 达成标准 / 在线状态 / 预计达标 前端筛选
    var fa=(_std.filterAchieved||"").trim();
    var fo=(_std.filterOnline||"").trim();
    var fe=(_std.filterEst||"").trim();
    if(fa) rows=rows.filter(function(r){ return _stdGradeLabel(r)===fa; });
    if(fo) rows=rows.filter(function(r){
      // 与渲染一致：旧 cache 的"未排班"回退为真实上下线状态再比对
      var os=r.online_status||"";
      if(os==="未排班"){ var c=r.online_status_code; os=(c===3)?"下线":((c===2)?"小休":"在线"); }
      return os===fo; });
    if(fe) rows=rows.filter(function(r){ return String(r.est_achievable_label||"")===fe; });

    // 表头排序：_std.sort = {key, dir}（dir: 1 升序 / -1 降序 / 0 默认）
    // 状态挂在 _std 上而非 DOM，切站点 / 切骑手 / 重新查询后都会沿用同一规则。
    rows=_stdSortRows(rows, _std.sort&&_std.sort.key, _std.sort&&_std.sort.dir);

    // 分页：筛选 + 排序都在**全量** rows 上做完后才切片，
    // 因此页内顺序就是全局顺序 —— 翻页不重排，也不影响当前排序规则。
    var total=rows.length;
    var pages=Math.max(1, Math.ceil(total/_std.pageSize));
    if(!_std.page||_std.page<1) _std.page=1;
    if(_std.page>pages) _std.page=pages;                    // 数据变少时自动回落末页
    var from=(_std.page-1)*_std.pageSize;
    var pageRows=rows.slice(from, from+_std.pageSize);

    var table=document.createElement("table"); table.className="std-table";
    table.innerHTML='<thead><tr>'+cols.map(function(c){
      var k=c[1];
      var st=(_std.sort&&_std.sort.key===k)?(_std.sort.dir||0):0;
      var cls="std-th-sortable"+(st>0?" on asc":(st<0?" on desc":""));
      return '<th class="'+cls+'" data-k="'+esc(k)+'" title="点击排序：升序 → 降序 → 默认">'+
        '<span class="th-in">'+esc(c[0])+_stdSortIcon(st)+'</span></th>';
    }).join("")+'</tr></thead>';
    // 排序交互：点击表头 → 升序 → 降序 → 默认（三态循环）。
    // 重渲染沿用同一 refresh 语义（非 refresh 时是本地重算，零上游请求）。
    table.querySelector("thead").addEventListener("click", function(ev){
      var th=ev.target.closest?ev.target.closest("th.std-th-sortable"):null;
      if(!th) return;
      _stdSortToggle(th.getAttribute("data-k"));
      _stdRenderRiders(host, refresh);
    });
    var tb=document.createElement("tbody");
    pageRows.forEach(function(r){
      var tr=document.createElement("tr");
      tr.innerHTML=cols.map(function(c){
        var k=c[1];
        if(k==="rider_name"){ var sc=r.scheduled;
          var dot='<span style="color:'+(sc?"#0F9D58":"#F5A623")+';margin-right:5px;font-size:10px" title="'+(sc?"已排班":"未排班有单")+'">●</span>';
          return '<td>'+dot+esc(r.rider_name||"")+'</td>'; }
        if(k==="achieved_label"){
          // 达成标准 = 命中等级；未达标 红色，标准1…标准5 绿色（未排班与排班同标准，无特殊灰）
          var gl=_stdGradeLabel(r);
          var lc=(gl==="未达标")?"rate-bad":"rate-ok";
          return '<td><span class="rate '+lc+'">'+esc(gl)+'</span></td>'; }
        if(k==="est_achievable_label"){ /* 综合五态：已达标/轻松达成=绿，有望达成=橙，不可达标/达成困难=红 */ var lab=r.est_achievable_label; var ec=(lab==="已达标"||lab==="轻松达成")?"rate-ok":(lab==="有望达成")?"rate-warn":"rate-bad"; var tip={"已达标":"有效在线≥6h","不可达标":"加完今天剩余仍不足6h","达成困难":"时长可达标，但单量节奏紧张(需≥8单/时)","有望达成":"时长可达标，单量节奏适中(4~8单/时)","轻松达成":"时长可达标，单量节奏宽松(<4单/时)"}[lab]||lab; return '<td><span class="rate '+ec+'" title="'+esc(tip)+'">'+esc(lab)+'</span></td>'; }
        if(k==="online_status"){
          var os=r.online_status||"";
          // 旧 cache 把未排班骑手覆盖成"未排班"，回退到真实上下线（online_status_code：3=下线 2=小休 其它=在线）
          if(os==="未排班"){ var c=r.online_status_code; os=(c===3)?"下线":((c===2)?"小休":"在线"); }
          var oc=(os==="在线")?"rate-ok":((os==="小休"||os==="申请小休")?"rate-warn":"rate-bad");
          return '<td><span class="rate '+oc+'">'+esc(os)+'</span></td>'; }
        if(k==="valid_online_min"||k==="full_day_online_min") return "<td>"+_stdFmtHm(r[k])+"</td>";
        if(k==="prev_level_duration_gap"){
          // 时长差值：0 或缺失表示「这一轴已够 / 无从比较」，置灰弱化（值本身不改）
          var dv=r[k];
          var dim=(dv==null||dv===0);
          return '<td'+(dim?' class="dim"':'')+'>'+_stdFmtHm(dv)+"</td>"; }
        return "<td>"+esc(r[k])+"</td>";
      }).join("");
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    host.innerHTML=""; host.appendChild(bn); host.appendChild(table);
    if(pages>1) host.appendChild(_stdPager(_std.page, pages, total, host, refresh));
  }).catch(function(e){ host.innerHTML='<div class="std-banner" style="display:block">请求失败：'+esc(String(e))+'</div>';
  }).then(function(){ if(done) done(); });   // 成功 / 失败 / 被限流都收尾，恢复按钮状态
}

/* [已废弃] 参与站点 UI 已于 2026-09-10 移除：站点参与范围改由「等级标准设置」的增/删自动同步 teams-config 维护，
   不再单独渲染参与站点区块。下方 _stdRenderTeamsSummary / _stdOpenTeamPicker 随之成为死代码，保留以备回滚。 */
export function _stdRenderTeamsConfig(host){ /* deprecated: 参与站点 UI 已移除，此入口不再被调用 */ }

/* 已选站点卡片：标题 + 右对齐管理按钮 + 可单独移除的 chips */
export function _stdRenderTeamsSummary(host, all, sel){
  var byId={};
  all.forEach(function(t){ byId[String(t.id)]=t.name||t.id; });
  // 数据全集（含已选但不在 all 里的，避免丢失）
  var data=all.map(function(t){ return [String(t.id), t.name||t.id]; });
  sel.forEach(function(id){
    id=String(id);
    if(!byId[id]){ data.unshift([id, id]); byId[id]=id; }
  });
  sel = sel.map(String);

  host.innerHTML="";
  var card=document.createElement("div"); card.className="st-teams-card";
  var head=document.createElement("div"); head.className="st-teams-card-head";
  var title=document.createElement("div"); title.className="st-teams-card-title";
  var btn=document.createElement("button"); btn.className="st-btn-ghost"; btn.textContent="管理";
  head.appendChild(title); head.appendChild(btn); card.appendChild(head);
  var chips=document.createElement("div"); chips.className="st-teams-chips"; card.appendChild(chips);
  host.appendChild(card);

  function draw(){
    title.innerHTML='已选 <b>'+sel.length+'</b> 个站点';
    chips.innerHTML="";
    if(!sel.length){ chips.innerHTML='<div class="st-empty-chips">暂无站点</div>'; return; }
    sel.forEach(function(id){
      var c=document.createElement("span"); c.className="st-chip";
      var nm=document.createElement("span"); nm.className="nm"; nm.textContent=byId[id]||id; nm.title=byId[id]||id;
      var x=document.createElement("button"); x.className="x"; x.textContent="×"; x.title="移除";
      x.addEventListener("click", function(ev){
        ev.stopPropagation();
        var newSel = sel.filter(function(s){ return String(s)!==id; });
        sel = newSel; draw();
        commit(newSel);   // 移除即保存；commit 内做「同步删除其等级标准」联动
      });
      c.appendChild(nm); c.appendChild(x); chips.appendChild(c);
    });
  }
  draw();

  // 用户主动提交（移除 chips / 弹窗确定）：先取服务端当前参与站点做 diff，再写，
  // 最后执行双向联动（减→删等级标准；增→弹编辑器队列）。同步侧的写不进此函数，不会互触发。
  function commit(newSel, onDone){
    newSel = newSel.map(String);
    api("/api/standard/teams-config").then(function(tc){
      var prev = (tc&&tc.teams||[]).map(String);
      var removed = prev.filter(function(s){ return newSel.indexOf(s)<0; });
      var added   = newSel.filter(function(s){ return prev.indexOf(s)<0; });
      _stdSaveTeams(newSel).then(function(r){
        if(r&&r.ok){
          removed.forEach(function(tid){ _stdDeleteGradeStandard(tid, _stdSettingsCurrentMonth()); });
          var needStd = added.filter(function(tid){ return !_stdGradeHasConfigured(tid); });
          if(needStd.length && _stdOpenGradeEditorFor){
            var queue = needStd.slice();
            (function step(){
              if(!queue.length) return;
              var tid = queue.shift();
              _stdOpenGradeEditorFor(tid, function(){ step(); });
            })();
          }
        }
        if(onDone) onDone(r);
      }).catch(function(e){ if(onDone) onDone({ok:false, error:String(e)}); });
    }).catch(function(e){ if(onDone) onDone({ok:false, error:String(e)}); });
  }

  btn.addEventListener("click", function(){
    _stdOpenTeamPicker(data, sel.slice(), function(newSel){
      sel = newSel.map(String); draw(); commit(newSel);
    });
  });
}

/* 保存参与站点（POST teams-config） */
export function _stdSaveTeams(ids){
  return api("/api/standard/teams-config", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({teams: ids})
  });
}

/* ===== 参与站点 ↔ 等级标准 双向联动（模块级，供两块设置共用）=====
   设计：两侧各自只做原子写；联动在前端编排。任何一侧的「同步写」都走 _stdSaveTeams 直写，
   不触发对方的用户提交逻辑，避免 A→B→A 死循环。参与站点用户提交前先 GET 当前列表做 diff，
   保证同步侧刚写入的变更已被纳入基准，状态不串。 */
var _stdGradeCache = {lastData:null, month:null};   // 等级标准区块注入，供联动判断「该站是否已配标准」
var _stdOpenGradeEditorFor = null;                   // 等级标准区块注入：function(tid, onClose){ openEditor("add", tid, onClose); }

/* 该站本月是否已配置等级标准（用于「参与站点新增→仅对无标准的站弹编辑器」） */
export function _stdGradeHasConfigured(tid){
  var d=_stdGradeCache.lastData;
  if(!d||!d.configured_ids) return false;
  return d.configured_ids.indexOf(String(tid))>=0;
}

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

/* 弹窗选择器：搜索 + 虚拟化列表 + 已选置顶 + 全选/清空 + 确定/取消 */
export function _stdOpenTeamPicker(data, initialSel, onSaved){
  var ROW_H=46, BUFFER=6;
  var state={
    query:"",
    selected:new Set(initialSel.map(String)),
    order:initialSel.map(String),   // 选择顺序 = 保存顺序 = 刷新优先级
    pin:true
  };

  var mask=document.createElement("div"); mask.className="st-modal-mask";
  var modal=document.createElement("div"); modal.className="st-modal";
  mask.appendChild(modal);

  var head=document.createElement("div"); head.className="st-modal-head";
  head.innerHTML='<div class="t">选择参与站点</div>';
  var xBtn=document.createElement("button"); xBtn.className="st-modal-x"; xBtn.innerHTML="&times;"; xBtn.title="关闭";
  head.appendChild(xBtn); modal.appendChild(head);

  var searchWrap=document.createElement("div"); searchWrap.className="st-modal-search";
  var search=document.createElement("input"); search.type="text"; search.placeholder="搜索站点名称或 ID…";
  searchWrap.appendChild(search); modal.appendChild(searchWrap);

  var tb=document.createElement("div"); tb.className="st-modal-toolbar";
  var cnt=document.createElement("div"); cnt.className="cnt";
  var acts=document.createElement("div"); acts.className="acts";
  var btnAll=document.createElement("button"); btnAll.className="st-btn-secondary"; btnAll.textContent="全选";
  var btnNone=document.createElement("button"); btnNone.className="st-btn-secondary"; btnNone.textContent="清空";
  var pin=document.createElement("label"); pin.className="st-pin";
  var pinCb=document.createElement("input"); pinCb.type="checkbox"; pinCb.checked=true;
  pin.appendChild(pinCb); pin.appendChild(document.createTextNode("已选置顶"));
  acts.appendChild(btnAll); acts.appendChild(btnNone); acts.appendChild(pin);
  tb.appendChild(cnt); tb.appendChild(acts); modal.appendChild(tb);

  var listEl=document.createElement("div"); listEl.className="st-modal-list";
  var spacer=document.createElement("div"); spacer.className="st-picker-spacer";
  listEl.appendChild(spacer); modal.appendChild(listEl);

  var foot=document.createElement("div"); foot.className="st-modal-foot";
  var hint=document.createElement("div"); hint.className="hint";
  var btns=document.createElement("div"); btns.className="btns";
  var cancel=document.createElement("button"); cancel.className="st-btn-ghost"; cancel.textContent="取消";
  var ok=document.createElement("button"); ok.className="st-btn-primary"; ok.textContent="确定";
  btns.appendChild(cancel); btns.appendChild(ok);
  foot.appendChild(hint); foot.appendChild(btns); modal.appendChild(foot);

  document.body.appendChild(mask);

  function computeView(){
    var q=state.query.trim().toLowerCase();
    var matched=data.filter(function(p){
      if(!q) return true;
      return (p[1]||"").toLowerCase().indexOf(q)>=0 || String(p[0]).toLowerCase().indexOf(q)>=0;
    });
    if(state.pin){
      var sel=state.order.filter(function(id){ return matched.some(function(p){ return String(p[0])===id; }); })
                         .map(function(id){ return data.find(function(p){ return String(p[0])===id; }); });
      var unsel=matched.filter(function(p){ return !state.selected.has(String(p[0])); });
      return sel.concat(unsel);
    }
    return matched;
  }

  var lastRange="";
  function renderWindow(force){
    var view=computeView();
    spacer.style.height=(view.length*ROW_H)+"px";
    var ch=listEl.clientHeight||360;
    var start=Math.max(0, Math.floor(listEl.scrollTop/ROW_H)-BUFFER);
    var visible=Math.ceil(ch/ROW_H)+BUFFER*2;
    var end=Math.min(view.length, start+visible);
    var range=start+"|"+end;
    if(!force && range===lastRange) return;
    lastRange=range;
    var old=spacer.querySelectorAll(".st-picker-row");
    for(var k=old.length-1;k>=0;k--) old[k].remove();
    var empty=spacer.querySelector(".st-picker-empty"); if(empty) empty.remove();
    if(!view.length){
      var e=document.createElement("div"); e.className="st-picker-empty"; e.textContent="无匹配站点";
      spacer.appendChild(e); return;
    }
    for(var i=start;i<end;i++){
      var p=view[i]; var id=String(p[0]); var on=state.selected.has(id);
      var row=document.createElement("div");
      row.className="st-picker-row"+(on?" on":"");
      row.style.top=(i*ROW_H)+"px"; row.style.height=ROW_H+"px";
      var ordIdx=state.order.indexOf(id);
      row.innerHTML='<span class="cb"></span>'+
        '<div class="info"><div class="name">'+esc(p[1])+'</div><div class="tid">'+esc(id)+'</div></div>'+
        (on&&state.pin?'<span class="ord">'+(ordIdx+1)+'</span>':'');
      row.addEventListener("click", (function(id){ return function(){ toggle(id); }; })(id));
      spacer.appendChild(row);
    }
  }

  function updateMeta(){
    var view=computeView();
    cnt.innerHTML='已选 <b>'+state.selected.size+'</b> / 命中 '+view.length+' 项';
    hint.textContent='已选 '+state.selected.size+' 个站点';
  }

  function toggle(id){
    id=String(id);
    if(state.selected.has(id)){ state.selected.delete(id); state.order=state.order.filter(function(x){return x!==id;}); }
    else { state.selected.add(id); state.order.push(id); }
    renderWindow(true); updateMeta();
  }

  search.addEventListener("input", function(){ state.query=search.value; listEl.scrollTop=0; renderWindow(true); updateMeta(); });
  pinCb.addEventListener("change", function(){ state.pin=pinCb.checked; listEl.scrollTop=0; renderWindow(true); updateMeta(); });
  btnAll.addEventListener("click", function(){ data.forEach(function(p){ var id=String(p[0]); if(!state.selected.has(id)){ state.selected.add(id); state.order.push(id);} }); renderWindow(true); updateMeta(); });
  btnNone.addEventListener("click", function(){ state.selected.clear(); state.order=[]; renderWindow(true); updateMeta(); });
  listEl.addEventListener("scroll", function(){ renderWindow(false); });
  function onKey(e){ if(e.key==="Escape") close(); }
  function close(){ document.removeEventListener("keydown", onKey); if(mask.parentNode) mask.parentNode.removeChild(mask); }
  xBtn.addEventListener("click", close);
  cancel.addEventListener("click", close);
  mask.addEventListener("click", function(e){ if(e.target===mask) close(); });
  ok.addEventListener("click", function(){
    ok.disabled=true; ok.textContent="保存中…";
    _stdSaveTeams(state.order.slice()).then(function(r){
      ok.disabled=false; ok.textContent="确定";
      if(r&&r.ok){ if(onSaved) onSaved(state.order.slice()); close(); }
      else { hint.textContent="保存失败："+((r&&r.error)||"未知错误"); }
    }).catch(function(e){ ok.disabled=false; ok.textContent="确定"; hint.textContent="保存失败："+String(e); });
  });
  document.addEventListener("keydown", onKey);

  renderWindow(true); updateMeta();
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
          _stdGradeCache.lastData=j; _stdGradeCache.month=mo;   // 供参与站点联动判断「该站是否已配标准」
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

  // 注入联动桥：参与站点新增后由此打开「新增」编辑器并预选站点
  _stdOpenGradeEditorFor = function(tid, onClose){ openEditor("add", tid, onClose, true); };

  top.querySelector("#gsManage").addEventListener("click", function(){ if(monthEl.value!==_stdSettingsCurrentMonth()) return; openEditor("manage"); });

  monthEl.addEventListener("change", function(){ syncHist(); load(); _thLoad(); });
  load();
}



/* 自动导出：供其他模块导入的内部顶层符号 */
export { _stdCoolTimer, _stdGradeCache, _stdOpenGradeEditorFor, _stdQuerying, state };
