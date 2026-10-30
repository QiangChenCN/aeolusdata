<template>
  <el-container class="app-root">
    <el-header class="app-header" height="56px">
      <AppHeader @toggle-nav="onToggleNav" />
    </el-header>
    <el-container class="app-body">
      <!-- 桌面端：保留可手风琴折叠的内嵌侧栏 -->
      <el-aside v-if="!isCompact" :width="app.sideOpen ? '200px' : '64px'" class="app-aside" :class="{ 'is-collapsed': !app.sideOpen }">
        <AppSide @toggle-nav="onToggleNav" />
      </el-aside>
      <!-- 紧凑布局（≤992）：侧栏改为覆盖式抽屉，由顶栏汉堡按钮唤起 -->
      <el-drawer
        v-if="isCompact"
        v-model="drawerOpen"
        :with-header="false"
        direction="ltr"
        size="200px"
        class="app-side-drawer"
      >
        <AppSide @toggle-nav="onToggleNav" />
      </el-drawer>
      <el-container class="app-content">
        <el-main class="app-main">
          <div class="app-main-inner">
            <router-view v-slot="{ Component }">
              <component :is="Component" :key="route.fullPath" />
            </router-view>
          </div>
        </el-main>
        <el-footer class="app-footer" height="40px">
          <span>Aeolus WorkBench</span>
          <span class="app-footer-sep">·</span>
          <span>© 2026 内部工具，仅供团队使用</span>
        </el-footer>
      </el-container>
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
/* 内容区满宽：底栏因此横跨整屏、不受 1440 限制；主内容的 1440 上限/下限与居中改由内层 .app-main-inner 控制 */
.app-content { flex: 1; height: 100%; }
.app-aside {
  background: var(--el-fill-color-light);
  border-right: 1px solid var(--el-border-color);
  transition: width 0.18s ease;
  overflow: hidden;
}
.app-main { padding: 0; background: var(--el-bg-color-page); overflow: auto; }
/* 主内容内层：铺满主区剩余空间，不再限制 1440 上下限 */
.app-main-inner { margin: 0 auto; height: 100%; }
.app-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-8);
  padding: 0 var(--sp-16);
  font-size: var(--el-font-size-extra-small);
  color: var(--el-text-color-secondary);
  background: var(--el-bg-color);
  border-top: 1px solid var(--el-border-color);
}
.app-footer-sep { opacity: 0.5; }
</style>
