<template>
  <div class="rbac">
    <div class="rbac-bar">
      <el-menu :default-active="activePath" mode="horizontal" router class="rbac-menu">
        <el-menu-item index="/settings/rbac/users">账号管理</el-menu-item>
        <el-menu-item index="/settings/rbac/roles">角色管理</el-menu-item>
        <el-menu-item index="/settings/rbac/policy">密码策略</el-menu-item>
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
  if (p.startsWith('/settings/rbac/users')) return '/settings/rbac/users';
  if (p.startsWith('/settings/rbac/roles')) return '/settings/rbac/roles';
  if (p.startsWith('/settings/rbac/policy')) return '/settings/rbac/policy';
  return '/settings/rbac/users';
});
</script>

<style scoped>
.rbac { display: flex; flex-direction: column; min-height: 100%; }
.rbac-bar { padding: var(--sp-12) var(--sp-20) 0; background: var(--el-bg-color); }
.rbac-menu { border-bottom: 1px solid var(--el-border-color); }
.rbac-menu :deep(.el-menu-item) { height: 44px; line-height: 44px; }
</style>
