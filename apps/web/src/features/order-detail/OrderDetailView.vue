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
      <el-select v-model="teamSel" class="od-sel" placeholder="站点" @change="changeTeam">
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
      <el-dropdown trigger="click">
        <el-button><el-icon><Operation /></el-icon> 列设置</el-button>
        <template #dropdown>
          <div class="od-cols">
            <el-checkbox-group v-model="visibleKeys">
              <el-checkbox v-for="c in columns" :key="c.key" :value="c.key" :label="c.label" />
            </el-checkbox-group>
          </div>
        </template>
      </el-dropdown>
      <span v-if="fetchedAt" class="od-tag">入库时间：{{ fetchedAt }}</span>
      <el-popover placement="bottom-end" width="400" trigger="hover">
        <template #reference>
          <span class="od-tag od-hist">历史 T-1~T-7：{{ historyTotal }} 条</span>
        </template>
        <div class="od-hpop">
          <div class="od-hpop-h">每天 04:00 滚动回补 T-1 ~ T-7 到历史运单明细表</div>
          <div v-for="d in historyDays" :key="d.date" class="od-hpop-row">
            <span class="od-hpop-d">{{ d.date }}</span>
            <span :class="{ 'od-hpop-zero': !d.rows }">{{ d.rows }} 条</span>
            <span class="od-hpop-at">{{ d.captured_at || '未入库' }}</span>
          </div>
          <div v-if="lastRun" class="od-hpop-last">
            上次运行：{{ lastRun.finished_at }} · 入库 {{ lastRun.saved_total }} 条
          </div>
          <div v-else class="od-hpop-last">暂无运行记录：等 04:00 定时任务，或点「回补历史」手动跑一次</div>
        </div>
      </el-popover>
      <span class="sp" />
      <el-button
        type="primary"
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
      历史数据（T-1~T-7 滚动留档） · 入库时间：{{ fetchedAt || '—' }} · 历史 T-1~T-7 共 {{ historyTotal }} 条
    </el-alert>

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
          :min-width="colWidth(c)"
          :align="c.kind === 'text' ? 'left' : 'center'"
          sortable="custom"
          show-overflow-tooltip
        >
          <template #default="{ row }">
            <span v-if="c.kind === 'bool'" :class="{ 'od-yes': row[c.key] === '是' }">
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
import { computed, onMounted, onUnmounted, nextTick } from 'vue';
import { ElMessage } from 'element-plus';
import { Operation, Refresh } from '@element-plus/icons-vue';
import { useOrderDetail } from './useOrderDetail.js';

const {
  dateRange, rangeIncludesToday, teamSel, stateSel, keyword,
  rows, columns, visibleColumns, visibleKeys, states,
  total, page, pageSize, fetchedAt,
  historyDays, historyTotal, lastRun,
  teamOptions, loading, loadErrMsg, needRefresh,
  refreshing, cooldown,
  bodyRef, bodyH, initMeasure,
  changeDate, changeTeam, changeState, onSortChange, onPageChange, onPageSizeChange,
  onRefresh, onRollupHistory, init, dispose,
} = useOrderDetail();

/** 当前查询为纯历史区间（不含今天）→ 展示历史数据来源说明条。 */
const isHistoryView = computed(() => !rangeIncludesToday.value);

const tableH = computed(() => Math.max(200, bodyH.value - 8));

/** 列宽按内容类型给：时间列最长，ID/名称居中偏窄，布尔列最窄。 */
function colWidth(c) {
  if (c.kind === 'time') return 165;
  if (c.kind === 'bool') return 90;
  if (c.kind === 'num') return 110;
  if (c.key === 'order_id' || c.key === 'order_no') return 180;
  if (c.key === 'team_name' || c.key === 'merchant_name') return 160;
  return 120;
}

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
.od-bar .sp { flex: 1; }
.od-cols {
  padding: var(--sp-12); max-height: 380px; overflow: auto;
  display: flex; flex-direction: column; gap: var(--sp-4);
}
/* 列设置：一列一行，避免 38 个复选框横排溢出下拉面板 */
.od-cols :deep(.el-checkbox-group) { display: flex; flex-direction: column; gap: var(--sp-4); }
.od-cols :deep(.el-checkbox) { height: auto; margin-right: 0; }
.od-hint { margin-bottom: var(--sp-12); }
.od-body { flex: 1; min-height: 0; }
.od-pg { flex: none; padding-top: var(--sp-12); display: flex; justify-content: flex-end; }

.od-yes { color: var(--danger, #d32f2f); font-weight: var(--fw-bold); }

.od-table { border-radius: var(--el-border-radius-base); }
.od-table :deep(.el-table th.el-table__cell),
.od-table :deep(.el-table td.el-table__cell) { padding: 8px 0; }
.od-table :deep(.el-table .cell) { line-height: 22px; white-space: nowrap; }
.od-table :deep(.caret-wrapper) { display: none !important; }
.od-table :deep(.ascending .caret-wrapper),
.od-table :deep(.descending .caret-wrapper) { display: inline-flex !important; }
.od-table :deep(.is-sortable:hover .caret-wrapper) { display: inline-flex !important; opacity: 0.4; cursor: pointer; }
</style>
