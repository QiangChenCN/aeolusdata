import { reactive, ref } from 'vue';
import {
  fetchBotConfig, saveBotConfig, reloadBot, fetchBotStatus,
  fetchBotCredentials, saveBotCredentials, patchBot,
} from '../api/dashboards.js';

/* 模块级共享状态：三个机器人配置子页（全局/机器人/实例）共用同一份数据与连接轮询 */
const bot = reactive({ botEnabled: true });
const savingBot = ref(false);
const reloadingBot = ref(false);

const status = reactive({ gatewayConnected: null, botEnabled: true, bots: [], connections: [], detail: '' });
const lastUpdated = ref('');

const creds = ref([]);
const credsLoading = ref(false);

const credDialog = ref(false);
const credEditing = ref(false);
const savingCred = ref(false);
const credForm = reactive({ id: '', label: '', clientId: '', secret: '', enabled: true, aiCardTyping: true, hasSecret: false, type: 'dingtalk' });

let pollTimer = null;
let consumerCount = 0;

export function useBotConfig() {

  /* ── 加载 ─────────────────────────────────────────── */
  async function loadBot() {
    try {
      const r = await fetchBotConfig();
      const c = (r && r.config) || {};
      bot.botEnabled = c.botEnabled !== false;
    } catch (e) { ElMessage.error(e.message || '加载机器人配置失败'); }
  }
  async function loadStatus() {
    try {
      const r = await fetchBotStatus();
      status.gatewayConnected = !!r.gatewayConnected;
      status.botEnabled = !!r.botEnabled;
      status.bots = Array.isArray(r.bots) ? r.bots : [];
      status.connections = Array.isArray(r.connections) ? r.connections : [];
      lastUpdated.value = new Date().toLocaleTimeString();
    } catch (e) { ElMessage.error(e.message || '加载机器人状态失败'); }
  }
  async function loadCredentials() {
    credsLoading.value = true;
    try {
      const r = await fetchBotCredentials();
      creds.value = Array.isArray(r.groups) ? r.groups : [];
    } catch (e) { ElMessage.error(e.message || '加载凭据分组失败'); }
    finally { credsLoading.value = false; }
  }
  async function loadAll() { await Promise.all([loadBot(), loadStatus(), loadCredentials()]); }

  /* ── 全局开关（开关即保存，并触发连接重建） ──────── */
  async function saveBot(v) {
    if (typeof v === 'boolean') bot.botEnabled = v;
    savingBot.value = true;
    try {
      const r = await saveBotConfig({ botEnabled: bot.botEnabled });
      if (r.reload) status.detail = r.reload.detail;
      ElMessage.success('总开关已更新' + (r.reload && r.reload.detail ? '（' + r.reload.detail + '）' : ''));
      await loadStatus();
    } catch (e) { ElMessage.error(e.message || '保存失败'); }
    finally { savingBot.value = false; }
  }
  async function doReload() {
    reloadingBot.value = true;
    try {
      const r = await reloadBot();
      if (r.reload) status.detail = r.reload.detail;
      ElMessage.success((r.reload && r.reload.detail) ? r.reload.detail : '已重新连接');
      await loadStatus();
    } catch (e) { ElMessage.error(e.message || '重连失败'); }
    finally { reloadingBot.value = false; }
  }

  /* ── 机器人与实例绑定 / 启停 ──────────────────────── */
  async function toggleBot(row, v) {
    row._saving = true;
    try {
      const r = await patchBot(row.botId, { enabled: v });
      if (!r.ok) ElMessage.error(r.error || '操作失败');
      else ElMessage.success((v ? '已启用 ' : '已停用 ') + row.displayName);
    } catch (e) { ElMessage.error(e.message || '操作失败'); }
    finally { row._saving = false; await loadStatus(); }
  }
  async function bindBot(row, v) {
    row._binding = true;
    try {
      const r = await patchBot(row.botId, { credentialsRef: v });
      if (!r.ok) ElMessage.error(r.error || '绑定失败');
      else ElMessage.success('已绑定 ' + row.displayName + ' → ' + (v || '未绑定'));
    } catch (e) { ElMessage.error(e.message || '绑定失败'); }
    finally { row._binding = false; await loadStatus(); }
  }
  async function renameInstance(row, name) {
    const n = (name || '').trim();
    if (!n) { ElMessage.error('名称不能为空'); return; }
    row._saving = true;
    try {
      const r = await patchBot(row.botId, { displayName: n });
      if (!r.ok) ElMessage.error(r.error || '重命名失败');
      else ElMessage.success('已更新实例名称');
    } catch (e) { ElMessage.error(e.message || '操作失败'); }
    finally { row._saving = false; await loadStatus(); }
  }
  async function setBotTimeout(row, v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 5 || n > 600) { ElMessage.error('查询超时需在 5~600 秒之间'); return; }
    row._saving = true;
    try {
      const r = await patchBot(row.botId, { queryTimeout: n });
      if (!r.ok) ElMessage.error(r.error || '操作失败');
      else ElMessage.success('已更新查询超时');
    } catch (e) { ElMessage.error(e.message || '操作失败'); }
    finally { row._saving = false; await loadStatus(); }
  }

  function refConnected(ref) {
    return !!status.connections.find((c) => c.ref === ref && c.connected);
  }
  function connOf(ref) {
    return status.connections.find((c) => c.ref === ref) || null;
  }
  function findCred(id) { return creds.value.find((c) => c.id === id); }
  function credExists(id) { return !!findCred(id); }
  function credEnabled(id) { const c = findCred(id); return !!c && c.enabled !== false; }
  function credHasSecret(id) { const c = findCred(id); return !!c && !!c.hasSecret; }

  /* ── 凭据分组（机器人）CRUD ──────────────────────── */
  function openCredAdd() {
    Object.assign(credForm, { id: '', label: '', clientId: '', secret: '', enabled: true, aiCardTyping: true, hasSecret: false, type: 'dingtalk' });
    credEditing.value = false;
    credDialog.value = true;
  }
  function openCredEdit(row) {
    Object.assign(credForm, {
      id: row.id, label: row.label, clientId: row.clientId, secret: '', enabled: row.enabled, aiCardTyping: row.aiCardTyping !== false, hasSecret: !!row.hasSecret, type: row.type || 'dingtalk',
    });
    credEditing.value = true;
    credDialog.value = true;
  }
  function credToPayload(c) {
    return { id: c.id, label: c.label || c.id, clientId: c.clientId, secret: c.secret || '', enabled: c.enabled !== false, aiCardTyping: c.aiCardTyping !== false, type: c.type || 'dingtalk' };
  }
  function typeLabel(t) {
    return ({ dingtalk: '钉钉', wecom: '企微' })[t] || (t ? t : '未设置');
  }
  async function saveCred() {
    if (!credForm.id.trim()) { ElMessage.error('分组ID不能为空'); return; }
    if (!credForm.clientId.trim()) { ElMessage.error('Client ID不能为空'); return; }
    if (!credEditing.value && !credForm.secret.trim()) { ElMessage.error('新增凭据必须填写 Secret'); return; }
    const next = credEditing.value
      ? creds.value.map((c) => (c.id === credForm.id ? credToPayload(credForm) : c))
      : [...creds.value, credToPayload(credForm)];
    savingCred.value = true;
    try {
      const r = await saveBotCredentials(next);
      if (!r.ok) { ElMessage.error(r.error || '保存失败'); return; }
      creds.value = r.groups || [];
      credDialog.value = false;
      ElMessage.success('凭据已保存');
      await loadStatus();
    } catch (e) { ElMessage.error(e.message || '保存失败'); }
    finally { savingCred.value = false; }
  }
  async function deleteCred(row) {
    if (status.bots.some((b) => b.credentialsRef === row.id)) {
      ElMessage.error('该凭据正被机器人实例引用，请先在实例中解绑');
      return;
    }
    const next = creds.value.filter((c) => c.id !== row.id);
    try {
      const r = await saveBotCredentials(next);
      if (!r.ok) { ElMessage.error(r.error || '删除失败'); return; }
      creds.value = r.groups || [];
      ElMessage.success('凭据已删除');
      await loadStatus();
    } catch (e) { ElMessage.error(e.message || '删除失败'); }
  }

  /* ── 轮询（按引用计数，仅最后一个子页卸载时停） ───── */
  function activate() {
    consumerCount++;
    if (!pollTimer) pollTimer = setInterval(() => { void loadStatus(); }, 15000);
  }
  function deactivate() {
    consumerCount = Math.max(0, consumerCount - 1);
    if (consumerCount === 0 && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  return {
    bot, savingBot, reloadingBot, status, lastUpdated, creds, credsLoading,
    credDialog, credEditing, savingCred, credForm,
    loadAll, loadStatus, saveBot, doReload,
    toggleBot, bindBot, renameInstance, setBotTimeout,
    refConnected, connOf, findCred, credExists, credEnabled, credHasSecret,
    openCredAdd, openCredEdit, saveCred, deleteCred, credToPayload, typeLabel,
    activate, deactivate,
  };
}
