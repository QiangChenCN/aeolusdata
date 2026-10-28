// 运单明细看板的数据层：站点目录 / 日期 / 站点 / 状态 / 关键字筛选与刷新。
// 只有本看板使用，改这里的请求编排不会波及别的看板。
import { computed, ref, watch } from 'vue';
import { fetchTeams } from '../../api/dashboards.js';
import { fetchOrderDetail, refreshOrderDetail, fetchOrderDetailHistoryStatus } from '../../api/order-detail.js';

const REFRESH_COOLDOWN_SEC = 60;
/** 关键字输入防抖：每个按键都打一次全量过滤请求太浪费。 */
const KEYWORD_DEBOUNCE_MS = 350;

/** 北京时间当天 YYYY-MM-DD（与后端 todayYmd 同口径）。 */
function todayYmd() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 看板默认可见列（系统默认集，非全量）：首次进入且无 localStorage 持久化时采用。
 * 与后端返回列求交集后生效（剔除已失效列）。对应列设置抽屉里的「默认列」。
 */
export const DEFAULT_VISIBLE_COLUMNS = [
  'trackingId',               // 运单id
  'knightId',                 // 骑手id
  'knightName',               // 骑手姓名
  'teamId',                   // 站点id
  'teamName',                 // 站点名称
  'platformMerchantId',       // 平台商家id
  'platformMerchantName',     // 平台商家名称
  'platformMerchantSeq',      // 商家订单流水号
  'stateDesc',                // 运单状态
  'merchantConsumerDistance', // 订单距离(km)
  'payAmount',                // 订单金额(元)
  'weight',                   // 订单重量(kg)
  'completeAt',               // 骑手送达时间
  'logisticsPredictDeliveryAt', // 平台期望时间
  'weatherGradeName',         // 天气等级
  'weatherName',              // 天气
  'isReverse',                // 是否逆向单
  'isReassign',               // 是否发生改派
  'isHighValueOrder',         // 是否高笔单
  'isSecondCallOrder',        // 是否二呼单
];

/** 默认列的展示顺序（与 DEFAULT_VISIBLE_COLUMNS 一一对应）。visibleColumns 据此排序：默认列在前按此顺序，用户额外勾选的列按后端原始顺序排其后。 */
const DEFAULT_ORDER_INDEX = new Map(DEFAULT_VISIBLE_COLUMNS.map((k, i) => [k, i]));

/** 看板调试日志前缀：浏览器 DevTools Console 用 "[OD]" 过滤所有表格调用。 */
const OD_LOG = '[OD]';
const odLog = (...a) => console.log(OD_LOG, ...a);
const odNow = () => Date.now();

/** 列显隐偏好的 localStorage key（持久化用户勾选，刷新不丢）。 */
const LS_VISIBLE_KEYS = 'od_visible_keys_v1';

/** 读取持久化的列显隐：无存储返回 null（首次默认全列）；解析失败同样回 null。 */
function loadStoredVisible() {
  try {
    const raw = localStorage.getItem(LS_VISIBLE_KEYS);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function useOrderDetail() {
  /* 筛选条件 */
  /** 按天偏移算 YYYY-MM-DD（北京时间），用于快捷区间。 */
  const shiftDay = (n) => {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  /** 所选日期区间 [开始, 结束]（含端点）；默认当天单日（历史与今天不可同时选）。 */
  const dateRange = ref([shiftDay(0), shiftDay(0)]);
  const teamSel = ref([]); // 多选：默认不选 = 全站
  const stateSel = ref('');
  const keyword = ref('');

  /* 结果 */
  const rows = ref([]);
  const columns = ref([]);
  const states = ref([]);
  const teamStats = ref([]);
  const total = ref(0);
  const page = ref(1);
  const pageSize = ref(50);
  const sortProp = ref('trackingFinishAt');
  const sortOrder = ref('descending');
  const fetchedAt = ref('');

  /* 历史滚动（T-1 ~ T-7）：每天 04:00 由后端定时任务回补到历史运单明细表 */
  const historyDays = ref([]);
  const historyTotal = ref(0);
  const lastRun = ref(null);

  /* 状态 */
  const teams = ref([]);
  const loading = ref(false);
  const loaded = ref(false);
  const loadErrMsg = ref('');
  const refreshing = ref(false);
  const cooldown = ref(0);

  /* 列显隐：优先读取 localStorage 持久化；无存储（null）则首次加载默认全列。
   * colInit 仅在「无存储」时为 true —— 首次拿到列定义后填全列；有存储则尊重用户配置
   * （与现有列求交集、剔除失效列，新增列默认隐藏，因用户已接管列配置）。 */
  const storedVisible = loadStoredVisible();
  const visibleKeys = ref(Array.isArray(storedVisible) ? [...storedVisible] : []);
  let colInit = storedVisible === null;
  const visibleColumns = computed(() => {
    const vis = new Set(visibleKeys.value);
    const cols = columns.value.filter((c) => vis.has(c.key));
    // 默认列按用户指定顺序排在前，用户额外勾选的列（不在默认集中）按后端原始顺序排在后
    return cols.sort((a, b) => {
      const ia = DEFAULT_ORDER_INDEX.has(a.key) ? DEFAULT_ORDER_INDEX.get(a.key) : Infinity;
      const ib = DEFAULT_ORDER_INDEX.has(b.key) ? DEFAULT_ORDER_INDEX.get(b.key) : Infinity;
      return ia - ib;
    });
  });

  /** 持久化列显隐到 localStorage（任意勾选变化都写，刷新不丢）。 */
  watch(visibleKeys, () => {
    try { localStorage.setItem(LS_VISIBLE_KEYS, JSON.stringify(visibleKeys.value)); } catch {}
  }, { deep: true });

  // 站点下拉：有数据的站点带上当天行数，便于一眼看出哪天哪站有单
  const statMap = computed(() => {
    const m = new Map();
    for (const s of teamStats.value) m.set(String(s.team), s.rows);
    return m;
  });
  const teamOptions = computed(() =>
    teams.value.map((t) => {
      const n = statMap.value.get(String(t.id));
      return { id: t.id, name: n ? `${t.name}（${n}）` : t.name };
    }),
  );

  /** 当前所选区间是否包含今天：决定「刷新数据」是否可用（刷新只写当天实时表）。 */
  const rangeIncludesToday = computed(() => {
    const [s, e] = dateRange.value;
    const t = todayYmd();
    return !!s && !!e && s <= t && t <= e;
  });

  const needRefresh = computed(() => loaded.value && total.value === 0 && rangeIncludesToday.value);

  let cooldownTimer = null;
  function startCooldown(sec) {
    const s = Math.max(1, Math.ceil(Number(sec) || REFRESH_COOLDOWN_SEC));
    cooldown.value = s;
    if (cooldownTimer) clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
      cooldown.value -= 1;
      if (cooldown.value <= 0) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
        cooldown.value = 0;
      }
    }, 1000);
  }

  async function load() {
    // 多选团队规整：空 / 含「全部站点」→ []（全站）；否则传具体站点数组
    const teamParam = (() => {
      const arr = Array.isArray(teamSel.value) ? teamSel.value : [teamSel.value].filter(Boolean);
      if (!arr.length || arr.includes('__all__')) return [];
      return arr;
    })();
    const params = {
      start: dateRange.value[0], end: dateRange.value[1],
      team: teamParam, q: keyword.value.trim(), state: stateSel.value,
      sort: sortProp.value, order: sortOrder.value === 'ascending' ? 'asc' : 'desc',
      page: page.value, pageSize: pageSize.value,
    };
    const t = odNow();
    odLog('load ▶ 请求', JSON.stringify(params));
    loading.value = true;
    try {
      const res = await fetchOrderDetail(params);
      const ms = odNow() - t;
      if (!res || !res.ok) {
        odLog('load ✗ 失败', `${ms}ms`, (res && res.error) || '运单明细读取失败');
        rows.value = [];
        total.value = 0;
        loadErrMsg.value = (res && res.error) || '运单明细读取失败';
        return false;
      }
      rows.value = res.rows || [];
      total.value = Number(res.total) || 0;
      // 服务端会把越界页码夹回有效范围，这里同步回来，避免分页器显示与实际不一致
      page.value = Number(res.page) || 1;
      fetchedAt.value = res.fetched_at || '';
      loadErrMsg.value = '';
      // 列定义：首次拿到后再补；切换条件时保持用户配置不动，以免闪空或被覆盖
      if (Array.isArray(res.columns) && res.columns.length) {
        const first = columns.value.length === 0;
        columns.value = res.columns;
        if (first) {
          const existing = res.columns.map((c) => c.key);
          if (colInit) {
            // 无持久化：采用系统默认可见列（与现有列求交集，剔除失效列）
            const def = new Set(DEFAULT_VISIBLE_COLUMNS);
            visibleKeys.value = existing.filter((k) => def.has(k));
          } else {
            // 有持久化：仅与现有列求交集（剔除后端已删除的失效列），新增列默认隐藏（尊重用户接管）
            const set = new Set(visibleKeys.value);
            visibleKeys.value = existing.filter((k) => set.has(k));
          }
          colInit = false;
        }
      }
      if (Array.isArray(res.teams)) teamStats.value = res.teams;
      if (Array.isArray(res.states)) states.value = res.states;
      odLog(`load ✓ 完成 ${ms}ms`, `total=${total.value} rows=${rows.value.length} fetchedAt=${fetchedAt.value || '—'}`);
      return true;
    } catch (e) {
      odLog('load ✗ 异常', `${odNow() - t}ms`, e && e.message ? e.message : e);
      rows.value = [];
      loadErrMsg.value = '加载失败：' + (e && e.message ? e.message : '未知错误');
      return false;
    } finally {
      loaded.value = true;
      loading.value = false;
    }
  }

  /* 条件变更：一律回到第 1 页 —— 换条件后停在第 7 页多半是空页。 */
  function changeDate() { odLog('trigger load ← changeDate', dateRange.value); page.value = 1; return load(); }
  /** 多选站点规范化：`__all__` 与具体站点互斥；默认不选（清空）= 全站。 */
  function changeTeam(val) {
    let next = Array.isArray(val) ? val.slice() : [val].filter(Boolean);
    if (next.includes('__all__') && next.length > 1) next = next.filter((x) => x !== '__all__');
    teamSel.value = next;
    page.value = 1;
    odLog('trigger load ← changeTeam', next);
    return load();
  }
  function changeState() { odLog('trigger load ← changeState', stateSel.value); page.value = 1; return load(); }
  function onSortChange({ prop, order }) {
    sortProp.value = order ? prop : '';
    sortOrder.value = order || '';
    page.value = 1;
    odLog('trigger load ← onSortChange', { prop, order });
    return load();
  }
  function onPageChange(p) { odLog('trigger load ← onPageChange', p); page.value = p; return load(); }
  function onPageSizeChange(s) { odLog('trigger load ← onPageSizeChange', s); pageSize.value = s; page.value = 1; return load(); }

  /** 列设置：全选（显示全部列）。 */
  function selectAll() {
    visibleKeys.value = columns.value.map((c) => c.key);
  }

  /** 当前系统默认可见列 key（与现有列求交集，随 DEFAULT_VISIBLE_COLUMNS 动态增减）。供「重置」恢复默认集。 */
  function defaultVisibleKeys() {
    const def = new Set(DEFAULT_VISIBLE_COLUMNS);
    return (columns.value || []).map((c) => c.key).filter((k) => def.has(k));
  }

  let kwTimer = null;
  watch(keyword, () => {
    if (kwTimer) clearTimeout(kwTimer);
    kwTimer = setTimeout(() => {
      page.value = 1;
      load();
    }, KEYWORD_DEBOUNCE_MS);
  });

  /**
   * 刷新：只拉「当天」全站运单入库（实时表仅保留当天，历史日由每日滚动任务维护）。
   * 若当前在查历史日，刷新后切回今天最新快照（避免「在历史日点刷新却无变化」的困惑）。
   */
  async function onRefresh() {
    if (refreshing.value || cooldown.value > 0) { odLog('refresh 跳过（刷新中或冷却）'); return { ok: false, error: '刷新中或处于冷却' }; }
    const t = odNow();
    odLog('refresh ▶ 请求', { date: todayYmd() });
    refreshing.value = true;
    loading.value = true; // 取数耗时最长，覆盖此等待期让表格全程有 loading 反馈
    try {
      const res = await refreshOrderDetail({ date: todayYmd() });
      startCooldown(REFRESH_COOLDOWN_SEC);
      if (!res || !res.ok) {
        odLog('refresh ✗ 失败', `${odNow() - t}ms`, (res && res.error) || '刷新失败');
        loading.value = false;
        return { ok: false, error: (res && res.error) || '刷新失败' };
      }
      // 实时表只存当天：若当前在查历史日，刷新后切回今天最新快照（重载交给 handleRefresh）
      if (dateRange.value[0] !== todayYmd()) dateRange.value = [todayYmd(), todayYmd()];
      odLog(`refresh ✓ 完成 ${odNow() - t}ms`);
      return { ok: true, data: res };
    } catch (e) {
      startCooldown(e && e.data && e.data.retry_after);
      loading.value = false;
      odLog('refresh ✗ 异常', e && e.message ? e.message : e);
      return { ok: false, error: e.message || '刷新失败' };
    } finally {
      refreshing.value = false;
    }
  }

  /** 历史滚动状态：T-1 ~ T-7 各天入库行数 + 上次运行快照。失败不影响主表。 */
  async function loadHistory() {
    const t = odNow();
    odLog('history ▶ 请求');
    try {
      const res = await fetchOrderDetailHistoryStatus();
      if (!res || !res.ok) {
        odLog('history ✗ 失败', `${odNow() - t}ms`, (res && res.error) || '状态读取失败');
        historyDays.value = [];
        lastRun.value = null;
        return;
      }
      historyDays.value = res.days || [];
      historyTotal.value = Number(res.total) || 0;
      lastRun.value = res.last_run || null;
      odLog(`history ✓ 完成 ${odNow() - t}ms`, `total=${historyTotal.value} lastRun=${(res.last_run && res.last_run.finished_at) || '—'}`);
    } catch (e) {
      odLog('history ✗ 异常', e && e.message ? e.message : e);
      /* 忽略：历史状态取不到时标签显示 0 条，不影响当天明细查看 */
    }
  }

  /* 内容区可用高度：测量 .od-body，使表格撑满内容页 */
  const bodyRef = ref(null);
  const bodyH = ref(520);
  let tabRO = null;
  function measure() {
    const el = bodyRef.value;
    if (!el) return;
    const h = el.clientHeight;
    if (h > 0) bodyH.value = Math.max(240, h - 8);
  }
  function initMeasure() {
    measure();
    if (typeof ResizeObserver !== 'undefined' && bodyRef.value) {
      tabRO = new ResizeObserver(() => measure());
      tabRO.observe(bodyRef.value);
    }
  }

  async function init() {
    const t = odNow();
    try {
      const res = await fetchTeams();
      teams.value = (res && res.teams) || [];
      odLog(`teams ✓ ${odNow() - t}ms`, `count=${teams.value.length}`);
    } catch (e) {
      odLog('teams ✗ 异常', e && e.message ? e.message : e);
      /* 忽略：目录取不到时站点下拉为空，仍可按「全部站点」查看 */
    }
    await load();
    await loadHistory();
  }

  function dispose() {
    if (cooldownTimer) clearInterval(cooldownTimer);
    if (kwTimer) clearTimeout(kwTimer);
    if (tabRO) tabRO.disconnect();
  }
  return {
    dateRange, rangeIncludesToday, teamSel, stateSel, keyword,
    rows, columns, visibleColumns, visibleKeys, states, teamStats,
    total, page, pageSize, sortProp, sortOrder, fetchedAt,
    historyDays, historyTotal, lastRun, loadHistory,
    teams, teamOptions, loading, loaded, loadErrMsg, needRefresh,
    refreshing, cooldown, startCooldown,
    bodyRef, bodyH, initMeasure,
    load, changeDate, changeTeam, changeState, onSortChange, onPageChange, onPageSizeChange,
    onRefresh, init, dispose, selectAll, defaultVisibleKeys,
  };
}
