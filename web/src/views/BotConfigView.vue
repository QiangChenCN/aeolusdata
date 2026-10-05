<template>
  <div class="botcfg">
    <h2 class="v-title">机器人配置</h2>

    <!-- 全局开关 -->
    <section class="bc-card">
      <h3 class="bc-h">连接配置（全局开关）</h3>
      <el-form label-width="180px" class="bc-form">
        <el-form-item label="AI 卡片打字效果">
          <el-switch v-model="bot.aiCardTyping" />
          <span class="muted" style="margin-left:8px">关闭则结果直接落定，不做逐字动画</span>
        </el-form-item>
        <el-form-item label="查询超时(秒)">
          <el-input-number v-model="bot.dingbotQueryTimeout" :min="5" :max="600" />
        </el-form-item>
        <el-form-item label="启用机器人（总开关）">
          <el-switch v-model="bot.botEnabled" />
          <span class="muted" style="margin-left:8px">关闭则停止所有 Stream 连接</span>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="savingBot" @click="saveBot">保存配置</el-button>
          <el-button :loading="reloadingBot" @click="doReloadBot">重新连接</el-button>
        </el-form-item>
      </el-form>
    </section>

    <!-- 凭据分组 -->
    <section class="bc-card">
      <h3 class="bc-h">
        凭据分组
        <el-button size="small" type="primary" style="margin-left:12px" @click="openCredAdd">新增凭据</el-button>
      </h3>
      <el-table :data="creds" stripe border class="bc-table">
        <el-table-column prop="label" label="名称" min-width="140" />
        <el-table-column prop="id" label="分组ID" min-width="160" />
        <el-table-column prop="clientId" label="Client ID" min-width="180" />
        <el-table-column label="Secret" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.hasSecret" size="small" type="success">已配置</el-tag>
            <el-tag v-else size="small" type="danger">未配置</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <el-button size="small" @click="openCredEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="deleteCred(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p class="muted bc-tip">
        每个分组对应一个钉钉应用的 Client ID / Secret；机器人实例通过「凭据分组」绑定到某一组，运行时按分组各自建立独立的 Stream 连接。
      </p>
    </section>

    <!-- 机器人实例与状态 -->
    <section class="bc-card">
      <h3 class="bc-h">
        机器人实例与状态
        <span class="bc-poll" v-if="lastUpdated">· 自动刷新中 · 最近更新 {{ lastUpdated }}</span>
      </h3>
      <el-descriptions :column="2" border class="bc-desc">
        <el-descriptions-item label="机器人总开关">
          <el-tag v-if="status.botEnabled" size="small" type="success">已启用</el-tag>
          <el-tag v-else size="small" type="info">已禁用</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="Stream 网关">
          <el-tag v-if="status.gatewayConnected === true" size="small" type="success">已连接</el-tag>
          <el-tag v-else-if="status.gatewayConnected === false" size="small" type="info">未连接</el-tag>
          <span v-else class="muted">未知</span>
        </el-descriptions-item>
      </el-descriptions>

      <el-table :data="status.bots" stripe border class="bc-table">
        <el-table-column prop="displayName" label="名称" min-width="160" />
        <el-table-column prop="botId" label="botId" min-width="160" />
        <el-table-column prop="type" label="类型" width="110" />
        <el-table-column label="凭据分组" min-width="200">
          <template #default="{ row }">
            <el-select
              :model-value="row.credentialsRef || ''"
              size="small"
              :loading="!!row._binding"
              placeholder="未绑定"
              @change="(v) => bindBot(row, v)">
              <el-option label="未绑定" value="" />
              <el-option v-for="c in creds" :key="c.id" :label="c.label + '（' + c.id + '）'" :value="c.id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="状态" min-width="140">
          <template #default="{ row }">
            <el-tag v-if="!row.enabled" size="small" type="info">已禁用</el-tag>
            <el-tag v-else-if="!row.credentialsRef" size="small" type="warning">未绑定凭据</el-tag>
            <el-tag v-else-if="!credExists(row.credentialsRef)" size="small" type="danger">绑定凭据不存在</el-tag>
            <el-tag v-else-if="!credEnabled(row.credentialsRef)" size="small" type="warning">凭据已停用</el-tag>
            <el-tag v-else-if="!credHasSecret(row.credentialsRef)" size="small" type="danger">凭据缺少 Secret</el-tag>
            <el-tag v-else-if="refConnected(row.credentialsRef)" size="small" type="success">运行中</el-tag>
            <el-tag v-else size="small" type="warning">网关未连接</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="90">
          <template #default="{ row }">
            <el-switch :model-value="row.enabled" :loading="!!row._saving" @change="(v) => toggleBot(row, v)" />
          </template>
        </el-table-column>
      </el-table>

      <h4 class="bc-sub">连接明细</h4>
      <el-table :data="status.connections" stripe border class="bc-table">
        <el-table-column prop="ref" label="凭据分组" min-width="180" />
        <el-table-column prop="clientId" label="Client ID" min-width="200" />
        <el-table-column label="连接状态" min-width="160">
          <template #default="{ row }">
            <el-tag v-if="row.missingCredential" size="small" type="danger">凭据未配置</el-tag>
            <el-tag v-else size="small" :type="row.connected ? 'success' : 'info'">
              {{ row.connected ? '已连接' : '未连接' }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>

      <p v-if="status.detail" class="muted bc-detail">最近操作：{{ status.detail }}</p>
    </section>

    <!-- 凭据编辑弹窗 -->
    <el-dialog v-model="credDialog" :title="credEditing ? '编辑凭据：' + credForm.id : '新增凭据'" width="520px">
      <el-form label-width="140px">
        <el-form-item label="分组ID">
          <el-input v-model="credForm.id" :disabled="credEditing" placeholder="如 dingtalk:default" />
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="credForm.label" placeholder="展示名，留空则用分组ID" />
        </el-form-item>
        <el-form-item label="Client ID">
          <el-input v-model="credForm.clientId" placeholder="钉钉应用 Client ID" />
        </el-form-item>
        <el-form-item label="Client Secret">
          <el-input
            v-model="credForm.secret" type="password" show-password
            :placeholder="credEditing && credForm.hasSecret ? '已配置（留空表示不修改）' : '钉钉应用 Client Secret'" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="credForm.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="credDialog = false">取消</el-button>
        <el-button type="primary" :loading="savingCred" @click="saveCred">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { useAppStore } from '../stores/app.js';
import {
  fetchBotConfig, saveBotConfig, reloadBot, fetchBotStatus,
  setBotEnabled, setBotCredentialsRef, fetchBotCredentials, saveBotCredentials,
} from '../api/dashboards.js';

const app = useAppStore();
const bot = reactive({ aiCardTyping: true, dingbotQueryTimeout: 60, botEnabled: true });
const savingBot = ref(false);
const reloadingBot = ref(false);
const status = reactive({ gatewayConnected: null, botEnabled: true, bots: [], connections: [], detail: '' });
const lastUpdated = ref('');

const creds = ref([]);
const credDialog = ref(false);
const credEditing = ref(false);
const savingCred = ref(false);
const credForm = reactive({ id: '', label: '', clientId: '', secret: '', enabled: true, hasSecret: false });

let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => { void loadStatus(); }, 15000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function loadBot() {
  try {
    const r = await fetchBotConfig();
    const c = (r && r.config) || {};
    bot.aiCardTyping = c.aiCardTyping !== false;
    bot.dingbotQueryTimeout = c.dingbotQueryTimeout || 60;
    bot.botEnabled = c.botEnabled !== false;
  } catch (e) { app.toast(e.message || '加载机器人配置失败', 'error'); }
}
async function loadStatus() {
  try {
    const r = await fetchBotStatus();
    status.gatewayConnected = !!r.gatewayConnected;
    status.botEnabled = !!r.botEnabled;
    status.bots = Array.isArray(r.bots) ? r.bots : [];
    status.connections = Array.isArray(r.connections) ? r.connections : [];
    lastUpdated.value = new Date().toLocaleTimeString();
  } catch (e) { app.toast(e.message || '加载机器人状态失败', 'error'); }
}
async function loadCredentials() {
  try {
    const r = await fetchBotCredentials();
    creds.value = Array.isArray(r.groups) ? r.groups : [];
  } catch (e) { app.toast(e.message || '加载凭据分组失败', 'error'); }
}

async function saveBot() {
  savingBot.value = true;
  try {
    const r = await saveBotConfig({
      aiCardTyping: bot.aiCardTyping,
      dingbotQueryTimeout: bot.dingbotQueryTimeout,
      botEnabled: bot.botEnabled,
    });
    if (r.reload) status.detail = r.reload.detail;
    app.toast(
      '全局配置已保存' + (r.reload && r.reload.detail ? '（' + r.reload.detail + '）' : ''),
      'success',
    );
    await loadStatus();
  } catch (e) { app.toast(e.message || '保存失败', 'error'); }
  finally { savingBot.value = false; }
}
async function doReloadBot() {
  reloadingBot.value = true;
  try {
    const r = await reloadBot();
    if (r.reload) status.detail = r.reload.detail;
    app.toast((r.reload && r.reload.detail) ? r.reload.detail : '已重新连接', 'success');
    await loadStatus();
  } catch (e) { app.toast(e.message || '重连失败', 'error'); }
  finally { reloadingBot.value = false; }
}
async function toggleBot(row, v) {
  row._saving = true;
  try {
    const r = await setBotEnabled(row.botId, v);
    if (!r.ok) { app.toast(r.error || '操作失败', 'error'); }
    else { app.toast((v ? '已启用 ' : '已停用 ') + row.displayName, 'success'); }
  } catch (e) { app.toast(e.message || '操作失败', 'error'); }
  finally { row._saving = false; await loadStatus(); }
}
async function bindBot(row, v) {
  row._binding = true;
  try {
    const r = await setBotCredentialsRef(row.botId, v);
    if (!r.ok) { app.toast(r.error || '绑定失败', 'error'); }
    else { app.toast('已绑定 ' + row.displayName + ' → ' + (v || '未绑定'), 'success'); }
  } catch (e) { app.toast(e.message || '绑定失败', 'error'); }
  finally { row._binding = false; await loadStatus(); }
}

function refConnected(ref) {
  return !!status.connections.find((c) => c.ref === ref && c.connected);
}
function findCred(id) {
  return creds.value.find((c) => c.id === id);
}
function credExists(id) {
  return !!findCred(id);
}
function credEnabled(id) {
  const c = findCred(id);
  return !!c && c.enabled !== false;
}
function credHasSecret(id) {
  const c = findCred(id);
  return !!c && !!c.hasSecret;
}

function openCredAdd() {
  Object.assign(credForm, { id: '', label: '', clientId: '', secret: '', enabled: true, hasSecret: false });
  credEditing.value = false;
  credDialog.value = true;
}
function openCredEdit(row) {
  Object.assign(credForm, {
    id: row.id, label: row.label, clientId: row.clientId, secret: '', enabled: row.enabled, hasSecret: !!row.hasSecret,
  });
  credEditing.value = true;
  credDialog.value = true;
}
async function saveCred() {
  if (!credForm.id.trim()) { app.toast('分组ID不能为空', 'error'); return; }
  if (!credForm.clientId.trim()) { app.toast('Client ID不能为空', 'error'); return; }
  if (!credEditing.value && !credForm.secret.trim()) { app.toast('新增凭据必须填写 Secret', 'error'); return; }
  const next = credEditing.value
    ? creds.value.map((c) => (c.id === credForm.id ? credToPayload(c) : c))
    : [...creds.value, credToPayload(credForm)];
  savingCred.value = true;
  try {
    const r = await saveBotCredentials(next);
    if (!r.ok) { app.toast(r.error || '保存失败', 'error'); return; }
    creds.value = r.groups || [];
    credDialog.value = false;
    app.toast('凭据已保存', 'success');
    await loadStatus();
  } catch (e) { app.toast(e.message || '保存失败', 'error'); }
  finally { savingCred.value = false; }
}
function credToPayload(c) {
  return { id: c.id, label: c.label || c.id, clientId: c.clientId, secret: c.secret || '', enabled: c.enabled !== false };
}
async function deleteCred(row) {
  if (status.bots.some((b) => b.credentialsRef === row.id)) {
    app.toast('该凭据正被机器人实例引用，请先在实例中解绑', 'error');
    return;
  }
  const next = creds.value.filter((c) => c.id !== row.id);
  try {
    const r = await saveBotCredentials(next);
    if (!r.ok) { app.toast(r.error || '删除失败', 'error'); return; }
    creds.value = r.groups || [];
    app.toast('凭据已删除', 'success');
    await loadStatus();
  } catch (e) { app.toast(e.message || '删除失败', 'error'); }
}

onMounted(() => { loadBot(); loadStatus(); loadCredentials(); startPolling(); });
onUnmounted(stopPolling);
</script>

<style scoped>
.botcfg { padding: var(--sp-20); }
.v-title { margin: 0 0 var(--sp-16); font-size: var(--fs-title); }
.bc-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--sp-16) var(--sp-20); margin-bottom: var(--sp-16); }
.bc-h { margin: 0 0 var(--sp-12); font-size: var(--fs-subtitle); }
.bc-poll { font-size: 12px; color: var(--muted); font-weight: normal; margin-left: 8px; }
.bc-form { max-width: 560px; }
.bc-desc { max-width: 560px; margin-bottom: var(--sp-12); }
.bc-table { margin-top: var(--sp-8); }
.bc-sub { margin: var(--sp-16) 0 var(--sp-8); font-size: var(--fs-subtitle); }
.bc-tip { margin-top: var(--sp-8); }
.bc-detail { margin-top: var(--sp-8); }
.muted { color: var(--muted); }
</style>
