<template>
  <div class="mio">
    <h2 class="v-title">MinIO 设置</h2>

    <el-card class="blk" shadow="never">
      <template #header>
        <span class="blk-h">图床配置</span>
      </template>

      <!-- 当前配置状态 -->
      <div class="status" :class="statusClass">
        <span class="st-dot"></span>
        <span v-if="masked.configured">
          已配置：{{ masked.endpoint }} / bucket「{{ masked.bucket }}」
          <span v-if="masked.access_key_hint" class="muted">（access_key {{ masked.access_key_hint }}）</span>
        </span>
        <span v-else> 尚未配置 MinIO，图床上传功能不可用；请先填写并保存。 </span>
      </div>

      <!-- 验证结果（真实连一次 MinIO） -->
      <div v-if="verify.state !== 'idle'" class="verify" :class="verifyClass">
        <span v-if="verify.state === 'running'">
          正在用已保存配置连接 MinIO…（bucket 探活 + 公开读策略，通常需 1~5 秒）
        </span>
        <template v-else>
          <span>{{ verify.message }}</span>
          <span v-if="verify.detail" class="muted">{{ verify.detail }}</span>
          <span class="muted">验证时间 {{ verify.checkedAt }}</span>
        </template>
      </div>

      <div class="actions">
        <el-button
          type="primary"
          :loading="verifying"
          :disabled="!masked.configured"
          @click="runVerify"
        >
          验证连接
        </el-button>
        <el-button @click="editConfig">编辑配置</el-button>
      </div>

      <!-- 配置表单（默认折叠，点击「编辑配置」展开；未配置时自动展开） -->
      <el-collapse-transition>
        <div v-show="editing" class="form-wrap">
          <el-divider />
          <el-form label-width="120px" class="form" @submit.prevent>
            <el-form-item label="endpoint">
              <el-input
                v-model="form.endpoint"
                placeholder="如 s3.example.com（不带协议头）"
                size="default"
                class="inp"
                clearable
              />
            </el-form-item>
            <el-form-item label="port">
              <el-input
                v-model="form.port"
                placeholder="留空默认 9000；HTTPS 直连域名一般填 443"
                size="default"
                class="inp inp-short"
                clearable
              />
            </el-form-item>
            <el-form-item label="bucket">
              <el-input
                v-model="form.bucket"
                placeholder="如 violation-images"
                size="default"
                class="inp"
                clearable
              />
            </el-form-item>
            <el-form-item label="公网直链基址">
              <el-input
                v-model="form.public_base"
                placeholder="如 https://s3.example.com/mybucket/（需含 bucket 段，末尾斜杠可省）"
                size="default"
                class="inp"
                clearable
              />
            </el-form-item>
            <el-form-item label="access_key">
              <el-input
                v-model="form.access_key"
                size="default"
                class="inp"
                clearable
                :placeholder="masked.hasSecret ? '已设置，修改请重填；留空保持不变' : '未设置，首次须填写'"
              />
            </el-form-item>
            <el-form-item label="secret_key">
              <el-input
                v-model="form.secret_key"
                type="password"
                show-password
                size="default"
                class="inp"
                :placeholder="masked.hasSecret ? '已设置，修改请重填；留空保持不变' : '未设置，首次须填写'"
              />
            </el-form-item>
            <el-form-item label="HTTPS">
              <el-switch v-model="form.secure" />
              <span class="muted switch-tip">开启则用 HTTPS（useSSL）连接</span>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="saving" @click="save">保存</el-button>
              <el-button @click="editing = false">取消</el-button>
              <span class="muted">保存后立即生效（无需重启），下一次图片上传即使用新配置。</span>
            </el-form-item>
          </el-form>
        </div>
      </el-collapse-transition>
    </el-card>

    <el-card class="blk" shadow="never">
      <template #header>
        <span class="blk-h">说明</span>
      </template>
      <ul class="notes">
        <li>配置由本页面维护，落盘在服务端 <code>apps/api/runtime/minio_config.json</code>（权限 0600，唯一来源），secret_key 明文不回传前端；不再支持手写配置文件。</li>
        <li>「验证连接」会真实连一次 MinIO：确认 bucket 可访问，并自动应用公开读（public-read）策略——不存在时会尝试创建。</li>
        <li>上传的图片对象名为「业务前缀 + 内容 SHA256 前 16 位」，同一张图重复上传只覆盖不堆积。</li>
      </ul>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { fetchMinioConfig, saveMinioConfig, testMinioConfig } from '../../api/dashboards.js';

// 「编辑配置」展开时预填当前已保存的配置（密码/密钥留空）

const masked = reactive({
  ok: true,
  configured: false,
  endpoint: '',
  port: undefined,
  bucket: '',
  public_base: '',
  secure: true,
  access_key_hint: undefined,
  hasSecret: false,
});
const form = reactive({ endpoint: '', port: '', bucket: '', public_base: '', access_key: '', secret_key: '', secure: true });
const saving = ref(false);
const editing = ref(false);
const verifying = ref(false);
// state: idle | running | ok | fail
const verify = reactive({ state: 'idle', message: '', detail: '', checkedAt: '' });

const statusClass = computed(() => (masked.configured ? 'status--ok' : 'status--warn'));

const verifyClass = computed(() => {
  if (verify.state === 'ok') return 'verify--ok';
  if (verify.state === 'fail') return 'verify--fail';
  return 'verify--run';
});

async function load() {
  try {
    const r = await fetchMinioConfig();
    const d = (r && r.data) || r || {};
    masked.configured = !!d.configured;
    masked.endpoint = d.endpoint || '';
    masked.port = d.port;
    masked.bucket = d.bucket || '';
    masked.public_base = d.public_base || '';
    masked.secure = d.secure !== false;
    masked.access_key_hint = d.access_key_hint;
    masked.hasSecret = !!d.hasSecret;
    // 尚未配置时自动展开表单，方便首次填写。
    editing.value = !masked.configured;
  } catch (e) {
    ElMessage.error(e.message || '加载 MinIO 配置失败');
  }
}

function fillForm() {
  form.endpoint = masked.endpoint || '';
  form.port = masked.port == null ? '' : String(masked.port);
  form.bucket = masked.bucket || '';
  form.public_base = masked.public_base || '';
  form.access_key = '';
  form.secret_key = '';
  form.secure = masked.secure;
}

async function save() {
  if (!form.endpoint.trim()) { ElMessage.error('endpoint 不能为空'); return; }
  if (!form.bucket.trim()) { ElMessage.error('bucket 不能为空'); return; }
  if (!form.public_base.trim()) { ElMessage.error('公网直链基址不能为空'); return; }
  saving.value = true;
  try {
    const payload = {
      endpoint: form.endpoint.trim(),
      bucket: form.bucket.trim(),
      public_base: form.public_base.trim(),
      access_key: form.access_key.trim(),
      secret_key: form.secret_key,
      secure: form.secure,
    };
    if (form.port !== '') payload.port = form.port;
    const r = await saveMinioConfig(payload);
    const d = (r && r.data) || r || {};
    if (d && d.ok) {
      ElMessage.success('已保存 MinIO 配置，立即生效');
      if (d.warning) ElMessage.warning({ message: d.warning, duration: 8000, showClose: true });
      form.secret_key = '';
      form.access_key = '';
      await load();
      editing.value = false;
    } else {
      ElMessage.error(d?.error || '保存失败');
    }
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

/** 用已保存配置真实连一次 MinIO（bucket 探活 + public-read 策略），确认配置可用。 */
async function runVerify() {
  if (verifying.value) return;
  verifying.value = true;
  verify.state = 'running';
  verify.message = '';
  verify.detail = '';
  try {
    const r = await testMinioConfig();
    const d = (r && r.data) || r || {};
    if (d.ok && d.direct_ok === false) {
      // 上传链路通，但公网直链打不开 —— 群里的图片会裂图，按失败呈现
      verify.state = 'fail';
      const sec = ((d.elapsed_ms || 0) / 1000).toFixed(1);
      verify.message = `上传链路通（bucket「${d.bucket || '-'}」可写，耗时 ${sec}s），但公网直链无法访问！`;
      verify.detail = `直链 ${d.direct_url || '-'} 回读失败（${d.direct_error || '未知'}）。请检查「公网直链基址」是否解析/反代到该 MinIO，或改用 http://${d.endpoint}:${masked.port || 9000}/…`;
    } else if (d.ok) {
      verify.state = 'ok';
      const sec = ((d.elapsed_ms || 0) / 1000).toFixed(1);
      verify.message = `验证通过：bucket「${d.bucket || '-'}」可访问，公网直链回读成功（耗时 ${sec}s）`;
      verify.detail = (d.created ? 'bucket 原先不存在，本次已自动创建。' : '') + '已应用公开读（public-read）策略，图片直链可匿名访问。';
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

function editConfig() {
  fillForm();
  editing.value = true;
  verify.state = 'idle'; // 编辑后旧验证结论不再适用
}

onMounted(load);
</script>

<style scoped>
.mio { padding: var(--sp-20); }
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
.st-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.status--ok .st-dot { background: #67c23a; }
.status--warn .st-dot { background: #e6a23c; }
.verify {
  display: flex; flex-direction: column; gap: var(--sp-4);
  padding: var(--sp-12) var(--sp-16); border-radius: 8px; margin-bottom: var(--sp-12);
  font-size: var(--el-font-size-small); border: 1px solid transparent;
}
.verify--run { background: #f4f4f5; color: #909399; border-color: #e9e9eb; }
.verify--ok { background: #f0f9eb; color: #529b2e; border-color: #e1f3d8; }
.verify--fail { background: #fef0f0; color: #c45656; border-color: #fde2e2; }
.status code { background: rgba(0,0,0,.05); padding: 1px 6px; border-radius: 4px; }
.actions { display: flex; gap: var(--sp-12); margin-top: var(--sp-4); }
.form-wrap { margin-top: var(--sp-8); }
.form { margin-top: var(--sp-8); }
.inp { max-width: 420px; }
.inp-short { max-width: 180px; }
.switch-tip { margin-left: var(--sp-8); }
.notes { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: var(--sp-6); font-size: var(--el-font-size-small); color: var(--el-text-color-regular); }
.notes code { background: rgba(0,0,0,.05); padding: 1px 6px; border-radius: 4px; }
</style>
