<template>
  <div class="tc">
    <!-- 工具条 -->
    <div class="tc-bar">
      <el-input v-model="q" class="tc-search" placeholder="搜索任务名…" clearable>
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="statusFilter" class="tc-sel" style="width: 132px">
        <el-option label="全部状态" value="all" />
        <el-option label="运行中" value="running" />
        <el-option label="排队中" value="queued" />
        <el-option label="成功" value="success" />
        <el-option label="失败" value="failed" />
        <el-option label="未运行" value="none" />
      </el-select>
      <el-select v-model="sortBy" class="tc-sel" style="width: 140px">
        <el-option label="排序：最近运行" value="last" />
        <el-option label="排序：名称" value="name" />
        <el-option label="排序：状态" value="status" />
      </el-select>
      <span class="sp" />
    </div>

    <!-- 主体：撑满剩余高度 -->
    <div class="tc-body">
      <!-- 状态：加载 / 空 -->
      <div v-if="!tasks.loaded" class="tc-state">
        <el-icon class="tc-state-ic"><Loading /></el-icon>
        <span>加载中…</span>
      </div>
      <div v-else-if="!filtered.length" class="tc-state">
        <el-icon class="tc-state-ic"><Box /></el-icon>
        <span>没有匹配的任务</span>
      </div>

      <!-- 表格视图 -->
      <el-table v-else :data="filtered" class="tc-table" size="default" stripe height="100%">
      <el-table-column label="状态" width="116">
        <template #default="{ row }">
          <span class="st-cell"><i class="st-dot" :style="{ background: ST_COLOR[rowStatus(row)] }"></i>{{ ST_TEXT(rowStatus(row)) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="任务" min-width="220">
        <template #default="{ row }">
          <div class="t-name">{{ row.name }}</div>
          <div v-if="row.desc" class="t-desc">{{ row.desc }}</div>
        </template>
      </el-table-column>
      <el-table-column label="风险" width="104">
        <template #default="{ row }">
          <el-tag size="small" :type="row.risk === 'danger' ? 'danger' : 'success'">{{ RISK_LABEL[row.risk] || '只读' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="最近运行" min-width="200">
        <template #default="{ row }">{{ lastTextOf(row) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="320" fixed="right">
        <template #default="{ row }">
          <div class="t-acts">
            <el-button @click="openConfig(row.id)"><el-icon><Setting /></el-icon>配置</el-button>
            <el-button type="primary" @click="onRun(row)"><el-icon><VideoPlay /></el-icon>运行</el-button>
            <el-button @click="onArtifacts(row)"><el-icon><Files /></el-icon>查看产物</el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>
    </div>

    <TaskConfigDialog ref="cfgRef" />
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import TaskConfigDialog from '../components/tasks/TaskConfigDialog.vue';
import { useTasksStore } from '../stores/tasks.js';
import { useRunsStore } from '../stores/runs.js';
import { useArtifactStore } from '../stores/artifact.js';
import { STATUS_TXT, RISK_LABEL } from '../utils/tokens.js';

const tasks = useTasksStore();
const runs = useRunsStore();
const artifact = useArtifactStore();

const q = ref('');
const statusFilter = ref('all');
const sortBy = ref('last');
const cfgRef = ref(null);

// 表格视图所需的行级辅助
const ST_COLOR = { running: 'var(--warn)', queued: 'var(--warn)', success: 'var(--ok)', failed: 'var(--err)', stopped: 'var(--muted)', none: 'var(--muted)' };
function ST_TEXT(s) { return STATUS_TXT[s] || (s === 'none' ? '未运行' : (s || '未运行')); }
function rowStatus(t) { return runs.runningTaskId === t.id ? 'running' : (t.status || 'none'); }
function lastTextOf(t) {
  const h = runs.history.find((x) => x.task_id === t.id);
  if (!h) return '—';
  return (h.start || '') + ' · ' + (h.duration || 0) + 's · ' + (h.error_kind || h.status || '');
}

const filtered = computed(() => tasks.visibleTasks({
  group: 'all',
  q: q.value,
  filter: sortBy.value === 'status' ? 'status' : sortBy.value === 'name' ? 'name' : null,
  sortDir: 'asc',
}));

function openConfig(id) { cfgRef.value?.open(id); }
async function onRun(task) {
  try {
    await runs.run(task.id, tasks.args[task.id] || {});
    // 任务配置仅在本次运行中有效：运行一次后清空持久化参数，回到默认
    tasks.resetArgs(task.id);
    ElMessage.success('已提交运行：' + task.name + '（配置已恢复默认）');
  } catch (e) {
    ElMessage.error(e.message);
  }
}
function onArtifacts(task) { artifact.open(task.id); }
</script>

<style scoped>
.tc { height: 100%; display: flex; flex-direction: column; padding: var(--sp-20); box-sizing: border-box; }

/* ── 工具条（sticky 常驻）─────────────────────────────── */
.tc-bar {
  flex: none;
  display: flex; align-items: center; gap: var(--sp-10); margin-bottom: var(--sp-18); flex-wrap: wrap;
  padding: var(--sp-10) var(--sp-12);
  background: var(--card); border: 1px solid var(--border); border-radius: var(--r-xl);
  box-shadow: var(--shadow-1);
  position: sticky; top: 0; z-index: 5;
}
.tc-search { flex: 1 1 240px; min-width: 180px; max-width: 360px; }
.tc-search :deep(.el-input) { width: 100%; }
.tc-sel { flex: none; }
.tc-bar .sp { flex: 1 1 auto; }

/* ── 主体：撑满剩余高度 ──────────────────────────────── */
.tc-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.tc-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-12); padding: var(--sp-40); text-align: center; color: var(--muted); }
.tc-state-ic { font-size: 40px; opacity: .4; }
.tc-state .tc-state-ic :deep(.el-icon) { font-size: 40px; }

/* ── 表格视图 ────────────────────────────────────────── */
.tc-table { flex: 1; min-height: 0; height: 100%; border-radius: var(--r-xl); overflow: hidden; box-shadow: var(--shadow-1); background: var(--card); }
.tc-table :deep(.el-table__header th.el-table__cell) { background: var(--surface-sunken); color: var(--text); font-weight: var(--fw-semibold); }
.tc-table :deep(.el-table__row:hover > td.el-table__cell) { background: var(--surface-sunken); }
.st-cell { display: inline-flex; align-items: center; gap: var(--sp-6); white-space: nowrap; }
.st-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.t-name { font-weight: var(--fw-semibold); color: var(--text); }
.t-desc { color: var(--muted); font-size: var(--el-font-size-extra-small); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-acts { display: flex; gap: var(--sp-8); flex-wrap: wrap; }
.t-acts :deep(.el-button) { display: inline-flex; align-items: center; gap: var(--sp-4); }

/* ── 响应式 ──────────────────────────────────────────── */
@media (max-width: 768px) {
  .tc-bar { gap: var(--sp-8); padding: var(--sp-10); }
  .tc-search { flex: 1 1 100%; max-width: none; order: -1; }
  .tc-bar .sp { display: none; }
}
@media (max-width: 620px) {
  .tc { padding: var(--sp-12); }
}
</style>
