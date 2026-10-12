<template>
  <!-- 单一路由出口：登录页（独立全屏）与应用壳（MainLayout）均通过它渲染 -->
  <router-view v-slot="{ Component }">
    <component :is="Component" :key="route.fullPath" />
  </router-view>

  <!-- 全局浮层（登录页与应用壳下均挂载，按需使用） -->
  <ConfirmDialog />
  <LogDialog />
  <ArtifactBrowser />
  <RunDrawer />
</template>

<script setup>
import { onMounted, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';
import ConfirmDialog from './components/common/ConfirmDialog.vue';
import LogDialog from './components/common/LogDialog.vue';
import ArtifactBrowser from './components/common/ArtifactBrowser.vue';
import RunDrawer from './components/common/RunDrawer.vue';
import { useAuthStore, setLoginRedirector } from './stores/auth.js';
import { useTasksStore } from './stores/tasks.js';
import { useRunsStore } from './stores/runs.js';
import { useSse } from './composables/useSse.js';
import { useCookiePoll } from './composables/useCookiePoll.js';
import { setUnauthorizedHandler } from './api/request.js';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const tasks = useTasksStore();
const runs = useRunsStore();
const sse = useSse();
const cookiePoll = useCookiePoll();

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
    .catch((e) => ElMessage.error('加载任务失败：' + e.message));
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
