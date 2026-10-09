<template>
  <div class="dv">
    <div class="dv-bar">
      <h2 class="v-title">配送超时</h2>
      <el-select v-model="teamSel" class="dv-sel" placeholder="站点" @change="load">
        <el-option label="全部站点" value="__all__" />
        <el-option v-for="t in teams" :key="t.id" :label="t.name" :value="t.id" />
      </el-select>
      <el-tag v-if="dataDate" type="info" effect="plain" class="dv-date-tag">数据日期：{{ dataDate }}</el-tag>
      <span class="sp" />
      <el-button
        type="primary"
        :loading="refreshing"
        :disabled="refreshing || cooldown > 0"
        :title="cooldown > 0 ? `刷新过于频繁，请等待 ${cooldown} 秒` : '拉取今日运单明细后重新计算'"
        @click="onRefresh"
      >
        <el-icon><Refresh /></el-icon>
        <span v-if="refreshing">刷新中…</span>
        <span v-else-if="cooldown > 0">请等待 {{ cooldown }}s</span>
        <span v-else>刷新数据</span>
      </el-button>
      <el-button :loading="loading" @click="load">
        <el-icon><Refresh /></el-icon> 重新计算
      </el-button>
    </div>

    <el-alert v-if="needRefresh" type="info" :closable="false" show-icon class="dv-hint">
      当前站点今日运单明细尚未落盘，请点「刷新数据」拉取最新订单明细后查看配送超时。
    </el-alert>
    <el-alert v-else-if="dataNote" type="warning" :closable="false" show-icon class="dv-hint">{{ dataNote }}</el-alert>

    <div v-if="loading" class="dv-state">
      <el-icon class="is-loading"><Loading /></el-icon> 加载中…
    </div>
    <template v-else>
      <!-- KPI 汇总卡片（随选中站点聚合；全部站点=各站求和后重算比率/均值） -->
      <div v-if="cards.length" class="dv-cards">
        <div v-for="c in cards" :key="c.label" class="dv-card">
          <span class="dv-card-num" :class="c.cls">{{ c.value }}</span>
          <span class="dv-card-label">{{ c.label }}</span>
        </div>
      </div>

      <!-- 站点配送时效对比表（列可排序；点击站点名下钻看准时率未达100%骑手） -->
      <el-table
        :data="rows"
        stripe
        border
        class="dv-table"
        empty-text="暂无配送超时数据"
        :max-height="560"
        :default-sort="{ prop: 'timeout_total', order: 'descending' }"
      >
        <el-table-column label="站点" min-width="170" fixed sortable>
          <template #default="{ row }">
            <el-button link type="primary" class="dv-link" @click="openStation(row)">
              {{ row.team_name }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column prop="pushed_order_volume" label="推配送单量" min-width="120" sortable />
        <el-table-column prop="delivery_completed" label="配送成功单量" min-width="130" sortable />
        <el-table-column prop="delivering" label="配送中单量" min-width="120" sortable />
        <el-table-column prop="timeout_total" label="超时单量" min-width="110" sortable />
        <el-table-column prop="predicted_timeout" label="预估超时单量" min-width="130" sortable />
        <el-table-column label="准时率" min-width="110" align="center" sortable :sort-method="numSort('ontime_rate')">
          <template #default="{ row }">
            <span class="rt" :class="rateClsUp(row.ontime_rate)">{{ fmtRate(row.ontime_rate) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="预估准时率" min-width="120" align="center" sortable :sort-method="numSort('predicted_ontime_rate')">
          <template #default="{ row }">
            <span class="rt" :class="rateClsUp(row.predicted_ontime_rate)">{{ fmtRate(row.predicted_ontime_rate) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="复合超时时长(分)" min-width="140" align="center" sortable :sort-method="numSort('composite_overtime_min')">
          <template #default="{ row }">
            <span class="rt rt--bad">{{ fmtMin(row.composite_overtime_min) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <!-- 两级下钻抽屉：站点 → 准时率未达100%骑手 → 超时订单明细 -->
    <el-drawer v-model="drawerOpen" :title="drawerTitle" size="46%" :with-header="true">
      <div v-if="drillLevel === 'riders'">
        <div class="dv-drill-hd">
          共 {{ drawerStation.riders.length }} 名骑手准时率未达 100%（按超平台期望分钟降序），点击骑手查看超时订单
        </div>
        <el-table :data="drawerStation.riders" stripe border class="dv-drill-table"
                  :default-sort="{ prop: 'overtime_min', order: 'descending' }" @row-click="onRiderRow">
          <el-table-column label="骑手" min-width="150" fixed sortable>
            <template #default="{ row }">
              <el-button link type="primary" class="dv-link">{{ row.rider_name || row.rider_id || '未知' }}</el-button>
            </template>
          </el-table-column>
          <el-table-column prop="delivered" label="配送成功单量" min-width="130" align="center" sortable />
          <el-table-column prop="timeout" label="超时单量" min-width="110" align="center" sortable />
          <el-table-column label="准时率" min-width="110" align="center" sortable :sort-method="numSort('ontime_rate')">
            <template #default="{ row }"><span class="rt" :class="rateClsUp(row.ontime_rate)">{{ fmtRate(row.ontime_rate) }}</span></template>
          </el-table-column>
          <el-table-column label="复合超时时长(分)" min-width="140" align="center" sortable :sort-method="numSort('overtime_min')">
            <template #default="{ row }"><span class="rt rt--bad">{{ fmtMin(row.overtime_min) }}</span></template>
          </el-table-column>
        </el-table>
      </div>
      <div v-else-if="drillLevel === 'orders'">
        <el-button text class="dv-back" @click="backToRiders"><el-icon><ArrowLeft /></el-icon> 返回骑手列表</el-button>
        <div class="dv-drill-hd">
          {{ selectedRider.rider_name || selectedRider.rider_id }} ·
          配送成功 {{ selectedRider.delivered }} 单 · 超时 {{ selectedRider.timeout }} 单 ·
          准时率 {{ fmtRate(selectedRider.ontime_rate) }}
        </div>
        <el-table :data="selectedRider.timeout_orders" stripe border class="dv-drill-table"
                  :default-sort="{ prop: 'over_min', order: 'descending' }">
          <el-table-column prop="tracking_id" label="运单号" min-width="200" />
          <el-table-column label="超时分钟" min-width="110" align="center" sortable>
            <template #default="{ row }"><span class="rt rt--bad">{{ fmtMin(row.over_min) }}</span></template>
          </el-table-column>
          <el-table-column label="严重度" min-width="100" align="center">
            <template #default="{ row }"><span class="sev" :class="sevCls(row.severity)">{{ sevText(row.severity) }}</span></template>
          </el-table-column>
        </el-table>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Refresh, Loading, ArrowLeft } from '@element-plus/icons-vue';
import { useAppStore } from '../stores/app.js';
import {
  fetchTeams, fetchRealtimeTimeout, refreshStandard, fetchRefreshStatus,
} from '../api/dashboards.js';

const app = useAppStore();
const teams = ref([]);
const teamSel = ref('__all__');
const rows = ref([]);
const loading = ref(false);
const loaded = ref(false);
const attempted = ref(0);
const dataDate = ref('');

/* —— 刷新数据（拉取今日订单明细后重算）：复用标准达成的 refreshStandard + 轮询 —— */
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
let pollTimer = null;
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

const needRefresh = computed(() => loaded.value && attempted.value > 0 && rows.value.length === 0);
const dataNote = computed(() => {
  const p = rows.value.find((x) => x.data_status === 'partial');
  return p ? p.data_note || '' : '';
});

/* —— 聚合：全部站点时对各站计数求和，比率/均值按口径重算 —— */
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }

const agg = computed(() => {
  const r = rows.value;
  const pushed = r.reduce((a, x) => a + num(x.pushed_order_volume), 0);
  const completed = r.reduce((a, x) => a + num(x.delivery_completed), 0);
  const delivering = r.reduce((a, x) => a + num(x.delivering), 0);
  const timeout = r.reduce((a, x) => a + num(x.timeout_total), 0);
  const predicted = r.reduce((a, x) => a + num(x.predicted_timeout), 0);
  const composite = r.reduce((a, x) => a + num(x.composite_overtime_min), 0);
  const handled = completed + delivering;
  return {
    pushed, completed, delivering, timeout, predicted, composite, handled,
    ontime: pct(completed - timeout, completed),
    predicted_ontime: pct(handled - timeout - predicted, handled),
  };
});

const cards = computed(() => [
  { label: '推配送单量', value: agg.value.pushed },
  { label: '配送成功单量', value: agg.value.completed },
  { label: '配送中单量', value: agg.value.delivering },
  { label: '超时单量', value: agg.value.timeout, cls: 'is-bad' },
  { label: '预估超时单量', value: agg.value.predicted, cls: 'is-warn' },
  { label: '准时率', value: fmtRate(agg.value.ontime), cls: rateClsUp(agg.value.ontime) },
  { label: '预估准时率', value: fmtRate(agg.value.predicted_ontime), cls: rateClsUp(agg.value.predicted_ontime) },
  { label: '复合超时时长(分)', value: fmtMin(agg.value.composite), cls: 'is-bad' },
]);

/* 数值列排序：null 永远排最后 */
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
/* 越高越好的比率着色（准时率 / 预估准时率） */
function rateClsUp(v) { if (v == null) return 'is-none'; if (v >= 95) return 'is-ok'; if (v >= 90) return 'is-warn'; return 'is-bad'; }
/* 严重度着色：8-15 较轻、15-30 偏重、≥30 严重 */
function sevCls(s) {
  if (s === '>=30') return 'sev--heavy';
  if (s === '15-30') return 'sev--mid';
  return 'sev--light';
}
function sevText(s) { if (s === '>=30') return '≥30分'; if (s === '15-30') return '15-30分'; return '8-15分'; }

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
      good.push(res.rows[0]);
      if (res.start && !dataDate.value) dataDate.value = res.start;
    }
    rows.value = good;
  } catch (e) {
    if (!silent) app.toast(e.message || '加载失败', 'error');
    if (!silent) rows.value = [];
  } finally {
    loaded.value = true;
    if (!silent) loading.value = false;
  }
}

/* —— 刷新数据：触发订单明细拉取（导出式取数），轮询完成后重算 —— */
async function onRefresh() {
  if (refreshing.value || cooldown.value > 0) return;
  refreshing.value = true;
  try {
    const body = {};
    if (teamSel.value !== '__all__') body.teams = [teamSel.value];
    const res = await refreshStandard(body);
    if (res && res.already_running) {
      app.toast('已有刷新任务在进行', 'info');
      startCooldown(REFRESH_COOLDOWN_SEC);
      poll();
      return;
    }
    if (!res || !res.ok) {
      app.toast((res && res.error) || '刷新启动失败', 'error');
      refreshing.value = false;
      return;
    }
    startCooldown(REFRESH_COOLDOWN_SEC);
    poll();
  } catch (e) {
    const ra = e && e.data && e.data.retry_after;
    startCooldown(ra && ra > 0 ? ra : REFRESH_COOLDOWN_SEC);
    app.toast(e.message || '刷新失败', 'error');
    refreshing.value = false;
  }
}
function poll() {
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const st = await fetchRefreshStatus();
      const status = st && st.status;
      if (!status || !status.running) {
        stopPoll();
        refreshing.value = false;
        app.toast('刷新完成', 'success');
        load();
      }
    } catch (e) { /* 轮询失败忽略 */ }
  }, 2000);
}

/* —— 两级下钻 —— */
const drawerOpen = ref(false);
const drillLevel = ref('riders');
const drawerStation = ref({ team_name: '', riders: [] });
const selectedRider = ref({ timeout_orders: [] });
const drawerTitle = computed(() => {
  if (drillLevel.value === 'orders') {
    const r = selectedRider.value;
    return `${r.rider_name || r.rider_id || '骑手'} · 超时订单明细`;
  }
  return `${drawerStation.value.team_name} · 准时率未达100%骑手`;
});
function openStation(row) {
  drawerStation.value = row;
  drillLevel.value = 'riders';
  selectedRider.value = { timeout_orders: [] };
  drawerOpen.value = true;
}
function onRiderRow(row) { openRider(row); }
function openRider(rider) {
  selectedRider.value = rider;
  drillLevel.value = 'orders';
}
function backToRiders() {
  drillLevel.value = 'riders';
  selectedRider.value = { timeout_orders: [] };
}

onMounted(async () => {
  try { const t = await fetchTeams(); teams.value = (t && t.teams) || []; } catch (e) { /* ignore */ }
  await load();
});

onUnmounted(() => {
  stopPoll();
  if (cooldownTimer) clearInterval(cooldownTimer);
});
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

/* ── 下钻抽屉 ──────────────────────────────── */
.dv-drill-hd { font-size: var(--el-font-size-small); color: var(--muted); margin: var(--sp-4) 0 var(--sp-12); }
.dv-drill-table { width: 100%; }
.dv-link { padding: 0; }
.dv-back { margin-bottom: var(--sp-12); }
.sev { display: inline-block; padding: 1px var(--sp-8); border-radius: var(--r-pill); font-size: var(--el-font-size-extra-small); font-weight: var(--fw-semibold); }
.sev--light { background: color-mix(in srgb, var(--warn, #ed6c02) 14%, transparent); color: var(--warn, #ed6c02); }
.sev--mid { background: color-mix(in srgb, #f57c00 16%, transparent); color: #f57c00; }
.sev--heavy { background: color-mix(in srgb, var(--danger, #d32f2f) 16%, transparent); color: var(--danger, #d32f2f); }

.dv-table { border-radius: var(--r-md); }
</style>
