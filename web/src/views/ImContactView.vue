<template>
  <div class="dv">
    <div class="dv-bar">
      <h2 class="v-title">IM 电联</h2>
      <el-select v-model="teamSel" class="dv-sel" placeholder="站点" @change="onTeamChange">
        <el-option label="全部站点" value="__all__" />
        <el-option v-for="t in teamOptions" :key="t.id" :label="t.name" :value="t.id" />
      </el-select>
      <el-date-picker
        v-model="range"
        class="dv-range"
        type="daterange"
        range-separator="~"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        value-format="YYYY-MM-DD"
        :clearable="false"
        @change="onRangeChange"
      />
      <el-button @click="openCfg"><el-icon><Setting /></el-icon> 站点设置</el-button>
      <span v-if="fetchedAt" class="dv-date-tag">取数时间：{{ fetchedAt }}</span>
      <span v-if="landedLabel" class="dv-range-tag">数据区间：{{ landedLabel }}</span>
      <span class="sp" />
      <el-button
        type="primary"
        :loading="refreshing"
        :disabled="refreshing || cooldown > 0"
        :title="cooldown > 0 ? `刷新过于频繁，请等待 ${cooldown} 秒` : '拉取所选区间的 IM 电联数据后重新计算'"
        @click="refresh"
      >
        <el-icon><Refresh /></el-icon>
        <span v-if="refreshing">刷新中…</span>
        <span v-else-if="cooldown > 0">请等待 {{ cooldown }}s</span>
        <span v-else>刷新数据</span>
      </el-button>
    </div>

    <el-alert v-if="needRefresh" type="info" :closable="false" show-icon class="dv-hint">
      {{ needRefreshNote }}
    </el-alert>
    <el-alert v-else-if="dataNote" type="warning" :closable="false" show-icon class="dv-hint">{{ dataNote }}</el-alert>
    <el-alert v-if="refreshNote" type="error" :closable="false" show-icon class="dv-hint">{{ refreshNote }}</el-alert>

    <!-- KPI 汇总卡片（随选中站点聚合；el-card + el-statistic，与考核看板同风格） -->
    <div v-if="cards.length" class="dv-cards">
      <el-card v-for="c in cards" :key="c.label" class="dv-card" shadow="never">
        <el-statistic :title="c.label" :value="c.value" :formatter="(v) => cardFmt(v, c)" :suffix="c.suffix" />
      </el-card>
    </div>

    <el-menu mode="horizontal" :default-active="activeTab" class="dv-menu" @select="(k) => (activeTab = k)">
      <el-menu-item index="station">站点数据</el-menu-item>
      <el-menu-item index="rider">骑手数据</el-menu-item>
    </el-menu>

    <div class="dv-body" ref="bodyRef">
      <!-- ① 站点数据 -->
      <div v-show="activeTab === 'station'" class="dv-pane">
        <el-table
          v-loading="loading"
          :data="rows"
          stripe
          border
          class="dv-table"
          empty-text="暂无 IM 电联数据"
          :max-height="560"
          :default-sort="{ prop: 'im_consult_cnt', order: 'descending' }"
        >
          <el-table-column prop="team_id" label="站点ID" min-width="130" fixed sortable show-overflow-tooltip />
          <el-table-column prop="team_name" label="站点" min-width="200" fixed sortable show-overflow-tooltip />
          <el-table-column label="送达电联率" min-width="120" align="center" sortable :sort-method="numSort('call_rate')">
            <template #default="{ row }"><span class="rt">{{ fmtRate(row.call_rate) }}</span></template>
          </el-table-column>
          <el-table-column label="IM及时回复率" min-width="130" align="center" sortable :sort-method="numSort('im_reply_rate')">
            <template #default="{ row }"><span class="rt">{{ fmtRate(row.im_reply_rate) }}</span></template>
          </el-table-column>
          <el-table-column prop="im_consult_cnt" label="IM咨询单量" min-width="120" align="center" sortable />
          <el-table-column prop="im_reply_cnt" label="IM及时回复单量" min-width="140" align="center" sortable />
          <el-table-column prop="call_excluded_cnt" label="电联剔除单量" min-width="130" align="center" sortable />
          <el-table-column prop="after_exclude_orders" label="剔除后接单量" min-width="130" align="center" sortable />
          <el-table-column prop="valid_call_orders" label="剔除后有效电联单量" min-width="170" align="center" sortable />
        </el-table>
      </div>

      <!-- ② 骑手数据：跨所选站点聚合所有骑手，分页 -->
      <div v-show="activeTab === 'rider'" class="dv-pane">
        <el-table
          v-loading="loading"
          :data="pagedRiderRows"
          :height="riderH"
          stripe
          border
          class="dv-table"
          empty-text="暂无骑手 IM 电联数据"
          :default-sort="{ prop: 'im_consult_cnt', order: 'descending' }"
        >
          <el-table-column prop="rider_id" label="骑手ID" min-width="150" fixed sortable show-overflow-tooltip />
          <el-table-column prop="rider_name" label="骑手姓名" min-width="120" fixed sortable show-overflow-tooltip />
          <el-table-column prop="team_id" label="站点ID" min-width="130" sortable show-overflow-tooltip />
          <el-table-column prop="team_name" label="站点" min-width="170" sortable show-overflow-tooltip />
          <el-table-column label="送达电联率" min-width="120" align="center" sortable :sort-method="numSort('call_rate')">
            <template #default="{ row }"><span class="rt">{{ fmtRate(row.call_rate) }}</span></template>
          </el-table-column>
          <el-table-column label="IM及时回复率" min-width="130" align="center" sortable :sort-method="numSort('im_reply_rate')">
            <template #default="{ row }"><span class="rt">{{ fmtRate(row.im_reply_rate) }}</span></template>
          </el-table-column>
          <el-table-column prop="im_consult_cnt" label="IM咨询单量" min-width="120" align="center" sortable />
          <el-table-column prop="im_reply_cnt" label="IM及时回复单量" min-width="140" align="center" sortable />
          <el-table-column prop="call_excluded_cnt" label="电联剔除单量" min-width="130" align="center" sortable />
          <el-table-column prop="after_exclude_orders" label="剔除后接单量" min-width="130" align="center" sortable />
          <el-table-column prop="valid_call_orders" label="剔除后有效电联单量" min-width="170" align="center" sortable />
        </el-table>
        <div class="dv-pg">
          <el-pagination
            v-model:current-page="riderPage"
            v-model:page-size="riderPageSize"
            :total="riderRows.length"
            :page-sizes="[25, 50, 75, 100]"
            layout="total, sizes, prev, pager, next, jumper"
            background
          />
        </div>
      </div>
    </div>

    <!-- 站点设置：选择需要在看板展示的站点（持久化） -->
    <el-dialog v-model="cfgVisible" title="站点设置（选择需要在看板展示的站点）" width="440px">
      <el-checkbox-group v-model="cfgSel" class="dv-cfg-group">
        <el-checkbox v-for="t in teams" :key="t.id" :value="t.id">{{ t.name }}</el-checkbox>
      </el-checkbox-group>
      <template #footer>
        <el-button @click="cfgVisible = false">取消</el-button>
        <el-button type="primary" :loading="cfgSaving" @click="saveCfg">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue';
import { Refresh, Setting } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import {
  fetchTeams, fetchImContact, refreshImContact, fetchImContactStatus,
  fetchImContactTeams, saveImContactTeams,
} from '../api/dashboards.js';

/* ── 站点 ─────────────────────────────────────────────────────────────── */
const teams = ref([]);
const teamSel = ref('__all__');
/* 展示站点配置：teamsCfg = 已配置展示的站点 id；未配置任何站点时回落全部（teamOptions 兜底）。 */
const teamsCfg = ref([]);
const teamOptions = computed(() =>
  teams.value.filter((t) => !teamsCfg.value.length || teamsCfg.value.includes(String(t.id)))
);
const cfgVisible = ref(false);
const cfgSel = ref([]);
const cfgSaving = ref(false);
function openCfg() {
  cfgSel.value = [...teamsCfg.value];
  cfgVisible.value = true;
}
async function saveCfg() {
  cfgSaving.value = true;
  try {
    const res = await saveImContactTeams(cfgSel.value);
    if (res && res.ok) {
      teamsCfg.value = res.teams || [...cfgSel.value];
      ElMessage.success('站点配置已保存');
      cfgVisible.value = false;
      teamSel.value = '__all__';   // 重置到全部站点，避免选中项被移出后下拉空白
      load();
    } else {
      ElMessage.error((res && res.error) || '保存失败');
    }
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    cfgSaving.value = false;
  }
}

/* ── 日期区间 ─────────────────────────────────────────────────────────────
   默认 T-1（昨天）：与装备报表（EquipmentFetchService.defaultDates）同口径 ——
   Quark FBI 报表通常有数据滞后，「今天」的送达电联数据往往还没落全，默认取昨天
   保证首次打开即有数据；需要看今天仍可手动选择。 */
function shiftDay(offset) {
  const d = new Date(Date.now() + offset * 86400000 + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
const range = ref([shiftDay(-1), shiftDay(-1)]);
const landed = ref({ start: '', end: '' });   // 已落盘的数据区间
const landedLabel = computed(() =>
  landed.value.start ? `${landed.value.start} ~ ${landed.value.end}` : '');
const fetchedAt = ref('');

/* ── 数据 ─────────────────────────────────────────────────────────────── */
const rows = ref([]);
const loading = ref(false);
const loaded = ref(false);
const attempted = ref(0);

const needRefresh = computed(() => loaded.value && attempted.value > 0 && rows.value.length === 0);
const needRefreshNote = computed(() => {
  const n = rows.value.find((x) => x.data_status === 'no_data');
  return (n && n.data_note) || '当前站点该区间 IM 电联数据尚未落盘，请点「刷新数据」拉取';
});
const dataNote = computed(() => {
  const p = rows.value.find((x) => x.data_status === 'partial');
  return p ? p.data_note || '' : '';
});
/* 失败提示（常驻，不只弹 toast）：取数失败 / 数据读取失败。
   读侧对 fetch_ok=false 一律按不可用处理（不展示旧数据），故失败时看板为空 + 本提示。 */
const refreshNote = ref('');

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const ids = teamSel.value === '__all__'
      ? teamOptions.value.map((t) => t.id)
      : [teamSel.value];
    attempted.value = ids.length;
    const results = await Promise.all(
      ids.map((id) => fetchImContact({ team: id }).catch((e) => ({ __err: e }))),
    );
    const good = [];
    const errs = [];
    for (const res of results) {
      if (!res || res.__err) { errs.push('请求失败'); continue; }
      if (!res.ok) { errs.push(res.error || '计算返回错误'); continue; }
      if (res.fetched_at && (!fetchedAt.value || res.fetched_at > fetchedAt.value)) {
        fetchedAt.value = res.fetched_at;
      }
      if (res.start && res.end) landed.value = { start: res.start, end: res.end };
      if (!res.rows || !res.rows.length) continue;   // need_refresh 等无数据行，不计入错误
      good.push(res.rows[0]);
    }
    rows.value = good;
    if (errs.length) {
      refreshNote.value = `数据读取失败（${errs.length} 个站点${good.length ? `，其余 ${good.length} 个站点正常` : ''}），请稍后重试`;
    } else {
      refreshNote.value = '';
    }
  } catch (e) {
    refreshNote.value = `数据读取失败：${e?.message || '未知错误'}`;
  } finally {
    loading.value = false;
    loaded.value = true;
    await nextTick();
    measureBody();
  }
}

/* 刷新：拉取所选区间 → 落盘 → 重算（Quark 报表较慢，按钮 loading 期间禁用）。 */
const refreshing = ref(false);
const cooldown = ref(0);
let cooldownTimer = null;
const REFRESH_COOLDOWN_SEC = 60;
function startCooldown(sec) {
  const s = Math.max(1, Math.ceil(Number(sec) || REFRESH_COOLDOWN_SEC));
  cooldown.value = s;
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1;
    if (cooldown.value <= 0) { clearInterval(cooldownTimer); cooldownTimer = null; cooldown.value = 0; }
  }, 1000);
}
async function refresh() {
  const [s, e] = range.value || [];
  if (!s || !e) { ElMessage.warning('请先选择日期区间'); return; }
  refreshing.value = true;
  try {
    const res = await refreshImContact({ start: s, end: e });
    if (res && res.ok) {
      ElMessage.success(res.msg || '拉取成功');
      startCooldown(REFRESH_COOLDOWN_SEC);
    } else {
      ElMessage.error((res && (res.error || res.msg)) || '拉取失败');
      refreshNote.value = `本次拉取失败：${(res && (res.error || res.msg)) || '未知错误'}（看板不展示旧数据，请重试）`;
    }
    await load(true);
  } catch (err) {
    ElMessage.error(err?.message || '拉取失败');
    refreshNote.value = `本次拉取失败：${err?.message || '未知错误'}（看板不展示旧数据，请重试）`;
  } finally {
    refreshing.value = false;
  }
}
function onTeamChange() { load(); }
/* 切换日期区间：该区间多半还没落盘，直接触发取数（用户选区间就是要看该区间）。 */
function onRangeChange() {
  const [s, e] = range.value || [];
  if (s && e) refresh();
}

/* ── 聚合：全部站点时对各站计数求和，比率按口径重算（不跨站平均） ────────── */
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
const agg = computed(() => {
  const r = rows.value;
  const sum = (k) => r.reduce((a, x) => a + num(x[k]), 0);
  const consult = sum('im_consult_cnt');
  const reply = sum('im_reply_cnt');
  const orders = sum('after_exclude_orders');
  const validCall = sum('valid_call_orders');
  return {
    consult, reply, orders, validCall,
    callRate: orders > 0 ? (validCall * 100) / orders : null,
    replyRate: consult > 0 ? (reply * 100) / consult : null,
  };
});
const cards = computed(() => {
  const mk = (label, value, digits) => ({
    label,
    value: value == null ? 0 : value,
    none: value == null,
    digits,
    suffix: digits > 0 ? '%' : '',
  });
  return [
    mk('送达电联率', agg.value.callRate, 3),
    mk('IM及时回复率', agg.value.replyRate, 3),
    mk('IM咨询单量', agg.value.consult, 0),
    mk('IM及时回复单量', agg.value.reply, 0),
    mk('剔除后有效电联单量', agg.value.validCall, 0),
  ];
});
/* 卡片数值格式化（el-statistic formatter）：接管 EP 默认补零逻辑 —— 无数据「—」、
   比率最多 3 位小数、不足不补零（与表格列口径一致）。 */
function cardFmt(v, c) {
  if (c.none) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return c.digits > 0 ? String(Number(n.toFixed(c.digits))) : String(n);
}
function fmtRate(v, digits = 3) {
  if (v == null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toFixed(digits))) + '%' : '—';
}

/* ── 骑手数据：跨所选站点聚合所有骑手（每行 row.riders 已含骑手指标） ────── */
const riderRows = computed(() => {
  const out = [];
  for (const r of rows.value) {
    const teamName = r.team_name || r.team_id;
    for (const rd of (r.riders || [])) {
      out.push({ team_id: r.team_id, team_name: teamName, ...rd });
    }
  }
  return out;
});
const riderPage = ref(1);
const riderPageSize = ref(25);
const pagedRiderRows = computed(() => {
  const start = (riderPage.value - 1) * riderPageSize.value;
  return riderRows.value.slice(start, start + riderPageSize.value);
});
watch(() => riderRows.value.length, () => { riderPage.value = 1; });

/* 数值列排序：null 永远排最后（无论升/降序），便于把「暂无数据」沉底 */
function numSort(key) {
  return (a, b) => {
    const va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return va - vb;
  };
}

/* ── 内容区可用高度：测量 .dv-body，使骑手表格撑满内容页 ────────────────── */
const bodyRef = ref(null);
const riderH = ref(520);
let bodyRO = null;
function measureBody() {
  const el = bodyRef.value;
  if (!el) return;
  const h = el.clientHeight;
  if (h > 0) riderH.value = Math.max(240, h - 56); // 减去分页器高度
}

onMounted(async () => {
  try { const t = await fetchTeams(); teams.value = (t && t.teams) || []; } catch (e) { /* ignore */ }
  try {
    const tc = await fetchImContactTeams();
    teamsCfg.value = (tc && tc.teams) || [];
  } catch (e) { /* ignore：取不到配置则回落全部站点 */ }
  try {
    const st = await fetchImContactStatus();
    if (st && st.landed) {
      landed.value = { start: st.start || '', end: st.end || '' };
      fetchedAt.value = st.fetched_at || '';
      if (st.start && st.end) range.value = [st.start, st.end];
      if (st.fetch_ok === false) {
        refreshNote.value = '上次拉取失败，请点「刷新数据」重试';
      }
    }
  } catch (e) { /* ignore */ }
  await load();
  await nextTick();
  measureBody();
  if (typeof ResizeObserver !== 'undefined' && bodyRef.value) {
    bodyRO = new ResizeObserver(() => measureBody());
    bodyRO.observe(bodyRef.value);
  }
});

onUnmounted(() => {
  if (cooldownTimer) clearInterval(cooldownTimer);
  if (bodyRO) bodyRO.disconnect();
});
</script>

<style scoped>
.dv { padding: var(--sp-20); display: flex; flex-direction: column; height: 100%; box-sizing: border-box; overflow: hidden; }
.dv-bar { display: flex; align-items: center; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.dv-sel { width: 160px; }
.dv-date-tag { font-size: var(--el-font-size-small); color: var(--el-text-color-secondary); }
.dv-range-tag { font-size: var(--el-font-size-small); color: var(--el-text-color-secondary); }
.dv-bar .sp { flex: 1; }
.dv-hint { margin-bottom: var(--sp-12); }

/* ── KPI 汇总卡片（el-card + el-statistic，与考核看板同风格） ──────────── */
.dv-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-12); margin-bottom: var(--sp-16); }
.dv-card :deep(.el-card__body) { padding: var(--sp-16); text-align: center; }
.dv-card :deep(.el-statistic__head) { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.dv-card :deep(.el-statistic__content) { font-size: 24px; font-weight: var(--fw-bold); color: var(--el-color-primary); line-height: 1.2; }

.dv-menu { border-bottom: 1px solid var(--el-border-color-light); margin-bottom: var(--sp-12); }
.dv-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dv-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dv-table { border-radius: var(--el-border-radius-base); }
.dv-pg { flex: none; padding-top: var(--sp-12); display: flex; justify-content: flex-end; }
.rt { font-weight: var(--fw-bold); }
.dv-cfg-group { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow: auto; }
</style>
