<template>
  <el-dropdown trigger="click" @command="onCommand">
    <span class="uc-trigger">
      <el-avatar class="uc-avatar" size="small">
        <template v-if="auth.user">{{ auth.user.charAt(0).toUpperCase() }}</template>
        <el-icon v-else><User /></el-icon>
      </el-avatar>
      <span class="uc-meta">
        <span class="uc-name">{{ auth.user || '未登录' }}</span>
        <span class="uc-role" v-if="auth.role">{{ roleLabel }}</span>
      </span>
      <el-icon class="uc-arrow"><ArrowDown /></el-icon>
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

const auth = useAuthStore();
const roleLabel = computed(() => (auth.role === 'admin' ? '管理员' : '用户'));

function onCommand(cmd) {
  if (cmd === 'logout') {
    auth.signout().catch(() => {});
    ElMessage.success('已退出登录');
  }
}
</script>

<style scoped>
.uc-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-12);
  padding: var(--sp-4) var(--sp-10);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--r-pill);
  background: var(--el-bg-color);
  cursor: pointer;
  outline: none;
}
.uc-trigger:hover { border-color: var(--el-color-primary); }
.uc-avatar {
  flex: none;
  background-color: var(--el-color-primary);
  color: #fff;
}
.uc-meta {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
  text-align: left;
}
.uc-name {
  font-weight: var(--fw-semibold);
  color: var(--el-text-color-primary);
  font-size: var(--el-font-size-small);
}
.uc-role { color: var(--el-color-primary); font-size: 11px; }
.uc-arrow { margin-left: var(--sp-4); color: var(--el-text-color-secondary); }
</style>
