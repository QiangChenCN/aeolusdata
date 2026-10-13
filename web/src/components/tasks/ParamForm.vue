<template>
  <div class="param-form">
    <el-form label-position="top" v-if="params.length">
      <el-form-item v-for="p in params" :key="p.flag">
        <template #label>
          <span class="pf-label">
            <el-icon class="pf-ic"><component :is="paramIcon(p)" /></el-icon>
            {{ p.label + (p.required ? ' *' : '') }}
          </span>
        </template>
        <el-switch v-if="p.type === 'switch'" v-model="form[p.flag]" />
        <el-select
          v-else-if="p.type === 'select'"
          v-model="form[p.flag]" :placeholder="p.placeholder || '请选择'" style="width: 100%"
        >
          <el-option v-for="o in optionsOf(p)" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-select
          v-else-if="p.type === 'multi-team'"
          v-model="form[p.flag]" multiple filterable :placeholder="'选择站点'"
          style="width: 100%"
        >
          <el-option v-for="tm in teamsList" :key="tm.value" :label="tm.label" :value="tm.value" />
        </el-select>
        <el-input v-else-if="p.type === 'group'" v-model="form[p.flag]" :placeholder="p.placeholder || '群 gid 或名称'" />
        <el-date-picker
          v-else-if="p.type === 'date'"
          v-model="form[p.flag]" type="date" value-format="YYYY-MM-DD"
          :placeholder="p.placeholder || '选择日期'" style="width: 100%"
        />
        <DateRangePicker v-else-if="p.type === 'daterange'" v-model="form[p.flag]" />
        <el-input v-else-if="p.type === 'textarea'" v-model="form[p.flag]" type="textarea" :rows="3" :placeholder="p.placeholder || ''" />
        <el-input v-else v-model="form[p.flag]" :placeholder="p.placeholder || ''" />
      </el-form-item>
    </el-form>
    <div v-else class="pf-empty">
      <el-icon><Box /></el-icon>
      <span>这个任务没有可配置的参数</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useTasksStore } from '../../stores/tasks.js';
import DateRangePicker from './DateRangePicker.vue';

const props = defineProps({
  task: { type: Object, required: true },
  form: { type: Object, required: true },
  params: { type: Array, default: () => [] },
});

const tasks = useTasksStore();

function optionsOf(p) {
  if (p.options_source === 'nodes' && props.task && Array.isArray(props.task.nodes)) {
    return props.task.nodes.map((n) => ({ value: n.id, label: n.name }));
  }
  return p.options || [];
}

function paramIcon(p) {
  const map = {
    switch: 'Switch', select: 'List', 'multi-team': 'Connection',
    group: 'ChatDotRound', date: 'Calendar', daterange: 'DateRange',
    textarea: 'Document', text: 'EditPen', number: 'EditPen',
  };
  return map[p.type] || 'EditPen';
}

const teamsList = computed(() =>
  ((tasks.teams && tasks.teams.teams) || []).map((t) => ({ value: t.id + '=' + t.name, label: t.name })));
</script>

<style scoped>
.param-form { padding: var(--sp-4) 0; }
.pf-label { display: inline-flex; align-items: center; gap: var(--sp-6); color: var(--el-text-color-regular); font-weight: var(--fw-medium); }
.pf-ic { color: var(--el-text-color-regular); font-size: 15px; }

.pf-empty {
  display: flex; flex-direction: column; align-items: center; gap: var(--sp-8);
  padding: var(--sp-32) var(--sp-20); color: var(--el-text-color-secondary);
}
.pf-empty :deep(.el-icon) { font-size: 30px; opacity: .55; }
</style>
