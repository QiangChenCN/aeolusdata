<template>
  <el-dialog
    v-model="visible"
    :title="title"
    width="82%"
    top="5vh"
    append-to-body
    @open="onOpen"
  >
    <div class="log-toolbar">
      <el-tag size="small" :type="statusTag">{{ statusText }}</el-tag>
      <span v-if="run && run.cmd" class="log-cmd" :title="run.cmd">{{ run.cmd }}</span>
      <span class="sp" />
      <label class="autoscroll">
        <el-switch v-model="autoScroll" size="small" /> 自动滚动
      </label>
      <el-button size="small" @click="copy"><el-icon><DocumentCopy /></el-icon> 复制</el-button>
      <el-button size="small" @click="download"><el-icon><Download /></el-icon> 下载</el-button>
      <el-button v-if="isRunning" size="small" type="danger" :loading="stopping" @click="stop">
        <el-icon><VideoPause /></el-icon> 停止
      </el-button>
    </div>
    <div ref="termEl" class="term log-term">
      <div v-for="(l, i) in lines" :key="i" class="log-line" :class="lineCls(l)">{{ l }}</div>
      <div v-if="!lines.length" class="log-empty">暂无日志输出</div>
    </div>
  </el-dialog>
</template>

<script setup>
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { useRunsStore } from '../../stores/runs.js';
import { useAppStore } from '../../stores/app.js';

const runs = useRunsStore();
const app = useAppStore();

const visible = computed({
  get: () => !!runs.modalRunId,
  set: (v) => { if (!v) runs.closeLog(); },
});
const run = computed(() => runs.modalRun || null);
const lines = computed(() => (run.value && run.value.lines) || []);
const isRunning = computed(() => run.value && run.value.status === 'running');

const statusText = computed(() => {
  const s = run.value && run.value.status;
  return { running: '执行中', failed: '失败', success: '成功', stopped: '已停止', queued: '排队中' }[s] || s || '未开始';
});
function statusTag(s) {
  return s === 'success' ? 'success' : s === 'failed' ? 'danger'
    : s === 'running' ? 'warning' : s === 'stopped' ? 'info' : s === 'queued' ? 'warning' : 'info';
}
const title = computed(() => (run.value && run.value.name ? '运行日志 · ' + run.value.name : '运行日志'));

const termEl = ref(null);
const autoScroll = ref(true);
const stopping = ref(false);

function onOpen() { nextTick(scrollToEnd); }
watch(() => lines.value.length, () => { if (autoScroll.value) nextTick(scrollToEnd); });

// SSE 在开发代理下可能被缓冲/丢事件，导致实时日志不全。
// 弹窗打开期间轮询 /api/log（走普通 fetch，代理正常）持续回填权威完整行，
// 保证「站点明细→汇总→渲染→上传→发送」整段都能看到，且跑完也能补齐。
let pollTimer = null;
function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => { if (runs.modalRunId) runs.syncLog(runs.modalRunId); }, 700);
}
function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
watch(visible, (v) => { if (v) startPoll(); else stopPoll(); });
onBeforeUnmount(stopPoll);
function scrollToEnd() {
  const el = termEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function lineCls(l) {
  if (/^✗|\[错误\]|\[失败\]/.test(l)) return 'l-bad';
  if (/^✓|\[完成\]|\[开始\]|\[系统\]/.test(l)) return 'l-sys';
  if (/^\$ /.test(l)) return 'l-cmd';
  if (/\b建议[:：]/.test(l)) return 'l-warn';
  return '';
}

async function copy() {
  try {
    await navigator.clipboard.writeText(lines.value.join('\n'));
    app.toast('已复制日志', 'success');
  } catch (e) {
    app.toast('复制失败，请手动选择', 'error');
  }
}
function download() {
  const blob = new Blob([lines.value.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (run.value && run.value.run_id ? run.value.run_id : 'log') + '.log';
  a.click();
  URL.revokeObjectURL(url);
}
async function stop() {
  if (!runs.modalRunId) return;
  stopping.value = true;
  try {
    await runs.stop(runs.modalRunId);
    app.toast('已发送停止指令', 'info');
  } catch (e) {
    app.toast(e.message, 'error');
  } finally {
    stopping.value = false;
  }
}
</script>

<style scoped>
.log-toolbar { display: flex; align-items: center; gap: var(--sp-10); margin-bottom: var(--sp-10); flex-wrap: wrap; }
.log-cmd {
  font-family: var(--font-mono); font-size: 12px; color: var(--muted);
  max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.log-toolbar .sp { flex: 1; }
.autoscroll { display: inline-flex; align-items: center; gap: var(--sp-6); color: var(--muted); font-size: var(--fs-caption); }
.log-term { height: 60vh; overflow: auto; padding: var(--sp-12); }
.log-line { white-space: pre-wrap; word-break: break-all; }
.log-empty { color: var(--term-dim); }
</style>
