<template>
  <div class="tc">
    <!-- 工具条 -->
    <div class="tc-bar">
      <el-input v-model="q" class="tc-search" placeholder="搜索任务名…" clearable>
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="sortBy" class="tc-sel" style="width: 140px">
        <el-option label="排序：最近运行" value="last" />
        <el-option label="排序：名称" value="name" />
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

      <!-- 卡片视图 -->
      <div v-else class="tc-grid">
        <div v-for="t in filtered" :key="t.id" class="tc-card">
          <div class="tc-card-title">
            <span class="t-name">{{ t.name }}</span>
            <span v-if="isRunning(t)" class="t-running"><el-icon class="t-spin"><Loading /></el-icon>运行中</span>
          </div>
          <div v-if="t.desc" class="t-desc">{{ t.desc }}</div>
          <div class="t-acts">
            <div class="tc-card-meta">
              <el-icon><Clock /></el-icon>
              <span v-if="lastTextOf(t)">{{ lastTextOf(t) }}</span>
              <el-tag size="small" :type="statusTagType(lastStatus(t))">{{ lastStatusLabel(t) }}</el-tag>
            </div>
            <el-button type="primary" size="large" class="t-run" :loading="isRunning(t)" @click="onRun(t)"><el-icon><VideoPlay /></el-icon>运行</el-button>
            <div class="t-acts-sub">
              <el-button @click="openConfig(t.id)"><el-icon><Setting /></el-icon>配置</el-button>
              <el-button @click="onArtifacts(t)"><el-icon><Files /></el-icon>查看产物</el-button>
            </div>
          </div>
        </div>
      </div>
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
import { STATUS_TXT } from '../utils/tokens.js';

const tasks = useTasksStore();
const runs = useRunsStore();

const artifact = useArtifactStore();

const q = ref('');
const sortBy = ref('last');
const cfgRef = ref(null);

// 卡片所需的行级辅助
function isRunning(t) { return runs.runningTaskId === t.id; }
function lastTextOf(t) {
  const h = runs.history.find((x) => x.task_id === t.id);
  if (!h) return '';
  return (h.start || '') + ' · ' + (h.duration || 0) + 's';
}
function lastStatus(t) {
  const h = runs.history.find((x) => x.task_id === t.id);
  return h ? (h.error_kind || h.status || '') : 'none';
}
const STATUS_TAG_TYPE = { success: 'success', failed: 'danger', running: 'warning', stopped: 'info', queued: 'warning', none: 'info' };
function statusTagType(s) { return STATUS_TAG_TYPE[s] || 'info'; }
function lastStatusLabel(t) {
  const s = lastStatus(t);
  return STATUS_TXT[s] || (s === 'none' ? '未运行' : s);
}

const filtered = computed(() => tasks.visibleTasks({
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
  background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: var(--el-border-radius-base);
  box-shadow: var(--el-box-shadow-light);
  position: sticky; top: 0; z-index: 5;
}
.tc-search { flex: 1 1 240px; min-width: 180px; max-width: 360px; }
.tc-search :deep(.el-input) { width: 100%; }
.tc-sel { flex: none; }
.tc-bar .sp { flex: 1 1 auto; }

/* ── 主体：撑满剩余高度 ──────────────────────────────── */
.tc-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.tc-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-12); padding: var(--sp-40); text-align: center; color: var(--el-text-color-secondary); }
.tc-state-ic { font-size: 40px; opacity: .4; }
.tc-state .tc-state-ic :deep(.el-icon) { font-size: 40px; }

/* ── 卡片视图 ────────────────────────────────────────── */
.tc-grid {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  display: grid; gap: var(--sp-14);
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  align-content: start; padding: var(--sp-2);
}
.tc-card {
  display: flex; flex-direction: column; gap: var(--sp-12);
  padding: var(--sp-16);
  background: var(--el-bg-color); border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base); box-shadow: var(--el-box-shadow-light);
  transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
}
.tc-card:hover { border-color: var(--brand, var(--el-color-primary)); transform: translateY(-2px); }
.tc-card-title { display: flex; align-items: center; gap: var(--sp-8); flex-wrap: wrap; min-width: 0; }
.t-name { font-weight: var(--fw-semibold); color: var(--el-text-color-primary); font-size: 15px; }
.t-running { display: inline-flex; align-items: center; gap: var(--sp-4); font-size: var(--el-font-size-extra-small); font-weight: var(--fw-semibold); color: var(--el-color-warning); white-space: nowrap; }
.t-spin { animation: tc-spin 1s linear infinite; }
@keyframes tc-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
.t-desc { color: var(--el-text-color-secondary); font-size: var(--el-font-size-extra-small); line-height: 1.5; }
.tc-card-meta { display: flex; align-items: center; gap: var(--sp-6); color: var(--el-text-color-secondary); font-size: var(--el-font-size-extra-small); }
.tc-card-meta :deep(.el-icon) { font-size: 14px; }
.t-acts { display: flex; flex-direction: column; gap: var(--sp-8); margin-top: auto; }
.t-acts-sub { display: flex; gap: var(--sp-8); }
.t-acts :deep(.el-button) { display: inline-flex; align-items: center; gap: var(--sp-4); flex: 1 1 auto; justify-content: center; }

/* ── 响应式 ──────────────────────────────────────────── */
@media (max-width: 768px) {
  .tc-bar { gap: var(--sp-8); padding: var(--sp-10); }
  .tc-search { flex: 1 1 100%; max-width: none; order: -1; }
  .tc-bar .sp { display: none; }
  .tc-grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--sp-10); }
}
@media (max-width: 620px) {
  .tc { padding: var(--sp-12); }
}
</style>
