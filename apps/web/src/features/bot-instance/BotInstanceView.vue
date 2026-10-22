<template>
  <div class="bc">
    <h2 class="v-title">实例配置</h2>
    <p class="muted bc-lead">配置每个机器人实例的参数。<b>显示名称 / 启用</b> 可在此调整并即时生效；<b>凭据绑定与运行状态</b> 请在「全局配置」中管理。</p>

    <div v-if="!status.bots.length" class="bc-empty muted">
      <el-icon><Loading /></el-icon><span>加载中…</span>
    </div>

    <div class="bc-grid">
      <section v-for="row in status.bots" :key="row.botId" class="inst-card">
        <header class="inst-head">
          <span class="inst-name">{{ row.displayName }}</span>
          <el-tag size="small" :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
        </header>

        <el-form label-width="92px" class="inst-form">
          <el-form-item label="显示名称">
            <el-input
              :model-value="row.displayName"
              size="default"
              :loading="!!row._saving"
              placeholder="实例展示名"
              @change="(v) => renameInstance(row, v)" />
          </el-form-item>
          <el-form-item label="实例ID">
            <el-input :model-value="row.botId" disabled />
          </el-form-item>
          <el-form-item label="推送渠道">
            <el-input :model-value="row.credentialsRef ? (findCred(row.credentialsRef) ? typeLabel(findCred(row.credentialsRef).type) : '未绑定') : '未绑定'" disabled />
          </el-form-item>
          <el-form-item label="查询超时(秒)">
            <el-input-number :model-value="row.queryTimeout" :min="5" :max="600" :loading="!!row._saving" @change="(v) => setBotTimeout(row, v)" />
          </el-form-item>
          <el-form-item label="启用">
            <el-switch :model-value="row.enabled" :loading="!!row._saving" @change="(v) => toggleBot(row, v)" />
          </el-form-item>
        </el-form>

        <footer class="inst-foot">
          <span v-if="!row.credentialsRef" class="inst-warn">未绑定凭据</span>
          <span v-else-if="!credExists(row.credentialsRef)" class="inst-warn">绑定凭据不存在</span>
          <span v-else-if="!credEnabled(row.credentialsRef)" class="inst-warn">凭据已停用</span>
          <span v-else-if="!credHasSecret(row.credentialsRef)" class="inst-warn">凭据缺少 Secret</span>
          <span v-else-if="refConnected(row.credentialsRef)" class="inst-ok">运行中</span>
          <span v-else class="inst-warn">网关未连接</span>
          <span class="inst-hint">凭据绑定请在「全局配置」中设置</span>
        </footer>
      </section>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue';
import { useBotConfig } from '../../composables/useBotConfig.js';

const {
  status, creds, loadAll, renameInstance, toggleBot, setBotTimeout,
  refConnected, credExists, credEnabled, credHasSecret, typeLabel, findCred, activate, deactivate,
} = useBotConfig();

onMounted(async () => { activate(); await loadAll(); });
onUnmounted(deactivate);
</script>

<style scoped>
.bc { padding: var(--sp-20); }
.v-title { margin: 0 0 var(--sp-8); font-size: var(--el-font-size-extra-large); }
.bc-lead { margin: 0 0 var(--sp-16); }
.bc-lead b { color: var(--el-text-color-primary); }
.bc-empty { display: flex; align-items: center; gap: var(--sp-8); padding: var(--sp-24); }
.bc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--sp-16); }
.inst-card { background: var(--surface); border: 1px solid var(--el-border-color); border-radius: var(--r-lg); padding: var(--sp-16) var(--sp-18); display: flex; flex-direction: column; }
.inst-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-8); margin-bottom: var(--sp-12); }
.inst-name { font-size: var(--el-font-size-medium); font-weight: var(--fw-semibold); color: var(--el-text-color-primary); }
.inst-form { flex: 1; }
.inst-form :deep(.el-form-item) { margin-bottom: var(--sp-12); }
.inst-foot { border-top: 1px solid var(--el-border-color-lighter); padding-top: var(--sp-10); margin-top: var(--sp-4); font-size: 12px; }
.inst-ok { color: var(--ok, #2ba471); font-weight: var(--fw-semibold); }
.inst-warn { color: var(--warn, #e6a23c); }
.inst-hint { color: var(--el-text-color-secondary); display: block; margin-top: var(--sp-4); }
.muted { color: var(--el-text-color-secondary); }
</style>
