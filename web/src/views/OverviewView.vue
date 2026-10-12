<template>
  <div class="dv">
    <div class="dv-bar">
      <h2 class="v-title">总览</h2>
      <el-date-picker
        v-model="range" type="daterange" value-format="YYYY-MM-DD"
        range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期"
        class="dv-range" @change="load"
      />
      <span class="sp" />
      <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon> 刷新</el-button>
    </div>

    <div v-if="loading" class="dv-state"><el-icon class="is-loading"><Loading /></el-icon> 加载中…</div>
    <template v-else>
      <div v-if="totals" class="dv-cards">
        <div v-for="c in totalCards" :key="c.label" class="dv-card">
          <span class="dv-card-num">{{ c.value }}</span>
          <span class="dv-card-label">{{ c.label }}</span>
        </div>
      </div>
      <el-table :data="rows" stripe border class="dv-table" height="520" empty-text="暂无站点数据">
        <el-table-column prop="name" label="站点" min-width="160" fixed />
        <el-table-column prop="accepted" label="接单" width="110" />
        <el-table-column prop="completed" label="完成" width="110" />
        <el-table-column prop="valid" label="有效" width="110" />
        <el-table-column prop="days" label="天数" width="90" />
      </el-table>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { fetchOverviewSiteOrders } from '../api/dashboards.js';

const range = ref([]);
const data = ref(null);
const loading = ref(false);

const rows = computed(() => (data.value && data.value.sites) || []);
const totals = computed(() => data.value && data.value.totals);
const totalCards = computed(() => {
  const t = totals.value; if (!t) return [];
  return [
    { label: '站点数', value: t.sites ?? '—' },
    { label: '接单', value: t.accepted ?? '—' },
    { label: '完成', value: t.completed ?? '—' },
    { label: '有效', value: t.valid ?? '—' },
  ];
});

function start() { return range.value && range.value[0]; }
function end() { return range.value && range.value[1]; }

async function load() {
  loading.value = true;
  try {
    const res = await fetchOverviewSiteOrders({ start: start(), end: end() });
    data.value = res || {};
  } catch (e) {
    ElMessage.error(e.message || '加载失败');
    data.value = { sites: [] };
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<style scoped>
.dv { padding: var(--sp-20); }
.dv-bar { display: flex; align-items: center; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.dv-range { width: 280px; }
.dv-bar .sp { flex: 1; }
.dv-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-12); margin-bottom: var(--sp-16); }
.dv-card { background: var(--white); border: 1px solid var(--border-soft); border-radius: var(--r-md); padding: var(--sp-16); display: flex; flex-direction: column; gap: 4px; }
.dv-card-num { font-size: 24px; font-weight: var(--fw-bold); color: var(--brand); }
.dv-card-label { font-size: var(--el-font-size-extra-small); color: var(--muted); }
.dv-table { border-radius: var(--r-md); }
.dv-state { padding: var(--sp-40); text-align: center; color: var(--muted); display: flex; gap: var(--sp-8); justify-content: center; align-items: center; }
</style>
