<template>
  <el-dropdown trigger="click" @command="onCommand">
    <span class="user-chip">
      <span class="ui-dot ui-dot--ok"></span>
      <span class="uc-name">{{ auth.user || '未登录' }}</span>
      <span class="uc-role" v-if="auth.role">{{ roleLabel }}</span>
      <el-icon><ArrowDown /></el-icon>
    </span>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="logout" divided>
          <el-icon><SwitchButton /></el-icon> 退出登录
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup>
import { computed } from 'vue';
import { useAuthStore } from '../../stores/auth.js';
import { useAppStore } from '../../stores/app.js';

const auth = useAuthStore();
const app = useAppStore();
const roleLabel = computed(() => (auth.role === 'admin' ? '管理员' : '用户'));

function onCommand(cmd) {
  if (cmd === 'logout') {
    auth.signout().catch(() => {});
    app.toast('已退出登录', 'success');
  }
}
</script>

<style scoped>
.user-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-6);
  padding: var(--sp-4) var(--sp-10);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-pill);
  background: var(--white);
  cursor: pointer;
  font-size: var(--el-font-size-extra-small);
}
.uc-name { font-weight: var(--fw-semibold); color: var(--text); }
.uc-role { color: var(--brand); font-size: 11px; }
</style>
