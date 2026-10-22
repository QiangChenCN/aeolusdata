<template>
  <!-- ② 骑手数据：跨所选站点聚合所有骑手（准时率未达100%），分页 + 全量排序后再分页 -->
  <div class="dv-pane">
    <el-table
      v-loading="loading"
      :data="pagedRiderRows"
      :height="riderH"
      stripe
      border
      class="dv-table"
      empty-text="暂无骑手超时数据"
      :default-sort="{ prop: 'overtime_sec', order: 'descending' }"
      @sort-change="onRiderSort"
    >
      <el-table-column prop="rider_id" label="骑手ID" min-width="150" fixed sortable show-overflow-tooltip />
      <el-table-column prop="rider_name" label="骑手姓名" min-width="150" fixed sortable show-overflow-tooltip />
      <el-table-column prop="team_id" label="站点ID" min-width="130" fixed sortable show-overflow-tooltip />
      <el-table-column prop="team_name" label="站点名称" min-width="170" sortable show-overflow-tooltip />
      <el-table-column prop="delivered" label="配送成功单量" min-width="130" align="center" sortable />
      <el-table-column prop="timeout" label="T8超时单量" min-width="120" align="center" sortable />
      <el-table-column prop="ontime_rate" label="准时率" min-width="110" align="center" sortable>
        <template #default="{ row }"><span class="rt" :class="rateClsUp(row.ontime_rate)">{{ fmtRate(row.ontime_rate) }}</span></template>
      </el-table-column>
      <el-table-column prop="overtime_sec" label="单均复合超时时长(秒)" min-width="150" align="center" sortable>
        <template #default="{ row }"><span class="rt rt--bad">{{ fmtMin(row.overtime_sec) }}</span></template>
      </el-table-column>
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
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { fmtRate, fmtMin, rateClsUp } from '../format.js';

const props = defineProps({
  rows: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  bodyH: { type: Number, default: 520 },
});

/* —— 跨所选站点聚合所有「准时率未达100%」骑手（每行 row.riders 已含骑手数据） —— */
const riderRows = computed(() => {
  const out = [];
  for (const r of props.rows) {
    const teamName = r.team_name || r.team_id;
    for (const rd of r.riders || []) {
      // 后端 rider.avg_overtime_min 为「单均复合超时时长(分钟)」= 超时单复合超时总时长 / 配送成功单量；
      // 看板按「秒」展示 → ×60
      const min = rd.avg_overtime_min;
      out.push({
        team_id: r.team_id,
        team_name: teamName,
        rider_id: rd.rider_id,
        rider_name: rd.rider_name,
        delivered: rd.delivered,
        timeout: rd.timeout,
        ontime_rate: rd.ontime_rate,
        overtime_sec: min == null ? null : Math.round(min * 60),
      });
    }
  }
  return out;
});

/* —— 分页 + 全量排序后再分页（el-table 自带排序仅作用于当前页，故手动排序） —— */
const riderPage = ref(1);
const riderPageSize = ref(25);
const riderSort = ref({ prop: 'overtime_sec', order: 'descending' });
const riderH = computed(() => Math.max(200, props.bodyH - 56));

function onRiderSort({ prop, order }) {
  riderSort.value = { prop, order };
  riderPage.value = 1;
}
const sortedRiderRows = computed(() => {
  const { prop, order } = riderSort.value;
  const arr = riderRows.value.slice();
  if (!prop || !order) return arr;
  const dir = order === 'ascending' ? 1 : -1;
  arr.sort((a, b) => {
    let va = a[prop];
    let vb = b[prop];
    if (typeof va === 'string' || typeof vb === 'string') {
      va = va == null ? '' : String(va);
      vb = vb == null ? '' : String(vb);
      return va.localeCompare(vb, 'zh') * dir;
    }
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va - vb) * dir;
  });
  return arr;
});
const pagedRiderRows = computed(() => {
  const start = (riderPage.value - 1) * riderPageSize.value;
  return sortedRiderRows.value.slice(start, start + riderPageSize.value);
});
/* 数据重载后回到第一页 */
watch(() => riderRows.value.length, () => { riderPage.value = 1; });
</script>

<style scoped>
.dv-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dv-pg { flex: none; padding-top: var(--sp-12); display: flex; justify-content: flex-end; }

.rt { font-weight: var(--fw-bold); }
.rt.is-ok { color: var(--ok, #2e7d32); }
.rt.is-warn { color: var(--warn, #ed6c02); }
.rt.is-bad { color: var(--danger, #d32f2f); }
.rt.is-none { color: var(--el-text-color-secondary); font-weight: var(--fw-normal); }
.rt--bad { color: var(--danger, #d32f2f); }

.dv-table { border-radius: var(--el-border-radius-base); }
.dv-table :deep(.el-table th.el-table__cell),
.dv-table :deep(.el-table td.el-table__cell) { padding: 8px 0; }
.dv-table :deep(.el-table .cell) { line-height: 22px; white-space: nowrap; }
.dv-table :deep(.caret-wrapper) { display: none !important; }
.dv-table :deep(.ascending .caret-wrapper),
.dv-table :deep(.descending .caret-wrapper) { display: inline-flex !important; }
.dv-table :deep(.is-sortable:hover .caret-wrapper) { display: inline-flex !important; opacity: 0.4; cursor: pointer; }
.dv-table :deep(.el-table__header .cell) { white-space: nowrap; }
</style>
