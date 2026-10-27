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
 * 默认展示列：首次加载后端返回列定义后，整体填为「全部列」（用户要求看板开放风神全部原始列）。
 * 保留本导出仅为兼容潜在外部引用；实际默认可见集在 load() 里按 columns 全量初始化。
 */
export const DEFAULT_VISIBLE_COLUMNS = [];

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
  const teamSel = ref('__all__');
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

  /* 列显隐：默认全部可见（首次拿到后端列定义后整体填为全部 key）。
   * colInit 保证：仅首次加载填充默认全列，之后用户手动在「列设置」里的增删不被覆盖。 */
  const visibleKeys = ref([...DEFAULT_VISIBLE_COLUMNS]);
  let colInit = false;
  const visibleColumns = computed(() =>
    columns.value.filter((c) => visibleKeys.value.includes(c.key)),
  );

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
    loading.value = true;
    try {
      const res = await fetchOrderDetail({
        start: dateRange.value[0],
        end: dateRange.value[1],
        team: teamSel.value,
        q: keyword.value.trim(),
        state: stateSel.value,
        sort: sortProp.value,
        order: sortOrder.value === 'ascending' ? 'asc' : 'desc',
        page: page.value,
        pageSize: pageSize.value,
      });
      if (!res || !res.ok) {
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
      // 列定义 / 站点覆盖 / 状态枚举：首次拿到后再补，切换条件时保持上次的值以免下拉闪空
      if (Array.isArray(res.columns) && res.columns.length) {
        const first = columns.value.length === 0;
        columns.value = res.columns;
        // 首次拿到列定义：默认全部可见（用户要求看板开放风神全部原始列）
        if (first && !colInit) {
          visibleKeys.value = res.columns.map((c) => c.key);
          colInit = true;
        }
      }
      if (Array.isArray(res.teams)) teamStats.value = res.teams;
      if (Array.isArray(res.states)) states.value = res.states;
    } catch (e) {
      rows.value = [];
      loadErrMsg.value = '加载失败：' + (e && e.message ? e.message : '未知错误');
      return false;
    } finally {
      loaded.value = true;
      loading.value = false;
    }
  }

  /* 条件变更：一律回到第 1 页 —— 换条件后停在第 7 页多半是空页。 */
  function changeDate() { page.value = 1; return load(); }
  function changeTeam() { page.value = 1; return load(); }
  function changeState() { page.value = 1; return load(); }
  function onSortChange({ prop, order }) {
    sortProp.value = order ? prop : '';
    sortOrder.value = order || '';
    page.value = 1;
    return load();
  }
  function onPageChange(p) { page.value = p; return load(); }
  function onPageSizeChange(s) { pageSize.value = s; page.value = 1; return load(); }

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
    if (refreshing.value || cooldown.value > 0) return { ok: false, error: '刷新中或处于冷却' };
    refreshing.value = true;
    loading.value = true; // 取数耗时最长，覆盖此等待期让表格全程有 loading 反馈
    try {
      const res = await refreshOrderDetail({ date: todayYmd() });
      startCooldown(REFRESH_COOLDOWN_SEC);
      if (!res || !res.ok) {
        loading.value = false;
        return { ok: false, error: (res && res.error) || '刷新失败' };
      }
      // 实时表只存当天：若当前在查历史日，刷新后切回今天最新快照（重载交给 handleRefresh）
      if (dateRange.value[0] !== todayYmd()) dateRange.value = [todayYmd(), todayYmd()];
      return { ok: true, data: res };
    } catch (e) {
      startCooldown(e && e.data && e.data.retry_after);
      loading.value = false;
      return { ok: false, error: e.message || '刷新失败' };
    } finally {
      refreshing.value = false;
    }
  }

  /** 历史滚动状态：T-1 ~ T-7 各天入库行数 + 上次运行快照。失败不影响主表。 */
  async function loadHistory() {
    try {
      const res = await fetchOrderDetailHistoryStatus();
      if (!res || !res.ok) {
        historyDays.value = [];
        lastRun.value = null;
        return;
      }
      historyDays.value = res.days || [];
      historyTotal.value = Number(res.total) || 0;
      lastRun.value = res.last_run || null;
    } catch {
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
    try {
      const t = await fetchTeams();
      teams.value = (t && t.teams) || [];
    } catch {
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
    onRefresh, init, dispose,
  };
}
