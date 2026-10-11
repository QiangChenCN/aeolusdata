<template>
  <div class="dv">
    <div class="dv-bar">
      <h2 class="v-title">实时数据</h2>
      <el-select v-model="teamSel" class="dv-sel" placeholder="站点" @change="load">
        <el-option label="全部站点" value="__all__" />
        <el-option v-for="t in teams" :key="t.id" :label="t.name" :value="t.id" />
      </el-select>
      <el-tag v-if="dataDate" type="info" effect="plain" class="dv-date-tag">数据日期：{{ dataDate }}</el-tag>
      <el-tag v-if="lastUpdated" :type="autoRefresh ? 'success' : 'info'" effect="plain" class="dv-date-tag">
        {{ autoRefresh ? '自动刷新中' : '已暂停自动刷新' }} · 最近更新 {{ lastUpdated }}
      </el-tag>
      <span class="sp" />
      <el-select v-model="intervalSec" class="dv-sel" style="width: 110px" @change="restartPoll">
        <el-option label="15 秒" :value="15" />
        <el-option label="30 秒" :value="30" />
        <el-option label="60 秒" :value="60" />
      </el-select>
      <el-switch v-model="autoRefresh" inline-prompt active-text="自动" inactive-text="手动" @change="onAutoToggle" />
      <el-button :loading="loading" @click="load">
        <el-icon><Refresh /></el-icon> 刷新
      </el-button>
    </div>

    <el-alert v-if="needRefresh" type="info" :closable="false" show-icon class="dv-hint">
      当前站点今日运单明细尚未落盘，请先在「标准达成」中点「刷新数据」拉取后，再来此查看实时数据。
    </el-alert>
    <el-alert v-else-if="dataNote" type="warning" :closable="false" show-icon class="dv-hint">{{ dataNote }}</el-alert>

    <div v-if="loading" class="dv-state">
      <el-icon class="is-loading"><Loading /></el-icon> 加载中…
    </div>
    <template v-else>
      <!-- KPI 汇总卡片（随选中站点聚合，全部站点=各站求和后重算比率） -->
      <div v-if="cards.length" class="dv-cards">
        <div v-for="c in cards" :key="c.label" class="dv-card">
          <span class="dv-card-num" :class="c.cls">{{ c.value }}</span>
          <span class="dv-card-label">{{ c.label }}</span>
        </div>
      </div>

      <!-- 站点明细对比表（列可排序，默认按推配送单量降序） -->
      <el-table
        :data="rows"
        stripe
        border
        class="dv-table"
        empty-text="暂无实时数据"
        :max-height="560"
        :default-sort="{ prop: 'pushed_order_volume', order: 'descending' }"
      >
        <el-table-column prop="team_name" label="站点" min-width="160" fixed sortable />
        <el-table-column prop="pushed_order_volume" label="推配送单量" min-width="120" sortable />
        <el-table-column prop="delivery_completed" label="配送完成单" min-width="120" sortable />
        <el-table-column prop="t8_timeout" label="T8超时单" min-width="110" sortable />
        <el-table-column label="T8准时率" min-width="120" align="center" sortable :sort-method="rateSort('t8_ontime_rate')">
          <template #default="{ row }">
            <span class="rt" :class="rateClsUp(row.t8_ontime_rate)">{{ fmtRate(row.t8_ontime_rate) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="complaint" label="投诉" min-width="80" sortable />
        <el-table-column prop="bad_review" label="差评" min-width="80" sortable />
        <el-table-column prop="claim" label="索赔" min-width="80" sortable />
        <el-table-column prop="cancel_liable" label="物流责取消" min-width="110" sortable />
        <el-table-column prop="early_delivered" label="提前送达" min-width="100" sortable />
        <el-table-column label="不满意率" min-width="110" align="center" sortable :sort-method="rateSort('unsat_rate')">
          <template #default="{ row }">
            <span class="rt" :class="rateClsDown(row.unsat_rate)">{{ fmtRate(row.unsat_rate) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="物流妥投率" min-width="120" align="center" sortable :sort-method="rateSort('fulfillment_rate')">
          <template #default="{ row }">
            <span class="rt" :class="rateClsUp(row.fulfillment_rate)">{{ fmtRate(row.fulfillment_rate) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useAppStore } from '../stores/app.js';
import { fetchTeams, fetchRealtimeStation } from '../api/dashboards.js';

const app = useAppStore();
const teams = ref([]);
const teamSel = ref('__all__');
const rows = ref([]);          // 有数据的站点行（已过滤 need_refresh）
const loading = ref(false);
const loaded = ref(false);
const attempted = ref(0);      // 本次实际请求的站点数
const dataDate = ref('');
const lastUpdated = ref('');   // 最近一次成功取数时间（HH:MM:SS）

/* —— 自动刷新（照搬 BotGlobalView 约定：setInterval + onUnmounted 清理）—— */
const autoRefresh = ref(true);
const intervalSec = ref(30);
let pollTimer = null;
function fmtClock(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => void load(true), intervalSec.value * 1000);
}
function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
function restartPoll() {
  if (autoRefresh.value) startPoll();
}
function onAutoToggle(on) {
  if (on) startPoll();
  else stopPoll();
}

const needRefresh = computed(() => loaded.value && attempted.value > 0 && rows.value.length === 0);
const dataNote = computed(() => {
  const p = rows.value.find((x) => x.data_status === 'partial');
  return p ? p.data_note || '' : '';
});

/* —— 聚合：全部站点时对各站计数求和，比率按口径重算（非直接平均比率）—— */
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }

const agg = computed(() => {
  const r = rows.value;
  const pushed = r.reduce((a, x) => a + num(x.pushed_order_volume), 0);
  const completed = r.reduce((a, x) => a + num(x.delivery_completed), 0);
  const t8 = r.reduce((a, x) => a + num(x.t8_timeout), 0);
  const complaint = r.reduce((a, x) => a + num(x.complaint), 0);
  const bad = r.reduce((a, x) => a + num(x.bad_review), 0);
  const claim = r.reduce((a, x) => a + num(x.claim), 0);
  const cancel = r.reduce((a, x) => a + num(x.cancel_liable), 0);
  const early = r.reduce((a, x) => a + num(x.early_delivered), 0);
  return {
    pushed, completed, t8, complaint, bad, claim, cancel, early,
    ontime: pct(completed - t8, completed),
    unsat: pct(complaint * 5 + bad * 5 + claim, pushed),
    fulfill: pct(completed, completed + cancel + early * 2),
  };
});

const cards = computed(() => [
  { label: '推配送单量', value: agg.value.pushed },
  { label: '配送完成单', value: agg.value.completed },
  { label: 'T8超时单', value: agg.value.t8 },
  { label: 'T8准时率', value: fmtRate(agg.value.ontime), cls: rateClsUp(agg.value.ontime) },
  { label: '投诉', value: agg.value.complaint },
  { label: '差评', value: agg.value.bad },
  { label: '索赔', value: agg.value.claim },
  { label: '物流责取消', value: agg.value.cancel },
  { label: '提前点送达', value: agg.value.early },
  { label: '不满意率', value: fmtRate(agg.value.unsat), cls: rateClsDown(agg.value.unsat) },
  { label: '物流妥投率', value: fmtRate(agg.value.fulfill), cls: rateClsUp(agg.value.fulfill) },
]);

/* 比率列排序：null 永远排最后（无论升/降序），便于把「暂无数据」沉底 */
function rateSort(key) {
  return (a, b) => {
    const va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return va - vb;
  };
}

function fmtRate(v) { return v == null ? '—' : (v + '%'); }
/* 越高越好的比率着色（T8准时率 / 物流妥投率） */
function rateClsUp(v) { if (v == null) return 'is-none'; if (v >= 95) return 'is-ok'; if (v >= 90) return 'is-warn'; return 'is-bad'; }
/* 越低越好的比率着色（不满意率） */
function rateClsDown(v) { if (v == null) return 'is-none'; if (v <= 2) return 'is-ok'; if (v <= 5) return 'is-warn'; return 'is-bad'; }

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const ids = teamSel.value === '__all__'
      ? teams.value.map((t) => t.id)
      : [teamSel.value];
    attempted.value = ids.length;
    dataDate.value = '';
    const results = await Promise.all(
      ids.map((id) => fetchRealtimeStation({ team: id }).catch(() => null)),
    );
    const good = [];
    for (const res of results) {
      if (!res || !res.ok || !res.rows || !res.rows.length) continue;
      good.push(res.rows[0]);
      if (res.start && !dataDate.value) dataDate.value = res.start;
    }
    rows.value = good;
    lastUpdated.value = fmtClock();
  } catch (e) {
    if (!silent) app.toast(e.message || '加载失败', 'error');
    if (!silent) rows.value = [];
  } finally {
    loaded.value = true;
    if (!silent) loading.value = false;
  }
}

onMounted(async () => {
  try { const t = await fetchTeams(); teams.value = (t && t.teams) || []; } catch (e) { /* ignore */ }
  await load();
  if (autoRefresh.value) startPoll();
});

onUnmounted(stopPoll);
</script>

<style scoped>
.dv { padding: var(--sp-20); }
.dv-bar { display: flex; align-items: center; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.dv-sel { width: 160px; }
.dv-date-tag { font-size: var(--el-font-size-small); }
.dv-bar .sp { flex: 1; }
.dv-hint { margin-bottom: var(--sp-12); }
.dv-state { padding: var(--sp-40); text-align: center; color: var(--muted); display: flex; gap: var(--sp-8); justify-content: center; align-items: center; }

/* ── KPI 汇总卡片（对齐时段出勤看板的卡片风格）──── */
.dv-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-12); margin-bottom: var(--sp-16); }
.dv-card { background: var(--white); border: 1px solid var(--border-soft); border-radius: var(--r-md); padding: var(--sp-16); display: flex; flex-direction: column; gap: 4px; }
.dv-card-num { font-size: 24px; font-weight: var(--fw-bold); color: var(--brand); }
.dv-card-label { font-size: var(--el-font-size-extra-small); color: var(--muted); }
.dv-card-num.is-ok { color: var(--ok, #2e7d32); }
.dv-card-num.is-warn { color: var(--warn, #ed6c02); }
.dv-card-num.is-bad { color: var(--danger, #d32f2f); }
.dv-card-num.is-none { color: var(--muted); }

/* ── 比率单元格 ──────────────────────────────── */
.rt { font-weight: var(--fw-bold); }
.rt.is-ok { color: var(--ok, #2e7d32); }
.rt.is-warn { color: var(--warn, #ed6c02); }
.rt.is-bad { color: var(--danger, #d32f2f); }
.rt.is-none { color: var(--muted); font-weight: var(--fw-normal); }

.dv-table { border-radius: var(--r-md); }
</style>
