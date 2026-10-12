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
          <component :is="Component" :key="route.fullPath" />
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { useRoute } from 'vue-router';
import AppHeader from '../components/layout/AppHeader.vue';
import AppSide from '../components/layout/AppSide.vue';
import { useAppStore } from '../stores/app.js';

const route = useRoute();
const app = useAppStore();
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
