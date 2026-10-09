<template>
  <el-dialog v-model="visible" :title="title" width="70%" top="6vh" append-to-body>
    <div v-if="artifact.loading" class="ab-state">
      <el-icon class="is-loading"><Loading /></el-icon> 加载产物中…
    </div>
    <div v-else-if="!files.length" class="ab-state">该任务暂无产物输出</div>
    <div v-else class="ab">
      <div class="ab-list">
        <div
          v-for="f in files" :key="f.rel"
          class="ab-item" :class="{ on: selected && selected.rel === f.rel }"
          @click="selected = f"
        >
          <el-icon class="ab-ic"><component :is="iconOf(f.type)" /></el-icon>
          <div class="ab-meta">
            <span class="ab-name" :title="f.name">{{ f.name }}</span>
            <span class="ab-sub">{{ f.type }} · {{ fmtSize(f.size) }} · {{ f.mtime }}</span>
          </div>
        </div>
      </div>
      <div class="ab-preview">
        <img v-if="isImg(selected)" :src="url(selected)" class="ab-img" :alt="selected.name" />
        <iframe v-else-if="isHtml(selected)" :src="url(selected)" class="ab-frame" />
        <div v-else-if="isText(selected)" class="ab-text">
          <div v-if="textLoading" class="ab-state"><el-icon class="is-loading"><Loading /></el-icon> 加载中…</div>
          <template v-else>
            <pre class="ab-pre">{{ textContent }}</pre>
            <div class="ab-text-bar">
              <el-button size="small" tag="a" :href="url(selected)" target="_blank" rel="noopener">
                <el-icon><TopRight /></el-icon> 打开 / 下载
              </el-button>
            </div>
          </template>
        </div>
        <div v-else-if="selected" class="ab-other">
          <p class="ab-other-tip">该类型不支持内联预览，可点击打开 / 下载：</p>
          <el-button type="primary" tag="a" :href="url(selected)" target="_blank" rel="noopener">
            <el-icon><TopRight /></el-icon> 打开 / 下载
          </el-button>
        </div>
        <div v-else class="ab-hint">← 选择左侧文件预览</div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useArtifactStore } from '../../stores/artifact.js';
import { useTasksStore } from '../../stores/tasks.js';
import { artifactUrl } from '../../api/runs.js';

const artifact = useArtifactStore();
const tasks = useTasksStore();

const visible = computed({
  get: () => artifact.visible,
  set: (v) => { if (!v) artifact.close(); },
});
const files = computed(() => artifact.files || []);
const selected = ref(null);
const textContent = ref('');
const textLoading = ref(false);

// 切换任务时重置选中
watch(() => artifact.taskId, () => { selected.value = null; });

// 文本类（含 json / jsonl / txt / csv / md / log …）产物内联预览：选中后拉取内容，JSON 自动美化
const TEXT_TYPES = new Set(['text', 'html']);
watch(
  () => (selected.value ? selected.value.rel : null),
  async (rel) => {
    textContent.value = '';
    if (!rel) return;
    const f = selected.value;
    if (!f || !TEXT_TYPES.has(f.type)) return;
    textLoading.value = true;
    try {
      const res = await fetch(artifactUrl(f.rel), { credentials: 'include' });
      const t = await res.text();
      // JSON 美化；解析失败（如 jsonl / 截断）则保留原文
      if (/^\s*[[{]/.test(t)) {
        try { textContent.value = JSON.stringify(JSON.parse(t), null, 2); } catch { textContent.value = t; }
      } else {
        textContent.value = t;
      }
    } catch {
      textContent.value = '（预览加载失败）';
    } finally {
      textLoading.value = false;
    }
  },
);

const title = computed(() => {
  const t = tasks.taskById(artifact.taskId);
  return '产物浏览器' + (t ? ' · ' + t.name : '');
});

function iconOf(type) {
  return type === 'image' ? 'Picture'
    : type === 'html' ? 'Document'
    : type === 'text' ? 'Document'
    : type === 'sheet' ? 'Grid'
    : 'Files';
}
function isImg(f) { return f && f.type === 'image'; }
function isText(f) { return f && f.type === 'text'; }
function isHtml(f) { return f && f.type === 'html'; }
function url(f) { return f ? artifactUrl(f.rel) : ''; }
function fmtSize(b) {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}
</script>

<style scoped>
.ab-state { padding: var(--sp-40); text-align: center; color: var(--muted); display: flex; align-items: center; justify-content: center; gap: var(--sp-8); }
.ab { display: grid; grid-template-columns: 280px 1fr; gap: var(--sp-12); height: 60vh; }
.ab-list { overflow: auto; border-right: 1px solid var(--border-soft); padding-right: var(--sp-8); }
.ab-item {
  display: flex; align-items: center; gap: var(--sp-10); padding: var(--sp-10) var(--sp-8);
  border-radius: var(--r-md); cursor: pointer;
}
.ab-item:hover { background: var(--surface-sunken); }
.ab-item.on { background: var(--brand-soft); }
.ab-ic { font-size: 18px; color: var(--muted); flex: none; }
.ab-meta { display: flex; flex-direction: column; min-width: 0; }
.ab-name { font-weight: var(--fw-semibold); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ab-sub { font-size: var(--el-font-size-extra-small); color: var(--muted); }
.ab-preview { overflow: hidden; display: flex; align-items: center; justify-content: center; background: var(--surface-sunken); border-radius: var(--r-md); }
.ab-img { max-width: 100%; max-height: 100%; object-fit: contain; }
.ab-frame { width: 100%; height: 100%; border: 0; background: #fff; }
.ab-text { width: 100%; height: 100%; display: flex; flex-direction: column; }
.ab-pre { flex: 1; margin: 0; padding: var(--sp-12); overflow: auto; white-space: pre-wrap; word-break: break-all; font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 13px; line-height: 1.55; text-align: left; }
.ab-text-bar { flex: none; padding: var(--sp-8) var(--sp-12); border-top: 1px solid var(--border-soft); text-align: right; background: var(--card); }
.ab-other { text-align: center; }
.ab-other-tip { color: var(--muted); margin-top: 0; }
.ab-hint { color: var(--muted); }
</style>
