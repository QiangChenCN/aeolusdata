<template>
  <el-dialog
    v-model="visible"
    title="登录工作台"
    :width="360"
    :close-on-click-modal="false"
    :close-on-press-escape="!auth.loginForced"
    :show-close="!auth.loginForced"
    append-to-body
  >
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item label="用户名">
        <el-input v-model="username" autofocus :disabled="loading" />
      </el-form-item>
      <el-form-item label="密码">
        <el-input
          v-model="password" type="password" show-password
          :disabled="loading" @keyup.enter="submit"
        />
      </el-form-item>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    </el-form>
    <template #footer>
      <el-button type="primary" :loading="loading" @click="submit">登录</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useAuthStore } from '../../stores/auth.js';

const auth = useAuthStore();
const visible = computed({
  get: () => auth.loginVisible,
  set: (v) => { if (!v && !auth.loginForced) auth.loginVisible = false; },
});
const username = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');

async function submit() {
  error.value = '';
  if (!username.value || !password.value) { error.value = '请输入用户名和密码'; return; }
  loading.value = true;
  try {
    await auth.signin(username.value, password.value);
  } catch (e) {
    error.value = e.message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>
