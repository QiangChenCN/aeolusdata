<template>
  <div class="dv">
    <div class="dv-bar">
      <h2 class="v-title">标准达成</h2>
      <el-select v-model="teamSel" class="dv-sel" placeholder="站点" @change="load">
        <el-option label="全部站点" value="__all__" />
        <el-option v-for="t in teamOptions" :key="t.id" :label="t.name" :value="t.id" />
      </el-select>
      <el-date-picker
        v-model="date" type="date" value-format="YYYY-MM-DD"
        placeholder="选择日期（清空则默认今天）" class="dv-date" clearable @change="load"
      />
      <span class="dv-data-time" :class="{ 'is-stale': dataStale }" :title="dataStale ? '取数时间早于所选日期，数据可能已过期，请点「刷新数据」' : '数据取数时间'">
        <el-icon><Clock /></el-icon> 取数时间：{{ dataTime || '未知' }}
      </span>
      <span class="sp" />
      <el-button
        type="primary"
        :loading="refreshing"
        :disabled="refreshing || cooldown > 0"
        :title="cooldown > 0 ? `刷新过于频繁，请等待 ${cooldown} 秒（与后端限时一致）` : ''"
        @click="onRefresh"
      >
        <el-icon><Refresh /></el-icon>
        <span v-if="refreshing">刷新中…</span>
        <span v-else-if="cooldown > 0">请等待 {{ cooldown }}s</span>
        <span v-else>刷新数据</span>
      </el-button>
    </div>

    <el-alert v-if="needRefresh" type="info" :closable="false" show-icon class="dv-hint">
      当前数据尚未刷新，点击下方「刷新数据」拉取最新结果。
    </el-alert>
    <el-alert v-if="dataNote" type="warning" :closable="false" show-icon class="dv-hint">{{ dataNote }}</el-alert>
    <el-alert v-if="noStationConfig" type="warning" :closable="false" show-icon class="dv-hint">
      <template v-if="!monthConfigured">
        {{ monthOf() }} 月份尚未配置考核标准，请到「考核设置 → 标准达成设置」为该月份添加参与站点并保存，看板才会展示数据。
      </template>
      <template v-else>
        {{ monthOf() }} 月份未添加任何参与考核站点（已保存为空），请到「考核设置 → 标准达成设置」添加站点。
      </template>
    </el-alert>

    <el-tabs v-model="tab" class="dv-tabs">
      <el-tab-pane label="站点看板" name="station">
        <div class="dv-filter">
          <span class="dv-filter-count">共 {{ stationRows.length }} 个站点</span>
        </div>
        <div v-if="summaryCards.length" class="dv-cards">
          <div v-for="c in summaryCards" :key="c.label" class="dv-card">
            <span class="dv-card-num">{{ c.value }}</span>
            <span class="dv-card-label">{{ c.label }}</span>
          </div>
        </div>
        <div class="dv-table-wrap">
          <el-table v-loading="loading" :data="stationRows" stripe border class="dv-table" height="100%">
            <el-table-column prop="team_name" label="站点" min-width="120" fixed sortable show-overflow-tooltip />
            <el-table-column prop="scale_target" label="天应排" min-width="90" align="center" sortable />
            <el-table-column label="门槛" min-width="90" align="center" sortable>
              <template #default="{ row }">
                <span v-if="row.threshold_count == null" class="dv-warn" :title="row.data_note || '未设置门槛'">未设置</span>
                <span v-else>{{ row.threshold_count }}</span>
              </template>
            </el-table-column>
            <el-table-column label="封顶" min-width="90" align="center" sortable>
              <template #default="{ row }">
                <span v-if="row.cap_count == null" class="dv-warn" :title="row.data_note || '未设置封顶'">未设置</span>
                <span v-else>{{ row.cap_count }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="scheduled_num" label="排班" min-width="90" align="center" sortable />
            <el-table-column prop="rider_with_order" label="有单" min-width="90" align="center" sortable />
            <el-table-column prop="achieved_num" label="达标" min-width="90" align="center" sortable />
            <el-table-column prop="achieved_rate" label="达标率" min-width="110" align="center" sortable show-overflow-tooltip>
              <template #default="{ row }"><span :class="rateCls(row.achieved_rate)">{{ fmtPct(row.achieved_rate) }}</span></template>
            </el-table-column>
            <el-table-column prop="expected_achievable_num" label="预计达成" min-width="110" align="center" sortable show-overflow-tooltip />
            <el-table-column prop="expected_achievable_rate" label="预计达成率" min-width="120" align="center" sortable show-overflow-tooltip>
              <template #default="{ row }"><span :class="rateCls(row.expected_achievable_rate)">{{ fmtPct(row.expected_achievable_rate) }}</span></template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <el-tab-pane label="骑手看板" name="rider">
          <div class="dv-filter">
            <el-input v-model="riderFilter" clearable placeholder="筛选骑手姓名" class="dv-filter-input">
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <el-select v-model="riderStdFilter" clearable placeholder="达成标准" class="dv-filter-sel">
              <el-option label="全部标准" value="" />
              <el-option v-for="s in riderStdOptions" :key="s" :label="s" :value="s" />
            </el-select>
            <el-select v-model="riderOnlineFilter" clearable placeholder="在线状态" class="dv-filter-sel">
              <el-option v-for="o in riderOnlineOptions" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
            <el-popover placement="bottom-end" :width="280" trigger="click">
              <template #reference>
                <el-button><el-icon><Setting /></el-icon> 列设置</el-button>
              </template>
              <div class="col-set">
                <div v-for="g in COL_GROUPS" :key="g.name" class="col-set-group">
                  <div class="col-set-gname">{{ g.name }}</div>
                  <el-checkbox v-for="c in g.cols" :key="c.prop" v-model="colVis[c.prop]" size="small">{{ c.label }}</el-checkbox>
                </div>
                <div class="col-set-tip">「骑手ID / 姓名 / 所属站点」为定位列，始终显示</div>
              </div>
            </el-popover>
            <span class="dv-filter-count">共 {{ riderRowsView.length }} 名骑手</span>
          </div>
          <div class="dv-rider-body">
            <div class="dv-table-wrap">
              <el-table v-loading="riderLoading" :data="riderPagedRows" stripe border size="large" class="dv-table" height="100%" empty-text="暂无骑手数据" @sort-change="onRiderSort">
                <el-table-column prop="rider_id" label="骑手ID" :min-width="riderColWidths['rider_id']" fixed sortable="custom" />
                <el-table-column prop="rider_name" label="骑手姓名" :min-width="riderColWidths['rider_name']" fixed sortable="custom">
                  <template #default="{ row }">
                    <span>{{ row.rider_name }}</span><el-tag size="small" :type="row.scheduled ? 'success' : 'info'" class="dv-sched-tag">{{ row.scheduled ? '排班' : '未排班' }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="team_name" label="所属站点" :min-width="riderColWidths['team_name']" fixed sortable="custom" />
                <el-table-column v-if="colVisible('valid_orders')" prop="valid_orders" label="有效完成单量" :min-width="riderColWidths['valid_orders']" align="center" sortable="custom" />
                <el-table-column v-if="colVisible('valid_online_min')" prop="valid_online_min" label="有效出勤时长" :min-width="riderColWidths['valid_online_min']" align="center" sortable="custom">
                  <template #default="{ row }">{{ fmtDur(row.valid_online_min) }}</template>
                </el-table-column>
                <el-table-column v-if="colVisible('achieved_standard')" prop="achieved_standard" label="达成标准" :min-width="riderColWidths['achieved_standard']" align="center" sortable="custom">
                  <template #default="{ row }"><el-tag size="small" :type="stdType(row.achieved_standard)">{{ row.achieved_standard }}</el-tag></template>
                </el-table-column>
                <el-table-column v-if="colVisible('std1_forecast_level')" prop="std1_forecast_level" label="预计可达标" :min-width="riderColWidths['std1_forecast_level']" align="center" sortable="custom">
                  <template #default="{ row }"><el-tag size="small" :type="fcType(row.std1_forecast)">{{ row.std1_forecast }}</el-tag></template>
                </el-table-column>
                <el-table-column v-if="colVisible('next_level_order_gap')" prop="next_level_order_gap" label="距下一标准单量差值" :min-width="riderColWidths['next_level_order_gap']" align="center" sortable="custom">
                  <template #default="{ row }"><span :class="{ 'dv-zero-gray': Number(row.next_level_order_gap) === 0 }">{{ row.next_level_order_gap }}</span></template>
                </el-table-column>
                <el-table-column v-if="colVisible('prev_level_duration_gap')" prop="prev_level_duration_gap" label="距下一标准时长差异" :min-width="riderColWidths['prev_level_duration_gap']" align="center" sortable="custom">
                  <template #default="{ row }"><span :class="{ 'dv-zero-gray': Number(row.prev_level_duration_gap) === 0 }">{{ fmtDur(row.prev_level_duration_gap) }}</span></template>
                </el-table-column>
                <el-table-column v-if="colVisible('online_status_code')" prop="online_status_code" label="在线状态" :min-width="riderColWidths['online_status_code']" align="center" sortable="custom">
                  <template #default="{ row }"><el-tag size="small" :type="onlineTagType(row.online_status_code)">{{ row.online_status || '—' }}</el-tag></template>
                </el-table-column>
                <el-table-column v-if="colVisible('delivering_orders')" prop="delivering_orders" label="配送中单量" :min-width="riderColWidths['delivering_orders']" align="center" sortable="custom">
                  <template #default="{ row }"><span :class="{ 'dv-zero-gray': Number(row.delivering_orders) === 0 }">{{ row.delivering_orders }}</span></template>
                </el-table-column>
                <el-table-column v-if="colVisible('non_today_orders')" prop="non_today_orders" label="非今日订单" :min-width="riderColWidths['non_today_orders']" align="center" sortable="custom">
                  <template #default="{ row }"><span :class="{ 'dv-zero-gray': Number(row.non_today_orders) === 0 }">{{ row.non_today_orders }}</span></template>
                </el-table-column>
                <el-table-column v-if="colVisible('reverse_orders')" prop="reverse_orders" label="逆向单" :min-width="riderColWidths['reverse_orders']" align="center" sortable="custom">
                  <template #default="{ row }"><span :class="{ 'dv-zero-gray': Number(row.reverse_orders) === 0 }">{{ row.reverse_orders }}</span></template>
                </el-table-column>
                <el-table-column v-if="colVisible('reassign_orders')" prop="reassign_orders" label="改派单" :min-width="riderColWidths['reassign_orders']" align="center" sortable="custom">
                  <template #default="{ row }"><span :class="{ 'dv-zero-gray': Number(row.reassign_orders) === 0 }">{{ row.reassign_orders }}</span></template>
                </el-table-column>
              </el-table>
            </div>
            <el-pagination
              class="dv-pager" background layout="total, sizes, prev, pager, next, jumper"
              :total="riderTotal" :page-size="riderPageSize" :current-page="riderPage"
              :page-sizes="[25, 50, 75, 100]"
              @current-change="riderPage = $event" @size-change="onRiderSizeChange"
            />
          </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { Search, Refresh, Setting, Clock } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';

import { filterRiders } from '../utils/riderFilter.js';
import {
  fetchTeams, fetchStandardStationReport, fetchStandardRiders,
  refreshStandard, fetchRefreshStatus,
  fetchStandardGradeGlobal,
} from '../api/dashboards.js';


const teams = ref([]);
const teamSel = ref('__all__');
/* 站点下拉严格按「标准达成设置」里当前月份的参与站点（partIds）显示，不回落全部站点、不回落默认站点 */
const partIds = ref(new Set());
const monthConfigured = ref(true);
const teamOptions = computed(() => (teams.value || []).filter((t) => partIds.value.has(String(t.id))));
const noStationConfig = computed(() => partIds.value.size === 0);
const tab = ref('station');
const riderFilter = ref('');
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const date = ref(todayStr());
const effDate = computed(() => date.value || todayStr());
function monthOf() { return effDate.value.slice(0, 7); }
const data = ref(null);
const loading = ref(false);
const refreshing = ref(false);
let pollTimer = null;

// 刷新按钮冷却倒计时：对齐后端 refresh-all 频控（refresh-runner.service.ts 的
// RATE_LIMIT_SEC=60，全局 REFRESH_ALL_GLOBAL_GAP_SEC=15）。后端接受刷新的那一刻
// 起算 60s；若被频控拒绝（429 + RATE_LIMITED），用服务端返回的 retry_after 对齐剩余秒数。
const cooldown = ref(0);
let cooldownTimer = null;
const REFRESH_COOLDOWN_SEC = 60;
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

const rows = computed(() => (data.value && data.value.rows) || []);
const needRefresh = computed(() => rows.value.some((r) => r.need_refresh) || (data.value && data.value.need_refresh));
const dataNote = computed(() => (data.value && data.value.data_note) || '');
/* 取数时间：原始数据最近一次落盘时间；若早于所选日期则视为过期 */
const dataTime = computed(() => (data.value && data.value.data_time) || '');
const dataStale = computed(() => {
  const t = dataTime.value;
  if (!t) return true;                       // 无取数时间 → 视为过期/未知
  return t.slice(0, 10) < effDate.value;       // 取数日期 < 所选日期 → 过期
});

/* 站点看板：按名称筛选 */
const stationRows = computed(() => rows.value);
/* 站点汇总卡片（基于当前筛选后的行聚合） */
const summaryCards = computed(() => {
  const list = stationRows.value;
  if (!list.length) return [];
  const sum = (k) => list.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const target = sum('scale_target');
  const achieved = sum('achieved_num');
  const exp = sum('expected_achievable_num');
  return [
    { label: '站点数', value: list.length },
    { label: '天应排', value: target || '—' },
    { label: '达标数', value: achieved || '—' },
    { label: '达标率', value: target ? Math.round((achieved / target) * 1000) / 10 + '%' : '—' },
    { label: '预计达成', value: exp || '—' },
  ];
});

function fmtPct(v) { return v == null ? '—' : (Math.round(v * 10) / 10) + '%'; }
function rateCls(v) {
  if (v == null) return '';
  if (v >= 80) return 'rate-good';
  if (v >= 50) return 'rate-mid';
  return 'rate-bad';
}

/* 骑手看板 */
const riderLoading = ref(false);
const riderRows = ref([]);
const riderLoaded = ref(false);
const riderStdFilter = ref('');
/* 在线状态筛选：选项与「在线状态」列文案一致（在线/小休/下线） */
const riderOnlineFilter = ref('');
const riderOnlineOptions = [
  { label: '全部在线状态', value: '' },
  { label: '在线', value: '在线' },
  { label: '小休', value: '小休' },
  { label: '下线', value: '下线' },
];
const riderStdOptions = computed(() => {
  const set = new Set();
  (riderRows.value || []).forEach((r) => { if (r.achieved_standard != null) set.add(r.achieved_standard); });
  return [...set];
});
const riderRowsView = computed(() => filterRiders(riderRows.value, {
  name: riderFilter.value,
  std: riderStdFilter.value,
  online: riderOnlineFilter.value,
}));

/* ============ 骑手看板：自定义排序 + 前端分页 ============ */
const riderPage = ref(1);
const riderPageSize = ref(25);
const riderSortProp = ref('');
const riderSortOrder = ref(''); // 'ascending' | 'descending' | ''
function onRiderSort({ prop, order }) {
  riderSortProp.value = prop || '';
  riderSortOrder.value = order || '';
  riderPage.value = 1;
}
function onRiderSizeChange(size) {
  riderPageSize.value = size;
  riderPage.value = 1;
}
/* 各列排序取值（与列 prop 对应；无 prop 的列已补 prop） */
function riderSortVal(row, prop) {
  switch (prop) {
    case 'valid_online_min': return Number(row.valid_online_min) || 0;
    case 'achieved_standard': return stdRank(row.achieved_standard);
    case 'std1_forecast_level': return fcRank(row.std1_forecast_level);
    case 'online_status_code': return onlineSort(row.online_status_code);
    default: {
      const v = row[prop];
      return v == null ? (typeof v === 'string' ? '' : -Infinity) : v;
    }
  }
}
function cmpVal(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a == null ? '' : a).localeCompare(String(b == null ? '' : b), 'zh-Hans-CN');
}
const riderSortedRows = computed(() => {
  const arr = riderRowsView.value.slice();
  const p = riderSortProp.value;
  const o = riderSortOrder.value;
  if (p && o) {
    const mul = o === 'ascending' ? 1 : -1;
    arr.sort((a, b) => mul * cmpVal(riderSortVal(a, p), riderSortVal(b, p)));
  }
  return arr;
});
const riderTotal = computed(() => riderSortedRows.value.length);
const riderPagedRows = computed(() => {
  const start = (riderPage.value - 1) * riderPageSize.value;
  return riderSortedRows.value.slice(start, start + riderPageSize.value);
});
/* 筛选条件变化时回到第一页 */
watch([riderFilter, riderStdFilter, riderOnlineFilter], () => { riderPage.value = 1; });
function fmtDur(m) {
  if (m == null) return '—';
  const total = Math.round(Number(m) || 0);
  const h = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(h).padStart(2, '0')}小时${String(mm).padStart(2, '0')}分钟`;
}
/* 全列自适应最小列宽：用 canvas 实测「表头 / 单元格」两处文本像素宽度，取较宽者 + 内边距/标签/排序箭头余量，
   保证所有列内容完整展示、不换行不省略。当总宽超过容器时，前 3 列（骑手ID/姓名/所属站点）fixed 冻结，
   其余列横向滚动（见模板 fixed 设置）。 */
let _measureCtx = null;
function measureTextWidth(str, fontSize = 14) {
  if (str == null) return 0;
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
  _measureCtx.font = `${fontSize}px "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Microsoft YaHei", sans-serif`;
  return _measureCtx.measureText(String(str)).width;
}
/* 骑手看板列元信息：label=表头文案；fmt=单元格展示文本转换；tag=是否带 el-tag（需额外内边距）；
   statusText=在线状态文案取 online_status；extra=额外宽度（如姓名后附排班状态标签）。 */
const RIDER_COLUMNS = [
  { prop: 'rider_id', label: '骑手ID' },
  { prop: 'rider_name', label: '骑手姓名', extra: 46 },
  { prop: 'team_name', label: '所属站点' },
  { prop: 'valid_orders', label: '有效完成单量' },
  { prop: 'valid_online_min', label: '有效出勤时长', fmt: fmtDur },
  { prop: 'achieved_standard', label: '达成标准', tag: true },
  { prop: 'std1_forecast_level', label: '预计可达标', tag: true },
  { prop: 'next_level_order_gap', label: '距下一标准单量差值' },
  { prop: 'prev_level_duration_gap', label: '距下一标准时长差异', fmt: fmtDur },
  { prop: 'online_status_code', label: '在线状态', tag: true, statusText: true },
  { prop: 'delivering_orders', label: '配送中单量' },
  { prop: 'non_today_orders', label: '非今日订单' },
  { prop: 'reverse_orders', label: '逆向单' },
  { prop: 'reassign_orders', label: '改派单' },
];
function riderColText(row, c) {
  if (c.statusText) return row.online_status || '—';
  if (c.fmt) return c.fmt(row[c.prop]);
  const v = row[c.prop];
  return v == null ? '' : String(v);
}
function riderColFitWidth(c) {
  /* 表头宽 = 文本 + 单元格内边距(24) + 排序箭头(14)；可排序列均有箭头 */
  const headerW = measureTextWidth(c.label, 14) + 24 + 14;
  let bodyMax = 0;
  for (const r of (riderRows.value || [])) {
    const w = measureTextWidth(riderColText(r, c), 14);
    if (w > bodyMax) bodyMax = w;
  }
  const bodyW = bodyMax + 24 + (c.tag ? 22 : 0) + (c.extra || 0);
  return Math.max(80, Math.ceil(Math.max(headerW, bodyW)));
}
const riderColWidths = computed(() => {
  const m = {};
  for (const c of RIDER_COLUMNS) m[c.prop] = riderColFitWidth(c);
  return m;
});
/* 方案1：列显隐设置——按指标分组，用户勾选显示哪些列；默认仅开启关键 KPI，表格更窄、避免横向滚动。
   前 3 列（骑手ID/姓名/所属站点）为定位列，始终显示，不在此设置范围内。 */
const COL_GROUPS = [
  { name: '单量', cols: [
    { prop: 'valid_orders', label: '有效完成单量' },
    { prop: 'delivering_orders', label: '配送中单量' },
    { prop: 'non_today_orders', label: '非今日订单' },
    { prop: 'reverse_orders', label: '逆向单' },
    { prop: 'reassign_orders', label: '改派单' },
    { prop: 'next_level_order_gap', label: '距下一标准单量差值' },
  ]},
  { name: '时长', cols: [
    { prop: 'valid_online_min', label: '有效出勤时长' },
    { prop: 'prev_level_duration_gap', label: '距下一标准时长差异' },
  ]},
  { name: '达成', cols: [
    { prop: 'achieved_standard', label: '达成标准' },
    { prop: 'std1_forecast_level', label: '预计可达标' },
    { prop: 'online_status_code', label: '在线状态' },
  ]},
];
const colVis = reactive({
  valid_orders: true, delivering_orders: true, non_today_orders: true,
  reverse_orders: true, reassign_orders: true, next_level_order_gap: true,
  valid_online_min: true, prev_level_duration_gap: true,
  achieved_standard: true, std1_forecast_level: true, online_status_code: true,
});
function colVisible(prop) { return colVis[prop] === true; }
const STD_RANK = { '标准5': 5, '标准4': 4, '标准3': 3, '标准2': 2, '标准1': 1, '未达标': 0, '时长未知': -1 };
function stdRank(label) { return STD_RANK[label] ?? -2; }
function stdType(label) {
  if (label === '标准5' || label === '标准4') return 'success';
  if (label === '标准3') return 'warning';
  if (label === '标准2' || label === '标准1') return 'primary';
  if (label === '未达标') return 'danger';
  return 'info';
}
/* 在线状态（来自实时考勤 workStatus）：3=下线 / 2=小休 / 其他=在线 / null=未知 */
function onlineTagType(code) {
  if (code == null) return 'info';
  if (code === 3) return 'danger';
  if (code === 2) return 'warning';
  return 'success';
}
function onlineSort(code) {
  if (code == null) return -1;
  if (code === 3) return 0;   // 下线
  if (code === 2) return 1;   // 小休
  return 2;                   // 在线
}
/* 标准一达成预测（剩余时间外推）的排序与配色 */
const FC_RANK = { '已达成': 4, '轻松': 3, '一般': 2, '困难': 1, '时长未知': 0, '不可达标': -1 };
function fcRank(level) { return level == null ? -1 : (level); }
function fcType(label) {
  if (label === '已达成' || label === '轻松') return 'success';
  if (label === '一般') return 'warning';
  if (label === '困难' || label === '不可达标') return 'danger';
  return 'info';
}

async function loadRiders() {
  riderLoading.value = true;
  try {
    const res = await fetchStandardRiders({ team: teamSel.value, start: start(), end: end(), month: monthOf() });
    riderRows.value = (res && res.rows) || [];
    riderLoaded.value = true;
  } catch (e) {
    ElMessage.error(e.message || '骑手数据加载失败');
    riderRows.value = [];
  } finally {
    riderLoading.value = false;
  }
}

function start() { return effDate.value; }
function end() { return effDate.value; }

/* 当前月份的参与考核站点（来自「标准达成设置」，有配置即参与），驱动站点下拉与看板联动 */
async function refreshParticipating() {
  try {
    const res = await fetchStandardGradeGlobal(monthOf());
    partIds.value = new Set(Object.keys((res && res.teams) || {}));
    monthConfigured.value = !!(res && res.configured);
    if (teamSel.value !== '__all__' && !partIds.value.has(String(teamSel.value))) {
      teamSel.value = '__all__';
    }
  } catch (e) {
    monthConfigured.value = true; // 配置接口异常时不误报「未配置」
  }
}

async function load() {
  loading.value = true;
  try {
    const res = await fetchStandardStationReport({ team: teamSel.value, start: start(), end: end(), month: monthOf() });
    data.value = res || {};
  } catch (e) {
    ElMessage.error(e.message || '加载失败');
    data.value = { rows: [] };
  } finally {
    loading.value = false;
  }
}

/* 切到骑手看板且未加载过 → 拉取；站点/日期变化时若正在看骑手则重新拉 */
watch(tab, (v) => {
  if (v === 'rider' && !riderLoaded.value) loadRiders();
});
watch([teamSel, date], () => {
  riderLoaded.value = false;
  if (tab.value === 'rider') loadRiders();
});
/* 日期（月份）变化 → 重新拉取参与考核站点，驱动下拉与看板联动 */
watch(date, async () => {
  await refreshParticipating();
});

async function onRefresh() {
  if (refreshing.value || cooldown.value > 0) return;
  refreshing.value = true;
  loading.value = true;          // 覆盖「后端刷新计算 + 轮询等待」这段最长空窗，使表格全程有 loading 反馈
  riderLoading.value = true;
  try {
    const body = { start: start(), end: end() };
    if (teamSel.value !== '__all__') body.teams = [teamSel.value];
    const res = await refreshStandard(body);
    if (res && res.already_running) {
      ElMessage.info('已有刷新任务在进行');
      startCooldown(REFRESH_COOLDOWN_SEC);
      poll();
      return;
    }
    if (!res || !res.ok) {
      ElMessage.error((res && res.error) || '刷新启动失败');
      refreshing.value = false;
      loading.value = false;           // 启动失败不进入轮询，手动复位表格 loading
      riderLoading.value = false;
      return;
    }
    // 后端已接受刷新：从此时起进入 60s 冷却（与 RATE_LIMIT_SEC 对齐）
    startCooldown(REFRESH_COOLDOWN_SEC);
    poll();
  } catch (e) {
    // 后端频控：429 + RATE_LIMITED，body.retry_after 为实际剩余秒数（≤60 或全局 15s 窗口剩余）
    const ra = e && e.data && e.data.retry_after;
    startCooldown(ra && ra > 0 ? ra : REFRESH_COOLDOWN_SEC);
    ElMessage.error(e.message || '刷新失败');
    refreshing.value = false;
    loading.value = false;           // 异常不进入轮询，手动复位表格 loading
    riderLoading.value = false;
  }
}
function poll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const st = await fetchRefreshStatus();
      const status = st && st.status;
      if (!status || !status.running) {
        clearInterval(pollTimer); pollTimer = null;
        refreshing.value = false;
        ElMessage.success('刷新完成');
        load();
        riderLoaded.value = false;
        if (tab.value === 'rider') loadRiders();
      }
    } catch (e) { /* 轮询失败忽略 */ }
  }, 2000);
}

onMounted(async () => {
  try { const t = await fetchTeams(); teams.value = (t && t.teams) || []; } catch (e) { /* ignore */ }
  await load();
  await refreshParticipating();
  // 刷新页面后从后端恢复刷新冷却：后端频控是进程级内存态（按用户 60s + 全局 15s），
  // 跨页面刷新仍有效，但前端 cooldown 是内存态会丢失，故加载时查询剩余秒数并重建倒计时，
  // 使「刷新页面也保持限制状态」。
  try {
    const st = await fetchRefreshStatus();
    const sec = st && st.status && st.status.cooldown_sec;
    if (sec && sec > 0) startCooldown(sec);
  } catch (e) { /* 查询失败不影响首屏 */ }
});

onUnmounted(() => {
  if (cooldownTimer) clearInterval(cooldownTimer);
});
</script>

<style scoped>
/* 整页 flex 列布局，占满 app-main 高度，使表格区域可弹性填充视口、底部贴合边缘 */
.dv { padding: var(--sp-20); display: flex; flex-direction: column; height: 100%; box-sizing: border-box; overflow: hidden; }
.dv-bar { display: flex; align-items: center; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.dv-sel { width: 160px; }
.dv-date { width: 160px; }
.dv-data-time { display: inline-flex; align-items: center; gap: 4px; font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); white-space: nowrap; }
.dv-data-time.is-stale { color: var(--el-color-warning); font-weight: var(--fw-semibold); }
.dv-bar .sp { flex: 1; }
.dv-hint { margin-bottom: var(--sp-12); }
.dv-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-12); margin-bottom: var(--sp-16); }
.dv-card {
  background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: var(--el-border-radius-base);
  padding: var(--sp-16); display: flex; flex-direction: column; gap: 4px;
}
.dv-card-num { font-size: 24px; font-weight: var(--fw-bold); color: var(--el-color-primary); }
.dv-card-label { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.dv-table { border-radius: var(--el-border-radius-base); width: 100%; }
/* 表格包裹层：占满标签页剩余高度，让 el-table(height=100%) 底部贴合视口 */
.dv-table-wrap { flex: 1; min-height: 0; display: flex; }
/* 骑手看板：表格 + 分页器纵向铺满 */
.dv-rider-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dv-pager { flex: none; padding: var(--sp-12) 0 0; display: flex; justify-content: flex-end; }

/* tabs 占满 dv 剩余高度，内容区弹性填充，确保激活的表格填满可视区 */
.dv-tabs { margin-top: var(--sp-4); flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dv-tabs :deep(.el-tabs__header) { margin-bottom: var(--sp-12); flex: none; }
.dv-tabs :deep(.el-tabs__content) { flex: 1; min-height: 0; }
.dv-tabs :deep(.el-tab-pane) { height: 100%; display: flex; flex-direction: column; }
.dv-filter { display: flex; align-items: center; gap: var(--sp-12); margin-bottom: var(--sp-12); }
.dv-filter-input { width: 260px; }
.dv-filter-count { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.dv-filter-sel { width: 160px; }
/* Req2：仅当前排序的列显示排序标识，其余列完全不占位（避免空隙与箭头错位） */
.dv-table :deep(.caret-wrapper) { display: none; }
.dv-table :deep(.ascending .caret-wrapper),
.dv-table :deep(.descending .caret-wrapper) { display: inline-flex; }
/* 表头防折行：列名与排序图标始终同一行；长列名由 nowrap + 自适应列宽兜底（列宽已按表头文本实测） */
.dv-table :deep(.el-table__header .cell) { white-space: nowrap; }
/* 未设置门槛/封顶时的报错提醒（红字） */
.dv-warn { color: var(--danger, #f56c6c); font-weight: var(--fw-semibold); }
/* 骑手姓名前的排班状态标签与姓名间距 */
.dv-sched-tag { margin-left: 6px; vertical-align: middle; font-size: 10px; height: 18px; line-height: 16px; padding: 0 5px; }
/* 指定列中值为 0 的单元格字色置浅灰 */
.dv-zero-gray { color: #c0c4cc; }
.rate-good { color: #1aac5a; font-weight: var(--fw-bold); }
.rate-mid { color: #e6a23c; font-weight: var(--fw-bold); }
.rate-bad { color: #f56c6c; font-weight: var(--fw-bold); }
/* 列设置弹层：按指标分组勾选 */
.col-set { display: flex; flex-direction: column; gap: 12px; }
.col-set-group { display: flex; flex-direction: column; gap: 4px; }
.col-set-gname { font-size: 12px; font-weight: 600; color: var(--el-text-color-secondary); margin-bottom: 2px; }
.col-set-tip { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.4; }
</style>
