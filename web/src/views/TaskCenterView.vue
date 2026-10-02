<template>
  <div class="tc-view">
    <div class="tc-heading">
      <span class="tc-heading-ic" :style="{ color: isAll ? 'var(--brand)' : groupColor }">
        <el-icon><component :is="headingIcon" /></el-icon>
      </span>
      <h2>{{ isAll ? '全部任务' : groupName }}</h2>
      <span class="tc-sub">{{ isAll ? `共 ${tasks.tasks.length} 个任务` : `${groupItems(groupId).length} 个任务` }}</span>
    </div>

    <div class="tc-toolbar">
      <el-input v-model="q" placeholder="搜索任务名…" clearable style="width: 240px">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="statusFilter" style="width: 130px">
        <el-option label="全部状态" value="all" />
        <el-option label="运行中" value="running" />
        <el-option label="排队中" value="queued" />
        <el-option label="成功" value="success" />
        <el-option label="失败" value="failed" />
        <el-option label="未运行" value="none" />
      </el-select>
      <el-select v-if="isAll" v-model="groupFilter" style="width: 140px">
        <el-option label="全部分组" value="all" />
        <el-option v-for="g in tasks.groups" :key="g.id" :label="g.name" :value="g.id" />
      </el-select>
      <el-select v-model="sortBy" style="width: 140px">
        <el-option label="排序：最近运行" value="last" />
        <el-option label="排序：名称" value="name" />
        <el-option label="排序：状态" value="status" />
      </el-select>
      <span class="sp" />
      <el-radio-group v-model="viewMode" class="tc-viewmode">
        <el-radio-button value="list"><el-icon><List /></el-icon>列表</el-radio-button>
        <el-radio-button value="board"><el-icon><Grid /></el-icon>看板</el-radio-button>
      </el-radio-group>
    </div>

    <div v-if="!tasks.loaded" class="tc-state">
      <el-icon class="tc-state-ic"><Loading /></el-icon>
      <span>加载中…</span>
    </div>
    <div v-else-if="!filtered.length" class="tc-state">
      <el-icon class="tc-state-ic"><Box /></el-icon>
      <span>没有匹配的任务</span>
    </div>

    <div v-else-if="viewMode === 'board'" class="board">
      <div v-for="col in boardCols" :key="col.key" class="board-col">
        <div class="board-col-h">
          <span class="bc-dot" :style="{ background: colColor[col.key] }"></span>
          <el-tag size="small" :type="col.tag">{{ col.label }}</el-tag>
          <span class="ct">{{ col.items.length }}</span>
        </div>
        <div class="board-items">
          <TaskCard
            v-for="t in col.items" :key="t.id" :task="t"
            @config="openConfig" @run="onRun" @artifacts="openArtifacts"
          />
        </div>
      </div>
    </div>

    <template v-else>
      <div v-for="g in groupsToShow" :key="g.id" class="tg">
        <div class="tg-head" :class="{ open: !collapsed[g.id] }" @click="toggleGroup(g.id)">
          <span class="tg-ic" :style="{ '--tone': g.color }">
            <el-icon><component :is="groupIconOf(g.id)" /></el-icon>
          </span>
          <b>{{ g.name }}</b>
          <span class="sp" />
          <span class="ct">{{ groupItems(g.id).length }}</span>
          <el-icon class="tg-arw"><ArrowRight /></el-icon>
        </div>
        <div v-show="!collapsed[g.id]" class="tg-items">
          <TaskCard
            v-for="t in groupItems(g.id)" :key="t.id" :task="t"
            @config="openConfig" @run="onRun" @artifacts="openArtifacts"
          />
        </div>
      </div>
    </template>

    <TaskConfigDialog ref="cfgRef" />
  </div>
</template>

<script setup>
import { ref, computed, reactive } from 'vue';
import { useRoute } from 'vue-router';
import TaskCard from '../components/tasks/TaskCard.vue';
import TaskConfigDialog from '../components/tasks/TaskConfigDialog.vue';
import { useTasksStore } from '../stores/tasks.js';
import { useRunsStore } from '../stores/runs.js';
import { useArtifactStore } from '../stores/artifact.js';
import { useAppStore } from '../stores/app.js';
import { GROUP_ICONS } from '../utils/tokens.js';

const tasks = useTasksStore();
const runs = useRunsStore();
const artifact = useArtifactStore();
const app = useAppStore();
const route = useRoute();

const q = ref('');
const statusFilter = ref('all');
const groupFilter = ref(route.params.groupId || 'all');
const sortBy = ref('last');
const viewMode = ref('list');
const collapsed = reactive({});
const cfgRef = ref(null);

const isAll = computed(() => route.params.groupId == null);
const groupId = computed(() => route.params.groupId);
const groupName = computed(() => { const g = tasks.groupById(groupId.value); return g ? g.name : ''; });
const groupColor = computed(() => { const g = tasks.groupById(groupId.value); return g ? g.color : 'var(--brand)'; });
const headingIcon = computed(() => isAll.value ? 'Grid' : (GROUP_ICONS[groupId.value] || 'Grid'));
function groupIconOf(id) { return GROUP_ICONS[id] || 'Grid'; }
const colColor = { running: 'var(--warn)', queued: 'var(--warn)', success: 'var(--ok)', failed: 'var(--err)', none: 'var(--muted)' };

const filtered = computed(() => tasks.visibleTasks({
  group: isAll.value ? groupFilter.value : groupId.value,
  q: q.value,
  filter: sortBy.value === 'status' ? 'status' : sortBy.value === 'name' ? 'name' : null,
  sortDir: 'asc',
}));

const groupsToShow = computed(() => tasks.groups);
function groupItems(id) { return filtered.value.filter((t) => t.group === id); }

const boardCols = computed(() => {
  const order = [
    ['running', '运行中', 'warning'],
    ['queued', '排队中', 'warning'],
    ['success', '成功', 'success'],
    ['failed', '失败', 'danger'],
    ['none', '未运行', 'info'],
  ];
  return order.map(([key, label, tag]) => ({
    key, label, tag,
    items: filtered.value.filter((t) => (key === 'none' ? !t.status : (t.status || 'none') === key)),
  }));
});

function toggleGroup(id) { collapsed[id] = !collapsed[id]; }
function openConfig(id) { cfgRef.value?.open(id); }
function openArtifacts(id) { artifact.open(id); }
async function onRun(task) {
  try {
    await runs.run(task.id, tasks.args[task.id] || {});
    // 任务配置仅在本次运行中有效：运行一次后清空持久化参数，回到默认
    tasks.resetArgs(task.id);
    app.toast('已提交运行：' + task.name + '（配置已恢复默认）', 'success');
  } catch (e) {
    app.toast(e.message, 'error');
  }
}
</script>

<style scoped>
.tc-view { padding: var(--sp-20); }
.tc-heading { display: flex; align-items: center; gap: var(--sp-10); margin-bottom: var(--sp-16); }
.tc-heading-ic {
  display: inline-flex; align-items: center; justify-content: center;
  width: var(--sz-34); height: var(--sz-34);
  border-radius: var(--r-xl); background: var(--brand-soft);
}
.tc-heading-ic :deep(.el-icon) { font-size: 20px; }
.tc-heading h2 { margin: 0; font-size: var(--fs-title); font-weight: var(--fw-bold); }
.tc-sub { color: var(--muted); font-size: var(--fs-caption); }

.tc-toolbar {
  display: flex; align-items: center; gap: var(--sp-10); margin-bottom: var(--sp-16); flex-wrap: wrap;
  padding: var(--sp-10) var(--sp-12);
  background: var(--card); border: 1px solid var(--border); border-radius: var(--r-xl);
  box-shadow: var(--shadow-1);
}
.tc-toolbar .sp { flex: 1; }
.tc-viewmode :deep(.el-radio-button__inner) { display: inline-flex; align-items: center; gap: var(--sp-4); }

.tc-state { display: flex; flex-direction: column; align-items: center; gap: var(--sp-10); padding: var(--sp-48) var(--sp-40); text-align: center; color: var(--muted); }
.tc-state-ic { font-size: 32px; opacity: .5; }
.tc-state .tc-state-ic :deep(.el-icon) { font-size: 32px; }

.board { display: flex; gap: var(--sp-16); align-items: flex-start; overflow-x: auto; padding-bottom: var(--sp-8); }
.board-col { flex: 1; min-width: 300px; background: var(--surface-sunken); border: 1px solid var(--border-soft); border-radius: var(--r-xl); padding: var(--sp-12); }
.board-col-h { display: flex; align-items: center; gap: var(--sp-8); margin-bottom: var(--sp-10); }
.bc-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.board-col-h .ct { color: var(--muted); font-size: var(--fs-caption); margin-left: auto; }
.board-items { display: flex; flex-direction: column; gap: var(--sp-10); }

.tg { margin-bottom: var(--sp-8); }
.tg-head {
  display: flex; align-items: center; gap: var(--sp-10);
  padding: var(--sp-10) var(--sp-12);
  background: var(--card); border: 1px solid var(--border); border-radius: var(--r-xl);
  box-shadow: var(--shadow-1);
  cursor: pointer; user-select: none;
  transition: background var(--dur-base) ease, border-color var(--dur-base) ease;
}
.tg-head:hover { background: var(--surface-sunken); border-color: var(--border-soft); }
.tg-ic {
  display: inline-flex; align-items: center; justify-content: center;
  width: var(--sz-28); height: var(--sz-28); flex: none;
  border-radius: var(--r-md); background: var(--tone-soft, #eee); color: var(--tone, #666);
}
.tg-ic :deep(.el-icon) { font-size: 16px; }
.tg-head b { font-size: var(--fs-title-sm); font-weight: var(--fw-semibold); color: var(--text); }
.tg-head .sp { flex: 1; }
.tg-head .ct {
  font-size: var(--fs-caption); color: var(--muted);
  background: var(--surface-sunken); padding: 1px var(--sp-8); border-radius: var(--r-pill); min-width: 22px; text-align: center;
}
.tg-arw { color: var(--muted); transition: transform var(--dur-slower) ease; }
.tg-head.open .tg-arw { transform: rotate(90deg); }
.tg-items { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--sp-12); padding: var(--sp-12) 0; }

@media (max-width: 620px) {
  .tc-view { padding: var(--sp-12); }
  .board { flex-wrap: wrap; }
  .board-col { min-width: 100%; }
  .tg-items { grid-template-columns: 1fr; }
}
</style>
