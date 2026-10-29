<template>
  <div class="od">
    <div class="od-bar">
      <h2 class="v-title">运单明细</h2>
      <el-date-picker
        v-model="dateRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        :shortcuts="shortcuts"
        :disabled-date="disabledDate"
        class="od-date"
        style="width: 260px; flex: 0 0 260px"
        @change="changeDate"
      />
      <el-select
        v-model="teamSel"
        class="od-sel"
        multiple
        clearable
        collapse-tags
        collapse-tags-tooltip
        placeholder="选择站点"
        style="width: 240px; flex: 0 0 240px"
        @change="changeTeam"
      >
        <el-option label="全部站点" value="__all__" />
        <el-option v-for="t in teamOptions" :key="t.id" :label="t.name" :value="t.id" />
      </el-select>
      <el-select
        v-model="stateSel"
        class="od-sel"
        clearable
        placeholder="运单状态"
        @change="changeState"
      >
        <el-option v-for="s in states" :key="s" :label="s" :value="s" />
      </el-select>
      <el-input
        v-model="keyword"
        class="od-kw"
        clearable
        placeholder="运单号 / 订单号 / 骑手 / 商家"
      />
      <el-button @click="colDrawer = true"><el-icon><Operation /></el-icon> 列设置</el-button>
      <el-button
        :loading="exporting"
        :disabled="exporting || loading"
        @click="onExport"
      >
        <el-icon><Download /></el-icon>
        <span v-if="exporting">导出中…</span>
        <span v-else>导出</span>
      </el-button>
      <span v-if="rangeIncludesToday && fetchedAt" class="od-tag">刷新时间：{{ fetchedAt }}</span>
      <span v-else-if="!rangeIncludesToday && historyLatestDate" class="od-tag">历史数据最新：{{ historyLatestDate }}</span>
      <el-button
        type="primary"
        class="od-refresh"
        :loading="refreshing"
        :disabled="!rangeIncludesToday || refreshing || cooldown > 0"
        :title="!rangeIncludesToday ? '所选区间不含今天，无法刷新（历史数据由每日 04:00 滚动任务维护）' : (cooldown > 0 ? `刷新过于频繁，请等待 ${cooldown} 秒` : '拉取当天全站运单明细入库')"
        @click="handleRefresh"
      >
        <el-icon><Refresh /></el-icon>
        <span v-if="refreshing">刷新中…</span>
        <span v-else-if="cooldown > 0">请等待 {{ cooldown }}s</span>
        <span v-else>刷新数据</span>
      </el-button>
    </div>

    <el-alert v-if="loadErrMsg" type="warning" :closable="false" show-icon class="od-hint">
      {{ loadErrMsg }}
    </el-alert>
    <el-alert v-else-if="needRefresh" type="info" :closable="false" show-icon class="od-hint">
      该区间暂无运单明细入库，点「刷新数据」拉取后即可查看（明细按运单完成时间统计当天全站运单）。
    </el-alert>
    <el-alert v-else-if="isHistoryView" type="success" :closable="false" show-icon class="od-hint">
      历史数据（T-1~T-7 滚动留档） · 历史数据最新：{{ historyLatestDate || '—' }} · 共 {{ historyTotal }} 条 · 最近回补：{{ lastRun?.finished_at || '—' }}
    </el-alert>

    <el-drawer v-model="colDrawer" title="列设置" direction="rtl" size="380px">
      <div class="od-col-toolbar">
        <el-input v-model="colSearch" clearable placeholder="搜索列名" :prefix-icon="Search" />
        <div class="od-col-actions">
          <el-button size="small" @click="selectAllDraft">全选</el-button>
          <el-button size="small" @click="resetColumns">重置</el-button>
        </div>
      </div>
      <div class="od-cols">
        <el-checkbox-group v-model="drawerKeys">
          <el-checkbox v-for="c in filteredColumns" :key="c.key" :value="c.key" :label="c.label" />
        </el-checkbox-group>
      </div>
      <template #footer>
        <div class="od-drawer-foot">
          <span class="od-col-count">已选 {{ drawerKeys.length }} / {{ columns.length }} 列</span>
          <el-button type="primary" size="small" @click="applyColumns">保存</el-button>
        </div>
      </template>
    </el-drawer>

    <div ref="bodyRef" class="od-body">
      <el-table
        v-loading="loading"
        :data="rows"
        :height="tableH"
        stripe
        border
        class="od-table"
        empty-text="暂无运单明细"
        @sort-change="onSortChange"
      >
        <el-table-column
          v-for="c in visibleColumns"
          :key="c.key"
          :prop="c.key"
          :label="c.label"
          :width="colWidths[c.key]"
          :align="c.kind === 'text' ? 'left' : 'center'"
          sortable="custom"
        >
          <template #default="{ row }">
            <span v-if="c.kind === 'bool'">
              {{ row[c.key] || '—' }}
            </span>
            <span v-else>{{ cellText(row[c.key]) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="od-pg">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[25, 50, 100, 200]"
        layout="total, sizes, prev, pager, next, jumper"
        background
        @current-change="onPageChange"
        @size-change="onPageSizeChange"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, nextTick, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Download, Operation, Refresh, Search } from '@element-plus/icons-vue';
import { useOrderDetail } from './useOrderDetail.js';

const {
  dateRange, rangeIncludesToday, teamSel, stateSel, keyword,
  rows, columns, visibleColumns, visibleKeys, states,
  total, page, pageSize, fetchedAt,
  historyDays, historyTotal, lastRun,
  teamOptions, loading, loadErrMsg, needRefresh,
  refreshing, cooldown, exporting, onExport,
  bodyRef, bodyH, initMeasure,
  changeDate, changeTeam, changeState, onSortChange, onPageChange, onPageSizeChange,
  onRefresh, onRollupHistory, init, dispose, defaultVisibleKeys,
} = useOrderDetail();

/** 列设置抽屉开关与搜索词。 */
const colDrawer = ref(false);
const colSearch = ref('');
/** 列设置抽屉的草稿勾选：仅在「保存」时提交到 visibleKeys，避免每次勾选都实时改表格。 */
const drawerKeys = ref([]);
watch(colDrawer, (open) => {
  if (open) drawerKeys.value = [...visibleKeys.value];
});
/** 抽屉内按搜索词过滤列（label / key 命中），不改动实际 visibleKeys。 */
const filteredColumns = computed(() => {
  const kw = colSearch.value.trim().toLowerCase();
  if (!kw) return columns.value;
  return columns.value.filter(
    (c) => c.label.toLowerCase().includes(kw) || c.key.toLowerCase().includes(kw),
  );
});
/** 抽屉内「全选」：仅改草稿（显示全部列），需点保存才生效。 */
function selectAllDraft() {
  drawerKeys.value = columns.value.map((c) => c.key);
}
/** 抽屉内「重置」：把草稿恢复为系统默认列集（19 列，随默认集动态增减），需点保存才生效。 */
function resetColumns() {
  drawerKeys.value = defaultVisibleKeys();
  colSearch.value = '';
}
/** 保存：把抽屉草稿提交为实际可见列，触发表格更新与持久化。 */
function applyColumns() {
  visibleKeys.value = [...drawerKeys.value];
  colDrawer.value = false;
}

/** 当前查询为纯历史区间（不含今天）→ 展示历史数据来源说明条。 */
const isHistoryView = computed(() => !rangeIncludesToday.value);

/** 历史滚动数据中实际已入库的最新一天（仅统计有数据的天，避免把「理论 T-1」当天未入库的日期算进去）。 */
const historyLatestDate = computed(() => {
  const ds = (historyDays.value || [])
    .filter((d) => (d.rows ?? 0) > 0)
    .map((d) => d.date)
    .filter(Boolean)
    .sort();
  return ds.length ? ds[ds.length - 1] : '';
});

const tableH = computed(() => Math.max(200, bodyH.value - 8));

/**
 * 列宽自适应：用 canvas 实测「表头 + 每行内容」的最大字符宽度，确保内容不被折叠/省略。
 * 列宽 = 内容最大宽 + 内边距；内容超宽时由 el-table 内部横向滚动承载，单元格保持单行不换行。
 */
let measureCanvas = null;
function measureTextWidth(text) {
  if (measureCanvas === null) measureCanvas = document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  ctx.font = '14px "Helvetica Neue", Helvetica, "PingFang SC", "Microsoft YaHei", Arial, sans-serif';
  return ctx.measureText(text == null ? '' : String(text)).width;
}
const CELL_PAD = 28;
/** 各列自适应宽度（key → px），随数据与可见列变化重算。 */
const colWidths = computed(() => {
  const map = {};
  const cols = visibleColumns.value || [];
  const data = rows.value || [];
  for (const c of cols) {
    let w = measureTextWidth(c.label) + CELL_PAD;
    if (c.kind === 'time') w = Math.max(w, 165);
    if (c.kind === 'bool') w = Math.max(w, 90);
    for (let i = 0; i < data.length; i++) {
      const tw = measureTextWidth(data[i][c.key]) + CELL_PAD;
      if (tw > w) w = tw;
    }
    map[c.key] = Math.max(80, Math.min(Math.round(w), 360));
  }
  return map;
});

function cellText(v) {
  return v === null || v === undefined || v === '' ? '—' : v;
}

/** 当天判断（北京时间），与后端同口径。 */
function todayYmd() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function shiftDay(n) {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
/** 本地 Date → YYYY-MM-DD（disabledDate 用，按用户所在时区）。 */
function ymdOf(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
/**
 * 日期段禁用规则：历史与今天不能同时选。
 * 关键：只在「选择进行中」（一端已选、另一端待选）约束——此时 start 已定，按 start 限制 end。
 * 若区间已完整或为空，则全部放开，否则默认的 [今天,今天] 会锁死面板、所有历史被禁用、点不进去。
 *   - 起点是今天 → 终点只能今天（单日今天）
 *   - 起点是历史 → 终点只能历史（禁用今天及以后）
 * 快捷选择直接赋值、不受此限制，故快捷里单独给出纯历史区间。
 */
const disabledDate = (time) => {
  const t = ymdOf(time);
  const today = todayYmd();
  const v = dateRange.value || [];
  const s = v[0];
  const e = v[1];
  if (s != null && e == null) {
    if (s === today) return t !== today;
    return t >= today;
  }
  return false;
};
/** 日期段快捷选择：今天 / 昨天 / 最近 7 天(历史) / 最近 30 天(历史)。 */
const shortcuts = [
  { text: '今天', value: () => { const t = todayYmd(); return [t, t]; } },
  { text: '昨天', value: () => { const y = shiftDay(-1); return [y, y]; } },
  { text: '最近 7 天', value: () => [shiftDay(-7), shiftDay(-1)] },
  { text: '最近 30 天', value: () => [shiftDay(-30), shiftDay(-1)] },
];

/** 刷新：拉全站运单入库后重载明细。 */
async function handleRefresh() {
  const r = await onRefresh();
  if (!r.ok) {
    ElMessage.error(r.error);
    return;
  }
  const res = r.data || {};
  const empty = (res.perTeam || []).filter((p) => !p.rows);
  if (empty.length) {
    ElMessage.warning(`刷新完成，但以下站点 0 条：${empty.map((p) => p.team).join('；')}`);
  } else {
    ElMessage.success(
      `刷新完成：导出 ${res.total} 条，入库 ${res.saved} 条，覆盖 ${(res.perTeam || []).length} 个站点`,
    );
  }
  await changeDate(); // 回到第 1 页并重载
}

onMounted(async () => {
  await init();
  await nextTick();
  initMeasure();
});
onUnmounted(dispose);
</script>

<style scoped>
.od { padding: var(--sp-20); display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
.od-bar { display: flex; align-items: center; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.od-date { flex: 0 0 260px; }
.od-sel { width: 160px; }
.od-kw { width: 260px; }
.od-tag { font-size: var(--el-font-size-small); color: var(--el-text-color-secondary); }
/* 历史滚动标签：hover 弹出 T-1 ~ T-7 覆盖明细 */
.od-hist {
  padding: 2px 8px; cursor: default;
  border: 1px solid var(--el-border-color-lighter); border-radius: var(--el-border-radius-base);
}
.od-hpop { display: flex; flex-direction: column; gap: var(--sp-4); }
.od-hpop-h { color: var(--el-text-color-secondary); margin-bottom: var(--sp-4); }
.od-hpop-row {
  display: grid; grid-template-columns: 96px 72px 1fr; gap: var(--sp-8);
  font-size: var(--el-font-size-small);
}
.od-hpop-zero { color: var(--el-text-color-placeholder); }
.od-hpop-at { color: var(--el-text-color-secondary); }
.od-hpop-last {
  margin-top: var(--sp-8); padding-top: var(--sp-8);
  border-top: 1px solid var(--el-border-color-lighter);
  font-size: var(--el-font-size-small); color: var(--el-text-color-secondary);
}
.od-refresh { margin-left: auto; }
.od-col-toolbar { display: flex; flex-direction: column; gap: var(--sp-8); margin-bottom: var(--sp-12); }
.od-col-actions { display: flex; gap: var(--sp-8); }
.od-cols {
  max-height: 66vh; overflow-y: auto;
  display: flex; flex-direction: column; gap: var(--sp-4);
}
/* 列设置：一列一行，避免全部原始列（70+）复选框横排溢出 */
.od-cols :deep(.el-checkbox-group) { display: flex; flex-direction: column; gap: var(--sp-4); }
.od-cols :deep(.el-checkbox) { height: auto; margin-right: 0; }
.od-col-count { font-size: var(--el-font-size-small); color: var(--el-text-color-secondary); }
.od-drawer-foot { display: flex; align-items: center; justify-content: space-between; width: 100%; }
.od-hint { margin-bottom: var(--sp-12); }
.od-body { flex: 1; min-height: 0; }
.od-pg { flex: none; padding-top: var(--sp-12); display: flex; justify-content: flex-end; }

.od-table { border-radius: var(--el-border-radius-base); }
.od-table :deep(.el-table th.el-table__cell),
.od-table :deep(.el-table td.el-table__cell) { padding: 8px 0; }
.od-table :deep(.el-table .cell) { line-height: 22px; white-space: nowrap; }
.od-table :deep(.caret-wrapper) { display: none !important; }
.od-table :deep(.ascending .caret-wrapper),
.od-table :deep(.descending .caret-wrapper) { display: inline-flex !important; }
.od-table :deep(.is-sortable:hover .caret-wrapper) { display: inline-flex !important; opacity: 0.4; cursor: pointer; }
</style>
