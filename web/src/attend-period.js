import { store, groupOf, taskById, countInGroup, producerOf, missingText, visibleTasks, taskState, argValue } from "./store.js";
import { api, savePrefs, loadPrefs, readTokens, withToken, ensureTeams } from "./api.js";
import { svg, esc, hexA, toast, debounce, viewHead } from "./ui.js";
import { TK, TK_MAP, RISK_LABEL, RISK_CLS, STATUS_CLS, STATUS_TXT, ICON } from "./tokens.js";
import { bus } from "./bus.js";
import { refreshLan, bindLanToggle, setArg, openSide, closeSide, askConfirm, closeConfirm, bindConfirmUI, lockScroll, unlockScroll } from "./behavior.js";
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

export function _apEnsureStyle(){
  if(document.getElementById("ap-css")) return;
  var s = document.createElement("style"); s.id = "ap-css";
  s.textContent = `
  .ap-wrap{display:flex;flex-direction:column;gap:14px}
  .ap-tabs{display:flex;gap:8px;margin-bottom:2px}
  .ap-tab{padding:7px 16px;border:1px solid var(--c-border,#e3e3e6);background:var(--c-white,#fff);
    border-radius:8px;font-size:14px;cursor:pointer;color:var(--muted)}
  .ap-tab.on{background:var(--brand,#FF5000);color:#fff;border-color:var(--brand,#FF5000)}
  .ap-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
    padding:60px 24px;background:var(--card);border:1px dashed var(--c-border,#e3e3e6);
    border-radius:var(--r-card);text-align:center}
  .ap-empty-ic{width:52px;height:52px;border-radius:14px;display:flex;align-items:center;justify-content:center;
    background:var(--c-cyan-soft,#E6F4F8);color:var(--cyan,#0891B2)}
  .ap-empty-ic svg{width:26px;height:26px}
  .ap-empty-title{font-size:16px;font-weight:700;color:var(--c-ink,#1a1a1a)}
  .ap-empty-sub{font-size:13px;line-height:1.6;max-width:540px;color:var(--muted)}
  .ap-empty-zone{margin-top:6px;align-self:stretch;max-width:560px;width:100%;
    border:1px dashed var(--c-border,#e3e3e6);border-radius:var(--r-card);padding:18px;text-align:center;
    font-size:12px;color:var(--muted);background:var(--c-white,#fff)}
  /* 工具栏（站点 / 日期 / 查询） */
  .ap-bar{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;background:var(--card);
    border:1px solid var(--c-border,#eee);border-radius:var(--r-card);padding:14px 16px;box-shadow:var(--shadow-1)}
  .ap-bar label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
  .ap-bar select,.ap-bar input[type=date]{padding:8px 10px;border:1px solid var(--c-border,#e3e3e6);
    border-radius:8px;font-size:14px;background:var(--c-white,#fff);color:var(--c-ink,#1a1a1a);min-width:120px}
  .ap-btn{padding:9px 18px;border:none;border-radius:8px;background:var(--brand,#FF5000);color:#fff;
    font-weight:600;cursor:pointer}
  .ap-btn:hover{filter:brightness(.95)}
  .ap-btn:disabled{opacity:.55;cursor:not-allowed;filter:none}
  .ap-meta{font-size:12px;color:var(--muted);margin-left:auto;align-self:center}
  .ap-err{font-size:13px;color:#E02020;padding:10px 0}
  /* 汇总卡片 */
  .ap-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px}
  .ap-card{background:var(--card);border:1px solid var(--c-border,#eee);border-radius:var(--r-card);
    padding:16px;box-shadow:var(--shadow-1)}
  .ap-card .k{font-size:12px;color:var(--muted)}
  .ap-card .v{font-size:26px;font-weight:700;margin-top:6px;color:var(--c-ink,#1a1a1a)}
  .ap-card .v.cyan{color:var(--cyan,#0891B2)}
  /* 时段有效 表格 */
  .ap-table{width:100%;border-collapse:collapse;background:var(--card);border-radius:var(--r-card);
    overflow:hidden;box-shadow:var(--shadow-1);font-size:13px}
  .ap-table th,.ap-table td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--c-border,#eee)}
  .ap-table th{background:var(--surface-sunken,#f6f7f9);color:var(--muted);font-weight:600;white-space:nowrap}
  .ap-table tbody tr:hover{background:var(--surface-sunken,#fafbfc)}
  .ap-table td.num,.ap-table th.num{text-align:right;font-variant-numeric:tabular-nums}
  .ap-table td.center,.ap-table th.center{text-align:center}
  /* 站点数据：4 张卡片（竖向排列），每张按系统设置时段展开分组表头 */
  .ap-station-card{margin:14px 0;background:var(--card);border:1px solid var(--c-border,#eee);border-radius:var(--r-card);overflow:hidden}
  .ap-station-card-h{padding:10px 14px;font-weight:700;color:var(--c-ink,#1a1a1a);background:var(--surface-sunken,#f6f7f9);border-bottom:1px solid var(--c-border,#eee);font-size:14px}
  .ap-station-table{table-layout:auto;width:100%;border-collapse:collapse;font-size:12px}
  .ap-station-table th,.ap-station-table td{padding:3px 4px;border-bottom:1px solid var(--c-border,#eee);white-space:nowrap}
  .ap-station-table th{color:var(--muted);font-weight:600;font-size:11.5px;text-align:center}
  .ap-station-table th.ap-grp{background:#eceef1;font-size:12px;color:var(--c-ink,#1a1a1a)}
  .ap-station-table th.ap-pcol{font-weight:600;color:var(--muted);font-size:11px}
  .ap-station-table td.num{text-align:right;font-variant-numeric:tabular-nums}
  .ap-station-table td.center{text-align:center;font-variant-numeric:tabular-nums}
  .ap-station-table tbody tr:hover td{background:var(--surface-sunken,#fafbfc)}
  .ap-station-table .ap-fd{display:inline-block;margin-left:2px;font-size:9px;color:var(--brand,#FF5000);font-weight:700}
  .ap-station-table .ap-badge{padding:1px 3px;font-size:10px;border-radius:999px;line-height:1.4}
  /* 合并列「分子/分母」：分子加重、分母弱化、分隔符中性色，便于一眼读达成结构 */
  .ap-station-table td.ap-combo{text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap}
  .ap-station-table .ap-cn{font-weight:600;color:var(--c-ink,#1a1a1a)}
  .ap-station-table .ap-slash{color:var(--muted);margin:0 1px;font-weight:400}
  .ap-station-table .ap-cd{color:var(--muted)}
  /* 冻结首两列（站点ID / 站点名称）+ 表头吸顶，横向滚动时保持可见 */
  .ap-station-table thead th{position:sticky;top:0;z-index:3;background:var(--surface-sunken,#f6f7f9)}
  .ap-station-table .ap-col-id{position:sticky;left:0;z-index:2;background:var(--card);font-weight:600}
  .ap-station-table .ap-col-name{position:sticky;left:var(--ap-id-w,64px);z-index:2;background:var(--card);overflow:hidden;text-overflow:ellipsis}
  .ap-station-table thead .ap-col-id,.ap-station-table thead .ap-col-name{z-index:4;background:var(--surface-sunken,#f6f7f9)}
  .ap-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-weight:600;font-size:12px}
  .ap-badge.ok{background:rgba(15,157,88,.12);color:#0F9D58}
  .ap-badge.warn{background:rgba(245,166,35,.15);color:#B9770E}
  .ap-badge.bad{background:rgba(224,32,32,.12);color:#E02020}
  .ap-badge.none{color:var(--muted);background:var(--surface-sunken,#f6f7f9)}
  .ap-slot{font-weight:600;color:var(--c-ink,#1a1a1a)}
  .ap-range{color:var(--muted);font-size:12px}
  .ap-note{font-size:12px;color:var(--muted);padding:4px 2px}
  /* 系统设置 面板（与 ap-card / 主题变量同源，保持视觉一致、独立渲染） */
  .ap-settings{display:flex;flex-direction:column;gap:16px}
  .ap-set-card{background:var(--card);border:1px solid var(--c-border,#eee);border-radius:var(--r-card);
    padding:16px 18px;box-shadow:var(--shadow-1)}
  .ap-set-card h3{margin:0 0 4px;font-size:15px;color:var(--c-ink,#1a1a1a)}
  .ap-set-card .desc{font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:12px}
  .ap-set-rows{display:flex;flex-direction:column;gap:10px}
  .ap-set-row{display:flex;align-items:center;justify-content:space-between;gap:14px;
    padding:10px 12px;background:var(--surface-sunken,#f6f7f9);border-radius:8px}
  .ap-set-row .lab{font-size:13px;color:var(--c-ink,#1a1a1a)}
  .ap-set-row .lab small{display:block;font-size:11px;color:var(--muted);margin-top:2px}
  .ap-set-row .val{font-size:13px;color:var(--muted)}
  .ap-set-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;
    background:var(--c-cyan-soft,#E6F4F8);color:var(--cyan,#0891B2)}
  /* 时段设置 表格 —— 统一布局：固定列宽、全部居中、禁止换行 */
  .ap-period-table{table-layout:fixed;width:100%;border-collapse:collapse;font-size:13px;
    background:var(--card,#fff);border-radius:var(--r-card);overflow:hidden;border:1px solid var(--c-border,#eef0f2)}
  .ap-period-table th,.ap-period-table td{text-align:center;vertical-align:middle;padding:11px 6px;white-space:nowrap;
    line-height:1.3;border-bottom:1px solid var(--c-border,#eef0f2);box-sizing:border-box}
  .ap-period-table th{background:var(--surface-sunken,#f6f7f9);color:var(--muted);font-weight:600;font-size:12.5px}
  .ap-period-table td{color:var(--c-ink,#1a1a1a)}
  .ap-period-table tbody tr:hover{background:var(--surface-sunken,#fafbfc)}
  .ap-period-table th:nth-child(1),.ap-period-table td:nth-child(1){width:34px}   /* 拖拽手柄列 */
  .ap-period-table th:nth-child(2),.ap-period-table td:nth-child(2),
  .ap-period-table th:nth-child(3),.ap-period-table td:nth-child(3){width:92px}
  .ap-period-table th:nth-child(4),.ap-period-table td:nth-child(4){width:112px}
  .ap-period-table th:nth-child(5),.ap-period-table td:nth-child(5){width:98px}
  .ap-period-table th:nth-child(6),.ap-period-table td:nth-child(6){width:108px}
  .ap-period-table th:nth-child(7),.ap-period-table td:nth-child(7){width:84px}
  .ap-period-table th:nth-child(8),.ap-period-table td:nth-child(8){width:84px}
  /* 方案E：响应式包裹 + 行内操作 + 时段时长自动列 + 底部保存条 + 拖拽排序 */
  .ap-table-wrap{overflow-x:auto;padding:var(--r-card)}  /* 表格与卡片边框留出空隙，大小=卡片圆角(--r-card=6px)，随设计规范联动 */
  .ap-period-table th.ap-act-col,.ap-period-table td.ap-act-col{width:104px}
  /* 拖拽排序：手柄列 / 拖拽中行 / 实时插入指示线 */
  .ap-drag-col{font-size:12px;color:var(--muted,#999)}
  .ap-drag-cell{text-align:center;color:var(--muted,#999);cursor:grab;user-select:none;vertical-align:middle;padding:0}
  .ap-drag-cell .ap-grip{display:inline-block;line-height:1;font-size:15px;letter-spacing:-2px}
  .ap-period-table tr[draggable=true]{cursor:grab}
  .ap-period-table tr[draggable=true]:active{cursor:grabbing}
  .ap-period-table tr.ap-dragging{opacity:.4;background:rgba(255,80,0,.06)}
  .ap-period-table tr.ap-drop-before > td{box-shadow:inset 0 3px 0 0 var(--accent,#FF5000)}
  .ap-period-table tr.ap-drop-after  > td{box-shadow:inset 0 -3px 0 0 var(--accent,#FF5000)}
  .ap-period-table tr.ap-drop-before.ap-drop-after > td{box-shadow:none}
  .ap-period-dur-auto{color:var(--muted,#999);background:rgba(0,0,0,.03);border-radius:6px;font-size:12px}
  .ap-row-act{display:inline-flex;gap:6px;justify-content:center;flex-wrap:wrap}
  .ap-row-act button{font-size:12px;padding:4px 9px;border-radius:6px;border:1px solid var(--c-border,#e3e3e6);background:var(--c-white,#fff);color:var(--c-ink,#1a1a1a);cursor:pointer;line-height:1.4}
  .ap-row-act button:hover{border-color:var(--accent,#FF5000);color:var(--accent,#FF5000)}
  .ap-row-act button.danger:hover{border-color:#dc2626;color:#dc2626}
  .ap-period-foot{display:flex;align-items:center;gap:12px;margin-top:14px;flex-wrap:wrap}
  .ap-btn-save{padding:7px 18px;border-radius:8px;border:1px solid var(--accent,#FF5000);background:var(--accent,#FF5000);color:#fff;font-size:13px;cursor:pointer}
  .ap-btn-save:disabled{opacity:.45;cursor:not-allowed;background:var(--c-white,#fff);color:var(--muted);border-color:var(--c-border,#e3e3e6)}
  .ap-period-table td input[type=text],
  .ap-period-table td input[type=number]{width:100%;box-sizing:border-box;padding:5px 4px;border:1px solid var(--c-border,#e3e3e6);
    border-radius:6px;font-size:13px;background:var(--c-white,#fff);color:var(--c-ink,#1a1a1a);text-align:center}
  .ap-period-table td.ap-ro{padding:11px 6px;color:var(--c-ink,#1a1a1a)}
  .ap-time-cell{display:inline-block;min-width:74px;padding:6px 10px;border:1px solid var(--c-border,#e3e3e6);border-radius:6px;
    background:var(--surface,#fff);color:var(--c-ink,#1a1a1a);font-size:13px;cursor:pointer;font-variant-numeric:tabular-nums;white-space:nowrap}
  .ap-time-cell:hover{border-color:var(--accent,#FF5000);color:var(--accent,#FF5000)}
  /* 骑手明细：骑手 × 时段 达标矩阵 */
  .ap-rider-table{table-layout:auto;font-size:13px}
  .ap-rider-table th,.ap-rider-table td{padding:8px 10px;border-bottom:1px solid var(--c-border,#eef0f2);white-space:nowrap;
    line-height:1.3;text-align:center;vertical-align:middle;box-sizing:border-box}
  .ap-rider-table th{background:var(--surface-sunken,#f6f7f9);color:var(--muted);font-weight:600;font-size:12.5px;position:relative}
  .ap-rider-table td{color:var(--c-ink,#1a1a1a)}
  .ap-rider-table tbody tr:hover{background:var(--surface-sunken,#fafbfc)}
  .ap-th-range{font-weight:400;font-size:11px;color:var(--muted);margin-top:2px}
  /* 前 3 列 sticky（骑手ID / 姓名 / 站点）随横向滚动固定 */
  .ap-rider-table th.sticky-col,.ap-rider-table td.sticky-col{position:sticky;left:0;z-index:2;
    background:var(--card,#fff);text-align:left}
  .ap-rider-table th.sticky-col{z-index:3;background:var(--surface-sunken,#f6f7f9)}
  .ap-rider-table tbody tr:hover td.sticky-col{background:var(--surface-sunken,#fafbfc)}
  /* 前 3 列 sticky（骑手ID / 姓名 / 站点）随横向滚动固定，按实际列宽设置 left 偏移避免重叠 */
  .ap-rider-table th.ap-rid,.ap-rider-table td.ap-rid{left:0;min-width:96px;width:96px;text-align:left}
  .ap-rider-table th.ap-rname,.ap-rider-table td.ap-rname{left:96px;min-width:100px;width:100px;text-align:left}
  .ap-rider-table th.ap-site-col,.ap-rider-table td.ap-site-col{left:196px;min-width:130px;width:130px;text-align:left}
  /* 时段达标单元格 */
  .ap-cell-ok{color:#16a34a;font-weight:700;font-size:15px}
  .ap-cell-bad{color:#dc2626;font-weight:700;font-size:15px}
  .ap-cell-na{color:var(--muted,#999);font-weight:700;font-size:15px}
  .ap-cell-rest{color:var(--muted,#bbb);font-size:14px}

  /* 时间选择弹窗（与月份弹窗同源视觉规范） */
  .ap-time-backdrop{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.35)}
  .ap-time-modal{background:var(--card,#fff);border:1px solid var(--c-border,#e3e3e6);border-radius:16px;box-shadow:0 16px 44px rgba(0,0,0,.18);padding:18px 16px 16px;width:min(280px,100%);max-width:280px;display:flex;flex-direction:column;align-items:stretch;box-sizing:border-box}
  .ap-time-head{font-size:16px;font-weight:600;color:var(--c-ink,#1a1a1a);text-align:center;margin-bottom:16px;line-height:1.2}
  .ap-time-cols{position:relative;display:flex;align-items:stretch;justify-content:center;height:210px;overflow:hidden;border-radius:12px;background:var(--surface,#f8f9fa)}
  /* 上下渐变遮罩：提示可滚动，同时遮住未对齐的首尾项 */
  .ap-time-cols::before,.ap-time-cols::after{content:"";position:absolute;left:0;right:0;height:52px;pointer-events:none;z-index:2}
  .ap-time-cols::before{top:0;background:linear-gradient(to bottom,var(--surface,#f8f9fa),transparent)}
  .ap-time-cols::after{bottom:0;background:linear-gradient(to top,var(--surface,#f8f9fa),transparent)}
  .ap-time-indicator{position:absolute;top:50%;left:10px;right:10px;height:36px;transform:translateY(-50%);background:rgba(255,80,0,.08);border:1px solid rgba(255,80,0,.28);border-radius:10px;pointer-events:none;z-index:1}
  .ap-time-col{flex:0 0 70px;width:70px;height:210px;overflow-y:auto;overflow-x:hidden;scroll-snap-type:y mandatory;padding:87px 0;text-align:center;position:relative;scrollbar-width:none;-ms-overflow-style:none}
  .ap-time-col::-webkit-scrollbar{display:none}
  .ap-time-item{height:36px;line-height:36px;scroll-snap-align:center;font-size:18px;color:var(--c-ink,#1a1a1a);cursor:pointer;border-radius:8px;font-variant-numeric:tabular-nums;position:relative;z-index:3}
  .ap-time-item:hover{background:rgba(255,80,0,.06)}
  .ap-time-item.sel{color:var(--accent,#FF5000);font-weight:700;background:transparent}
  .ap-time-sep{flex:0 0 20px;width:20px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:var(--muted);user-select:none;z-index:3}
  .ap-time-foot{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
  .ap-time-cancel,.ap-time-ok{min-width:64px;padding:8px 16px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;transition:all .15s;line-height:1.2}
  .ap-time-cancel{border:1px solid var(--c-border,#e3e3e6);background:var(--surface,#fff);color:var(--c-ink,#1a1a1a)}
  .ap-time-cancel:hover{border-color:var(--accent,#FF5000);color:var(--accent,#FF5000)}
  .ap-time-ok{border:1px solid var(--accent,#FF5000);background:var(--accent,#FF5000);color:#fff}
  .ap-time-ok:hover{filter:brightness(.95)}
  @media(max-width:360px){
    .ap-time-modal{padding:16px 12px 14px}
    .ap-time-col{flex:0 0 64px;width:64px}
    .ap-time-sep{flex:0 0 18px;width:18px}
  }
  /* 设置面板 通用（头部 / 月份切换 / 编辑态 / 提示） */
  .ap-set-foot{display:flex;align-items:center;gap:12px;margin-top:14px;flex-wrap:wrap}
  .ap-set-msg{font-size:12px;padding:4px 10px;border-radius:6px;display:none}
  .ap-set-msg.ok{color:#2a9d3a;background:#e8f5e9}
  .ap-set-msg.err{color:#c0392b;background:#fdecea}
  .ap-set-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
  .ap-set-head .desc{margin-bottom:0}
  .ap-btn-edit{min-width:76px}
  .ap-btn-edit.saving{background:#2a9d3a}
  .ap-month-bar{position:relative;display:flex;align-items:center;gap:10px;margin:2px 0 12px;flex-wrap:wrap}
  .ap-month-trigger{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border:1px solid var(--c-border,#e3e3e6);border-radius:8px;
    background:var(--surface,#fff);color:var(--c-ink,#1a1a1a);font-size:13px;cursor:pointer;min-width:158px}
  .ap-month-trigger:hover{border-color:var(--accent,#FF5000)}
  .ap-month-trigger.open{border-color:var(--accent,#FF5000);box-shadow:0 0 0 2px rgba(255,80,0,.12)}
  .ap-month-trigger .ic{font-size:14px}
  .ap-month-trigger .caret{margin-left:auto;color:var(--muted);transition:transform .15s}
  .ap-month-trigger.open .caret{transform:rotate(180deg)}
  .ap-month-trigger:disabled{opacity:.5;cursor:not-allowed}
  .ap-month-popup{display:none;position:absolute;top:calc(100% + 6px);left:0;z-index:50;background:var(--card,#fff);
    border:1px solid var(--c-border,#e3e3e6);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:10px;min-width:248px}
  .ap-mp-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .ap-mp-nav{width:30px;height:30px;border:1px solid var(--c-border,#e3e3e6);border-radius:8px;background:var(--surface,#fff);
    color:var(--c-ink,#1a1a1a);font-size:16px;line-height:1;cursor:pointer}
  .ap-mp-nav:hover{border-color:var(--accent,#FF5000);color:var(--accent,#FF5000)}
  .ap-mp-label{font-size:14px;font-weight:600;color:var(--c-ink,#1a1a1a)}
  .ap-mp-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
  .ap-mp-cell{padding:9px 0;text-align:center;font-size:13px;border-radius:8px;cursor:pointer;color:var(--c-ink,#1a1a1a);
    border:1px solid transparent;user-select:none}
  .ap-mp-cell:hover{background:var(--surface-sunken,#f6f7f9)}
  .ap-mp-cell.focus{background:rgba(255,80,0,.10);font-weight:600}
  .ap-mp-cell.selected{border-color:var(--accent,#FF5000);color:var(--accent,#FF5000);font-weight:700}
  .ap-month-hint{font-size:12px;color:var(--muted)}
  .ap-month-hint.ok{color:#2a9d3a}
  .ap-month-hint.err{color:#c0392b}
  /* 站点管理（系统设置 → 站点管理）：框内展示已选 + 右上角管理按钮 + 弹窗多选 combobox */
  .ap-btn-sm{padding:6px 12px;font-size:13px;border:none;border-radius:8px;background:var(--surface-sunken,#f0f1f3);color:var(--c-ink,#1a1a1a);cursor:pointer}
  .ap-btn-sm:hover{filter:brightness(.97)}
  .ap-btn-primary{background:var(--brand,#FF5000);color:#fff;border:none}
  .ap-btn-primary:hover{filter:brightness(.96)}
  .ap-btn-primary:disabled{opacity:.6;cursor:default}
  .ap-teams-box{border:1px solid var(--c-border,#e3e3e6);border-radius:var(--r-card);background:var(--surface,#fff);padding:14px 16px}
  .ap-teams-box-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .ap-teams-box-title{font-size:13px;font-weight:600;color:var(--c-ink,#1a1a1a)}
  .ap-teams-box-title b{color:var(--brand,#FF5000)}
  .ap-teams-box-hint{font-size:12px;color:var(--muted);margin-top:10px}
  .ap-teams-chips{display:flex;flex-wrap:wrap;gap:8px;min-height:32px;align-items:center}
  .ap-teams-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border:1px solid var(--brand,#FF5000);border-radius:999px;background:rgba(255,80,0,.07);color:var(--brand,#FF5000);font-size:13px;font-weight:500}
  .ap-teams-chips-empty{color:var(--muted);font-size:13px;padding:4px 2px}
  /* 弹窗 */
  .ap-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px}
  .ap-modal{width:min(560px,100%);max-height:88vh;display:flex;flex-direction:column;background:var(--c-white,#fff);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.28);overflow:hidden}
  .ap-modal-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--c-border,#e3e3e6)}
  .ap-modal-head h3{margin:0;font-size:16px;color:var(--c-ink,#1a1a1a)}
  .ap-modal-x{border:none;background:transparent;font-size:22px;line-height:1;color:var(--muted);cursor:pointer;padding:0 4px}
  .ap-modal-x:hover{color:var(--c-ink,#1a1a1a)}
  .ap-modal-body{padding:16px 18px;overflow-y:auto}
  .ap-modal-foot{display:flex;justify-content:flex-end;gap:10px;padding:14px 18px;border-top:1px solid var(--c-border,#e3e3e6)}
  /* 多选 combobox */
  .ap-combo{position:relative}
  .ap-combo-box{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-height:44px;padding:7px 10px;border:1px solid var(--c-border,#e3e3e6);border-radius:10px;background:var(--c-white,#fff);cursor:text}
  .ap-combo.open .ap-combo-box{border-color:var(--accent,#FF5000);box-shadow:0 0 0 3px rgba(255,80,0,.12)}
  .ap-combo-ph{color:var(--muted);font-size:13px}
  .ap-combo-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;background:rgba(255,80,0,.1);color:var(--brand,#FF5000);font-size:13px}
  .ap-combo-chip b{font-weight:500}
  .ap-combo-x{cursor:pointer;font-style:normal;font-weight:700;opacity:.7}
  .ap-combo-x:hover{opacity:1}
  .ap-combo-panel{position:fixed;left:0;top:0;z-index:10000;background:var(--c-white,#fff);border:1px solid var(--c-border,#e3e3e6);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.16);padding:8px;display:none}
  .ap-combo-panel.show{display:block}
  .ap-combo-search{width:100%;padding:8px 10px;border:1px solid var(--c-border,#e3e3e6);border-radius:8px;font-size:13px;margin-bottom:8px;box-sizing:border-box;background:var(--c-white,#fff);color:var(--c-ink,#1a1a1a)}
  .ap-combo-search:focus{border-color:var(--accent,#FF5000);box-shadow:0 0 0 3px rgba(255,80,0,.12)}
  .ap-combo-opts{max-height:240px;overflow-y:auto}
  .ap-combo-opt{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;font-size:13px;color:var(--c-ink,#1a1a1a);cursor:pointer}
  .ap-combo-opt:hover{background:var(--surface-sunken,#f0f1f3)}
  .ap-combo-ck{flex:0 0 auto;width:16px;height:16px;border:1.5px solid var(--c-border,#cbd5e1);border-radius:4px;position:relative;box-sizing:border-box}
  .ap-combo-opt.on .ap-combo-ck{background:var(--brand,#FF5000);border-color:var(--brand,#FF5000)}
  .ap-combo-opt.on .ap-combo-ck::after{content:"";position:absolute;left:5px;top:1px;width:4px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
  .ap-combo-oid{color:var(--muted);font-size:11px;margin-left:auto;flex:0 0 auto}
  .ap-combo-empty{padding:16px;text-align:center;color:var(--muted);font-size:13px}
  .ap-combo-foot{display:flex;align-items:center;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--c-border,#e3e3e6)}
  .ap-combo-count{font-size:12px;color:var(--muted)}
  /* 骑手明细：工具栏搜索 / 排序 / 筛选 */
  .ap-rider-bar{flex-wrap:wrap}
  .ap-rider-tools{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-left:auto}
  .ap-in{padding:8px 10px;border:1px solid var(--c-border,#e3e3e6);border-radius:8px;font-size:13px;background:var(--c-white,#fff);color:var(--c-ink,#1a1a1a);min-width:160px}
  .ap-in:focus{outline:none;border-color:var(--accent,#FF5000);box-shadow:0 0 0 3px rgba(255,80,0,.12)}
  .ap-sel{padding:8px 10px;border:1px solid var(--c-border,#e3e3e6);border-radius:8px;font-size:13px;background:var(--c-white,#fff);color:var(--c-ink,#1a1a1a)}
  .ap-chk{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);cursor:pointer}
  .ap-chk input{accent-color:var(--accent,#FF5000)}
  .ap-card-filter{background:rgba(255,80,0,.06);border-color:rgba(255,80,0,.25)}
  .ap-card-filter b{color:var(--accent,#FF5000)}
  /* 骑手明细：滚动容器 + 双轴吸顶 + 斑马纹 */
  .ap-rider-scroll{max-height:62vh;overflow:auto;border-radius:var(--r-card);box-shadow:var(--shadow-1);background:var(--card)}
  /* 骑手明细加载动画：请求发起→返回期间持续展示，纯动画无文字，约占表格区域 1/4 并居中 */
  .ap-rider-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;
    min-height:240px;width:100%;gap:18px}
  .ap-rider-spinner{width:72px;height:72px;border-radius:50%;
    border:7px solid var(--surface-sunken,#eef0f2);border-top-color:var(--cyan,#0891B2);
    animation:ap-spin .9s linear infinite}
  .ap-rider-pulse{width:160px;height:8px;border-radius:999px;background:var(--surface-sunken,#eef0f2);
    overflow:hidden;position:relative}
  .ap-rider-pulse::after{content:"";position:absolute;left:-40%;top:0;height:100%;width:40%;border-radius:999px;
    background:linear-gradient(90deg,transparent,var(--cyan,#0891B2),transparent);animation:ap-pulse 1.4s ease-in-out infinite}
  @keyframes ap-spin{to{transform:rotate(360deg)}}
  @keyframes ap-pulse{to{left:100%}}
  /* 无数据 / 占位：纯图标、无文字 */
  .ap-rider-empty{min-height:200px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--muted)}
  .ap-rider-table{table-layout:auto;font-size:13px;margin:0;border-collapse:separate;border-spacing:0}
  .ap-rider-table thead th{position:sticky;top:0;z-index:5;background:var(--surface-sunken,#f6f7f9)}
  .ap-rider-table thead th.sticky-col{z-index:6}
  .ap-rider-table tbody tr:nth-child(4n+1) td:not(.sticky-col),
  .ap-rider-table tbody tr:nth-child(4n+2) td:not(.sticky-col){background:rgba(0,0,0,.022)}
  .ap-rider-table tbody tr.ap-rider-detail td{background:var(--surface-sunken,#fafbfc)}
  .ap-rider-row{cursor:pointer}
  .ap-rider-row:hover td{background:var(--surface-sunken,#fafbfc)}
  .ap-rider-row.ap-row-open td{background:rgba(255,80,0,.05)}
  .ap-rid{font-variant-numeric:tabular-nums;color:var(--muted)}
  .ap-rname{font-weight:600;text-align:left}
  /* 热力单元格：状态色块 + 实际/要求单量 */
  .ap-cell{font-size:12px}
  .ap-glyph{display:block;font-size:15px;font-weight:700;line-height:1.1}
  .ap-cell-ok .ap-glyph{color:#16a34a}
  .ap-cell-bad .ap-glyph{color:#dc2626}
  .ap-cell-na .ap-glyph{color:var(--muted,#999)}
  .ap-cell-sub{display:block;font-size:10.5px;color:var(--muted);margin-top:1px;font-variant-numeric:tabular-nums}
  .ap-cell-ok{background:rgba(22,163,74,.08)}
  .ap-cell-bad{background:rgba(220,38,38,.08)}
  .ap-cell-na{background:rgba(120,120,120,.06)}
  .ap-cell-rest{color:var(--muted,#bbb);font-size:14px}
  .ap-cell-future{color:#94a3b8;font-size:12px;font-weight:600;background:rgba(148,163,184,.07)}
  .ap-cell-now{outline:2px solid rgba(37,99,235,.45);outline-offset:-2px}
  .ap-num{font-variant-numeric:tabular-nums}
  /* 达标率迷你进度条 */
  .ap-rate{position:relative;min-width:64px;height:18px;background:var(--surface-sunken,#f0f1f3);border-radius:999px;overflow:hidden;display:inline-block;vertical-align:middle}
  .ap-rate-bar{position:absolute;left:0;top:0;bottom:0;border-radius:999px}
  .ap-rate-ok{background:#16a34a}
  .ap-rate-warn{background:#f59e0b}
  .ap-rate-bad{background:#dc2626}
  .ap-rate-na{background:transparent}
  .ap-rate-txt{position:relative;z-index:1;font-size:11px;line-height:18px;padding:0 8px;font-variant-numeric:tabular-nums;color:var(--c-ink,#1a1a1a)}
  .ap-empty-row{text-align:center;color:var(--muted);padding:22px;font-size:13px}
  /* 表头排序：仅当前排序列显示小箭头（1 字符，不撑宽其它列）；th 已 position:relative */
  .ap-rider-table th[data-sort]{cursor:pointer;user-select:none}
  .ap-rider-table th[data-sort]:hover{background:var(--surface-sunken-2,#eceef1)}
  .ap-rider-table thead th[data-sort].sticky-col:hover{background:var(--surface-sunken-2,#eceef1)}
  .ap-sort-ic{display:inline-block;margin-left:5px;font-size:10px;line-height:1;color:#2563eb;font-weight:700;vertical-align:middle}
  /* 行下钻明细（accordion） */
  .apd{padding:12px 16px}
  .apd-head{font-size:13px;font-weight:600;color:var(--c-ink,#1a1a1a);margin-bottom:8px}
  .apd-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:6px 0;border-bottom:1px dashed var(--c-border,#eee)}
  .apd-row:last-child{border-bottom:none}
  .apd-t{font-weight:600;min-width:120px}
  .apd-t small{font-weight:400;color:var(--muted);margin-left:4px}
  .apd-v{color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums}
  .apd-rest .apd-v{font-style:italic}
  .apd-row .ap-badge{margin-left:auto}
  @media(max-width:560px){
    .ap-rider-tools{margin-left:0;width:100%}
    .ap-in{flex:1;min-width:0}
  }
  `;
  document.head.appendChild(s);
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
  _apEnsureStyle();
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
      if(!ids.length) ids = ["917521136"];   // 兜底：绝不空白
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
        '<option value="917521136">长安万科站</option>';
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
  function _apRenderRiderGrid(){
    var body = document.getElementById("apRiderBody");
    if(!body) return;
    var j = _apRiderData;
    var now = new Date();
    if(!j) return;
    var isAll = (j.team === "__all__");
    if(!j.ok){ body.innerHTML = '<div class="ap-err">加载失败：'+(j.error?esc(j.error):"未知错误")+'</div>'; return; }
    if(j.need_refresh){ body.innerHTML = _apRiderEmptyGlyph("user-check"); return; }
    if(!j.periods || !j.periods.length){ body.innerHTML = _apRiderEmptyGlyph("user-check"); return; }
    var allRows = j.rows||[];
    var periods = j.periods;
    var jdate = j.date || _apToday();
    periods.forEach(function(pd){
      pd._start = _apPeriodDate(jdate, pd.start_time);
      pd._end = _apPeriodDate(jdate, pd.end_time);
      // 跨午夜时段（如 夜宵2 22:00–00:00）：结束时间早于开始 → 结束日 +1 天，避免被误判为「已过」
      if(pd._start && pd._end && pd._end <= pd._start){ pd._end = new Date(pd._end.getTime() + 86400000); }
    });
    // 达标率 / 「仅看未达标」均按「已过的排班时段」(end<=now) 重算，与实时时刻对齐
    allRows.forEach(function(r){ r._passedRate = _apPassedRate(r, periods, now); });
    // 视图筛选：仅「全部站点」展示全部；选定单站时从缓存中筛出该站骑手（不发起请求）
    var viewTeam = _ap.team;
    var isViewAll = !viewTeam || viewTeam === "__all__";
    var viewRows = isViewAll ? allRows : allRows.filter(function(r){ return String(r.team_id) === String(viewTeam); });
    if(!viewRows.length){ body.innerHTML = _apRiderEmptyGlyph("user-check"); return; }

    var q = (_apRiderFilter.q||"").trim().toLowerCase();
    var rows = viewRows.slice();
    if(q) rows = rows.filter(function(r){ return (r.rider_name||"").toLowerCase().indexOf(q)>=0 || String(r.rider_id).toLowerCase().indexOf(q)>=0; });
    if(_apRiderFilter.onlyFail) rows = rows.filter(function(r){ return r._passedRate != null && r._passedRate < 100; });
    rows.sort(_apSortCmp);   // 统一按 _ap.sortKey / _ap.sortDir 排序（稳定排序）

    var colspanN = periods.length + 5;   // 骑手ID + 骑手姓名 + 所属站点 + 达标率 + 全天 + 剩余时段
    var totalRiders = viewRows.length;

    var html = '<div class="ap-rider-scroll"><table class="ap-table ap-rider-table"><thead><tr>'+
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
    html += '</tr></thead><tbody>';
    if(!rows.length){
      html += '<tr><td class="ap-empty-row" colspan="'+colspanN+'"></td></tr>';
    }
    rows.forEach(function(r){
      var rate = r._passedRate;
      var rateCls = rate==null? "na" : (rate>=100? "ok":"warn"); if(rate!=null && rate<80) rateCls="bad";
      var fdCls, fdGlyph, fdSub, fdTitle;
      if(!r.full_day_configured){
        fdCls = "na"; fdGlyph = "?"; fdSub = "未配置"; fdTitle = "系统设置中未配置全天标准";
      } else if(r.full_day_achieved === true){
        fdCls = "ok"; fdGlyph = "✓";
        fdSub = (r.full_day_orders_req ? (r.full_day_orders+" / "+r.full_day_orders_req) : "—");
        fdTitle = "全天达标：单量 "+r.full_day_orders+" / "+r.full_day_orders_req+"，有效在线 "+r.full_day_online_h+"h / "+r.full_day_online_req_h+"h";
      } else if(r.full_day_achieved === false){
        fdCls = "bad"; fdGlyph = "✗";
        fdSub = (r.full_day_orders_req ? (r.full_day_orders+" / "+r.full_day_orders_req) : "—");
        fdTitle = "全天未达标：单量 "+r.full_day_orders+" / "+r.full_day_orders_req+"，有效在线 "+r.full_day_online_h+"h / "+r.full_day_online_req_h+"h";
      } else {
        fdCls = "na"; fdGlyph = "?"; fdSub = "—"; fdTitle = "";
      }
      html += '<tr class="ap-rider-row" data-rid="'+esc(r.rider_id)+'">'+
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
        if(pd._start && now < pd._start){   // 时段尚未开始（已排班）→ 显示「未开始」
          html += '<td class="center ap-cell ap-cell-future" title="尚未开始（排班 '+esc(pd.start_time||"")+'–'+esc(pd.end_time||"")+'）">未开始</td>';
          return;
        }
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
      html += '<tr class="ap-rider-detail" data-drid="'+esc(r.rider_id)+'" style="display:none"><td class="sticky-col" colspan="'+colspanN+'">'+
        _apRiderDetailHtml(r, periods)+'</td></tr>';
    });
    html += '</tbody></table></div>';
    if(j.data_note){ html += '<div style="margin:8px 0;padding:6px 10px;border-left:3px solid #f59e0b;background:#fffbeb;color:#92400e;font-size:13px;border-radius:4px">'+esc(j.data_note)+'</div>'; }
    body.innerHTML = html;
    body.querySelectorAll(".ap-rider-row").forEach(function(tr){
      tr.addEventListener("click", function(){
        var rid = tr.getAttribute("data-rid");
        var d = body.querySelector('.ap-rider-detail[data-drid="'+rid+'"]');
        var willOpen = !!(d && d.style.display === "none");
        // 手风琴：同一时间只允许一行展开 —— 先收起全部明细行与行高亮
        body.querySelectorAll(".ap-rider-detail").forEach(function(x){ x.style.display="none"; });
        body.querySelectorAll(".ap-rider-row.ap-row-open").forEach(function(x){ x.classList.remove("ap-row-open"); });
        if(willOpen){ d.style.display=""; tr.classList.add("ap-row-open"); }   // 点已展开行=收起；点其它行=收起旧的、展开新的
      });
    });
    var meta = document.getElementById("apRiderMeta");
    if(meta){
      var viewLabel = isViewAll ? "全部站点" : _apTeamName(viewTeam);
      meta.textContent = viewLabel + " · " + (j.date||"") + " · 已加载 " + totalRiders + " 名骑手（缓存）";
    }
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
    if(onlyFailEl){ onlyFailEl.checked = _apRiderFilter.onlyFail; onlyFailEl.addEventListener("change", function(){ _apRiderFilter.onlyFail = onlyFailEl.checked; reGrid(); }); }
    if(_apRiderData) _apRenderRiderGrid();
    else body.innerHTML = _apRiderEmptyGlyph("user-check");
  }

  // ---- 系统设置：各时段时长 / 单量要求配置（与标准达成系统设置同样的加载-编辑-保存逻辑）----
  function _apRenderSettings(pane){
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
              if(typeof _apFillTeams === "function"){ ["apTeam","apRiderTeam"].forEach(function(sid){ var el=document.getElementById(sid); if(el) _apFillTeams(el); }); }
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
    if(mode==="settings") _apRenderSettings(settingsHost);
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

/* 标准达成（一级菜单「数据看板」→ 子页「标准达成」）。
   数据源：后端 /api/standard/achievement（走真实风神接口，三源聚合）。
   图表库 ECharts 本地化在 web/vendor/echarts.min.js（青色主题，呼应数据看板）。 */
var _std = { teams:[], names:{}, team:"__all__", start:"", end:"", mode:"station",
  rider:"",            // 骑手筛选："" = 全部骑手；切站点时自动重置
  riderPool:[],        // 骑手候选池（最近一次 riders 接口返回的 rows 精简版）
  sort:{key:null,dir:0}, // 表头排序：{key=列名, dir:1 升序 / -1 降序 / 0 默认}
  page:1,              // 骑手表当前页码（切站点 / 切骑手 / 重新查询时归 1）
  pageSize:20          // 骑手表每页条数（10/15/20/25/30 可选，默认 20）
};
var _STD_ALL_TEAM = "__all__";   // 站点下拉「全部站点」的 value（后端合并取数）
// 查询按钮冷却的存储键（提到与 _std 同级：渲染入口可能早于下方 var 赋值执行，
// 若此时 _stdCoolKey 还是 undefined，localStorage 会读写到 "undefined" 键）
var _stdCoolKey = "stdQueryCooldownV1";

export function _stdEnsureStyle(){
  if(document.getElementById("std-css")) return;
  var s = document.createElement("style"); s.id = "std-css";
  s.textContent = `
  .std-wrap{display:flex;flex-direction:column;gap:16px}
  .std-bar{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;background:var(--card);
    border:1px solid var(--c-border,#eee);border-radius:var(--r-card);padding:14px 16px;box-shadow:var(--shadow-1)}
  .std-bar label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
  .std-bar select,.std-bar input[type=date]{padding:8px 10px;border:1px solid var(--c-border,#e3e3e6);
    border-radius:8px;font-size:14px;background:var(--c-white,#fff);color:var(--c-ink,#1a1a1a);min-width:100px}
  .std-btn{padding:9px 18px;border:none;border-radius:8px;background:var(--brand,#FF5000);color:#fff;
    font-weight:600;cursor:pointer}
  .std-btn:hover{filter:brightness(.95)}
  .std-btn:disabled{opacity:.55;cursor:not-allowed;filter:none}
  .std-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
  .std-card{background:var(--card);border:1px solid var(--c-border,#eee);border-radius:var(--r-card);
    padding:16px;box-shadow:var(--shadow-1)}
  .std-card .k{font-size:12px;color:var(--muted)}
  .std-card .v{font-size:26px;font-weight:700;margin-top:6px;color:var(--c-ink,#1a1a1a)}
  .std-card .v.cyan{color:var(--cyan,#0891B2)}
  .std-card .sub{font-size:12px;color:var(--muted);margin-top:2px}
  .std-sec-h{font-weight:600;margin:2px;font-size:15px;color:var(--c-ink,#1a1a1a)}
  .std-table{width:100%;border-collapse:collapse;background:var(--card);border-radius:var(--r-card);
    overflow:hidden;box-shadow:var(--shadow-1);font-size:14px}
  .std-table th,.std-table td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--c-border,#eee)}
  .std-table th{background:var(--surface-sunken,#f6f7f9);color:var(--muted);font-weight:600}
  .std-table tbody tr:hover{background:var(--surface-sunken,#fafbfc)}
  .rate{display:inline-block;padding:2px 8px;border-radius:999px;font-weight:600;font-size:12px}
  .rate-ok{background:rgba(15,157,88,.12);color:#0F9D58}
  .rate-warn{background:rgba(245,166,35,.15);color:#B9770E}
  .rate-bad{background:rgba(224,32,32,.12);color:#E02020}
  .rate-none{color:var(--muted)}
  .std-chart{background:var(--card);border:1px solid var(--c-border,#eee);border-radius:var(--r-card);
    box-shadow:var(--shadow-1);padding:12px;height:340px}
  .std-banner{font-size:13px;padding:8px 12px;border-radius:8px;background:var(--c-cyan-soft,#E6F4F8);
    color:var(--cyan,#0891B2)}
  .std-live{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);cursor:pointer}
  /* Tab 栏：分段控件（吸顶 + 窄屏横滚 + 图标+标签，对应 NNG「图标+标签」「溢出滚动」） */
  .std-tabs{display:flex;gap:4px;margin-bottom:2px;padding:4px;background:var(--surface-sunken,#f1f3f5);
    border-radius:12px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;
    position:sticky;top:0;z-index:6}
  .std-tabs::-webkit-scrollbar{display:none}
  .std-tab{flex:1 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:6px;
    padding:8px 18px;border:1px solid transparent;background:transparent;border-radius:9px;
    font-size:14px;cursor:pointer;color:var(--muted);white-space:nowrap;transition:all .15s}
  .std-tab .t-ic{flex:none;display:inline-block}
  .std-tab:hover{color:var(--text,#1a1a1a)}
  .std-tab.on{background:var(--brand,#FF5000);color:#fff;border-color:var(--brand,#FF5000);box-shadow:var(--shadow-1);font-weight:500}
  /* 骑手维度表：内容完整展示——单行不换行、不省略（绝不截断）。
     改自动布局，列宽按内容自然撑开；容器 .std-rider 仅在本表格区允许横向滚动，
     整页不出现横向滚动条，超长内容也完整可见。 */
  .std-rider{overflow-x:auto;overflow-y:hidden}
  .std-rider > .std-table{width:100%;min-width:max-content;table-layout:auto;font-size:12px}
  .std-rider .std-table th{white-space:nowrap;vertical-align:middle;line-height:1.25}
  .std-rider .std-table td{white-space:nowrap;vertical-align:middle}
  .std-rider .std-table td.dim{color:var(--muted-2,#9aa4ad)}   /* 时长差值 0 / 无数据：置灰弱化 */
  /* 单列居中：全天有效单量(4) / 单量差值(7) / 全天单量(11) */
  .std-rider .std-table th:nth-child(4),.std-rider .std-table td:nth-child(4),
  .std-rider .std-table th:nth-child(7),.std-rider .std-table td:nth-child(7),
  .std-rider .std-table th:nth-child(11),.std-rider .std-table td:nth-child(11){text-align:center}
  /* 窄屏：仅缩小字号与内边距，列仍按内容撑开、可横向滚动查看 */
  @media (max-width:1100px){
    .std-rider > .std-table{font-size:11px}
    .std-rider .std-table th,.std-rider .std-table td{padding:7px 7px}
  }
  /* 站点报表（按站点逐行，15 列）：紧凑布局——表宽锁 100%，列宽按内容自然分配；
     表头可换行（中文按字断行，永不撑破容器），数据单元格 nowrap 保证数字对齐。
     显示用短表头，完整列名挂 th 的 title 悬停可见；标准1~5 由行内展开面板承载。 */
  .std-report{overflow-x:auto}   /* 兜底：极端窄屏才在表格容器内横滚，不污染整页 */
  .std-table-wrap{width:100%;min-width:0}
  .std-report-table{width:100%;table-layout:auto;margin:0;font-size:12px;border-collapse:collapse}
  .std-report-table th{white-space:normal;line-height:1.25;vertical-align:middle;padding:5px 6px;text-align:center}
  .std-report-table td{white-space:nowrap;vertical-align:middle;padding:5px 6px;text-align:center}
  .std-report-table th:first-child,.std-report-table td:first-child,
  .std-report-table th:nth-child(2),.std-report-table td:nth-child(2){text-align:left}
  .std-report-table .col-pct{font-weight:600}
  .std-report-table .muted-col{color:var(--muted,#8a93a0);font-size:12px}   /* 未设置门槛/封顶 提示 */
  /* 窄屏：再压一档字号与内边距，仍保持无横向滚动条 */
  @media (max-width:1280px){
    .std-report-table{font-size:11px}
    .std-report-table th,.std-report-table td{padding:5px 4px}
  }
  /* 站点报表顶部 KPI 概要条（对应 GoodData「头条报告置顶」/DataAnalyst「5 秒抓主信息」） */
  .std-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:14px}
  .std-summary .ss{background:var(--card,#fff);border:1px solid var(--c-border,#e3e3e6);border-radius:var(--r-card);
    padding:12px 16px;box-shadow:var(--shadow-1);display:flex;flex-direction:column;gap:4px}
  .std-summary .ss-k{font-size:12px;color:var(--muted,#8a93a0)}
  .std-summary .ss-v{font-size:22px;font-weight:700;color:var(--c-ink,#1a1a1a);font-variant-numeric:tabular-nums}
  .std-summary .ss-v.ok{color:#0F9D58}
  .std-summary .ss-v.warn{color:#B9770E}
  .std-summary .ss-v.bad{color:#E02020}
  .std-report-foot{display:flex;justify-content:flex-end;align-items:center;gap:12px;
    font-size:12px;color:var(--muted,#8a93a0);padding:8px 12px}
  .std-report-foot .srf-note{margin-right:auto;min-width:0}
  /* 次要入口：表格底部右侧文字链接（弱层级，hover 才现品牌色）——替代原独立 footbar 强橙按钮 */
  .std-std-link{padding:2px 0;border:none;background:none;color:var(--muted,#8a93a0);
    font-size:12px;cursor:pointer;transition:color .15s;white-space:nowrap}
  .std-std-link:hover{color:var(--brand,#FF5000)}
  /* 行内展开：点站点行即展开该站明细（即时渲染，读 _std.rptRows 已有字段，零请求）。
     样式沿用骑手明细行下钻 .apd 的度量（12px/16px、12.5px 次要色、dashed 分隔）。 */
  .std-report-table tr.std-exp-row{cursor:pointer}
  .std-report-table tr.std-exp-row.on{background:var(--surface-1,#fafbfc)}
  .std-report-table tr.std-exp-row:focus-visible{outline:2px solid var(--brand,#FF5000);outline-offset:-2px}
  .std-exp-ico{display:inline-block;width:9px;margin-right:6px;color:var(--muted,#8a93a0);transition:transform .15s}
  .std-report-table tr.std-exp-row.on .std-exp-ico{transform:rotate(90deg);color:var(--brand,#FF5000)}
  .std-report-table tr.std-exp-panel>td{padding:0;background:var(--surface-1,#fafbfc);
    border-left:2px solid var(--brand,#FF5000)}
  .std-exp-wrap{padding:12px 16px;display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start;
    animation:stdExpIn .14s ease-out}
  @keyframes stdExpIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  .std-exp-g{min-width:180px}
  .std-exp-g .g-t{font-size:12px;color:var(--muted,#8a93a0);margin-bottom:6px}
  .std-exp-g .g-v{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;
    color:var(--muted,#8a93a0);font-variant-numeric:tabular-nums}
  .std-exp-g .g-v b{font-weight:600;color:var(--c-ink,#1a1a1a);margin-left:2px}
  .std-exp-g .g-v b.tot{color:var(--brand,#FF5000)}
  .std-exp-more{margin-left:auto;align-self:flex-end}
  /* 系统设置：门槛值 / 封顶值 面板（录入/校验/保存与「标准目标设置」一致） */
  .st-gs-thresh{margin-top:18px;padding:14px 16px;background:var(--c-panel,#fafbfc);border:1px solid var(--c-border,#e6e8eb);border-radius:var(--r-card)}
  .st-gs-thresh h3{margin:0 0 6px;font-size:14px;color:var(--text,#222)}
  .st-gs-thresh-desc{font-size:12px;color:var(--muted,#8a93a0);line-height:1.5;margin-bottom:10px}
  .st-gs-thresh-row{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
  .st-gs-thresh-row .st-ge-field{display:flex;flex-direction:column;gap:4px}
  .st-gs-thresh-row .st-ge-field .lab{font-size:12px;color:var(--muted,#8a93a0)}
  .st-gs-thresh-row input[type=number]{width:120px;padding:7px 9px;border:1px solid var(--c-border,#d9dce1);border-radius:8px;font-size:13px;font-family:inherit}
  .st-gs-thresh-row .st-btn-primary{height:34px}
  /* 表头排序：三态（默认 → 升序 → 降序 → 默认），图标用上下三角，
     当前方向取主色 #FF5000，未激活方向半透明。cursor/hover 与其它可点控件一致。 */
  .std-th-sortable{cursor:pointer;user-select:none;white-space:nowrap}
  .std-th-sortable:hover{color:var(--brand,#FF5000)}
  .std-th-sortable .sort-ic{margin-left:5px;vertical-align:-2px;flex:none;display:inline-block}
  .std-th-sortable .th-in{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
  .std-th-sortable .sort-ic path{fill:currentColor;opacity:.28}
  .std-th-sortable.on .sort-ic .up{opacity:1;fill:var(--brand,#FF5000)}
  .std-th-sortable.on .sort-ic .dn{opacity:1;fill:var(--brand,#FF5000)}
  .std-th-sortable.desc .sort-ic .up{opacity:.28;fill:currentColor}
  .std-th-sortable.asc  .sort-ic .dn{opacity:.28;fill:currentColor}
  /* 骑手表分页：每页条数可选（10/15/20/25/30）。排序 / 筛选都在**全量** rows 上先做完再切片，
     所以页内顺序 = 全局顺序，翻页不会重排、不会打乱当前排序规则。 */
  .std-pager{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;
    justify-content:flex-end;font-size:13px;color:var(--muted)}   /* 分页控件靠右 */
  .std-pager .pg{min-width:32px;padding:5px 10px;text-align:center;cursor:pointer;
    border:1px solid var(--c-border,#e3e3e6);border-radius:6px;
    background:var(--c-white,#fff);color:var(--muted);font-size:13px}
  .std-pager .pg:hover:not(:disabled):not(.on){border-color:var(--brand,#FF5000);color:var(--brand,#FF5000)}
  .std-pager .pg.on{background:var(--brand,#FF5000);border-color:var(--brand,#FF5000);
    color:#fff;font-weight:600}
  .std-pager .pg:disabled{opacity:.45;cursor:not-allowed}
  .std-pager .pg.dots{border:none;background:none;cursor:default;padding:5px 2px}
  .std-pager .pg-info{margin-left:4px;color:var(--muted)}
  .std-pager .pg-size-select{margin:0 4px;padding:4px 20px 4px 8px;border:1px solid var(--c-border,#e3e3e6);
    border-radius:6px;background:var(--c-white,#fff);color:var(--c-ink,#1a1a1a);font-size:13px;
    cursor:pointer;outline:none;appearance:none;-webkit-appearance:none;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6H0z' fill='%23999'/%3E%3C/svg%3E");
    background-repeat:no-repeat;background-position:right 6px center}
  .std-pager .pg-size-select:focus{border-color:var(--brand,#FF5000)}
  /* 站点 / 骑手筛选（combobox）：同一组筛选控件 */
  .std-team-pick,.std-rider-pick{box-sizing:border-box;
    padding:7px 12px;border:1px solid var(--c-border,#e3e3e6);border-radius:8px;font-size:14px;
    color:var(--c-ink,#1a1a1a);background:#fff;outline:none;transition:all .15s}
  .std-team-pick{min-width:180px;max-width:300px;width:280px}
  .std-team-pick:focus{border-color:var(--brand,#FF5000);box-shadow:0 0 0 3px rgba(255,80,0,.12)}
  .std-rider-pick{min-width:150px;max-width:240px;width:240px}
  .std-rider-pick:focus{border-color:var(--brand,#FF5000);box-shadow:0 0 0 3px rgba(255,80,0,.12)}
  .std-combo{position:relative}
  .std-combo-list{position:absolute;top:calc(100% + 4px);left:0;z-index:30;min-width:240px;max-height:280px;
    overflow-y:auto;background:#fff;border:1px solid var(--c-border,#e3e3e6);border-radius:10px;
    box-shadow:0 8px 24px rgba(20,22,28,.14);padding:6px;display:none}
  .std-combo.open .std-combo-list{display:block}
  .std-combo-item{padding:8px 10px;border-radius:7px;cursor:pointer;font-size:14px;color:var(--c-ink,#1a1a1a);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .std-combo-item:hover,.std-combo-item.active{background:rgba(255,80,0,.08)}
  .std-combo-item .sub{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--muted);margin-left:8px}
  .std-combo-empty{padding:10px;color:var(--muted);font-size:13px;text-align:center}
  /* ===== 系统设置：参与站点 + 等级标准 ===== */
  .std-settings{--st-pad:20px;--st-gap:20px;display:flex;flex-direction:column;gap:var(--st-gap);padding:var(--st-pad);
    background:var(--card);border:1px solid var(--c-border,#eee);border-radius:var(--r-card);box-shadow:var(--shadow-1)}
  .std-sec{background:var(--surface-1,#fafbfc);border:1px solid var(--c-border,#eef0f3);border-radius:var(--r-card);padding:var(--st-pad)}
  .std-sec > h4{margin:0 0 6px;font-size:17px;font-weight:600;color:var(--c-ink,#1a1a1a)}
  .std-sec > .hint{margin:0 0 18px;font-size:13px;color:var(--muted);line-height:1.6}
  .st-btn-primary{padding:8px 18px;border:none;background:var(--brand,#FF5000);color:#fff;border-radius:8px;
    font-size:14px;font-weight:600;cursor:pointer;transition:filter .15s}
  .st-btn-primary:hover{filter:brightness(.95)}
  .st-btn-primary:disabled{background:#d0d4da;cursor:not-allowed;filter:none}
  .st-btn-secondary{padding:6px 12px;border:1px solid var(--c-border,#e3e3e6);background:#fff;border-radius:6px;
    font-size:13px;color:var(--c-ink,#1a1a1a);cursor:pointer;transition:all .15s}
  .st-btn-secondary:hover{border-color:var(--brand,#FF5000);color:var(--brand,#FF5000)}
  .st-toast{font-size:13px;color:var(--muted)}
  .st-toast.ok{color:#0F9D58}
  .st-toast.err{color:#E02020}

  /* 参与站点：已选列表框（卡片边框，独立突出）+ 弹窗选择器（虚拟化，支持数百站点） */
  .st-teams-card{border:1px solid var(--c-border,#e3e3e6);border-radius:var(--r-card);background:var(--card,#fff);
    overflow:hidden;box-shadow:0 1px 3px rgba(20,22,28,.06)}
  .st-teams-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;
    padding:12px 14px;border-bottom:1px solid var(--c-border,#eef0f3)}
  .st-teams-card-title{font-size:14px;font-weight:500;color:var(--c-ink,#1a1a1a)}
  .st-teams-card-title b{color:var(--brand,#FF5000);font-weight:600}
  .st-btn-text{padding:6px 12px;border:none;background:transparent;color:var(--brand,#FF5000);
    font-size:14px;font-weight:500;border-radius:8px;cursor:pointer;transition:background .15s}
  .st-btn-text:hover{background:rgba(255,80,0,.08)}
  .st-teams-chips{display:flex;flex-wrap:wrap;gap:8px;padding:14px;max-height:200px;overflow-y:auto}
  .st-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 6px 4px 11px;background:rgba(255,80,0,.08);
    border:1px solid rgba(255,80,0,.25);border-radius:999px;font-size:12.5px;color:#c2410c;max-width:220px}
  .st-chip .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .st-chip .x{flex:none;width:16px;height:16px;border:none;background:transparent;color:#c2410c;cursor:pointer;
    font-size:15px;line-height:1;border-radius:50%;display:flex;align-items:center;justify-content:center}
  .st-chip .x:hover{background:rgba(255,80,0,.18)}
  .st-empty-chips{font-size:13px;color:var(--muted);padding:2px}

  /* 弹窗遮罩 + 对话框 */
  .st-modal-mask{position:fixed;inset:0;background:rgba(20,22,28,.45);backdrop-filter:blur(2px);
    display:flex;align-items:center;justify-content:center;z-index:1000;padding:24px}
  .st-modal{width:min(760px,100%);max-height:84vh;background:var(--card,#fff);border-radius:14px;
    box-shadow:0 20px 60px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;
    font-size:14px;color:var(--c-ink,#1a1a1a)}
  .st-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
    padding:16px 20px;border-bottom:1px solid var(--c-border,#eef0f3)}
  .st-modal-head .t{font-size:16px;font-weight:600}
  .st-modal-head .sub{font-size:12px;color:var(--muted);margin-top:3px}
  .st-modal-x{border:none;background:transparent;font-size:22px;line-height:1;color:var(--muted);cursor:pointer;padding:0 4px}
  .st-modal-x:hover{color:var(--c-ink,#1a1a1a)}
  .st-modal-search{padding:14px 20px 6px}
  .st-modal-search input{width:100%;padding:10px 14px;border:1px solid var(--c-border,#e3e3e6);border-radius:9px;
    font-size:14px;outline:none;box-sizing:border-box;transition:all .15s}
  .st-modal-search input:focus{border-color:var(--brand,#FF5000);box-shadow:0 0 0 3px rgba(255,80,0,.12)}
  .st-modal-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
    padding:8px 20px 12px}
  .st-modal-toolbar .cnt{font-size:13px;color:var(--muted)}
  .st-modal-toolbar .cnt b{color:var(--c-ink,#1a1a1a);font-weight:600}
  .st-modal-toolbar .acts{display:flex;gap:8px;align-items:center}
  .st-pin{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);cursor:pointer;user-select:none}
  .st-pin input{accent-color:var(--brand,#FF5000);margin:0}
  /* 虚拟化滚动列表：只渲染可见行，数百/上千站点也不卡 */
  .st-modal-list{flex:1;min-height:260px;max-height:46vh;overflow-y:auto;position:relative;
    border-top:1px solid var(--c-border,#eef0f3);border-bottom:1px solid var(--c-border,#eef0f3);
    background:var(--surface-1,#fafbfc)}
  .st-picker-spacer{position:relative;width:100%}
  .st-picker-row{position:absolute;left:0;right:0;display:flex;align-items:center;gap:12px;padding:0 20px;
    box-sizing:border-box;cursor:pointer;border-bottom:1px solid var(--c-border,#f0f1f4);background:#fff;transition:background .12s}
  .st-picker-row:hover{background:rgba(255,80,0,.04)}
  .st-picker-row.on{background:rgba(255,80,0,.06)}
  .st-picker-row .cb{flex:none;width:18px;height:18px;border:2px solid var(--c-border,#d0d4da);border-radius:5px;
    display:flex;align-items:center;justify-content:center;transition:all .15s}
  .st-picker-row.on .cb{border-color:var(--brand,#FF5000);background:var(--brand,#FF5000)}
  .st-picker-row .cb::after{content:"";width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;
    transform:rotate(45deg) translate(-1px,-1px);opacity:0;transition:opacity .15s}
  .st-picker-row.on .cb::after{opacity:1}
  .st-picker-row .info{flex:1;min-width:0}
  .st-picker-row .name{font-size:14px;font-weight:500;color:var(--c-ink,#1a1a1a);line-height:1.4;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .st-picker-row .tid{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--muted);margin-top:2px}
  .st-picker-row .ord{flex:none;min-width:20px;height:20px;padding:0 6px;border-radius:999px;
    background:var(--brand,#FF5000);color:#fff;font-size:11px;font-weight:600;
    display:flex;align-items:center;justify-content:center}
  .st-picker-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:14px}
  .st-modal-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 20px}
  .st-modal-foot .hint{font-size:12px;color:var(--muted)}
  .st-modal-foot .btns{display:flex;gap:10px}
  .st-btn-ghost{padding:8px 16px;border:1px solid var(--c-border,#e3e3e6);background:#fff;border-radius:8px;
    font-size:14px;color:var(--c-ink,#1a1a1a);cursor:pointer;transition:all .15s}
  .st-btn-ghost:hover{border-color:var(--brand,#FF5000);color:var(--brand,#FF5000)}
  .st-btn-danger{padding:8px 16px;border:1px solid #f3c2c2;background:#fff;color:#E02020;border-radius:8px;
    font-size:14px;cursor:pointer;transition:all .15s}
  .st-btn-danger:hover:not(:disabled){border-color:#E02020;background:rgba(224,32,32,.06)}
  .st-btn-danger:disabled{opacity:.45;cursor:not-allowed}

  /* 等级标准：搜索站点 */
  .st-gs-search{padding:7px 12px;border:1px solid var(--c-border,#e3e3e6);border-radius:8px;font-size:14px;
    color:var(--c-ink,#1a1a1a);background:#fff;outline:none;transition:all .15s;min-width:200px}
  .st-gs-search:focus{border-color:var(--brand,#FF5000);box-shadow:0 0 0 3px rgba(255,80,0,.12)}

  /* 等级标准：页面顶部统一栏（左=月份 + 站点搜索，右=管理） */
  .st-gs-global-topbar{padding:2px 0 10px;border-bottom:1px solid var(--c-border,#eee);margin-bottom:14px}
  .st-gs-global-topbar .ctrl{display:flex;align-items:center;gap:8px}
  .st-gs-global-topbar .ctrl label{font-size:13px;color:var(--muted)}
  .st-gs-global-topbar .ctrl input[type=month]{padding:7px 12px;border:1px solid var(--c-border,#e3e3e6);border-radius:8px;background:var(--bg,#fff)}
  .st-gs-global-topbar .ctrl input[type=month]:focus{border-color:var(--brand,#FF5000);box-shadow:0 0 0 3px rgba(255,80,0,.12)}
  .st-gs-topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;
    position:sticky;top:48px;z-index:4;background:var(--card,#fff);padding:8px 0;border-bottom:1px solid var(--c-border,#eee)}
  .st-gs-topbar .left{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .st-gs-topbar .ctrl{display:flex;align-items:center;gap:8px}
  .st-gs-topbar .ctrl label{font-size:13px;color:var(--muted)}
  .st-gs-topbar .ctrl input[type=month]{padding:7px 12px;border:1px solid var(--c-border,#e3e3e6);border-radius:8px;
    font-size:14px;color:var(--c-ink,#1a1a1a);background:#fff;outline:none;transition:all .15s}
  .st-gs-topbar .ctrl input[type=month]:focus{border-color:var(--brand,#FF5000);box-shadow:0 0 0 3px rgba(255,80,0,.12)}
  .st-gs-topbar .right{display:flex;align-items:center;gap:10px}
  .st-gs-topbar .right button{box-sizing:border-box;height:36px;padding:0 16px;border-radius:8px;
    font-size:14px;font-weight:500;line-height:1;display:inline-flex;align-items:center;justify-content:center;
    cursor:pointer;transition:all .15s}
  .st-gs-topbar .right button:disabled{opacity:.45;cursor:not-allowed}
  /* 等级标准：表格 / 编辑器弹窗 */
  .st-gs-empty{text-align:center;padding:40px 20px;color:var(--muted);font-size:14px}
  .std-banner.warn{display:block;background:rgba(255,80,0,.06);border:1px solid rgba(255,80,0,.18);
    color:var(--warn,#B9770E);padding:9px 14px;border-radius:8px;font-size:13px;margin-bottom:12px}
  /* 表格容器：横向滚动 + 纵向滚动（粘性表头 + 首列） */
  .st-gs-scroll{max-height:62vh;overflow:auto;border:1px solid var(--c-border,#e3e3e6);border-radius:10px;background:#fff}
  .st-gs-table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px;color:var(--c-ink,#1a1a1a);min-width:900px}
  .st-gs-table thead th{position:sticky;top:0;z-index:2;background:var(--surface-1,#f5f6f8);
    padding:10px 12px;text-align:center;font-weight:600;border-bottom:1px solid var(--c-border,#d9dce1);
    border-right:1px solid var(--c-border,#eef0f3);white-space:nowrap}
  .st-gs-table thead th.grp{background:var(--surface-2,#eceef1);font-size:12px;color:var(--muted)}
  .st-gs-table thead th.corner{text-align:left;left:0;z-index:3}
  .st-gs-table tbody td{padding:9px 12px;text-align:center;border-bottom:1px solid var(--c-border,#eef0f3);
    border-right:1px solid var(--c-border,#f3f4f6);white-space:nowrap}
  .st-gs-table tbody td.name{text-align:left;position:sticky;left:0;background:#fff;z-index:1;font-weight:500}
  .st-gs-table tbody td.name .tid{display:block;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--muted);font-weight:400;margin-top:2px}
  .st-gs-table tbody tr:hover td{background:rgba(255,80,0,.035)}
  .st-gs-table tbody tr:hover td.name{background:rgba(255,80,0,.035)}
  /* 编辑器弹窗 */
  .st-modal-body{padding:18px 20px;overflow-y:auto;flex:1}
  .st-ge-field{margin-bottom:18px}
  .st-ge-field > label{display:block;font-size:13px;color:var(--muted);margin-bottom:7px}
  .st-ge-combo{position:relative}
  .st-ge-combo-input{width:100%;padding:10px 12px;border:1px solid var(--c-border,#e3e3e6);border-radius:8px;
    font-size:14px;color:var(--c-ink,#1a1a1a);background:#fff;outline:none;box-sizing:border-box;transition:all .15s}
  .st-ge-combo-input:focus{border-color:var(--brand,#FF5000);box-shadow:0 0 0 3px rgba(255,80,0,.12)}
  .st-ge-combo-list{position:absolute;left:0;right:0;top:calc(100% + 4px);max-height:240px;overflow:auto;z-index:6;
    background:#fff;border:1px solid var(--c-border,#e3e3e6);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.14);display:none}
  .st-ge-combo-list.open{display:block}
  .st-ge-combo-item{padding:9px 12px;cursor:pointer;font-size:14px;border-bottom:1px solid var(--c-border,#f3f4f6)}
  .st-ge-combo-item:last-child{border-bottom:none}
  .st-ge-combo-item:hover,.st-ge-combo-item.active{background:rgba(255,80,0,.06)}
  .st-ge-combo-item .tid{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--muted);margin-left:8px}
  .st-ge-combo-item .tag-new{margin-left:8px;font-size:11px;color:var(--brand,#FF5000);border:1px solid rgba(255,80,0,.32);border-radius:6px;padding:1px 6px;font-weight:500}
  .st-ge-sep{font-size:13px;color:var(--muted);font-weight:600;margin:2px 0 10px}
  .st-ge-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
  @media(max-width:680px){.st-ge-grid{grid-template-columns:repeat(3,1fr)}}
  .st-ge-grid .col{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted)}
  .st-ge-grid .col input{width:100%;padding:8px 6px;border:1px solid var(--c-border,#e3e3e6);border-radius:6px;
    font-size:14px;text-align:center;color:var(--c-ink,#1a1a1a);outline:none;box-sizing:border-box;transition:all .15s}
  .st-ge-grid .col input:focus{border-color:var(--brand,#FF5000);box-shadow:0 0 0 2px rgba(255,80,0,.12)}
  .st-ge-month{font-size:13px;color:var(--muted);margin-bottom:14px}
  .st-ge-month b{color:var(--brand,#FF5000);font-weight:600}
  .st-ge-msg{font-size:13px;color:var(--muted);margin-top:12px}
  .st-ge-msg.ok{color:#0F9D58}
  .st-ge-msg.err{color:#E02020}
  /* 表格区域大 Loading（数据刷新/加载时居中覆盖表格内容区域） */
  .std-table-loader{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
    min-height:320px;padding:40px;background:var(--card);border:1px solid var(--c-border,#eee);
    border-radius:var(--r-card);box-shadow:var(--shadow-1);text-align:center;color:var(--muted)}
  .std-table-loader .dots{display:inline-flex;gap:12px;align-items:center}
  .std-table-loader .dots i{width:18px;height:18px;border-radius:50%;background:var(--brand,#FF5000);
    opacity:.25;animation:std-table-dot 1.2s ease-in-out infinite}
  .std-table-loader .dots i:nth-child(2){animation-delay:.22s}
  .std-table-loader .dots i:nth-child(3){animation-delay:.44s}
  .std-table-loader .txt{font-size:16px;font-weight:500;line-height:1.5}
  .std-table-loader .sub{font-size:13px;opacity:.75;line-height:1.5}
  /* 数据加载动画 —— 圆角/背景/阴影与 .std-card 一致，三点脉动配色取主色 #FF5000 */
  .std-loading{display:flex;align-items:center;gap:10px;padding:16px;background:var(--card);
    border:1px solid var(--c-border,#eee);border-radius:var(--r-card);box-shadow:var(--shadow-1);
    font-size:13px;color:var(--muted)}
  .std-loading .dots{display:inline-flex;gap:5px;align-items:center}
  .std-loading .dots i{width:8px;height:8px;border-radius:50%;background:var(--brand,#FF5000);
    opacity:.25;animation:std-dot 1.05s ease-in-out infinite}
  .std-loading .dots i:nth-child(2){animation-delay:.18s}
  .std-loading .dots i:nth-child(3){animation-delay:.36s}
  @keyframes std-dot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
  @keyframes std-table-dot{0%,80%,100%{opacity:.25;transform:translateY(0) scale(1)}40%{opacity:1;transform:translateY(-10px) scale(1.1)}}
  `;
  document.head.appendChild(s);
}
export function _stdTableLoader(text, sub){
  return '<div class="std-table-loader"><span class="dots"><i></i><i></i><i></i></span>'+
         '<div class="txt">'+esc(text||"加载中…")+'</div>'+
         (sub?('<div class="sub">'+esc(sub)+'</div>'):'')+'</div>';
}
export function _stdYMD(d){ var y=d.getFullYear(),m=("0"+(d.getMonth()+1)).slice(-2),g=("0"+d.getDate()).slice(-2); return y+"-"+m+"-"+g; }
export function _stdEnsureECharts(cb){
  // echarts 已通过 import 同步加载，直接回调（保留原调用约定，避免大范围改动）
  cb();
}

/* 自动导出：供其他模块导入的内部顶层符号 */
export { LS_DS_KEY, _STD_ALL_TEAM, _ap, _apDataset, _apRiderData, _apRiderFilter, _std, _stdCoolKey, state };
