<template>
  <el-container class="app-root">
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

    <!-- 全局浮层 -->
    <LoginDialog />
    <ConfirmDialog />
    <ToastHost />
    <LogDialog />
    <ArtifactBrowser />
    <RunDrawer />
  </el-container>
</template>

<script setup>
import { onMounted, watch } from 'vue';
import AppHeader from './components/layout/AppHeader.vue';
import AppSide from './components/layout/AppSide.vue';
import LoginDialog from './components/common/LoginDialog.vue';
import ConfirmDialog from './components/common/ConfirmDialog.vue';
import ToastHost from './components/common/ToastHost.vue';
import LogDialog from './components/common/LogDialog.vue';
import ArtifactBrowser from './components/common/ArtifactBrowser.vue';
import RunDrawer from './components/common/RunDrawer.vue';
import { useAuthStore } from './stores/auth.js';
import { useAppStore } from './stores/app.js';
import { useTasksStore } from './stores/tasks.js';
import { useRunsStore } from './stores/runs.js';
import { useSse } from './composables/useSse.js';
import { useCookiePoll } from './composables/useCookiePoll.js';
import { setUnauthorizedHandler } from './api/request.js';

const auth = useAuthStore();
const app = useAppStore();
const tasks = useTasksStore();
const runs = useRunsStore();
const sse = useSse();
const cookiePoll = useCookiePoll();

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

watch(
  () => auth.authenticated,
  (ok) => { if (ok) startServices(); else stopServices(); },
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
