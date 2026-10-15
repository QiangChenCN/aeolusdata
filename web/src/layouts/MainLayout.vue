<template>
  <el-container class="app-root">
    <el-header class="app-header" height="56px">
      <AppHeader @toggle-nav="onToggleNav" />
    </el-header>
    <el-container class="app-body">
      <!-- 桌面端：保留可手风琴折叠的内嵌侧栏 -->
      <el-aside v-if="!isCompact" :width="app.sideOpen ? '248px' : '0'" class="app-aside">
        <AppSide />
      </el-aside>
      <!-- 紧凑布局（≤992）：侧栏改为覆盖式抽屉，由顶栏汉堡按钮唤起 -->
      <el-drawer
        v-if="isCompact"
        v-model="drawerOpen"
        :with-header="false"
        direction="ltr"
        size="248px"
        class="app-side-drawer"
      >
        <AppSide />
      </el-drawer>
      <el-main class="app-main">
        <router-view v-slot="{ Component }">
          <component :is="Component" :key="route.fullPath" />
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppHeader from '../components/layout/AppHeader.vue';
import AppSide from '../components/layout/AppSide.vue';
import { useAppStore } from '../stores/app.js';
import { useBreakpoint } from '../composables/useBreakpoint.js';

const route = useRoute();
const app = useAppStore();
const { isCompact } = useBreakpoint();

// 紧凑布局下用抽屉承载侧栏；桌面端仍走 app.sideOpen 手风琴折叠
const drawerOpen = ref(false);
function onToggleNav() {
  if (isCompact.value) drawerOpen.value = !drawerOpen.value;
  else app.toggleSide();
}
// 路由切换 / 回到桌面宽度时自动收起抽屉，避免覆盖内容
watch(() => route.fullPath, () => { if (isCompact.value) drawerOpen.value = false; });
watch(isCompact, (v) => { if (!v) drawerOpen.value = false; });
</script>

<style scoped>
.app-root { height: 100%; }
.app-header { padding: 0; background: var(--el-bg-color); border-bottom: 1px solid var(--el-border-color); }
.app-body { height: calc(100% - 56px); }
.app-aside {
  background: var(--el-fill-color-light);
  border-right: 1px solid var(--el-border-color);
  transition: width 0.18s ease;
  overflow: hidden;
}
.app-main { padding: 0; background: var(--el-bg-color-page); overflow: auto; }
</style>
