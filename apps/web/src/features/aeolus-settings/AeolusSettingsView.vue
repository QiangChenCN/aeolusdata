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
        <span v-if="masked.hasAccount && masked.hasPassword">
          已设置账号：{{ masked.account }}
        </span>
        <span v-else-if="masked.hasAccount">
          已设置账号：{{ masked.account }}，但尚未设置密码。
        </span>
        <span v-else> 尚未配置账号，取数前请先填写并保存。 </span>
      </div>

      <!-- 验证结果（跑一遍 SSO 登录 + cookie 探活） -->
      <div v-if="verify.state !== 'idle'" class="verify" :class="verifyClass">
        <span v-if="verify.state === 'running'">
          正在用已保存凭据跑一遍登录验证…（SSO 登录 + 探活，通常需 3~10 秒）
        </span>
        <template v-else>
          <span>{{ verify.message }}</span>
          <span v-if="verify.detail" class="muted">{{ verify.detail }}</span>
          <span class="muted">验证时间 {{ verify.checkedAt }}</span>
        </template>
      </div>

      <!-- 验证 / 退出登录 / 切换账号 -->
      <div class="actions">
        <el-button
          type="primary"
          :loading="verifying"
          :disabled="!(masked.hasAccount && masked.hasPassword)"
          @click="runVerify"
        >
          验证登录
        </el-button>
        <el-button @click="switchAccount">切换账号</el-button>
        <el-button :loading="loggingOut" @click="logout">退出登录</el-button>
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
              <span class="muted">保存后立即生效，并自动跑一遍登录验证（获取 cookie 确认账号密码正确）。</span>
            </el-form-item>
          </el-form>
        </div>
      </el-collapse-transition>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { fetchAeolusCreds, saveAeolusCreds, logoutAeolus, testAeolusCreds } from '../../api/dashboards.js';


const masked = reactive({ ok: true, hasAccount: false, hasPassword: false, account: '', accountHint: undefined, source: 'none' });
const form = reactive({ account: '', password: '' });
const saving = ref(false);
const loggingOut = ref(false);
const editing = ref(false);
const verifying = ref(false);
// state: idle | running | ok | fail
const verify = reactive({ state: 'idle', message: '', detail: '', checkedAt: '' });

const statusClass = computed(() => {
  if (masked.hasAccount && masked.hasPassword) return 'status--ok';
  return 'status--warn';
});

const verifyClass = computed(() => {
  if (verify.state === 'ok') return 'verify--ok';
  if (verify.state === 'fail') return 'verify--fail';
  return 'verify--run';
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
      // 保存后立刻跑一遍登录验证，确认这套账号密码现在真能拿到 cookie。
      await runVerify();
    } else {
      ElMessage.error(d?.error || '保存失败');
    }
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

/**
 * 用已保存凭据跑一遍完整 SSO 登录 + cookie 探活，确认账号密码设置正确。
 * 后端验证通过会把新 cookie 落盘，取数链可直接复用，无需再登一次。
 */
async function runVerify() {
  if (verifying.value) return;
  verifying.value = true;
  verify.state = 'running';
  verify.message = '';
  verify.detail = '';
  try {
    const r = await testAeolusCreds();
    const d = (r && r.data) || r || {};
    if (d.ok) {
      verify.state = 'ok';
      const sec = ((d.elapsed_ms || 0) / 1000).toFixed(1);
      verify.message = `验证通过：已成功获取登录 cookie（长度 ${d.cookie_len ?? '-'}${
        d.has_mozi_token ? '，含 MOZI_TOKEN' : ''
      }，耗时 ${sec}s）`;
      verify.detail = d.saved ? '新 cookie 已落盘，后续取数可直接复用。' : '';
    } else {
      verify.state = 'fail';
      verify.message = `验证失败：${d.error || '未知错误'}`;
      verify.detail = '';
    }
    verify.checkedAt = new Date().toLocaleString('zh-CN');
  } catch (e) {
    verify.state = 'fail';
    verify.message = `验证失败：${e.message || '请求异常'}`;
    verify.checkedAt = new Date().toLocaleString('zh-CN');
  } finally {
    verifying.value = false;
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
  verify.state = 'idle'; // 切号后旧的验证结论不再适用
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
.verify {
  display: flex; flex-direction: column; gap: var(--sp-4);
  padding: var(--sp-12) var(--sp-16); border-radius: 8px; margin-bottom: var(--sp-12);
  font-size: var(--el-font-size-small); border: 1px solid transparent;
}
.verify--run { background: #f4f4f5; color: #909399; border-color: #e9e9eb; }
.verify--ok { background: #f0f9eb; color: #529b2e; border-color: #e1f3d8; }
.verify--fail { background: #fef0f0; color: #c45656; border-color: #fde2e2; }
.status code { background: rgba(0,0,0,.05); padding: 1px 6px; border-radius: 4px; }
.tip { margin-bottom: var(--sp-16); }
.actions { display: flex; gap: var(--sp-12); margin-top: var(--sp-4); }
.form-wrap { margin-top: var(--sp-8); }
.form { margin-top: var(--sp-8); }
.inp { max-width: 360px; }
</style>
