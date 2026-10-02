<template>
  <el-dialog v-model="visible" width="560px" top="6vh" append-to-body @open="build">
    <template #header>
      <div class="cfg-hd">
        <span class="cfg-hd-ic"><el-icon><Setting /></el-icon></span>
        <div class="cfg-hd-txt">
          <span class="cfg-hd-title">{{ task?.name || '配置' }}</span>
          <span class="cfg-hd-sub">调整该任务的运行参数后保存</span>
        </div>
      </div>
    </template>
    <ParamForm v-if="task" :task="task" :form="form" :params="params" />
    <template #footer>
      <el-button @click="reset"><el-icon><Refresh /></el-icon>恢复默认</el-button>
      <el-button @click="visible = false"><el-icon><Close /></el-icon>取消</el-button>
      <el-button type="primary" @click="save"><el-icon><Check /></el-icon>保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue';
import ParamForm from './ParamForm.vue';
import { useTasksStore } from '../../stores/tasks.js';
import { useAppStore } from '../../stores/app.js';

const tasks = useTasksStore();
const app = useAppStore();

const visible = ref(false);
const task = ref(null);
const form = ref({});
const params = computed(() =>
  (task.value?.params || []).filter((p) => p.flag !== '--begin' && p.flag !== '--end'));

function open(taskId) {
  const t = tasks.taskById(taskId);
  if (!t) return;
  task.value = t;
  build();
  visible.value = true;
}

function build() {
  const t = task.value;
  const f = {};
  (t.params || []).forEach((p) => {
    if (p.flag === '--begin' || p.flag === '--end') return;
    let v = tasks.argValue(t.id, p.flag, p.default);
    if (p.type === 'switch') v = !!v;
    else if (p.type === 'multi-team') v = v ? String(v).split(',').filter(Boolean) : [];
    else v = v == null ? '' : String(v);
    f[p.flag] = v;
  });
  form.value = f;
}

function save() {
  const t = task.value;
  (t.params || []).forEach((p) => {
    if (p.flag === '--begin' || p.flag === '--end') return;
    let v = form.value[p.flag];
    if (p.type === 'multi-team') v = (v || []).join(',');
    if (p.type === 'switch') v = !!v;
    tasks.setArg(t.id, p.flag, v);
  });
  app.toast('已保存配置', 'success');
  visible.value = false;
}

function reset() { build(); app.toast('已恢复默认（未保存）', 'info'); }

defineExpose({ open });
</script>

<style scoped>
.cfg-hd { display: flex; align-items: center; gap: var(--sp-12); }
.cfg-hd-ic {
  display: inline-flex; align-items: center; justify-content: center;
  width: var(--sz-36); height: var(--sz-36); flex: none;
  border-radius: var(--r-xl); background: var(--brand-soft); color: var(--brand);
}
.cfg-hd-ic :deep(.el-icon) { font-size: 19px; }
.cfg-hd-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cfg-hd-title { font-size: var(--fs-title-lg); font-weight: var(--fw-semibold); color: var(--text); }
.cfg-hd-sub { font-size: var(--fs-caption); color: var(--muted); }

:deep(.el-dialog__footer .el-button) { display: inline-flex; align-items: center; gap: var(--sp-4); }
</style>
