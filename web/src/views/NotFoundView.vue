<script setup>
import { useRouter } from 'vue-router';
const router = useRouter();
</script>

<template>
  <div class="nf">
    <div class="nf-code">404</div>
    <div class="nf-title">页面不存在</div>
    <div class="nf-desc">你访问的地址不存在或已被移除。</div>
    <el-button type="primary" @click="router.push('/')">返回首页</el-button>
  </div>
</template>

<style scoped>
.nf {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-12);
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  text-align: center;
  padding: var(--sp-24);
}
.nf-code {
  font-size: 96px;
  font-weight: var(--fw-bold);
  line-height: 1;
  color: var(--el-color-primary);
}
.nf-title { font-size: 22px; font-weight: var(--fw-bold); }
.nf-desc { color: var(--el-text-color-secondary); margin-bottom: var(--sp-12); }
</style>
