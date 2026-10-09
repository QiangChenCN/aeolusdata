<template>
  <span class="capsule" :title="title">
    <span class="ui-dot" :class="'ui-dot--' + dot"></span>
    <span class="cap-label">{{ label }}</span>
    <span class="cap-text">{{ text }}</span>
  </span>
</template>

<script setup>
defineProps({
  label: { type: String, default: '' },
  dot: { type: String, default: 'muted' },   // ok | err | warn | info | muted
  text: { type: String, default: '' },
  title: { type: String, default: '' },
});
</script>

<style scoped>
.capsule {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  padding: var(--sp-4) var(--sp-10);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-pill);
  background: var(--white);
  font-size: var(--el-font-size-extra-small);
  line-height: 1;
  white-space: nowrap;
}
.cap-label { color: var(--muted); }
.cap-text { color: var(--text); font-weight: var(--fw-semibold); }
</style>
