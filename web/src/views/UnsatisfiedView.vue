<template>
  <div class="dv">
    <div class="dv-bar">
      <span class="dv-title">违规处罚</span>
    </div>

    <el-menu mode="horizontal" :default-active="tab" class="dv-menu" @select="(k) => (tab = k)">
      <el-menu-item index="realtime">实时</el-menu-item>
      <el-menu-item index="monthly">月累计</el-menu-item>
    </el-menu>

    <!-- 月累计 -->
    <div v-show="tab === 'monthly'" class="dv-pane">
      <div class="dv-controls">
        <span class="dv-ctl-label">月份</span>
        <el-date-picker
          v-model="month"
          type="month"
          value-format="YYYY-MM"
          format="YYYY-MM"
          placeholder="选择月份"
          size="small"
          style="width: 140px"
          :clearable="false"
          @change="loadMonthly"
        />
        <span class="dv-ctl-label">违规分类</span>
        <el-select
          v-model="monthlyCats"
          multiple
          collapse-tags
          collapse-tags-tooltip
          size="small"
          style="width: 240px"
          placeholder="违规分类"
        >
          <el-option
            v-for="o in monthlyCatOptions"
            :key="o.value"
            :label="o.label"
            :value="o.value"
          />
        </el-select>
        <span v-if="monthDays" class="dv-date">已入库 {{ monthDays }} 天</span>
      </div>
      <div class="dv-table-wrap">
        <el-table
          ref="monthlyTableRef"
          :data="monthlyPagedRows"
          v-loading="loadingMonthly"
          border
          height="100%"
          empty-text="暂无数据，每日 03:00 自动同步至 T-1"
        >
          <el-table-column
            v-for="col in monthlyColumns"
            :key="col.key"
            :prop="col.key"
            :label="col.label"
            :min-width="col.minWidth"
            :formatter="col.key === 'violationTime' ? fmtDateTime
              : CODE_FIELDS.has(col.key) ? fmtCode : undefined"
            show-overflow-tooltip
          />
        </el-table>
      </div>
      <div class="dv-foot">
        <el-pagination
          v-model:current-page="monthlyPage"
          :page-size="monthlyPageSize"
          :total="monthlyFilteredRows.length"
          :page-sizes="[25, 50, 100, 200]"
          layout="sizes, prev, pager, next, jumper, total"
          size="small"
          background
          @size-change="monthlyPage = 1"
        />
      </div>
    </div>

    <!-- 实时 -->
    <div v-show="tab === 'realtime'" class="dv-pane">
      <div class="dv-controls">
        <span class="dv-ctl-label">取数时间</span>
        <span class="dv-date">{{ fetchedAt || '—' }}</span>
        <el-button size="small" type="primary" :loading="loadingRealtime" @click="refreshRealtime">
          刷新
        </el-button>
        <el-button size="small" v-if="!isToday" @click="backToToday">回到今天</el-button>
        <span class="dv-ctl-label">违规分类</span>
        <el-select
          v-model="realtimeCats"
          multiple
          collapse-tags
          collapse-tags-tooltip
          size="small"
          style="width: 240px"
          placeholder="违规分类"
        >
          <el-option
            v-for="o in realtimeCatOptions"
            :key="o.value"
            :label="o.label"
            :value="o.value"
          />
        </el-select>
      </div>
      <div class="dv-table-wrap">
        <el-table
          ref="realtimeTableRef"
          :data="realtimeFilteredRows"
          v-loading="loadingRealtime"
          border
          height="100%"
          empty-text="暂无数据，点「刷新」获取最新并落盘"
        >
          <el-table-column
            v-for="col in realtimeColumns"
            :key="col.key"
            :prop="col.key"
            :label="col.label"
            :min-width="col.minWidth"
            :formatter="col.key === 'violationTime' ? fmtDateTime
              : CODE_FIELDS.has(col.key) ? fmtCode : undefined"
            show-overflow-tooltip
          />
        </el-table>
      </div>
      <div class="dv-foot">共 {{ realtimeFilteredRows.length }} 条</div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, computed, nextTick } from 'vue';
import { ElMessage } from 'element-plus';
import {
  fetchViolationRange,
  fetchViolationMonth,
  fetchViolationRangeDb,
  saveViolationRows,
} from '../api/unsatisfied.js';

const tab = ref('realtime');
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// 月累计：月份选择器（el-date-picker type=month），默认当月
const month = ref(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
// 实时标签只盯今天：默认查当天；打开即从落盘读取，无缓存时自动拉取最新并落盘。点刷新才拉风神最新。
const realtimeRange = ref([todayStr(), todayStr()]);
const realtimeRangeText = computed(() => realtimeRange.value.join(' ~ '));
const isToday = computed(() => {
  const t = todayStr();
  return realtimeRange.value[0] === t && realtimeRange.value[1] === t;
});
// 上次成功取数的时间（取数时间）。
const fetchedAt = ref('');
const loadingMonthly = ref(false);
const loadingRealtime = ref(false);
const monthlyRows = ref([]);
const monthlyColumns = ref([]);
const monthDays = ref(0);
// 月累计分页：整月常有上千行，全量渲染会卡数秒，故分页渲染
const monthlyPage = ref(1);
const monthlyPageSize = ref(25);
const monthlyTableRef = ref(null);
const realtimeTableRef = ref(null);
const monthlyPagedRows = computed(() => {
  const start = (monthlyPage.value - 1) * monthlyPageSize.value;
  return monthlyFilteredRows.value.slice(start, start + monthlyPageSize.value);
});
const realtimeRows = ref([]);
const realtimeColumns = ref([]);

/* ===== 违规分类筛选（选项取自当前数据，默认全选，可多选） ===== */
const catLabel = (code) =>
  (CODE_LABELS.violationCategory && CODE_LABELS.violationCategory[code]) || code || '—';
const catOf = (r) => String(r?.violationCategory ?? '');
const distinctCats = (rows) => [...new Set((rows || []).map(catOf))];
// 数据刷新后：保留仍存在的旧选择，否则（首次加载）全选
const mergeCats = (prev, available) => {
  const kept = (prev || []).filter((c) => available.includes(c));
  return kept.length ? kept : available;
};

const realtimeCats = ref([]);
const realtimeCatOptions = computed(() =>
  distinctCats(realtimeRows.value).map((v) => ({ value: v, label: catLabel(v) })),
);
const realtimeFilteredRows = computed(() =>
  realtimeRows.value.filter((r) => realtimeCats.value.includes(catOf(r))),
);

const monthlyCats = ref([]);
const monthlyCatOptions = computed(() =>
  distinctCats(monthlyRows.value).map((v) => ({ value: v, label: catLabel(v) })),
);
const monthlyFilteredRows = computed(() =>
  monthlyRows.value.filter((r) => monthlyCats.value.includes(catOf(r))),
);

const nowDtStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const toMs = (d) => Date.parse(`${d}T00:00:00+08:00`);
const toMsEnd = (d) => Date.parse(`${d}T23:59:59.999+08:00`);
// 违规时间：上游返回 ISO（含 T / 可能带 Z），展示为普通日期时间 "2026-10-07 23:41:28"
function fmtDateTime(_row, _col, value) {
  if (!value) return '';
  return String(value).replace('T', ' ').replace(/Z$/, '');
}
// 骑手：上游合并为 "骑手ID-骑手姓名"，拆分为两列
function splitKnight(info) {
  const s = info == null ? '' : String(info);
  const i = s.indexOf('-');
  if (i < 0) return { knightId: s, knightName: '' };
  return { knightId: s.slice(0, i).trim(), knightName: s.slice(i + 1).trim() };
}
// 团队/站点：上游合并为 "站点ID-站点名称"，拆分为两列
function splitTeam(info) {
  const s = info == null ? '' : String(info);
  const i = s.indexOf('-');
  if (i < 0) return { teamId: s, teamName: '' };
  return { teamId: s.slice(0, i).trim(), teamName: s.slice(i + 1).trim() };
}
// 需要把英文代码转中文的列
const CODE_FIELDS = new Set([
  'violationCategory', 'violationType', 'violationStatus',
  'appealStatus', 'eventSource',
]);
// 英文代码 → 中文。取值来自风神真实数据（按 violationOrderId 关联 download CSV 的中文，已覆盖全量样本）。
const CODE_LABELS = {
  eventSource: {
    APOLLO: '运单平台',
    RIDER: '骑士作业',
    USER: '用户',
    SPZT: '索赔中台',
    KFPT: '开放平台',
  },
  violationCategory: {
    OVERTIME: '超时',
    COMPLAIN: '投诉',
    BAD_REVIEW: '差评',
    CLAIM: '餐货损',
    CANCEL: '取消',
  },
  violationType: {
    1001: '超时送达',
    1004: '违规取消',
    1005: '违规送达',
    1028: '少餐错餐 (差评)',
    1029: '送达不通知',
    1030: '不送上门 (差评)',
    1035: '未保持餐品完整（索赔）',
    1036: '送错位置（索赔）',
    1037: '少餐错餐（索赔）',
    1038: '丢餐（索赔）',
    1039: '提前点送达（索赔）',
    1053: '配送超时（索赔）',
  },
  violationStatus: {
    10: '成立',
    20: '不成立',
  },
  appealStatus: {
    10: '待申诉',
    20: '申诉中',
    30: '申诉成功',
    40: '申诉失败',
    50: '申诉过期',
    '-1': '不可申诉',
  },
};
// 代码列 formatter：命中映射则显示中文，否则原样显示（避免误标）
function fmtCode(_row, column, value) {
  if (!value) return '';
  const key = column && column.property;
  const m = key && CODE_LABELS[key];
  return (m && m[value]) || value;
}
function normalizeRows(rows) {
  return (rows || []).map(({ knightInfo, teamInfo, ...rest }) => ({
    ...rest,
    ...splitKnight(knightInfo),
    ...splitTeam(teamInfo),
  }));
}

// 明确不展示的字段（数据里有但表格不渲染）
const HIDDEN_FIELDS = new Set(['agentInfo', 'cancelType']);

// extraHidden：调用方可追加的隐藏字段（如月累计不展示"申诉截止"）
function buildColumns(rows, extraHidden = []) {
  const hidden = new Set([...HIDDEN_FIELDS, ...extraHidden]);
  const keys = new Set();
  rows.slice(0, 50).forEach((r) =>
    Object.keys(r).forEach((k) => {
      if (!hidden.has(k)) keys.add(k);
    }),
  );
  // 真实字段（风神 queryList 返回，英文 key）→ 友好中文标签，按业务顺序排列
  const LABELS = {
    violationTime: '违规时间',
    violationOrderId: '违规编号',
    trackingId: '运单号',
    knightId: '骑手ID',
    knightName: '骑手姓名',
    teamId: '站点ID',
    teamName: '站点名称',
    violationCategory: '违规分类',
    violationType: '违规类型',
    violationStatus: '违规状态',
    bonus: '处罚',
    violationReason: '违规原因',
    appealStatus: '申诉状态',
    appealExpireTime: '申诉截止',
    eventSource: '数据来源',
  };
  const ORDER = [
    'violationTime', 'violationOrderId', 'trackingId', 'knightId', 'knightName', 'teamId', 'teamName',
    'violationCategory', 'violationType', 'violationStatus', 'bonus',
    'violationReason', 'appealStatus', 'appealExpireTime', 'eventSource',
  ];
  const ordered = ORDER.filter((k) => keys.has(k));
  const rest = [...keys].filter((k) => !ordered.includes(k));

  // 列宽自适应：按"表头/内容展示文本"的最长宽度估算 min-width。
  // el-table 的 fit 会把容器剩余宽度按各列 min-width 的比例分配，故内容越长的列分到越多余量。
  const sample = rows.slice(0, 50);
  const unitsOf = (k) => {
    let max = textUnits(LABELS[k] || k);
    for (const r of sample) {
      const u = textUnits(displayValue(k, r[k]));
      if (u > max) max = u;
    }
    return max;
  };
  const minWidthOf = (k) =>
    Math.round(Math.min(MAX_COL_W, Math.max(MIN_COL_W, unitsOf(k) * PX_PER_UNIT + COL_PADDING)));

  return [...ordered, ...rest].map((k) => ({
    key: k,
    label: LABELS[k] || k,
    minWidth: minWidthOf(k),
  }));
}

/* ===== 列宽自适应 ===== */
const MIN_COL_W = 90;
const MAX_COL_W = 340;
const PX_PER_UNIT = 7; // 1 单位≈半角字符宽；中文按 2 单位算
const COL_PADDING = 30;

// 估算文本宽度单位：中日韩/全角字符按 2，其余按 1
function textUnits(s) {
  let u = 0;
  for (const ch of String(s ?? '')) {
    u += /[\u2e80-\ufe4f\uff00-\uff60]/.test(ch) ? 2 : 1;
  }
  return u;
}
// 单元格实际展示值（需与 formatter 保持一致，否则宽度估算会偏）
function displayValue(key, v) {
  if (v == null) return '';
  if (key === 'violationTime') return String(v).replace('T', ' ').replace(/Z$/, '');
  if (CODE_FIELDS.has(key)) {
    const m = CODE_LABELS[key];
    return (m && m[v]) || v;
  }
  return v;
}

async function loadMonthly() {
  loadingMonthly.value = true;
  try {
    const r = await fetchViolationMonth(month.value);
    if (!r.ok) {
      ElMessage.error(r.error || '查询失败');
      return;
    }
    monthlyRows.value = normalizeRows(r.rows || []);
    monthlyColumns.value = buildColumns(monthlyRows.value, ['appealExpireTime']);
    monthlyCats.value = mergeCats(monthlyCats.value, distinctCats(monthlyRows.value));
    monthlyPage.value = 1;
    // 已入库天数（按违规时间日期去重统计）
    monthDays.value = new Set(
      monthlyRows.value.map((x) => String(x.violationTime || '').slice(0, 10)),
    ).size;
  } catch (e) {
    ElMessage.error(e?.message || '查询失败');
  } finally {
    loadingMonthly.value = false;
  }
}

// 渲染一批原始行为表格（拆骑手/站点列）
function renderRealtime(rows) {
  realtimeRows.value = normalizeRows(rows);
  realtimeColumns.value = buildColumns(realtimeRows.value);
  realtimeCats.value = mergeCats(realtimeCats.value, distinctCats(realtimeRows.value));
}

// 读本地已落盘缓存（不请求风神）：切换标签/改区间时调用
async function loadRealtimeCache() {
  const [s, e] = realtimeRange.value;
  if (!s || !e) return;
  loadingRealtime.value = true;
  try {
    const r = await fetchViolationRangeDb({ start: s, end: e });
    if (!r.ok) {
      ElMessage.error(r.error || '读取缓存失败');
      return;
    }
    renderRealtime(r.rows || []);
    // 取数时间 = 该区间最近一次落盘时间
    fetchedAt.value = r.fetchedAt || '—';
    if ((r.rows || []).length === 0) {
      // 本地该区间无缓存，自动拉取最新并落盘，避免打开即空白
      ElMessage.info('本地暂无缓存，正在拉取最新数据并落盘…');
      await refreshRealtime();
    }
  } catch (err) {
    ElMessage.error(err?.message || '读取缓存失败');
  } finally {
    loadingRealtime.value = false;
  }
}

// 实时拉取最新并落盘（刷新按钮）：请求风神 → 写入 violation.db → 展示
async function refreshRealtime() {
  const [s, e] = realtimeRange.value;
  if (!s || !e) return;
  loadingRealtime.value = true;
  try {
    const r = await fetchViolationRange({ start_ms: toMs(s), end_ms: toMsEnd(e), page_size: 200 });
    if (!r.ok) {
      ElMessage.error(r.error || '查询失败');
      return;
    }
    const rows = r.rows || [];
    try {
      await saveViolationRows(rows);
    } catch (_) {
      /* 落盘失败不影响本次展示 */
    }
    renderRealtime(rows);
    fetchedAt.value = nowDtStr();
  } catch (err) {
    ElMessage.error(err?.message || '查询失败');
  } finally {
    loadingRealtime.value = false;
  }
}

function backToToday() {
  realtimeRange.value = [todayStr(), todayStr()];
  loadRealtimeCache();
}

// 筛选变化后回到第一页，避免停留在超出范围的页码
watch(monthlyCats, () => {
  monthlyPage.value = 1;
});

watch(tab, async () => {
  if (tab.value === 'monthly') loadMonthly();
  else loadRealtimeCache();
  // v-show 隐藏时表格拿不到高度，切回后需重算才能撑满内容区
  await nextTick();
  const t = tab.value === 'monthly' ? monthlyTableRef.value : realtimeTableRef.value;
  t?.doLayout?.();
});

onMounted(() => {
  // 必须按**当前标签**主动加载一次：watch(tab) 只在标签切换时触发，
  // 首次进入（默认停在「实时」）不会触发 —— 否则即使 violation.db/realtime.db
  // 已有落盘数据，实时表格也会一直空白，必须切到月累计再切回来才显示。
  if (tab.value === 'monthly') loadMonthly();
  else loadRealtimeCache();
});
</script>

<style scoped>
.dv {
  padding: 16px;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}
.dv-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.dv-title {
  font-size: 18px;
  font-weight: 600;
}
.dv-menu {
  border-bottom: 1px solid #ebeef5;
  margin-bottom: 12px;
}
.dv-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.dv-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
/* 表格撑满内容区：flex:1 + min-height:0 让 el-table 的 height:100% 能解析出确定高度 */
.dv-table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.dv-table-wrap :deep(.el-table) {
  flex: 1;
  min-height: 0;
}
/* 放宽行高，避免行过于紧凑 */
.dv-table-wrap :deep(.el-table th.el-table__cell),
.dv-table-wrap :deep(.el-table td.el-table__cell) {
  padding: 12px 0;
}
.dv-table-wrap :deep(.el-table .cell) {
  line-height: 20px;
}
.dv-ctl-label {
  color: #6e6e6e;
}
.dv-date {
  font-weight: 600;
}
.dv-foot {
  margin-top: 8px;
  color: #6e6e6e;
  font-size: 13px;
}
</style>
