<template>
  <el-dialog
    v-model="visible"
    :title="confirm ? confirm.title || '请确认' : '请确认'"
    :width="380"
    append-to-body
  >
    <p class="cf-msg">{{ confirm ? confirm.message : '' }}</p>
    <template #footer>
      <el-button @click="cancel">{{ confirm ? confirm.cancelText || '取消' : '取消' }}</el-button>
      <el-button type="primary" @click="ok">{{ confirm ? confirm.okText || '确定' : '确定' }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed } from 'vue';
import { useAppStore } from '../../stores/app.js';

const app = useAppStore();
const confirm = computed(() => app.confirm);
const visible = computed({
  get: () => !!app.confirm,
  set: (v) => { if (!v) app.resolveConfirm(false); },
});
function ok() { app.resolveConfirm(true); }
function cancel() { app.resolveConfirm(false); }
</script>

<style scoped>
.cf-msg { margin: 0; color: var(--text-body); line-height: var(--lh-base); }
</style>
