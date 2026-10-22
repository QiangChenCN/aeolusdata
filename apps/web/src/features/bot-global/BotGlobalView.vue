<template>
  <div class="bc">
    <h2 class="v-title">全局配置</h2>

    <!-- 机器人总开关：状态 + 开关二合一 -->
    <section class="bc-card">
      <h3 class="bc-h">机器人总开关</h3>
      <div class="sw-row">
        <el-switch :model-value="bot.botEnabled" :loading="savingBot" @change="saveBot" />
        <el-tag size="small" :type="switchState.type">{{ switchState.text }}</el-tag>
        <span class="muted">关闭则停止所有 Stream 连接（切换即时保存）</span>
      </div>
    </section>

    <!-- 机器人与实例绑定及状态（含网关连接状态） -->
    <section class="bc-card">
      <h3 class="bc-h">
        机器人与实例绑定及状态
        <span class="bc-poll" v-if="lastUpdated">· 自动刷新中 · 最近更新 {{ lastUpdated }}</span>
      </h3>

      <h4 class="bc-sub">实例绑定</h4>
      <el-table :data="status.bots" stripe border class="bc-table">
        <el-table-column prop="displayName" label="名称" min-width="160" />
        <el-table-column prop="botId" label="botId" min-width="160" />
        <el-table-column prop="type" label="实例类型" width="110" />
        <el-table-column label="推送渠道" min-width="100">
          <template #default="{ row }">
            <el-tag
              v-if="row.credentialsRef && findCred(row.credentialsRef)"
              size="small"
              :type="findCred(row.credentialsRef).type === 'wecom' ? 'warning' : 'success'">
              {{ typeLabel(findCred(row.credentialsRef).type) }}
            </el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
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
      <p class="muted bc-tip">
        每个机器人实例通过「凭据分组」绑定到一个应用凭据（钉钉 / 企微 等），运行时按分组各自建立独立的连接；未绑定则不参与消息收发。
      </p>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted } from 'vue';
import { useBotConfig } from '../../composables/useBotConfig.js';

const {
  bot, savingBot, status, lastUpdated, creds,
  loadAll, saveBot, toggleBot, bindBot,
  refConnected, credExists, credEnabled, credHasSecret, typeLabel, findCred, activate, deactivate,
} = useBotConfig();

const switchState = computed(() => {
  if (!bot.botEnabled) return { text: '已禁用', type: 'info' };
  if (status.gatewayConnected) return { text: '运行中', type: 'success' };
  return { text: '已停止', type: 'warning' };
});

onMounted(async () => { activate(); await loadAll(); });
onUnmounted(deactivate);
</script>

<style scoped>
.bc { padding: var(--sp-20); }
.v-title { margin: 0 0 var(--sp-16); font-size: var(--el-font-size-extra-large); }
.bc-card { background: var(--surface); border: 1px solid var(--el-border-color); border-radius: var(--r-lg); padding: var(--sp-16) var(--sp-20); margin-bottom: var(--sp-16); }
.bc-h { margin: 0 0 var(--sp-12); font-size: var(--el-font-size-medium); }
.bc-poll { font-size: 12px; color: var(--el-text-color-secondary); font-weight: normal; margin-left: 8px; }
.sw-row { display: flex; align-items: center; gap: var(--sp-10); }
.gw-row { display: flex; align-items: center; gap: var(--sp-10); margin-bottom: var(--sp-10); flex-wrap: wrap; }
.bc-table { margin-top: var(--sp-8); }
.bc-sub { margin: var(--sp-16) 0 var(--sp-8); font-size: var(--el-font-size-medium); }
.bc-tip { margin-top: var(--sp-8); }
.bc-detail { margin-top: var(--sp-8); }
.muted { color: var(--el-text-color-secondary); }
</style>
