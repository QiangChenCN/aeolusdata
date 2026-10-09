<template>
  <div class="toast-host">
    <transition-group name="toast">
      <div v-for="t in app.toasts" :key="t.id" class="toast" :class="'toast--' + t.type">
        {{ t.message }}
      </div>
    </transition-group>
  </div>
</template>

<script setup>
import { useAppStore } from '../../stores/app.js';
const app = useAppStore();
</script>

<style scoped>
.toast-host {
  position: fixed;
  top: calc(56px + 8px); /* 紧贴 header 栏底部并留出 8px 间隙 */
  left: 50%;
  transform: translateX(-50%);
  z-index: 4000;
  display: flex;
  flex-direction: column;
  gap: var(--sp-10);
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  padding: var(--sp-10) var(--sp-16);
  border-radius: var(--r-lg);
  background: var(--surface-overlay);
  color: var(--text);
  box-shadow: var(--shadow-3);
  font-size: var(--el-font-size-base);
  max-width: 360px;
}
.toast--success { border-bottom: 3px solid var(--ok); }
.toast--error { border-bottom: 3px solid var(--err); }
.toast--info { border-bottom: 3px solid var(--info); }
.toast--warning { border-bottom: 3px solid var(--warn); }
.toast-enter-active, .toast-leave-active { transition: all 0.25s ease; }
/* 出现：从 header 向下滑入；消失：向上缩回 header */
.toast-enter-from { opacity: 0; transform: translateY(-12px); }
.toast-leave-to { opacity: 0; transform: translateY(-12px); }
</style>
