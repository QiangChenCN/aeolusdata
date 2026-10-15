<template>
  <div class="assess">
    <div class="assess-bar">
      <el-menu :default-active="activePath" mode="horizontal" router class="assess-menu">
        <el-menu-item index="/assess/service">服务质量设置</el-menu-item>
        <el-menu-item index="/assess/standard">标准达成设置</el-menu-item>
      </el-menu>
    </div>
    <router-view v-slot="{ Component }">
      <component :is="Component" />
    </router-view>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const activePath = computed(() => {
  const p = route.path;
  if (p.startsWith('/assess/service')) return '/assess/service';
  if (p.startsWith('/assess/standard')) return '/assess/standard';
  return '/assess/service';
});
</script>

<style scoped>
.assess { display: flex; flex-direction: column; min-height: 100%; }
.assess-bar { padding: var(--sp-12) var(--sp-20) 0; background: var(--el-bg-color); }
.assess-menu { border-bottom: 1px solid var(--el-border-color); }
.assess-menu :deep(.el-menu-item) { height: 44px; line-height: 44px; }
</style>
