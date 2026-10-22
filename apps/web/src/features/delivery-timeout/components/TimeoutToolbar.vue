<template>
  <div class="dv-bar">
    <h2 class="v-title">配送超时</h2>
    <el-select
      :model-value="modelValue"
      class="dv-sel"
      placeholder="站点"
      @update:model-value="(v) => emit('update:modelValue', v)"
      @change="emit('change')"
    >
      <el-option label="全部站点" value="__all__" />
      <el-option v-for="t in teamOptions" :key="t.id" :label="t.name" :value="t.id" />
    </el-select>
    <el-button @click="emit('open-config')"><el-icon><Setting /></el-icon> 站点设置</el-button>
    <span v-if="fetchedAt" class="dv-date-tag">取数时间：{{ fetchedAt }}</span>
    <span class="sp" />
    <el-button
      type="primary"
      :loading="refreshing"
      :disabled="refreshing || cooldown > 0"
      :title="cooldown > 0 ? `刷新过于频繁，请等待 ${cooldown} 秒` : '拉取今日运单明细后重新计算'"
      @click="emit('refresh')"
    >
      <el-icon><Refresh /></el-icon>
      <span v-if="refreshing">刷新中…</span>
      <span v-else-if="cooldown > 0">请等待 {{ cooldown }}s</span>
      <span v-else>刷新数据</span>
    </el-button>
  </div>
</template>

<script setup>
import { Refresh, Setting } from '@element-plus/icons-vue';

defineProps({
  modelValue: { type: String, default: '__all__' },
  teamOptions: { type: Array, default: () => [] },
  fetchedAt: { type: String, default: '' },
  refreshing: { type: Boolean, default: false },
  cooldown: { type: Number, default: 0 },
});
const emit = defineEmits(['update:modelValue', 'change', 'open-config', 'refresh']);
</script>

<style scoped>
.dv-bar { display: flex; align-items: center; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.dv-sel { width: 160px; }
.dv-date-tag { font-size: var(--el-font-size-small); color: var(--el-text-color-secondary); }
.dv-bar .sp { flex: 1; }
</style>
