<template>
  <!-- 登录页：全屏独立页面，脱离 App 壳 -->
  <router-view v-if="isPublic" />

  <!-- 应用主壳：受保护页 -->
  <el-container v-else class="app-root">
    <el-header class="app-header" height="56px">
      <AppHeader />
    </el-header>
    <el-container class="app-body">
      <el-aside :width="app.sideOpen ? '248px' : '0'" class="app-aside">
        <AppSide />
      </el-aside>
      <el-main class="app-main">
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </el-main>
    </el-container>
  </el-container>

  <!-- 全局浮层（两类布局下均挂载，按需使用） -->
  <ConfirmDialog />
  <ToastHost />
  <LogDialog />
  <ArtifactBrowser />
  <RunDrawer />
</template>

<script setup>
import { computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppHeader from './components/layout/AppHeader.vue';
import AppSide from './components/layout/AppSide.vue';
import ConfirmDialog from './components/common/ConfirmDialog.vue';
import ToastHost from './components/common/ToastHost.vue';
import LogDialog from './components/common/LogDialog.vue';
import ArtifactBrowser from './components/common/ArtifactBrowser.vue';
import RunDrawer from './components/common/RunDrawer.vue';
import { useAuthStore, setLoginRedirector } from './stores/auth.js';
import { useAppStore } from './stores/app.js';
import { useTasksStore } from './stores/tasks.js';
import { useRunsStore } from './stores/runs.js';
import { useSse } from './composables/useSse.js';
import { useCookiePoll } from './composables/useCookiePoll.js';
import { setUnauthorizedHandler } from './api/request.js';
import { useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const app = useAppStore();
const tasks = useTasksStore();
const runs = useRunsStore();
const sse = useSse();
const cookiePoll = useCookiePoll();

const isPublic = computed(() => route.meta && route.meta.public === true);

// 当前路由非登录页时，401 / 退出登录 → 重定向到登录页并保留来源
setLoginRedirector(() => {
  if (route.name === 'login') return;
  const target = route.fullPath && route.fullPath !== '/' ? route.fullPath : null;
  router.replace(target ? { path: '/login', query: { redirect: target } } : { path: '/login' });
});
// 任意请求 401 时由 request 层调用 → 触发上面的重定向
setUnauthorizedHandler(() => auth.requireLogin());

function startServices() {
  tasks.loadState()
    .then((state) => runs.applyState(state))
    .catch((e) => app.toast('加载任务失败：' + e.message, 'error'));
  tasks.loadTeams();
  sse.connect();
  cookiePoll.start();
}
function stopServices() {
  sse.stop();
  cookiePoll.stop();
}

onMounted(() => { auth.bootstrap(); });

// immediate：刷新进入时登录态可能已由守卫填充完毕，此时 watcher 注册后不会再触发变化，
// 不加 immediate 会导致任务/事件流等后台服务始终不启动（页面空白、无数据）。
watch(
  () => auth.authenticated,
  (ok) => { if (ok) startServices(); else stopServices(); },
  { immediate: true },
);
</script>

<style scoped>
.app-root { height: 100%; }
.app-header { padding: 0; background: var(--white); border-bottom: 1px solid var(--border); }
.app-body { height: calc(100% - 56px); }
.app-aside {
  background: var(--surface-sunken);
  border-right: 1px solid var(--border);
  transition: width 0.18s ease;
  overflow: hidden;
}
.app-main { padding: 0; background: var(--bg); overflow: auto; }
</style>
