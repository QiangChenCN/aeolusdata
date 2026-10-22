<template>
  <!-- 两级下钻抽屉：站点 → 准时率未达100%骑手 → 超时订单明细 -->
  <el-drawer :model-value="modelValue" :title="drawerTitle" size="46%" :with-header="true"
             @update:model-value="(v) => emit('update:modelValue', v)">
    <div v-if="drillLevel === 'riders'">
      <div class="dv-drill-hd">
        共 {{ station.riders.length }} 名骑手准时率未达 100%（按超平台期望分钟降序），点击骑手查看超时订单
      </div>
      <el-table :data="station.riders" stripe border class="dv-drill-table"
                :default-sort="{ prop: 'overtime_min', order: 'descending' }" @row-click="onRiderRow">
        <el-table-column label="骑手" min-width="150" fixed sortable show-overflow-tooltip>
          <template #default="{ row }">
            <el-button link type="primary" class="dv-link">{{ row.rider_name || row.rider_id || '未知' }}</el-button>
          </template>
        </el-table-column>
        <el-table-column prop="delivered" label="配送成功单量" min-width="130" align="center" sortable />
        <el-table-column prop="timeout" label="超时单量" min-width="110" align="center" sortable />
        <el-table-column label="准时率" min-width="110" align="center" sortable :sort-method="numSort('ontime_rate')">
          <template #default="{ row }"><span class="rt" :class="rateClsUp(row.ontime_rate)">{{ fmtRate(row.ontime_rate) }}</span></template>
        </el-table-column>
        <el-table-column label="单均复合超时时长(秒)" min-width="150" align="center" sortable
                         :sort-method="numSort('avg_overtime_min')">
          <template #default="{ row }">
            <span class="rt rt--bad">{{ row.avg_overtime_min == null ? '—' : Math.round(row.avg_overtime_min * 60) }}</span>
          </template>
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
        <el-table-column prop="tracking_id" label="运单号" min-width="200" show-overflow-tooltip />
        <el-table-column label="超时分钟" min-width="110" align="center" sortable>
          <template #default="{ row }"><span class="rt rt--bad">{{ fmtMin(row.over_min) }}</span></template>
        </el-table-column>
        <el-table-column label="严重度" min-width="100" align="center">
          <template #default="{ row }"><span class="sev" :class="sevCls(row.severity)">{{ sevText(row.severity) }}</span></template>
        </el-table-column>
      </el-table>
    </div>
  </el-drawer>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { ArrowLeft } from '@element-plus/icons-vue';
import { fmtRate, fmtMin, rateClsUp, sevCls, sevText, numSort } from '../format.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 被下钻的站点行 rows[] 中的一项（含 riders / riders[].timeout_orders）。 */
  station: { type: Object, default: () => ({ team_name: '', riders: [] }) },
});
const emit = defineEmits(['update:modelValue']);

const drillLevel = ref('riders');
const selectedRider = ref({ timeout_orders: [] });

const drawerTitle = computed(() => {
  if (drillLevel.value === 'orders') {
    const r = selectedRider.value;
    return `${r.rider_name || r.rider_id || '骑手'} · 超时订单明细`;
  }
  return `${props.station.team_name} · 准时率未达100%骑手`;
});

// 每次打开都从「骑手列表」这一级开始（保留上次选中的骑手会让返回状态错乱）。
watch(
  () => props.modelValue,
  (v) => {
    if (!v) return;
    drillLevel.value = 'riders';
    selectedRider.value = { timeout_orders: [] };
  },
);

function onRiderRow(row) {
  selectedRider.value = row;
  drillLevel.value = 'orders';
}
function backToRiders() {
  drillLevel.value = 'riders';
  selectedRider.value = { timeout_orders: [] };
}
</script>

<style scoped>
.dv-drill-hd { font-size: var(--el-font-size-small); color: var(--el-text-color-secondary); margin: var(--sp-4) 0 var(--sp-12); }
.dv-drill-table { width: 100%; }
.dv-drill-table :deep(.el-table .cell) { line-height: 22px; white-space: nowrap; }
.dv-link { padding: 0; }
.dv-back { margin-bottom: var(--sp-12); }

.rt { font-weight: var(--fw-bold); }
.rt.is-ok { color: var(--ok, #2e7d32); }
.rt.is-warn { color: var(--warn, #ed6c02); }
.rt.is-bad { color: var(--danger, #d32f2f); }
.rt.is-none { color: var(--el-text-color-secondary); font-weight: var(--fw-normal); }
.rt--bad { color: var(--danger, #d32f2f); }

.sev { display: inline-block; padding: 1px var(--sp-8); border-radius: var(--r-pill); font-size: var(--el-font-size-extra-small); font-weight: var(--fw-semibold); }
.sev--light { background: color-mix(in srgb, var(--warn, #ed6c02) 14%, transparent); color: var(--warn, #ed6c02); }
.sev--mid { background: color-mix(in srgb, #f57c00 16%, transparent); color: #f57c00; }
.sev--heavy { background: color-mix(in srgb, var(--danger, #d32f2f) 16%, transparent); color: var(--danger, #d32f2f); }
</style>
