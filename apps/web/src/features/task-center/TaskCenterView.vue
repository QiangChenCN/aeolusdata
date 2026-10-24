<template>
  <div class="tc">
    <!-- 页面标题 -->
    <div class="page-head">
      <h1 class="page-title">任务中心</h1>
      <p class="page-sub">自动化任务总览，覆盖考勤播报、申诉提醒、运单入库与文档生成，点击「运行」立即执行一次。</p>
    </div>

    <!-- 顶部工具条：分类胶囊 + 搜索 + 排序 + 视图切换 -->
    <div class="tc-bar">
      <div class="tc-cats">
        <el-check-tag
          v-for="g in groupTabs"
          :key="g.id"
          class="cat"
          :checked="activeGroup === g.id"
          @change="activeGroup = g.id"
        >
          {{ g.name }}<span class="cat-n">{{ g.count }}</span>
        </el-check-tag>
      </div>
      <div class="tc-tools">
        <el-input v-model="q" class="tc-search" placeholder="搜索任务名称或描述…" clearable>
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-select v-model="sortBy" class="tc-sel">
          <el-option label="排序：最近运行" value="recent" />
          <el-option label="排序：名称" value="name" />
          <el-option label="排序：状态优先" value="status" />
        </el-select>
        <el-radio-group v-model="viewMode" size="small" class="tc-view">
          <el-radio-button value="grid"><el-icon><Grid /></el-icon></el-radio-button>
          <el-radio-button value="list"><el-icon><List /></el-icon></el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <!-- 卡片网格（全宽自适应列数） -->
    <div v-if="filtered.length" class="tc-grid" :class="{ 'is-list': viewMode === 'list' }">
      <el-card
        v-for="t in filtered"
        :key="t.id"
        class="tc-card"
        shadow="hover"
      >
        <div class="card-main">
          <div class="tile" :style="icStyle(t)">
            <el-icon :size="20"><component :is="icName(t)" /></el-icon>
          </div>
          <div class="card-text">
            <div class="title-row">
              <span class="t-title" :title="t.name">{{ t.name }}</span>
              <el-tag size="small" :type="state(t).type" effect="light" class="t-chip">
                <span v-if="state(t).dot" class="dot" />{{ state(t).txt }}
              </el-tag>
            </div>
            <div class="desc">{{ t.desc || '—' }}</div>
            <div class="meta">
              <span class="meta-item"><el-icon><Collection /></el-icon>{{ groupName(t) }}</span>
              <span class="meta-item"><el-icon><Clock /></el-icon>{{ lastTextOf(t) || '尚无运行记录' }}</span>
            </div>
          </div>
        </div>

        <div class="card-actions">
          <el-button
            :type="runBtnPrimary(t) ? 'primary' : 'default'"
            :plain="!runBtnPrimary(t)"
            class="run-btn"
            :loading="isRunning(t)"
            @click="onRun(t)"
          >
            <el-icon v-if="!isRunning(t)"><VideoPlay /></el-icon>运行
          </el-button>
          <div class="foot-links">
            <el-button text @click="openConfig(t.id)"><el-icon><Setting /></el-icon>配置</el-button>
            <el-button text @click="onArtifacts(t)"><el-icon><Files /></el-icon>产物</el-button>
          </div>
        </div>
      </el-card>
    </div>

    <el-empty v-else description="没有匹配的任务" class="tc-empty" />

    <!-- 最近运行 -->
    <section class="panel">
      <div class="panel-head">
        <span class="panel-title">最近运行</span>
        <span class="panel-count">{{ recentRuns.length }}</span>
        <el-button text class="panel-more" @click="$router.push('/history')">全部记录<el-icon><ArrowRight /></el-icon></el-button>
      </div>
      <el-table :data="recentRuns" class="run-table" empty-text="暂无运行记录">
        <el-table-column label="任务" prop="name" min-width="160" />
        <el-table-column label="触发">
          <template #default="{ row }">{{ row.trigger }}</template>
        </el-table-column>
        <el-table-column label="开始时间" prop="start" />
        <el-table-column label="耗时">
          <template #default="{ row }">{{ row.duration != null ? row.duration + 's' : '—' }}</template>
        </el-table-column>
        <el-table-column label="结果">
          <template #default="{ row }">
            <el-tag :type="row.etype" size="small" effect="light">
              <span v-if="row.etype === 'success'" class="dot" />{{ row.result }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作">
          <template #default="{ row }">
            <el-button text size="small" @click="onOpenRun(row)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <TaskConfigDialog ref="cfgRef" />
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { ArrowRight } from '@element-plus/icons-vue';
import TaskConfigDialog from '../../components/tasks/TaskConfigDialog.vue';
import { useTasksStore } from '../../stores/tasks.js';
import { useRunsStore } from '../../stores/runs.js';
import { useArtifactStore } from '../../stores/artifact.js';
import { STATUS_TXT, GROUP_ICONS } from '../../utils/tokens.js';

const tasks = useTasksStore();
const runs = useRunsStore();
const artifact = useArtifactStore();

const q = ref('');
const sortBy = ref('recent');
const activeGroup = ref('all');
const viewMode = ref('grid');
const cfgRef = ref(null);

// 分类胶囊：全部 + 各业务分组（带任务数）
const groupTabs = computed(() => [
  { id: 'all', name: '全部', count: tasks.countInGroup('all') },
  ...tasks.groups.map((g) => ({ id: g.id, name: g.name, count: tasks.countInGroup(g.id) })),
]);

function isRunning(t) { return runs.runningTaskId === t.id; }
function lastRecord(t) { return (runs.history || []).find((x) => x.task_id === t.id); }
function lastTextOf(t) {
  const h = lastRecord(t);
  if (!h) return '';
  return (h.start || '') + (h.duration ? ' · ' + h.duration + 's' : '');
}
function lastStatus(t) {
  const h = lastRecord(t);
  return h ? (h.error_kind || h.status || '') : 'none';
}
// 卡片右上角状态
function state(t) {
  if (isRunning(t)) return { txt: '执行中', type: 'warning', dot: true };
  const s = lastStatus(t);
  if (s === 'success') return { txt: '已启用', type: 'success', dot: true };
  if (s === 'failed') return { txt: '上次失败', type: 'danger' };
  if (s === 'stopped') return { txt: '已暂停', type: 'info' };
  if (s === 'none') return { txt: '未运行', type: 'info' };
  return { txt: STATUS_TXT[s] || s, type: 'info' };
}
// 运行按钮：已启用 / 执行中 → 实心 primary；其余 → 浅色 plain
function runBtnPrimary(t) { return isRunning(t) || state(t).type === 'success'; }

function groupOf(t) { return tasks.groupById(t.group) || {}; }
function groupName(t) { return groupOf(t).name || t.group || ''; }
function icName(t) { return GROUP_ICONS[t.group] || 'Grid'; }
function icStyle(t) {
  const c = groupOf(t).color || '#409eff';
  return { color: c, background: hexA(c, 0.1) };
}
function hexA(hex, a) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

const filtered = computed(() => {
  let list = tasks.visibleTasks({
    q: q.value,
    group: activeGroup.value,
    filter: sortBy.value === 'status' ? 'status' : null,
    sortDir: 'asc',
  }).slice();
  if (sortBy.value === 'name') {
    list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  } else if (sortBy.value === 'recent') {
    const st = (t) => lastRecord(t)?.start || '';
    list.sort((a, b) => st(b).localeCompare(st(a)));
  }
  return list;
});

// 最近运行表格
const recentRuns = computed(() =>
  (runs.history || []).slice(0, 8).map((h) => {
    const t = tasks.taskById(h.task_id);
    const st = h.error_kind || h.status || '';
    let result = '—', etype = 'info';
    if (st === 'success') { result = '成功'; etype = 'success'; }
    else if (st === 'failed') { result = '失败'; etype = 'danger'; }
    else if (st === 'running') { result = '执行中'; etype = 'warning'; }
    else if (st === 'stopped') { result = '已停止'; etype = 'info'; }
    else if (st === 'queued') { result = '排队中'; etype = 'warning'; }
    return {
      run_id: h.run_id,
      name: t ? t.name : (h.name || h.task_id),
      trigger: h.trigger || '—',
      start: h.start || '—',
      duration: h.duration,
      result,
      etype,
    };
  }),
);
function onOpenRun(row) { if (row.run_id) runs.openLog(row.run_id); }

function openConfig(id) { cfgRef.value?.open(id); }
async function onRun(task) {
  try {
    await runs.run(task.id, tasks.args[task.id] || {});
    tasks.resetArgs(task.id);
    ElMessage.success('已提交运行：' + task.name + '（配置已恢复默认）');
  } catch (e) {
    ElMessage.error(e.message);
  }
}
function onArtifacts(task) { artifact.open(task.id); }
</script>

<style scoped>
.tc { width: 100%; max-width: none; min-height: 100%; box-sizing: border-box; padding: 20px 24px 40px; }

/* ── 页面标题 ───────────────────────────────────── */
.page-head { margin-bottom: 16px; }
.page-title { font-size: 22px; font-weight: 600; color: var(--el-text-color-primary); }
.page-sub { margin-top: 6px; font-size: 13px; color: var(--el-text-color-secondary); max-width: 70ch; }

/* ── 顶部工具条 ───────────────────────────────────── */
.tc-bar {
  display: flex; align-items: center; gap: 12px;
  margin-bottom: 16px; flex-wrap: wrap;
}
.tc-cats { flex: 1 1 auto; display: flex; flex-wrap: wrap; gap: 8px; }
.tc-cats .cat { font-weight: 600; font-size: 13px; padding: 5px 14px; border-radius: 999px; }
.cat-n { margin-left: 6px; font-size: 12px; opacity: .7; }
.tc-tools { flex: none; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tc-search { width: 240px; }
.tc-sel { width: 150px; }

/* ── 卡片网格（全宽自适应列数）────────────────────── */
.tc-grid {
  display: grid; gap: 14px;
  grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
  align-items: stretch;
}
.tc-card {
  border-radius: 12px; border: 1px solid var(--el-border-color);
  transition: border-color .15s ease, transform .15s ease;
}
.tc-card:hover { border-color: var(--el-color-primary); transform: translateY(-2px); }
.tc-card :deep(.el-card__body) {
  display: flex; flex-direction: column; gap: 13px; padding: 16px !important;
}

.card-main { display: flex; gap: 12px; min-width: 0; }
.tile {
  width: 40px; height: 40px; border-radius: 11px; flex: none;
  display: flex; align-items: center; justify-content: center;
}
.card-text { min-width: 0; flex: 1; }
.title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.t-title {
  font-size: 15px; font-weight: 600; color: var(--el-text-color-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.t-chip { flex: none; }
.dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: currentColor; margin-right: 5px; vertical-align: middle;
}

.desc {
  margin-top: 7px;
  color: var(--el-text-color-secondary); font-size: 12.5px; line-height: 1.6;
  min-height: 40px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.meta {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 11px;
  margin-top: 9px; color: var(--el-text-color-secondary); font-size: 12px;
}
.meta-item { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.meta-item :deep(.el-icon) { font-size: 13px; }

.card-actions {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--el-border-color-lighter);
}
.run-btn { flex: none; min-width: 96px; font-weight: 600; }
.foot-links { display: flex; gap: 2px; }

/* 列表视图 */
.tc-grid.is-list { grid-template-columns: 1fr; }
.tc-grid.is-list .tc-card :deep(.el-card__body) { flex-direction: row; align-items: center; gap: 18px; }
.tc-grid.is-list .card-main { flex: 1; align-items: center; }
.tc-grid.is-list .desc { -webkit-line-clamp: 1; min-height: 0; margin-top: 5px; }
.tc-grid.is-list .card-actions { margin-top: 0; padding-top: 0; border-top: 0; flex: none; }

/* ── 空状态 / 最近运行 ─────────────────────────────── */
.tc-empty { padding: 48px 0; }
.panel {
  margin-top: 24px;
  background: var(--el-bg-color); border: 1px solid var(--el-border-color);
  border-radius: 12px; overflow: hidden;
}
.panel-head {
  display: flex; align-items: center; gap: 10px;
  padding: 13px 18px; border-bottom: 1px solid var(--el-border-color-lighter);
}
.panel-title { font-size: 14px; font-weight: 600; }
.panel-count {
  font-size: 11.5px; color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light); padding: 2px 7px; border-radius: 5px;
  font-variant-numeric: tabular-nums;
}
.panel-more { margin-left: auto; }
.run-table { font-size: 13px; }

/* ── 响应式 ───────────────────────────────────────── */
@media (max-width: 768px) {
  .tc { padding: 16px 16px 32px; }
  .tc-search { width: 100%; }
  .tc-tools { flex: 1 1 100%; }
}
</style>
