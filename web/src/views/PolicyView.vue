<template>
  <div class="adm">
    <h2 class="v-title">密码策略</h2>

    <el-form label-width="160px" class="adm-form">
      <el-form-item label="最小长度"><el-input-number v-model="policy.min_length" :min="6" :max="64" /></el-form-item>
      <el-form-item label="最大长度"><el-input-number v-model="policy.max_length" :min="6" :max="128" /></el-form-item>
      <el-form-item label="要求大写"><el-switch v-model="policy.require_upper" /></el-form-item>
      <el-form-item label="要求小写"><el-switch v-model="policy.require_lower" /></el-form-item>
      <el-form-item label="要求数字"><el-switch v-model="policy.require_digit" /></el-form-item>
      <el-form-item label="要求符号"><el-switch v-model="policy.require_symbol" /></el-form-item>
      <el-form-item label="最大有效期(天)"><el-input-number v-model="policy.max_age_days" :min="0" :max="365" /></el-form-item>
      <el-form-item label="防复用"><el-switch v-model="policy.prevent_reuse" /></el-form-item>
      <el-form-item label="泄露筛查"><el-switch v-model="policy.breach_check" /></el-form-item>
      <el-form-item label="锁定尝试次数"><el-input-number v-model="policy.lockout_attempts" :min="1" :max="20" /></el-form-item>
      <el-form-item label="锁定分钟"><el-input-number v-model="policy.lockout_minutes" :min="1" :max="1440" /></el-form-item>
      <el-form-item label="允许粘贴"><el-switch v-model="policy.allow_paste" /></el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="savingPolicy" @click="savePolicy">保存策略</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useAppStore } from '../stores/app.js';
import { fetchPolicy, savePolicy as postPolicy } from '../api/dashboards.js';

const app = useAppStore();
const policy = reactive({});
const savingPolicy = ref(false);

async function loadPolicy() {
  try { const r = await fetchPolicy(); Object.assign(policy, r.policy || {}); } catch (e) { app.toast(e.message || '加载策略失败', 'error'); }
}
async function savePolicy() {
  savingPolicy.value = true;
  try { await postPolicy(policy); app.toast('策略已保存', 'success'); }
  catch (e) { app.toast(e.message || '保存失败', 'error'); }
  finally { savingPolicy.value = false; }
}
onMounted(loadPolicy);
</script>

<style scoped>
.adm { padding: var(--sp-20); }
.v-title { margin: 0 0 var(--sp-16); font-size: var(--el-font-size-extra-large); }
.adm-form { max-width: 520px; }
</style>
