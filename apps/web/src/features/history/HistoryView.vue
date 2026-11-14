<template>
  <div class="hist">
    <div class="hist-bar">
      <h2 class="v-title">运行记录</h2>
      <span class="v-sub">最近 30 条执行记录，点击可回看日志或查看详情</span>
      <span class="sp" />
      <el-button size="small" type="danger" plain @click="onClearAll">
        <el-icon><Delete /></el-icon> 清空记录
      </el-button>
      <el-button size="small" :loading="loading" @click="load">
        <el-icon><Refresh /></el-icon> 刷新
      </el-button>
    </div>

    <el-table :data="rows" stripe class="hist-table" empty-text="暂无运行记录">
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="statusTag(row.status)">{{ STATUS_TXT[row.status] || row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="name" label="任务" min-width="180" show-overflow-tooltip />
      <el-table-column label="分组" width="140">
        <template #default="{ row }">{{ groupName(row.group) }}</template>
      </el-table-column>
      <el-table-column prop="start" label="开始时间" width="170" />
      <el-table-column label="耗时" width="90">
        <template #default="{ row }">{{ row.duration }}s</template>
      </el-table-column>
      <el-table-column label="退出码" width="80">
        <template #default="{ row }">{{ row.exit_code == null ? '—' : row.exit_code }}</template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openLog(row)">日志</el-button>
          <el-button link type="primary" size="small" @click="openDrawer(row)">详情</el-button>
          <el-button link type="danger" size="small" @click="onDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRunsStore } from '../../stores/runs.js';
import { useTasksStore } from '../../stores/tasks.js';

import { useDrawerStore } from '../../stores/drawer.js';
import { fetchHistory } from '../../api/dashboards.js';
import { STATUS_TXT } from '../../utils/tokens.js';

const runs = useRunsStore();
const tasks = useTasksStore();

const drawer = useDrawerStore();

const rows = ref([]);
const loading = ref(false);

function statusTag(s) {
  return s === 'success' ? 'success' : s === 'failed' ? 'danger'
    : s === 'running' ? 'warning' : s === 'stopped' ? 'info'
    : s === 'queued' ? 'warning' : 'info';
}
function groupName(g) { const x = tasks.groupById(g); return x ? x.name : g; }
function openLog(h) { runs.openLog(h.run_id); }
function openDrawer(h) { drawer.open(h); }

async function onDelete(h) {
  try {
    await ElMessageBox.confirm(`确定删除「${h.name || h.task_id}」这条运行记录吗？日志文件将一并删除。`, '删除运行记录', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch { return; }
  try {
    await runs.deleteRun(h.run_id);
    ElMessage.success('已删除');
    load();
  } catch (e) {
    ElMessage.error(e.message || '删除失败');
  }
}

async function onClearAll() {
  try {
    await ElMessageBox.confirm('确定清空全部运行记录吗？对应日志文件将一并删除。', '清空运行记录', {
      confirmButtonText: '清空',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch { return; }
  try {
    await runs.clearAllHistory();
    ElMessage.success('已清空');
    load();
  } catch (e) {
    ElMessage.error(e.message || '清空失败');
  }
}

async function load() {
  loading.value = true;
  try {
    const res = await fetchHistory();
    const list = (res && res.history) || [];
    rows.value = list;
    runs.history = list;
  } catch (e) {
    ElMessage.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<style scoped>
.hist { padding: var(--sp-20); }
.hist-bar { display: flex; align-items: baseline; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.v-sub { color: var(--el-text-color-secondary); font-size: var(--el-font-size-base); }
.hist-bar .sp { flex: 1; }
.hist-table { border-radius: var(--el-border-radius-base); overflow: hidden; }
</style>
