<template>
  <div class="bot">
    <div class="bot-bar">
      <el-menu :default-active="activePath" mode="horizontal" router class="bot-menu">
        <el-menu-item index="/bot/global">全局配置</el-menu-item>
        <el-menu-item index="/bot/robot">凭证配置</el-menu-item>
        <el-menu-item index="/bot/instance">实例配置</el-menu-item>
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
  if (p.startsWith('/bot/global')) return '/bot/global';
  if (p.startsWith('/bot/robot')) return '/bot/robot';
  if (p.startsWith('/bot/instance')) return '/bot/instance';
  return '/bot/global';
});
</script>

<style scoped>
.bot { display: flex; flex-direction: column; min-height: 100%; }
.bot-bar { padding: var(--sp-12) var(--sp-20) 0; background: var(--el-bg-color); }
.bot-menu { border-bottom: 1px solid var(--el-border-color); }
.bot-menu :deep(.el-menu-item) { height: 44px; line-height: 44px; }
</style>
