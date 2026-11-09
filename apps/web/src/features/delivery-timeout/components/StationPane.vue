<template>
  <!-- ① 站点数据：KPI 汇总 + 站点配送时效对比表（点击站点名下钻看骑手/订单） -->
  <div class="dv-pane">
    <div v-if="cards.length" class="dv-cards">
      <el-card v-for="c in cards" :key="c.label" class="dv-card" shadow="never">
        <span class="dv-card-num" :class="c.cls">{{ c.value }}</span>
        <span class="dv-card-label">{{ c.label }}</span>
      </el-card>
    </div>
    <el-card class="dv-table-card" shadow="never">
    <el-table
      v-loading="loading"
      :data="rows"
      stripe
      border
      class="dv-table"
      empty-text="暂无配送超时数据"
      :max-height="560"
      :default-sort="{ prop: 'timeout_total', order: 'descending' }"
    >
      <el-table-column prop="team_id" label="站点ID" min-width="130" fixed sortable show-overflow-tooltip />
      <el-table-column prop="team_name" label="站点" min-width="200" fixed sortable show-overflow-tooltip>
        <template #default="{ row }">
          <el-button link type="primary" class="dv-link" @click="emit('drill', row)">
            {{ row.team_name }}
          </el-button>
        </template>
      </el-table-column>
      <el-table-column prop="pushed_order_volume" label="推配送单量" min-width="120" sortable />
      <el-table-column prop="delivery_completed" label="配送成功单量" min-width="130" sortable />
      <el-table-column prop="timeout_total" label="超时单量" min-width="110" sortable />
      <el-table-column label="准时率" min-width="110" align="center" sortable :sort-method="numSort('ontime_rate')">
        <template #default="{ row }">
          <span class="rt" :class="rateClsUp(row.ontime_rate)">{{ fmtRate(row.ontime_rate) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="单均复合超时时长(秒)" min-width="160" align="center" sortable
                       :sort-method="numSort('avg_compound_overtime_sec')">
        <template #default="{ row }">
          <span class="rt rt--bad">{{ fmtMin(row.avg_compound_overtime_sec) }}</span>
        </template>
      </el-table-column>
    </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { fmtRate, fmtMin, rateClsUp, numSort, num } from '../format.js';

const props = defineProps({
  rows: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
});
const emit = defineEmits(['drill']);

/* —— 聚合：全部站点时对各站计数求和，比率/均值按口径重算 —— */
function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

const agg = computed(() => {
  const r = props.rows;
  const pushed = r.reduce((a, x) => a + num(x.pushed_order_volume), 0);
  const completed = r.reduce((a, x) => a + num(x.delivery_completed), 0);
  const timeout = r.reduce((a, x) => a + num(x.timeout_total), 0);
  // 单均复合超时时长（考核口径，单位秒）：各站分子/分母求和后重算均值
  const cNum = r.reduce((a, x) => a + num(x.compound_overtime_sec), 0);
  const cDen = r.reduce((a, x) => a + num(x.compound_detail && x.compound_detail.denominator), 0);
  const avgCompound = cDen > 0 ? Math.round((cNum / cDen) * 100) / 100 : null;
  // T8 加权准时率（与每行 ontime_rate 同源）：对各项分子/分母求和后重算
  const dt = (k) => r.reduce((a, x) => a + num(x.t8_rate_detail && x.t8_rate_detail[k]), 0);
  const t8Num = dt('t8_ontime') - dt('false_slow_cancel') - dt('early_delivered') * 2;
  const t8Den = dt('valid_completed') + dt('high_value_timeout') * 1 + dt('starbucks_timeout') * 2;
  return {
    pushed,
    completed,
    timeout,
    avgCompound,
    // 明细缺失（旧缓存/未刷新）时退化为简单口径，避免汇总显示「-」
    ontime:
      t8Den > 0
        ? Math.round((t8Num / t8Den) * 1000) / 10
        : completed > 0
          ? pct(completed - timeout, completed)
          : null,
  };
});

const cards = computed(() => [
  { label: '推配送单量', value: agg.value.pushed },
  { label: '配送成功单量', value: agg.value.completed },
  { label: '超时单量', value: agg.value.timeout, cls: 'is-bad' },
  { label: '准时率', value: fmtRate(agg.value.ontime), cls: rateClsUp(agg.value.ontime) },
  { label: '单均复合超时时长(秒)', value: fmtMin(agg.value.avgCompound), cls: 'is-bad' },
]);
</script>

<style scoped>
.dv-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* 表格卡片：纯容器（无 header/footer），body 沿用 EP 默认 20px padding；
   flex:none 避免固定高度表格被 flex 压缩后裁切 */
.dv-table-card { flex: none; }

/* ── KPI 汇总卡片 ── */
.dv-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-12); margin-bottom: var(--sp-16); }
.dv-card :deep(.el-card__body) { display: flex; flex-direction: column; gap: 4px; padding: var(--sp-16); }
.dv-card-num { font-size: 24px; font-weight: var(--fw-bold); color: var(--el-color-primary); }
.dv-card-label { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.dv-card-num.is-ok { color: var(--ok, #2e7d32); }
.dv-card-num.is-warn { color: var(--warn, #ed6c02); }
.dv-card-num.is-bad { color: var(--danger, #d32f2f); }
.dv-card-num.is-none { color: var(--el-text-color-secondary); }

/* ── 比率单元格 ── */
.rt { font-weight: var(--fw-bold); }
.rt.is-ok { color: var(--ok, #2e7d32); }
.rt.is-warn { color: var(--warn, #ed6c02); }
.rt.is-bad { color: var(--danger, #d32f2f); }
.rt.is-none { color: var(--el-text-color-secondary); font-weight: var(--fw-normal); }
.rt--bad { color: var(--danger, #d32f2f); }
.dv-link { padding: 0; }

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
