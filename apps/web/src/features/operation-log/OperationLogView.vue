<template>
  <div class="op-log">
    <div class="op-head">
      <h2 class="op-title">操作日志</h2>
      <span class="op-sub">全项目级溯源：谁 · 时间 · 用什么代码 · 操作了什么</span>
    </div>

    <el-form class="op-filter" :inline="true" @submit.prevent="load">
      <el-form-item label="操作者">
        <el-input v-model="f.actor" placeholder="system / 用户名 / machine" clearable style="width: 190px" />
      </el-form-item>
      <el-form-item label="动作">
        <el-input v-model="f.action" placeholder="rollup.history / GET /api/..." clearable style="width: 240px" />
      </el-form-item>
      <el-form-item label="起始">
        <el-date-picker v-model="f.from" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" :clearable="true" />
      </el-form-item>
      <el-form-item label="结束">
        <el-date-picker v-model="f.to" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" :clearable="true" />
      </el-form-item>
      <el-form-item label="条数">
        <el-input-number v-model="f.limit" :min="1" :max="500" :step="50" controls-position="right" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="load">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </el-form-item>
    </el-form>

    <el-alert v-if="error" type="error" :title="error" show-icon class="op-err" />

    <el-table
      :data="rows"
      v-loading="loading"
      stripe
      border
      class="op-table"
      empty-text="暂无记录"
    >
      <el-table-column prop="ts" label="时间" width="180" />
      <el-table-column prop="actor" label="操作者" width="150" />
      <el-table-column prop="method" label="方法" width="80" />
      <el-table-column prop="action" label="动作" min-width="240" show-overflow-tooltip />
      <el-table-column prop="target" label="对象" width="170" show-overflow-tooltip />
      <el-table-column prop="code" label="代码" width="260" show-overflow-tooltip />
      <el-table-column prop="status" label="状态" width="80" />
      <el-table-column prop="duration_ms" label="耗时(ms)" width="100" />
      <el-table-column label="详情" min-width="220">
        <template #default="{ row }">
          <el-tooltip :content="row.detail || '-'" placement="top" :disabled="!row.detail">
            <span class="op-detail">{{ row.detail || '-' }}</span>
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { fetchOperationLog } from '../../api/operation-log.js';

const rows = ref([]);
const loading = ref(false);
const error = ref('');
const f = reactive({ actor: '', action: '', from: '', to: '', limit: 100 });

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const r = await fetchOperationLog({ ...f });
    rows.value = (r && r.logs) || [];
  } catch (e) {
    error.value = (e && e.message) || '查询失败';
  } finally {
    loading.value = false;
  }
}

function reset() {
  f.actor = '';
  f.action = '';
  f.from = '';
  f.to = '';
  f.limit = 100;
  load();
}

onMounted(load);
</script>

<style scoped>
.op-log { padding: 16px; }
.op-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.op-title { margin: 0; font-size: 18px; }
.op-sub { color: var(--el-text-color-secondary); font-size: 13px; }
.op-filter { margin-bottom: 12px; flex-wrap: wrap; }
.op-err { margin-bottom: 12px; }
.op-table { width: 100%; }
.op-detail {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
