<template>
  <div class="dt">
    <h2 class="v-title">钉钉设置</h2>

    <!-- 钉钉授权 -->
    <el-card class="blk" shadow="never">
      <div v-if="ding.loggedIn" class="ding-ok">
        <div class="ding-ok-head">
          <span class="ok-dot"></span>
          <span class="ok-title">授权状态</span>
          <el-button size="small" type="danger" plain :loading="ding.loggingOut" @click="dingLogout">退出登录</el-button>
        </div>
        <div class="ding-info-grid" v-if="ding.profile && ding.profile.corp_name">
          <div class="di"><span class="di-k">组织</span><span class="di-v">{{ ding.profile.corp_name }}</span></div>
          <div class="di"><span class="di-k">账号</span><span class="di-v">{{ ding.profile.user_name || '-' }}<span class="di-sub" v-if="ding.profile.user_id"> · {{ ding.profile.user_id }}</span></span></div>
          <div class="di"><span class="di-k">访问令牌</span><span class="di-v"><el-tag :type="ding.profile.token_valid ? 'success' : 'danger'" size="small" effect="light">{{ ding.profile.token_valid ? '有效' : '已失效' }}</el-tag></span></div>
          <div class="di"><span class="di-k">刷新令牌</span><span class="di-v"><el-tag :type="ding.profile.refresh_token_valid ? 'success' : 'danger'" size="small" effect="light">{{ ding.profile.refresh_token_valid ? '有效' : '已失效' }}</el-tag></span></div>
          <div class="di di-wide"><span class="di-k">有效期至</span><span class="di-v">{{ fmt(ding.profile.expires_at) }}<span class="di-sub">（剩余 {{ remainDays(ding.profile.expires_at) }} 天）</span></span></div>
        </div>
      </div>
      <template v-else>
        <p class="muted">
          钉钉未授权：发消息、解析群等依赖钉钉的功能暂不可用。点击下方按钮获取授权码，
          在浏览器或钉钉中打开授权链接并完成授权即可。
        </p>
        <el-button type="primary" :loading="ding.loading" @click="dingStart">
          {{ ding.info ? '重新获取授权码' : '获取登录授权码' }}
        </el-button>
      </template>

      <div v-if="ding.info" class="ding-card">
        <div class="ding-row">
          <span class="ding-k">授权码</span>
          <code class="ding-code">{{ ding.info.userCode }}</code>
          <el-button size="small" @click="copyText(ding.info.userCode)">复制</el-button>
        </div>
        <div class="ding-row">
          <span class="ding-k">授权链接</span>
          <a :href="ding.info.verificationUri" target="_blank" rel="noopener">点击打开授权页</a>
        </div>
        <div class="ding-row">
          <span class="ding-k">过期时间</span>
          <span>{{ new Date(ding.expireAt).toLocaleString() }}</span>
        </div>
        <el-alert
          type="info"
          :closable="false"
          title="请在浏览器/钉钉打开上方链接并确认授权，本页会自动刷新状态；授权完成后无需手动操作。"
        />
      </div>
    </el-card>

    <!-- 钉钉单点登录(SSO)配置 -->
    <el-card class="blk" shadow="never">
      <template #header>
        <span class="blk-h">钉钉单点登录 (SSO) 配置</span>
        <el-tag :type="sso.enabled ? 'success' : 'info'" size="small" effect="light" class="blk-tag">
          {{ sso.enabled ? '已启用' : '未启用' }}
        </el-tag>
        <span class="blk-sub">配置后无需修改服务器 .env，保存即生效</span>
      </template>

      <el-alert
        v-if="!sso.enabled"
        type="warning"
        :closable="false"
        class="blk-alert"
        title="AppKey / AppSecret 未填写时，钉钉登录入口不会显示，系统仅保留账密登录。"
      />

      <el-form label-width="160px" class="sso-form">
        <el-form-item label="AppKey">
          <el-input v-model="sso.appKey" placeholder="钉钉企业内部应用的 AppKey" size="small" />
        </el-form-item>
        <el-form-item label="AppSecret">
          <el-input
            v-model="sso.appSecret"
            :placeholder="sso.appSecretSet ? '已设置，修改请重填；留空保持不变' : '钉钉企业内部应用的 AppSecret'"
            type="password"
            show-password
            size="small"
          />
        </el-form-item>
        <el-form-item label="CorpId">
          <el-input v-model="sso.corpId" placeholder="企业 CorpId（JSAPI 免登需要）" size="small" />
        </el-form-item>
        <el-form-item label="OAuth2 回跳地址">
          <el-input
            v-model="sso.oauthRedirectUri"
            placeholder="https://你的域名/api/auth/dingtalk/oauth-callback"
            size="small"
          />
          <span class="cfg-hint">浏览器独立访问扫码登录用，须在钉钉后台「登录与分享 → 回调域名」登记该域名。</span>
        </el-form-item>
        <el-form-item label="前端地址">
          <el-input v-model="sso.frontendUrl" placeholder="留空则自动取请求来源（同域部署可留空）" size="small" />
        </el-form-item>
        <el-form-item label="未绑定自动开户">
          <el-select v-model="sso.autoProvisionRole" size="small" class="sso-select">
            <el-option label="关闭（需先绑定）" value="" />
            <el-option label="viewer（只读）" value="viewer" />
            <el-option label="operator（操作）" value="operator" />
          </el-select>
          <span class="cfg-hint">开启后，钉钉内首次访问且未绑定的账号将按所选角色自动开户并登录。</span>
        </el-form-item>
      </el-form>

      <div class="cfg-actions">
        <el-button type="primary" :loading="ssoSaving" @click="saveSso">保存配置</el-button>
        <span class="muted">保存后会即时写入服务器并生效，无需重启服务。</span>
      </div>
    </el-card>

    <!-- DWS 配置项 -->
    <el-card class="blk" shadow="never">
      <template #header>
        <span class="blk-h">DWS 配置项</span>
        <span class="blk-sub">基于 dws CLI，共 {{ items.length }} 项 · {{ categories.length }} 类</span>
      </template>

      <el-collapse v-model="activeGroups">
        <el-collapse-item
          v-for="g in grouped"
          :key="g.cat"
          :title="catLabel(g.cat)"
          :name="g.cat"
        >
          <div v-for="it in g.items" :key="it.key" class="cfg-row">
            <div class="cfg-meta">
              <code class="cfg-key">{{ it.key }}</code>
              <span class="cfg-desc">{{ it.description }}</span>
            </div>
            <el-input
              v-if="it.sensitive"
              v-model="form[it.key]"
              :placeholder="origSensitive[it.key] ? '已设置，修改请重填；留空保持不变' : '未设置'"
              type="password"
              show-password
              size="small"
              class="cfg-input"
            />
            <el-input
              v-else
              v-model="form[it.key]"
              :placeholder="'默认：' + it.default"
              size="small"
              class="cfg-input"
            />
          </div>
        </el-collapse-item>
      </el-collapse>

      <div class="cfg-actions">
        <el-button type="primary" :loading="saving" @click="save">保存配置</el-button>
        <span class="muted">
          修改后重新执行相关 dws 操作即生效；非敏感项留空将恢复 dws 内置默认，敏感项留空则保持不变。
        </span>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, reactive, ref, computed } from 'vue';
import { useAppStore } from '../stores/app.js';
import {
  dingAuthStart,
  dingAuthStatus,
  dingAuthLogout,
  dingConfig,
  saveDingConfig,
  getSsoConfig,
  saveSsoConfig,
} from '../api/dashboards.js';

const app = useAppStore();

const CAT_LABELS = {
  core: '核心',
  auth: '认证',
  network: '网络',
  security: '安全',
  audit: '审计',
  runtime: '运行时',
  debug: '调试',
  external: '外部透传',
};

/* ---------------- 钉钉授权 ---------------- */
const ding = reactive({ loading: false, info: null, expireAt: 0, loggedIn: false, profileName: '', profile: {}, loggingOut: false });
let dingTimer = null;
async function dingRefresh() {
  try {
    const r = await dingAuthStatus();
    const d = (r && r.data) || r || {};
    ding.loggedIn = !!d.authenticated;
    const p = d.profile || {};
    ding.profileName = p.profileName || p.corpName || p.name || '';
    ding.profile = p;
    if (ding.loggedIn) { ding.info = null; stopDingPoll(); }
  } catch (e) { /* 轮询错误忽略 */ }
}
async function dingLogout() {
  const ok = await app.confirmDialog({
    title: '退出钉钉登录',
    message: '确定要退出钉钉登录吗？退出后需重新发起授权，发消息等依赖钉钉的功能将暂不可用。',
    okText: '退出',
    cancelText: '取消',
  });
  if (!ok) return;
  ding.loggingOut = true;
  try {
    const r = await dingAuthLogout();
    if (r && r.ok) {
      ElMessage.success('已退出钉钉登录，可重新发起授权');
      ding.profile = {};
      await dingRefresh();
    } else {
      ElMessage.error((r && (r.error || r.message)) || '退出登录失败');
    }
  } catch (e) { ElMessage.error(e.message || '退出登录失败'); }
  finally { ding.loggingOut = false; }
}
function fmt(iso) {
  if (!iso) return '-';
  const t = new Date(iso);
  if (isNaN(t.getTime())) return String(iso);
  return t.toLocaleString('zh-CN', { hour12: false });
}
function remainDays(iso) {
  if (!iso) return '-';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '-';
  return Math.max(0, Math.ceil((t - Date.now()) / 86400000));
}
function startDingPoll() { stopDingPoll(); dingTimer = setInterval(dingRefresh, 3000); dingRefresh(); }
function stopDingPoll() { if (dingTimer) { clearInterval(dingTimer); dingTimer = null; } }
async function dingStart() {
  ding.loading = true;
  try {
    const r = await dingAuthStart();
    const d = (r && r.data) || r || {};
    ding.info = { userCode: d.userCode, verificationUri: d.verificationUri };
    ding.expireAt = Date.now() + (Number(d.expiresInSeconds) || 900) * 1000;
    startDingPoll();
    ElMessage.success('已生成授权码，请在浏览器中完成授权');
  } catch (e) { ElMessage.error(e.message || '发起授权失败'); }
  finally { ding.loading = false; }
}
function copyText(t) {
  try { navigator.clipboard?.writeText(t); ElMessage.success('已复制'); } catch { /* ignore */ }
}

/* ---------------- DWS 配置项 ---------------- */
const items = ref([]);
const form = reactive({});
const origSensitive = reactive({});
const saving = ref(false);
// 默认全部折叠，用户按需展开；之前默认展开 8 类显得过长。
const activeGroups = ref([]);

const categories = computed(() => [...new Set(items.value.map((i) => i.category))]);
const grouped = computed(() =>
  categories.value.map((cat) => ({ cat, items: items.value.filter((i) => i.category === cat) })),
);
function catLabel(c) { return CAT_LABELS[c] || c; }

async function loadConfig() {
  try {
    const r = await dingConfig();
    const body = (r && r.data) || r || {};
    const its = body.items || [];
    items.value = its;
    its.forEach((it) => {
      form[it.key] = it.value || '';
      if (it.sensitive) origSensitive[it.key] = !!it.value;
    });
  } catch (e) { ElMessage.error(e.message || '加载 dws 配置失败'); }
}
async function save() {
  saving.value = true;
  const patch = {};
  items.value.forEach((it) => {
    const v = form[it.key] ?? '';
    if (it.sensitive) {
      if (v !== '') patch[it.key] = v; // 敏感项留空 = 保持不变
    } else {
      patch[it.key] = v; // 非敏感项空 = 恢复默认
    }
  });
  try {
    const r = await saveDingConfig(patch);
    if (r && r.ok) { ElMessage.success('已保存 dws 配置'); await loadConfig(); }
    else ElMessage.error('保存失败');
  } catch (e) { ElMessage.error(e.message || '保存失败'); }
  finally { saving.value = false; }
}

onMounted(() => { dingRefresh(); loadConfig(); loadSso(); });
onUnmounted(stopDingPoll);

/* ---------------- 钉钉 SSO 配置 ---------------- */
const sso = reactive({
  enabled: false,
  appKey: '',
  appSecret: '',
  appSecretSet: false,
  corpId: '',
  oauthRedirectUri: '',
  frontendUrl: '',
  autoProvisionRole: '',
});
const ssoSaving = ref(false);
async function loadSso() {
  try {
    const r = await getSsoConfig();
    const c = (r && r.config) || {};
    sso.enabled = !!c.enabled;
    sso.appKey = c.appKey || '';
    sso.appSecret = '';
    sso.appSecretSet = !!c.appSecretSet;
    sso.corpId = c.corpId || '';
    sso.oauthRedirectUri = c.oauthRedirectUri || '';
    sso.frontendUrl = c.frontendUrl || '';
    sso.autoProvisionRole = c.autoProvisionRole || '';
  } catch (e) { ElMessage.error(e.message || '加载钉钉 SSO 配置失败'); }
}
async function saveSso() {
  ssoSaving.value = true;
  try {
    const r = await saveSsoConfig({
      appKey: sso.appKey,
      appSecret: sso.appSecret, // 留空 = 保持不变（已设置时）
      corpId: sso.corpId,
      oauthRedirectUri: sso.oauthRedirectUri,
      frontendUrl: sso.frontendUrl,
      autoProvisionRole: sso.autoProvisionRole,
    });
    if (r && r.ok) { ElMessage.success('已保存钉钉 SSO 配置'); await loadSso(); }
    else ElMessage.error((r && r.error) || '保存失败');
  } catch (e) { ElMessage.error(e.message || '保存失败'); }
  finally { ssoSaving.value = false; }
}
</script>

<style scoped>
.dt { padding: var(--sp-20); }
.v-title { margin: 0 0 var(--sp-16); font-size: var(--el-font-size-extra-large); }
.blk { margin-bottom: var(--sp-16); }
.blk-h { font-size: var(--el-font-size-medium); font-weight: var(--fw-semibold); }
.blk-sub { margin-left: var(--sp-12); font-size: var(--el-font-size-extra-small); color: var(--muted); }
.blk-tag { margin-left: var(--sp-8); }
.blk-alert { margin-bottom: var(--sp-16); }
.muted { color: var(--muted); }
.sso-form { max-width: 720px; margin-top: var(--sp-8); }
.sso-select { width: 220px; }
.cfg-hint { display: block; margin-top: 4px; font-size: var(--el-font-size-extra-small); color: var(--muted); line-height: 1.4; }
.ding-card { margin-top: var(--sp-16); border: 1px solid #ebeef5; border-radius: 8px; padding: var(--sp-16); }
.ding-row { display: flex; align-items: center; gap: var(--sp-12); margin-bottom: var(--sp-12); }
.ding-k { width: 72px; color: var(--muted); flex: none; }
.ding-code { font-size: 18px; letter-spacing: 2px; background: #f5f7fa; padding: 2px 8px; border-radius: 4px; }
.cfg-row { display: flex; align-items: flex-start; gap: var(--sp-16); padding: var(--sp-8) 0; border-bottom: 1px dashed #f0f0f0; }
.cfg-row:last-child { border-bottom: none; }
.cfg-meta { flex: 1; min-width: 0; }
.cfg-key { font-size: var(--el-font-size-small); color: var(--text); background: #f5f7fa; padding: 1px 6px; border-radius: 4px; }
.cfg-desc { display: block; margin-top: 4px; font-size: var(--el-font-size-extra-small); color: var(--muted); line-height: 1.4; }
.cfg-input { width: 360px; flex: none; }
.cfg-actions { margin-top: var(--sp-16); display: flex; align-items: center; gap: var(--sp-12); flex-wrap: wrap; }
.ding-ok { border: 1px solid #e1f3d8; background: #f0f9eb; border-radius: 8px; padding: var(--sp-16); }
.ding-ok-head { display: flex; align-items: center; gap: var(--sp-12); margin-bottom: var(--sp-12); }
.ok-dot { width: 9px; height: 9px; border-radius: 50%; background: #67c23a; box-shadow: 0 0 0 3px rgba(103,194,58,.18); flex: none; }
.ok-title { font-weight: 600; font-size: var(--el-font-size-medium); flex: 1; }
.ding-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-10) var(--sp-24); }
.di { display: flex; align-items: baseline; gap: var(--sp-10); min-width: 0; }
.di-wide { grid-column: 1 / -1; }
.di-k { width: 64px; color: var(--muted); flex: none; font-size: var(--el-font-size-extra-small); }
.di-v { font-size: var(--el-font-size-small); color: #303133; word-break: break-all; }
.di-sub { color: var(--muted); margin-left: 4px; }
</style>
