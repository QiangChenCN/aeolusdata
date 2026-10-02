<template>
  <div class="dv">
    <div class="dv-bar">
      <h2 class="v-title">实时数据</h2>
      <el-select v-model="teamSel" class="dv-sel" placeholder="站点" @change="load">
        <el-option label="全部站点" value="__all__" />
        <el-option v-for="t in teams" :key="t.id" :label="t.name" :value="t.id" />
      </el-select>
      <el-date-picker
        v-model="range" type="daterange" value-format="YYYY-MM-DD"
        range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期"
        class="dv-range" @change="load"
      />
      <span class="sp" />
      <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon> 刷新</el-button>
    </div>

    <el-alert v-if="needRefresh" type="info" :closable="false" show-icon class="dv-hint">
      当前数据尚未刷新，请在标准达成中执行「刷新数据」后回来查看。
    </el-alert>
    <el-alert v-if="dataNote" type="warning" :closable="false" show-icon class="dv-hint">{{ dataNote }}</el-alert>

    <div v-if="loading" class="dv-state"><el-icon class="is-loading"><Loading /></el-icon> 加载中…</div>
    <el-table v-else :data="rows" stripe border class="dv-table" height="520" empty-text="暂无实时数据">
      <el-table-column prop="team_name" label="站点" min-width="160" fixed />
      <el-table-column prop="pushed_order_volume" label="推送单量" width="110" />
      <el-table-column prop="delivery_completed" label="已送达" width="100" />
      <el-table-column prop="t8_timeout" label="8分钟超时" width="110" />
      <el-table-column prop="t8_ontime_rate" label="8分钟准时率" width="120" />
      <el-table-column prop="complaint" label="投诉" width="80" />
      <el-table-column prop="bad_review" label="差评" width="80" />
      <el-table-column prop="claim" label="理赔" width="80" />
      <el-table-column prop="cancel_liable" label="有责取消" width="100" />
      <el-table-column prop="early_delivered" label="提前送达" width="100" />
      <el-table-column prop="unsat_rate" label="不满意率" width="100" />
      <el-table-column prop="fulfillment_rate" label="履约率" width="100" />
    </el-table>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useAppStore } from '../stores/app.js';
import { fetchTeams, fetchRealtimeStation } from '../api/dashboards.js';

const app = useAppStore();
const teams = ref([]);
const teamSel = ref('__all__');
const range = ref([]);
const data = ref(null);
const loading = ref(false);

const rows = computed(() => (data.value && data.value.rows) || []);
const needRefresh = computed(() => (data.value && data.value.need_refresh) || (rows.value.length === 0 && !!data.value));
const dataNote = computed(() => (data.value && data.value.data_note) || '');

function start() { return range.value && range.value[0]; }
function end() { return range.value && range.value[1]; }

async function load() {
  loading.value = true;
  try {
    const res = await fetchRealtimeStation({ team: teamSel.value, start: start(), end: end() });
    data.value = res || {};
  } catch (e) {
    app.toast(e.message || '加载失败', 'error');
    data.value = { rows: [] };
  } finally {
    loading.value = false;
  }
}
onMounted(async () => {
  try { const t = await fetchTeams(); teams.value = (t && t.teams) || []; } catch (e) { /* ignore */ }
  await load();
});
</script>

<style scoped>
.dv { padding: var(--sp-20); }
.dv-bar { display: flex; align-items: center; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--fs-title); }
.dv-sel { width: 160px; }
.dv-range { width: 280px; }
.dv-bar .sp { flex: 1; }
.dv-hint { margin-bottom: var(--sp-12); }
.dv-table { border-radius: var(--r-md); }
.dv-state { padding: var(--sp-40); text-align: center; color: var(--muted); display: flex; gap: var(--sp-8); justify-content: center; align-items: center; }
</style>
