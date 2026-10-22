<template>
  <!-- ③ 运单明细：跨所选站点聚合所有超时订单（考核看板高比单T8超时下钻时经 tt=gaobi 过滤，无可见筛选控件） -->
  <div class="dv-pane">
    <el-table
      v-loading="loading"
      :data="pagedOrderRows"
      :height="orderH"
      stripe
      border
      class="dv-table"
      empty-text="暂无超时运单明细"
      :default-sort="{ prop: 'deliver_dur_sec', order: 'descending' }"
      @sort-change="onOrderSort"
    >
      <el-table-column prop="order_id" label="运单ID" min-width="170" fixed sortable="custom" show-overflow-tooltip />
      <el-table-column prop="rider_id" label="骑手ID" min-width="120" fixed sortable="custom" show-overflow-tooltip />
      <el-table-column prop="rider_name" label="骑手姓名" min-width="110" fixed sortable="custom" show-overflow-tooltip />
      <el-table-column prop="team_id" label="站点ID" min-width="130" fixed sortable="custom" show-overflow-tooltip />
      <el-table-column prop="team_name" label="站点姓名" min-width="170" sortable="custom" show-overflow-tooltip />
      <el-table-column prop="merchant_id" label="商家ID" min-width="120" sortable="custom" show-overflow-tooltip />
      <el-table-column prop="merchant_name" label="商家名称" min-width="150" sortable="custom" show-overflow-tooltip />
      <el-table-column prop="flow_no" label="流水号" min-width="140" sortable="custom" show-overflow-tooltip />
      <el-table-column prop="over_min" label="超时分钟" min-width="100" align="center" sortable="custom">
        <template #default="{ row }">{{ fmtMin(row.over_min) }}</template>
      </el-table-column>
      <el-table-column prop="compound_overtime_sec" label="复合超时时长(秒)" min-width="150" align="center" sortable="custom">
        <template #default="{ row }"><span class="rt rt--bad">{{ fmtMin(row.compound_overtime_sec) }}</span></template>
      </el-table-column>
      <el-table-column prop="arrive_dur_sec" label="到店时长" min-width="110" align="center" sortable="custom">
        <template #default="{ row }">{{ fmtSecToMin(row.arrive_dur_sec) }}</template>
      </el-table-column>
      <el-table-column prop="wait_dur_sec" label="等餐时长" min-width="110" align="center" sortable="custom">
        <template #default="{ row }">{{ fmtSecToMin(row.wait_dur_sec) }}</template>
      </el-table-column>
      <el-table-column prop="deliver_dur_sec" label="配送时长" min-width="110" align="center" sortable="custom">
        <template #default="{ row }">{{ fmtSecToMin(row.deliver_dur_sec) }}</template>
      </el-table-column>
      <el-table-column prop="accept_time" label="骑手接单时间" min-width="170" align="center" sortable="custom" />
      <el-table-column prop="arrive_time" label="骑手到店时间" min-width="170" align="center" sortable="custom" />
      <el-table-column prop="pickup_time" label="骑手取餐时间" min-width="170" align="center" sortable="custom" />
      <el-table-column prop="deliver_time" label="骑手送达时间" min-width="170" align="center" sortable="custom" />
      <el-table-column prop="expect_time" label="平台期望时间" min-width="170" align="center" sortable="custom" />
    </el-table>
    <div class="dv-pg">
      <el-pagination
        v-model:current-page="orderPage"
        v-model:page-size="orderPageSize"
        :total="sortedOrderRows.length"
        :page-sizes="[25, 50, 75, 100]"
        layout="total, sizes, prev, pager, next, jumper"
        background
      />
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { fmtMin, fmtSecToMin } from '../format.js';

const props = defineProps({
  rows: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  bodyH: { type: Number, default: 520 },
  /** '' = 全部 T8 超时；'gaobi' = 仅高比单 T8 超时（考核看板下钻带入）。 */
  typeFilter: { type: String, default: '' },
});

/* —— 跨所选站点聚合所有超时订单（来自各骑手的 timeout_orders） —— */
const orderRows = computed(() => {
  const out = [];
  for (const r of props.rows) {
    const teamName = r.team_name || r.team_id;
    for (const rd of r.riders || []) {
      const riderName = rd.rider_name || rd.rider_id || '未知';
      for (const o of rd.timeout_orders || []) {
        out.push({
          team_id: r.team_id,
          team_name: teamName,
          order_id: o.order_id,
          flow_no: o.flow_no,
          over_min: o.over_min,
          compound_overtime_sec: o.compound_overtime_sec,
          rider_id: rd.rider_id,
          rider_name: riderName,
          merchant_id: o.merchant_id,
          merchant_name: o.merchant_name,
          accept_time: o.accept_time,
          arrive_time: o.arrive_time,
          pickup_time: o.pickup_time,
          deliver_time: o.deliver_time,
          expect_time: o.expect_time,
          arrive_dur_sec: o.arrive_dur_sec,
          wait_dur_sec: o.wait_dur_sec,
          deliver_dur_sec: o.deliver_dur_sec,
          // 是否高比单（后端 det 标记）：供「高比单T8超时」下钻过滤，不在表格展示
          is_high_value: o.is_high_value,
        });
      }
    }
  }
  return out;
});

/* —— 全量排序后再分页（el-table 自带排序仅作用于当前页，故手动排序；sortable="custom"） —— */
const orderPage = ref(1);
const orderPageSize = ref(25);
const orderSort = ref({ prop: 'deliver_dur_sec', order: 'descending' });
const orderH = computed(() => Math.max(200, props.bodyH - 56));
const ORDER_NUMERIC = new Set([
  'over_min', 'compound_overtime_sec', 'arrive_dur_sec', 'wait_dur_sec', 'deliver_dur_sec',
]);

function onOrderSort({ prop, order }) {
  orderSort.value = { prop, order };
  orderPage.value = 1;
}
const sortedOrderRows = computed(() => {
  const base =
    props.typeFilter === 'gaobi' ? orderRows.value.filter((o) => o.is_high_value) : orderRows.value;
  const { prop, order } = orderSort.value;
  if (!prop || !order) return base;
  const dir = order === 'ascending' ? 1 : -1;
  const arr = base.slice();
  arr.sort((a, b) => {
    const an = a[prop] == null;
    const bn = b[prop] == null;
    if (an && bn) return 0;
    if (an) return 1; // null 永远排最后（升/降序均如此）
    if (bn) return -1;
    let c;
    if (ORDER_NUMERIC.has(prop)) c = a[prop] - b[prop];
    else c = String(a[prop]).localeCompare(String(b[prop]), 'zh');
    return dir * c;
  });
  return arr;
});
const pagedOrderRows = computed(() => {
  const start = (orderPage.value - 1) * orderPageSize.value;
  return sortedOrderRows.value.slice(start, start + orderPageSize.value);
});
// 数据重载后回到第一页
watch(() => sortedOrderRows.value.length, () => { orderPage.value = 1; });
</script>

<style scoped>
.dv-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dv-pg { flex: none; padding-top: var(--sp-12); display: flex; justify-content: flex-end; }

.rt { font-weight: var(--fw-bold); }
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
