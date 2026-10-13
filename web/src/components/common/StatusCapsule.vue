<template>
  <el-tag
    class="cap"
    :type="tagType"
    :size="size"
    effect="plain"
    :title="title"
  >
    <span class="ui-dot" :class="'ui-dot--' + dot"></span>
    <span v-if="label" class="cap-label">{{ label }}</span>
    <span v-if="text" class="cap-text">{{ text }}</span>
  </el-tag>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  label: { type: String, default: '' },
  dot: { type: String, default: 'muted' },   // ok | err | warn | info | muted
  text: { type: String, default: '' },
  title: { type: String, default: '' },
  size: { type: String, default: 'default' },  // small | default | large（交给 Element 控制字号）
});

// 把圆点语义映射到 el-tag 的 type，让边框/底色也带状态色
const tagType = computed(() => {
  switch (props.dot) {
    case 'ok': return 'success';
    case 'err': return 'danger';
    case 'warn': return 'warning';
    case 'info':
    case 'muted':
    default: return 'info';
  }
});
</script>

<style scoped>
.cap {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  border-radius: var(--r-pill);
}
.cap-label { color: var(--el-text-color-secondary); }
.ui-dot + .cap-label { margin-left: var(--sp-4); }
.cap-label + .cap-text { margin-left: var(--sp-4); }
.cap-text { font-weight: var(--fw-semibold); }
</style>
