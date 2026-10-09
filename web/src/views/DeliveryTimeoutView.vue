<template>
  <div class="dv">
    <div class="dv-bar">
      <h2 class="v-title">配送超时</h2>
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
      当前站点今日运单明细尚未落盘，请先在「标准达成」中点「刷新数据」拉取后，再来此查看配送超时。
    </el-alert>
    <el-alert v-else-if="dataNote" type="warning" :closable="false" show-icon class="dv-hint">{{ dataNote }}</el-alert>

    <div v-if="loading" class="dv-state">
      <el-icon class="is-loading"><Loading /></el-icon> 加载中…
    </div>
    <template v-else>
      <!-- KPI 汇总卡片（随选中站点聚合，全部站点=各站求和后重算比率/均值） -->
      <div v-if="cards.length" class="dv-cards">
        <div v-for="c in cards" :key="c.label" class="dv-card">
          <span class="dv-card-num" :class="c.cls">{{ c.value }}</span>
          <span class="dv-card-label">{{ c.label }}</span>
        </div>
      </div>

      <!-- 站点超时对比表（列可排序，默认按超时单降序；每行可展开看该站超时订单明细） -->
      <el-table
        :data="rows"
        stripe
        border
        class="dv-table"
        empty-text="暂无配送超时数据"
        :max-height="560"
        :default-sort="{ prop: 'timeout_total', order: 'descending' }"
      >
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="dv-detail">
              <div class="dv-detail-hd">该站超时订单明细（按超时分钟降序，共 {{ row.timeout_orders.length }} 单）</div>
              <el-table
                v-if="row.timeout_orders.length"
                :data="row.timeout_orders"
                size="small"
                border
                class="dv-detail-table"
                :default-sort="{ prop: 'over_min', order: 'descending' }"
              >
                <el-table-column prop="tracking_id" label="运单号" min-width="180" />
                <el-table-column label="骑手" min-width="140">
                  <template #default="{ row: d }">
                    <span>{{ d.rider_name || d.rider_id || '—' }}</span>
                  </template>
                </el-table-column>
                <el-table-column prop="over_min" label="超时分钟" min-width="110" sortable />
                <el-table-column label="严重度" min-width="100" align="center">
                  <template #default="{ row: d }">
                    <span class="sev" :class="sevCls(d.severity)">{{ sevText(d.severity) }}</span>
                  </template>
                </el-table-column>
              </el-table>
              <div v-else class="dv-detail-empty">该站暂无超时订单</div>
            </div>
          </template>
        </el-table-column>

        <el-table-column prop="team_name" label="站点" min-width="160" fixed sortable />
        <el-table-column prop="delivery_completed" label="配送完成单" min-width="120" sortable />
        <el-table-column prop="timeout_total" label="超时单(T8)" min-width="120" sortable />
        <el-table-column label="准时率" min-width="110" align="center" sortable :sort-method="numSort('ontime_rate')">
          <template #default="{ row }">
            <span class="rt" :class="rateClsUp(row.ontime_rate)">{{ fmtRate(row.ontime_rate) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="平均超时分钟" min-width="130" align="center" sortable :sort-method="numSort('avg_over_min')">
          <template #default="{ row }">
            <span class="rt">{{ fmtMin(row.avg_over_min) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最大超时分钟" min-width="130" align="center" sortable :sort-method="numSort('max_over_min')">
          <template #default="{ row }">
            <span class="rt rt--bad">{{ fmtMin(row.max_over_min) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="b_815" label="8-15分" min-width="100" sortable />
        <el-table-column prop="b_1530" label="15-30分" min-width="100" sortable />
        <el-table-column prop="b_30" label="≥30分" min-width="100" sortable />
      </el-table>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useAppStore } from '../stores/app.js';
import { fetchTeams, fetchRealtimeTimeout } from '../api/dashboards.js';

const app = useAppStore();
const teams = ref([]);
const teamSel = ref('__all__');
const rows = ref([]);          // 有数据的站点行（已过滤 need_refresh）
const loading = ref(false);
const loaded = ref(false);
const attempted = ref(0);      // 本次实际请求的站点数
const dataDate = ref('');
const lastUpdated = ref('');   // 最近一次成功取数时间（HH:MM:SS）

/* —— 自动刷新（照搬实时数据看板约定：setInterval + onUnmounted 清理）—— */
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

/* —— 聚合：全部站点时对各站计数求和，比率/均值按口径重算（非直接平均）—— */
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }
function bval(x, k) { const v = x.buckets && x.buckets[k]; return v == null ? 0 : Number(v); }

const agg = computed(() => {
  const r = rows.value;
  const completed = r.reduce((a, x) => a + num(x.delivery_completed), 0);
  const timeout = r.reduce((a, x) => a + num(x.timeout_total), 0);
  const b815 = r.reduce((a, x) => a + bval(x, '8-15'), 0);
  const b1530 = r.reduce((a, x) => a + bval(x, '15-30'), 0);
  const b30 = r.reduce((a, x) => a + bval(x, '>=30'), 0);
  const over_sum = r.reduce((a, x) => a + num(x.over_min_sum), 0);
  const avg = timeout > 0 ? Math.round((over_sum / timeout) * 10) / 10 : null;
  const max = r.reduce((m, x) => (x.max_over_min == null ? m : Math.max(m, x.max_over_min)), null);
  return {
    completed, timeout, b815, b1530, b30, avg, max,
    ontime: pct(completed - timeout, completed),
  };
});

const cards = computed(() => [
  { label: '配送完成单', value: agg.value.completed },
  { label: '超时单(T8)', value: agg.value.timeout, cls: 'is-bad' },
  { label: '准时率', value: fmtRate(agg.value.ontime), cls: rateClsUp(agg.value.ontime) },
  { label: '平均超时分钟', value: fmtMin(agg.value.avg), cls: 'is-warn' },
  { label: '最大超时分钟', value: fmtMin(agg.value.max), cls: 'is-bad' },
  { label: '8-15分', value: agg.value.b815 },
  { label: '15-30分', value: agg.value.b1530 },
  { label: '≥30分', value: agg.value.b30, cls: 'is-bad' },
]);

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

function fmtRate(v) { return v == null ? '—' : (v + '%'); }
function fmtMin(v) { return v == null ? '—' : v; }
/* 越高越好的比率着色（准时率） */
function rateClsUp(v) { if (v == null) return 'is-none'; if (v >= 95) return 'is-ok'; if (v >= 90) return 'is-warn'; return 'is-bad'; }

/* 严重度着色：8-15 较轻、15-30 偏重、≥30 严重 */
function sevCls(s) {
  if (s === '>=30') return 'sev--heavy';
  if (s === '15-30') return 'sev--mid';
  return 'sev--light';
}
function sevText(s) {
  if (s === '>=30') return '≥30分';
  if (s === '15-30') return '15-30分';
  return '8-15分';
}

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const ids = teamSel.value === '__all__'
      ? teams.value.map((t) => t.id)
      : [teamSel.value];
    attempted.value = ids.length;
    dataDate.value = '';
    const results = await Promise.all(
      ids.map((id) => fetchRealtimeTimeout({ team: id }).catch(() => null)),
    );
    const good = [];
    for (const res of results) {
      if (!res || !res.ok || !res.rows || !res.rows.length) continue;
      const row = res.rows[0];
      // 把分桶提到顶层便于表格排序（保持与 Python buckets 键同步）
      row.b_815 = bval(row, '8-15');
      row.b_1530 = bval(row, '15-30');
      row.b_30 = bval(row, '>=30');
      good.push(row);
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

/* ── KPI 汇总卡片 ──── */
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
.rt--bad { color: var(--danger, #d32f2f); }

/* ── 展开明细 ──────────────────────────────── */
.dv-detail { padding: var(--sp-8) var(--sp-16) var(--sp-16); }
.dv-detail-hd { font-size: var(--el-font-size-small); color: var(--muted); margin: var(--sp-4) 0 var(--sp-8); }
.dv-detail-table { width: 100%; }
.dv-detail-empty { color: var(--muted); padding: var(--sp-8) 0; }
.sev { display: inline-block; padding: 1px var(--sp-8); border-radius: var(--r-pill); font-size: var(--el-font-size-extra-small); font-weight: var(--fw-semibold); }
.sev--light { background: color-mix(in srgb, var(--warn, #ed6c02) 14%, transparent); color: var(--warn, #ed6c02); }
.sev--mid { background: color-mix(in srgb, #f57c00 16%, transparent); color: #f57c00; }
.sev--heavy { background: color-mix(in srgb, var(--danger, #d32f2f) 16%, transparent); color: var(--danger, #d32f2f); }

.dv-table { border-radius: var(--r-md); }
</style>
