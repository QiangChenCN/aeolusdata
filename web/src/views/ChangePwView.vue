<template>
  <div class="adm">
    <h2 class="v-title">个人改密</h2>

    <el-form label-width="120px" class="adm-form">
      <el-form-item label="旧密码"><el-input v-model="pw.old" type="password" show-password /></el-form-item>
      <el-form-item label="新密码"><el-input v-model="pw.next" type="password" show-password /></el-form-item>
      <el-form-item label="确认新密码">
        <el-input v-model="pw.confirm" type="password" show-password />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="savingPw" @click="doChangePw">提交</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useAppStore } from '../stores/app.js';
import { changePw } from '../api/dashboards.js';

const app = useAppStore();
const savingPw = ref(false);
const pw = reactive({ old: '', next: '', confirm: '' });

async function doChangePw() {
  if (pw.next !== pw.confirm) { app.toast('两次输入的新密码不一致', 'warning'); return; }
  savingPw.value = true;
  try { await changePw({ old_password: pw.old, new_password: pw.next }); app.toast('密码已修改', 'success'); pw.old = pw.next = pw.confirm = ''; }
  catch (e) { app.toast(e.message || '修改失败', 'error'); }
  finally { savingPw.value = false; }
}
</script>

<style scoped>
.adm { padding: var(--sp-20); }
.v-title { margin: 0 0 var(--sp-16); font-size: var(--el-font-size-extra-large); }
.adm-form { max-width: 520px; }
</style>
