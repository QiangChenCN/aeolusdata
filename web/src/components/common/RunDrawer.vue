<template>
  <el-drawer v-model="visible" :title="'运行详情'" size="420px" direction="rtl" append-to-body>
    <div v-if="entry" class="rd">
      <div class="rd-head">
        <el-tag :type="statusTag(entry.status)">{{ STATUS_TXT[entry.status] || entry.status }}</el-tag>
        <span class="rd-name">{{ entry.name }}</span>
      </div>

      <el-descriptions :column="1" border size="small" class="rd-desc">
        <el-descriptions-item label="运行 ID">{{ entry.run_id }}</el-descriptions-item>
        <el-descriptions-item label="分组">{{ groupName }}</el-descriptions-item>
        <el-descriptions-item label="开始时间">{{ entry.start }}</el-descriptions-item>
        <el-descriptions-item label="耗时">{{ entry.duration }} 秒</el-descriptions-item>
        <el-descriptions-item label="退出码">{{ entry.exit_code == null ? '—' : entry.exit_code }}</el-descriptions-item>
      </el-descriptions>

      <div v-if="entry.error_kind" class="rd-err">
        <b>诊断：{{ entry.error_kind }}</b>
        <p>{{ entry.error_advice }}</p>
      </div>

      <div class="rd-actions">
        <el-button type="primary" @click="viewLog">
          <el-icon><Document /></el-icon> 查看日志
        </el-button>
      </div>
    </div>
  </el-drawer>
</template>

<script setup>
import { computed } from 'vue';
import { useDrawerStore } from '../../stores/drawer.js';
import { useRunsStore } from '../../stores/runs.js';
import { useTasksStore } from '../../stores/tasks.js';
import { STATUS_TXT } from '../../utils/tokens.js';

const drawer = useDrawerStore();
const runs = useRunsStore();
const tasks = useTasksStore();

const visible = computed({
  get: () => drawer.visible,
  set: (v) => { if (!v) drawer.close(); },
});
const entry = computed(() => drawer.entry);
const groupName = computed(() => {
  const e = entry.value;
  if (!e) return '';
  const g = tasks.groupById(e.group);
  return g ? g.name : e.group;
});
function statusTag(s) {
  return s === 'success' ? 'success' : s === 'failed' ? 'danger'
    : s === 'running' ? 'warning' : s === 'stopped' ? 'info' : s === 'queued' ? 'warning' : 'info';
}
function viewLog() {
  if (entry.value) runs.openLog(entry.value.run_id);
  drawer.close();
}
</script>

<style scoped>
.rd { display: flex; flex-direction: column; gap: var(--sp-16); }
.rd-head { display: flex; align-items: center; gap: var(--sp-10); }
.rd-name { font-weight: var(--fw-bold); font-size: var(--el-font-size-medium); }
.rd-err {
  background: var(--brand-soft); border-radius: var(--r-md); padding: var(--sp-12);
  color: var(--text);
}
.rd-err p { margin: var(--sp-6) 0 0; color: var(--muted); font-size: var(--el-font-size-base); }
.rd-actions { margin-top: var(--sp-8); }
</style>
