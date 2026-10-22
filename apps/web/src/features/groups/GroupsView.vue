<template>
  <div class="grp">
    <div class="grp-bar">
      <h2 class="v-title">群组</h2>
      <span class="v-sub">按名称检索风神群组，或勾选常用群组快速复用</span>
    </div>

    <el-input
      v-model="q"
      class="grp-search"
      placeholder="输入群组名称关键词检索…"
      clearable
      :prefix-icon="Search"
      @input="onInput"
    />

    <div v-if="loading" class="grp-state"><el-icon class="is-loading"><Loading /></el-icon> 检索中…</div>
    <div v-else-if="!groups.length" class="grp-state grp-empty">
      {{ q ? '未找到匹配群组' : '暂无最近使用的群组，试着搜索一下' }}
    </div>
    <ul v-else class="grp-list">
      <li v-for="g in groups" :key="g.id" class="grp-item" :class="{ recent: g.recent }">
        <div class="grp-info">
          <span class="grp-title">{{ g.title }}</span>
          <span v-if="g.recent" class="grp-flag">最近</span>
          <span v-if="g.score != null" class="grp-score">{{ g.score }}</span>
        </div>
        <div class="grp-acts">
          <el-button size="small" type="primary" plain @click="useGroup(g)">记录</el-button>
          <el-button v-if="g.recent" size="small" text type="danger" @click="forget(g)">遗忘</el-button>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { Search } from '@element-plus/icons-vue';
import { fetchGroups, markGroupUsed, forgetGroup } from '../../api/dashboards.js';

const q = ref('');
const groups = ref([]);
const loading = ref(false);
let timer = null;

async function doFetch() {
  loading.value = true;
  try {
    const res = await fetchGroups(q.value);
    groups.value = (res && res.groups) || [];
  } catch (e) {
    ElMessage.error(e.message || '检索失败');
    groups.value = [];
  } finally {
    loading.value = false;
  }
}
function onInput() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(doFetch, 300);
}

async function useGroup(g) {
  try {
    await markGroupUsed(g.id, g.title);
    ElMessage.success('已记录群组：' + g.title);
    if (!q.value) doFetch();
  } catch (e) { ElMessage.error(e.message || '记录失败'); }
}
async function forget(g) {
  try {
    await forgetGroup(g.id);
    ElMessage.info('已遗忘：' + g.title);
    doFetch();
  } catch (e) { ElMessage.error(e.message || '操作失败'); }
}
onMounted(doFetch);
</script>

<style scoped>
.grp { padding: var(--sp-20); max-width: 760px; margin: 0 auto; }
.grp-bar { margin-bottom: var(--sp-16); }
.v-title { margin: 0 0 var(--sp-6); font-size: var(--el-font-size-extra-large); }
.v-sub { color: var(--el-text-color-secondary); font-size: var(--el-font-size-base); }
.grp-search { margin-bottom: var(--sp-16); }
.grp-state { padding: var(--sp-24); text-align: center; color: var(--el-text-color-secondary); display: flex; gap: var(--sp-8); justify-content: center; align-items: center; }
.grp-list { list-style: none; margin: 0; padding: 0; }
.grp-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--sp-12) var(--sp-14); border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base); margin-bottom: var(--sp-8); background: var(--el-bg-color);
}
.grp-item.recent { background: var(--el-color-primary-light-9); }
.grp-info { display: flex; align-items: center; gap: var(--sp-8); }
.grp-title { font-weight: var(--fw-semibold); }
.grp-flag { font-size: var(--el-font-size-extra-small); color: var(--el-color-primary); border: 1px solid var(--el-color-primary); border-radius: var(--el-border-radius-base); padding: 0 var(--sp-6); }
.grp-score { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.grp-acts { display: flex; gap: var(--sp-6); }
</style>
