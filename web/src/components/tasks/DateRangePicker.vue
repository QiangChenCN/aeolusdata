<template>
  <div class="drp">
    <el-date-picker
      :model-value="begin" type="date" value-format="YYYY-MM-DD"
      placeholder="开始日期" style="flex: 1" @update:model-value="onBegin"
    />
    <span class="drp-sep">~</span>
    <el-date-picker
      :model-value="end" type="date" value-format="YYYY-MM-DD"
      placeholder="结束日期" style="flex: 1" @update:model-value="onEnd"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({ modelValue: { type: String, default: '' } });
const emit = defineEmits(['update:modelValue']);

const parts = computed(() => (props.modelValue || '').split('~'));
const begin = computed(() => parts.value[0] || '');
const end = computed(() => parts.value[1] || '');

function onBegin(v) { emit('update:modelValue', (v || '') + '~' + end.value); }
function onEnd(v) { emit('update:modelValue', begin.value + '~' + (v || '')); }
</script>

<style scoped>
.drp { display: flex; align-items: center; gap: var(--sp-8); width: 100%; }
.drp-sep {
  flex: none; color: var(--el-text-color-secondary); font-size: var(--el-font-size-extra-small);
  padding: 2px var(--sp-6); border-radius: var(--r-pill);
  background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter);
}
</style>
