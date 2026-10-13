<template>
  <div class="ae">
    <h2 class="v-title">风神设置</h2>

    <el-card class="blk" shadow="never">
      <template #header>
        <span class="blk-h">账号设置</span>
      </template>

      <!-- 当前配置账号信息 -->
      <div class="status" :class="statusClass">
        <span class="st-dot"></span>
        <span v-if="masked.source === 'env'">
          凭据由环境变量 <code>AEOLUS_ACCOUNT</code> / <code>AEOLUS_PASSWORD</code> 提供，此处保存的文件不生效。
        </span>
        <span v-else-if="masked.hasAccount && masked.hasPassword">
          已设置账号：{{ masked.account }}
        </span>
        <span v-else-if="masked.hasAccount">
          已设置账号：{{ masked.account }}，但尚未设置密码。
        </span>
        <span v-else> 尚未配置账号，取数前请先填写并保存。 </span>
      </div>

      <el-alert
        v-if="masked.source === 'env'"
        type="warning"
        :closable="false"
        class="tip"
        title="检测到环境变量覆盖"
        description="当前登录凭据来自环境变量，本页保存的文件仅在移除环境变量后生效。如需改为界面管理，请清除后端 AEOLUS_ACCOUNT / AEOLUS_PASSWORD 环境变量。"
      />

      <!-- 退出登录 / 切换账号 -->
      <div class="actions">
        <el-button :loading="loggingOut" @click="logout">退出登录</el-button>
        <el-button type="primary" @click="switchAccount">切换账号</el-button>
      </div>

      <!-- 切换账号表单（默认折叠，点击「切换账号」展开） -->
      <el-collapse-transition>
        <div v-show="editing" class="form-wrap">
          <el-divider />
          <el-form label-width="80px" class="form" @submit.prevent>
            <el-form-item label="账号">
              <el-input
                v-model="form.account"
                placeholder="风神登录账号（手机号 / 工号）"
                size="default"
                class="inp"
                clearable
              />
            </el-form-item>
            <el-form-item label="密码">
              <el-input
                v-model="form.password"
                type="password"
                show-password
                size="default"
                class="inp"
                :placeholder="masked.hasPassword ? '已设置，修改请重填；留空保持不变' : '未设置，首次须填写'"
              />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="saving" @click="save">保存</el-button>
              <el-button @click="editing = false">取消</el-button>
              <span class="muted">保存后立即生效，下次取数/重登自动使用新凭据。</span>
            </el-form-item>
          </el-form>
        </div>
      </el-collapse-transition>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { fetchAeolusCreds, saveAeolusCreds, logoutAeolus } from '../api/dashboards.js';


const masked = reactive({ ok: true, hasAccount: false, hasPassword: false, account: '', accountHint: undefined, source: 'none' });
const form = reactive({ account: '', password: '' });
const saving = ref(false);
const loggingOut = ref(false);
const editing = ref(false);

const statusClass = computed(() => {
  if (masked.source === 'env') return 'status--env';
  if (masked.hasAccount && masked.hasPassword) return 'status--ok';
  return 'status--warn';
});

async function load() {
  try {
    const r = await fetchAeolusCreds();
    const d = (r && r.data) || r || {};
    masked.hasAccount = !!d.hasAccount;
    masked.hasPassword = !!d.hasPassword;
    masked.account = d.account || '';
    masked.accountHint = d.accountHint;
    masked.source = d.source || 'none';
    // 尚未配置账号时自动展开表单，方便首次填写。
    editing.value = !masked.hasAccount;
  } catch (e) {
    ElMessage.error(e.message || '加载账号配置失败');
  }
}

async function save() {
  if (!form.account || !form.account.trim()) {
    ElMessage.error('账号不能为空');
    return;
  }
  saving.value = true;
  try {
    const r = await saveAeolusCreds({ account: form.account.trim(), password: form.password || '' });
    const d = (r && r.data) || r || {};
    if (d && d.ok) {
      ElMessage.success('已保存账号');
      form.password = ''; // 清空密码框，避免误留存
      editing.value = false;
      await load();
    } else {
      ElMessage.error(d?.error || '保存失败');
    }
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function logout() {
  loggingOut.value = true;
  try {
    const r = await logoutAeolus();
    const d = (r && r.data) || r || {};
    if (d && d.ok) {
      ElMessage.success('已退出登录，下次取数将自动重登');
    } else {
      ElMessage.error(d?.error || '退出登录失败');
    }
  } catch (e) {
    ElMessage.error(e.message || '退出登录失败');
  } finally {
    loggingOut.value = false;
  }
}

function switchAccount() {
  editing.value = true;
  form.account = '';
  form.password = '';
}

onMounted(load);
</script>

<style scoped>
.ae { padding: var(--sp-20); }
.v-title { margin: 0 0 var(--sp-16); font-size: var(--el-font-size-extra-large); }
.blk { margin-bottom: var(--sp-16); }
.blk-h { font-size: var(--el-font-size-medium); font-weight: var(--fw-semibold); }
.muted { color: var(--el-text-color-secondary); font-size: var(--el-font-size-extra-small); }
.status {
  display: flex; align-items: center; gap: var(--sp-8);
  padding: var(--sp-12) var(--sp-16); border-radius: 8px; margin-bottom: var(--sp-12);
  font-size: var(--el-font-size-small);
}
.status--ok { background: #f0f9eb; color: #529b2e; border: 1px solid #e1f3d8; }
.status--warn { background: #fdf6ec; color: #b88230; border: 1px solid #faecd8; }
.status--env { background: #f4f4f5; color: #909399; border: 1px solid #e9e9eb; }
.st-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.status--ok .st-dot { background: #67c23a; }
.status--warn .st-dot { background: #e6a23c; }
.status--env .st-dot { background: #c0c4cc; }
.status code { background: rgba(0,0,0,.05); padding: 1px 6px; border-radius: 4px; }
.tip { margin-bottom: var(--sp-16); }
.actions { display: flex; gap: var(--sp-12); margin-top: var(--sp-4); }
.form-wrap { margin-top: var(--sp-8); }
.form { margin-top: var(--sp-8); }
.inp { max-width: 360px; }
</style>
