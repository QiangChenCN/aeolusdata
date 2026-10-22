<template>
  <div class="preset">
    <div class="preset-bar">
      <h2 class="v-title">预设</h2>
      <span class="v-sub">以默认/已保存参数一键执行常用任务，详细配置请前往任务中心</span>
      <span class="sp" />
      <el-button size="small" @click="goTasks">前往任务中心</el-button>
    </div>

    <div v-if="!tasks.tasks.length" class="preset-state">暂无任务，请先在任务中心加载</div>
    <div class="preset-grid">
      <el-card v-for="t in tasks.tasks" :key="t.id" class="preset-card" shadow="hover">
        <div class="preset-card-h">
          <span class="preset-group" :style="groupStyle(t.group)">{{ groupName(t.group) }}</span>
          <span class="preset-name">{{ t.name }}</span>
        </div>
        <div class="preset-card-f">
          <el-button size="small" type="primary" :loading="runningId === t.id" @click="runTask(t)">运行</el-button>
          <el-button size="small" @click="goConfig(t)">配置</el-button>
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useTasksStore } from '../../stores/tasks.js';
import { useRunsStore } from '../../stores/runs.js';


const router = useRouter();
const tasks = useTasksStore();
const runs = useRunsStore();

const runningId = ref('');

function groupName(g) { const x = tasks.groupById(g); return x ? x.name : g; }
function groupStyle(g) {
  const x = tasks.groupById(g);
  return x && x.color ? { background: x.color + '22', color: x.color, borderColor: x.color + '55' } : {};
}
function goTasks() { router.push('/tasks'); }
function goConfig(t) { router.push('/tasks'); }

async function runTask(t) {
  runningId.value = t.id;
  try {
    const args = (tasks.args && tasks.args[t.id]) || {};
    await runs.run(t.id, args);
    // 任务配置仅在本次运行中有效：运行一次后清空持久化参数，回到默认
    tasks.resetArgs(t.id);
    ElMessage.success('已启动：' + t.name + '（配置已恢复默认）');
  } catch (e) { ElMessage.error(e.message || '启动失败'); }
  finally { runningId.value = ''; }
}
</script>

<style scoped>
.preset { padding: var(--sp-20); }
.preset-bar { display: flex; align-items: baseline; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.v-sub { color: var(--el-text-color-secondary); font-size: var(--el-font-size-base); }
.preset-bar .sp { flex: 1; }
.preset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--sp-12); }
.preset-card { margin-bottom: 0; }
.preset-card-h { display: flex; flex-direction: column; gap: var(--sp-6); margin-bottom: var(--sp-12); }
.preset-group { align-self: flex-start; font-size: var(--el-font-size-extra-small); border: 1px solid var(--el-border-color-lighter); border-radius: var(--el-border-radius-base); padding: 1px var(--sp-8); }
.preset-name { font-weight: var(--fw-semibold); font-size: var(--el-font-size-medium); }
.preset-card-f { display: flex; gap: var(--sp-8); }
.preset-state { padding: var(--sp-40); text-align: center; color: var(--el-text-color-secondary); }
</style>
