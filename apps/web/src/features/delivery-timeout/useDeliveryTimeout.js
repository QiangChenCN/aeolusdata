// 配送超时看板的数据层：站点目录 / 展示站点配置 / 站点计算结果的并发拉取与刷新。
// 只有本看板使用（2026-10-21 从 DeliveryTimeoutView.vue 剥离），改这里的请求编排不会波及别的看板。
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { fetchTeams } from '../../api/dashboards.js';
import {
  fetchDeliveryTimeout,
  refreshDeliveryTimeout,
  fetchDeliveryTimeoutTeams,
} from '../../api/delivery-timeout.js';

const REFRESH_COOLDOWN_SEC = 60;

export function useDeliveryTimeout() {
  const route = useRoute();

  /* 站点目录 + 展示站点配置 */
  const teams = ref([]);
  const teamsCfg = ref([]);
  const teamSel = ref('__all__');
  const teamOptions = computed(() =>
    teams.value.filter((t) => !teamsCfg.value.length || teamsCfg.value.includes(String(t.id))),
  );

  /* 站点 id → 名称（来自风神全量站点目录 GET /api/teams）。
     后端对未登记的站点会把 team_name 回退成 id，这里用权威名称覆盖，避免表格出现裸 id。 */
  const teamsNameMap = computed(() => {
    const m = new Map();
    for (const t of teams.value) m.set(String(t.id), t.name);
    return m;
  });

  /* 计算结果与加载状态 */
  const rows = ref([]);
  const loading = ref(false);
  const loaded = ref(false);
  const attempted = ref(0);
  const fetchedAt = ref('');
  const loadErrMsg = ref('');
  const justRefreshed = ref(false);
  const activeTab = ref('station');
  /** 运单明细过滤：'' = 全部 T8 超时；'gaobi' = 仅高比单 T8 超时（考核看板下钻时带入）。 */
  const orderTypeFilter = ref('');

  const needRefresh = computed(() => loaded.value && attempted.value > 0 && rows.value.length === 0);
  const dataNote = computed(() => {
    const p = rows.value.find((x) => x.data_status === 'partial');
    return p ? p.data_note || '' : '';
  });

  /* 内容区可用高度：测量 .dv-body，使骑手 / 运单表格撑满内容页 */
  const bodyRef = ref(null);
  const bodyH = ref(520);
  let tabRO = null;
  function measureTabs() {
    const el = bodyRef.value;
    if (!el) return;
    const h = el.clientHeight;
    if (h > 0) bodyH.value = Math.max(240, h - 8);
  }

  /* 刷新冷却 */
  const refreshing = ref(false);
  const cooldown = ref(0);
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

  /** 拉取所选站点（或全部展示站点）的计算结果；silent 用于刷新后重算不闪 loading。 */
  async function load(silent = false) {
    if (!silent) loading.value = true;
    try {
      const ids =
        teamSel.value === '__all__' ? teamOptions.value.map((t) => t.id) : [teamSel.value];
      attempted.value = ids.length;
      fetchedAt.value = '';
      const results = await Promise.all(
        ids.map((id) => fetchDeliveryTimeout({ team: id }).catch((e) => ({ __err: e }))),
      );
      const good = [];
      const errs = [];
      for (const res of results) {
        if (!res || res.__err) {
          errs.push('请求失败');
          continue;
        }
        if (!res.ok) {
          errs.push(res.error || '计算返回错误');
          continue;
        }
        if (!res.rows || !res.rows.length) continue; // need_refresh 等无数据行，不计入错误
        const row = res.rows[0];
        const nm = teamsNameMap.value.get(String(row.team_id ?? res.team));
        if (nm) row.team_name = nm;
        good.push(row);
        // 取数时间：全部站点取各站最近入库时间的最大值（最新一次取数）
        if (res.fetched_at && (!fetchedAt.value || res.fetched_at > fetchedAt.value)) {
          fetchedAt.value = res.fetched_at;
        }
      }
      rows.value = good;
      loadErrMsg.value = errs.length ? '部分站点计算/请求失败：' + errs.join('；') : '';
    } catch (e) {
      if (!silent) rows.value = [];
      loadErrMsg.value = '加载失败：' + (e && e.message ? e.message : '未知错误');
      return false;
    } finally {
      loaded.value = true;
      if (!silent) loading.value = false;
    }
  }

  /** 刷新：拉全站运单入库（本看板自有 PG 明细表）后重算。同步返回，无需轮询。 */
  async function onRefresh() {
    if (refreshing.value || cooldown.value > 0) return;
    refreshing.value = true;
    loading.value = true; // 取数耗时最长，覆盖此等待期让表格全程有 loading 反馈
    justRefreshed.value = true;
    try {
      const res = await refreshDeliveryTimeout({});
      startCooldown(REFRESH_COOLDOWN_SEC);
      if (!res || !res.ok) {
        loading.value = false;
        return { ok: false, error: (res && res.error) || '刷新失败' };
      }
      return { ok: true, data: res };
    } catch (e) {
      startCooldown(e && e.data && e.data.retry_after);
      loading.value = false;
      return { ok: false, error: e.message || '刷新失败' };
    } finally {
      refreshing.value = false;
    }
  }

  function onTeamChange() {
    justRefreshed.value = false;
    return load();
  }

  /** 页面初始化：拉站点目录与展示站点配置，处理考核看板下钻携带的 query。 */
  async function init() {
    try {
      const t = await fetchTeams();
      teams.value = (t && t.teams) || [];
    } catch (e) {
      /* 忽略：目录取不到则回落到计算返回的 id */
    }
    try {
      const tc = await fetchDeliveryTimeoutTeams();
      teamsCfg.value = (tc && tc.teams) || [];
    } catch (e) {
      /* 忽略：取不到配置则回落全部站点 */
    }
    const q = route.query || {};
    if (q.team) teamSel.value = String(q.team);
    if (q.tt === 'gaobi') orderTypeFilter.value = 'gaobi';
    if (q.tab === 'order') activeTab.value = 'order';
    // 首屏加载的失败提示由调用方（页面）统一 ElMessage，故此处不吞。
    await load();
  }

  /** 挂载完成后的高度测量（需在 DOM 就绪后调用）。 */
  function initMeasure() {
    measureTabs();
    if (typeof ResizeObserver !== 'undefined' && bodyRef.value) {
      tabRO = new ResizeObserver(() => measureTabs());
      tabRO.observe(bodyRef.value);
    }
  }

  function dispose() {
    if (cooldownTimer) clearInterval(cooldownTimer);
    if (tabRO) tabRO.disconnect();
  }

  return {
    teams, teamsCfg, teamSel, teamOptions,
    rows, loading, loaded, attempted, fetchedAt, loadErrMsg, justRefreshed,
    needRefresh, dataNote, activeTab, orderTypeFilter,
    bodyRef, bodyH, measureTabs,
    refreshing, cooldown, startCooldown,
    load, onRefresh, onTeamChange, init, initMeasure, dispose,
  };
}
