<template>
  <el-card class="task-card" :class="['card--' + (status || 'none'), { 'is-running': running }]" shadow="never">
    <span class="tc-accent" :style="{ background: groupColor }"></span>

    <div class="tc-head">
      <div class="tc-title">
        <span class="tc-ico" :style="{ '--tone': groupColor }">
          <el-icon><component :is="groupIcon" /></el-icon>
        </span>
        <h3 class="tc-name" :title="task.name">{{ task.name }}</h3>
        <span class="tc-badge" :class="'tc-badge--' + (status || 'none')">
          <i class="tc-badge-dot"></i>{{ statusText }}
        </span>
      </div>
      <div class="tc-meta">
        <span class="gchip" :style="{ '--tone': groupColor }">{{ groupName }}</span>
        <el-tag size="small" :type="riskTag">{{ riskLabel }}</el-tag>
        <el-tooltip v-if="task.prereq_note" :content="task.prereq_note">
          <el-tag size="small" type="warning">前置</el-tag>
        </el-tooltip>
      </div>
    </div>

    <p v-if="task.desc" class="tc-desc">{{ task.desc }}</p>

    <div class="tc-outs">
      <el-icon><Document /></el-icon>
      <span>产物：{{ (task.outputs && task.outputs.length) ? task.outputs.join('、') : '—' }}</span>
    </div>

    <div v-if="task.missing && task.missing.length" class="tc-note">
      <el-icon><WarningFilled /></el-icon>
      <span :title="'缺少前置产物：' + missingText">缺少前置产物：{{ missingText }}</span>
    </div>

    <!-- 执行节点区间 -->
    <div v-if="nodes.length" class="tc-nodes">
      <span class="tc-nodes-label">执行节点</span>
      <div class="tc-nodes-sels">
        <el-select
          :model-value="beginVal" size="small" placeholder="开始" style="width: 130px"
          @update:model-value="(v) => setNode('begin', v)"
        >
          <el-option v-for="n in nodes" :key="n.id" :label="n.name" :value="n.id" />
        </el-select>
        <span class="tc-arrow">→</span>
        <el-select
          :model-value="endVal" size="small" placeholder="结束" style="width: 130px"
          @update:model-value="(v) => setNode('end', v)"
        >
          <el-option v-for="n in nodes" :key="n.id" :label="n.name" :value="n.id" />
        </el-select>
        <span v-if="nodeInvalid" class="tc-nodes-err">{{ nodeInvalid }}</span>
      </div>
    </div>

    <div class="tc-foot">
      <div class="tc-actions">
        <el-button size="small" @click="$emit('config', task.id)">
          <el-icon><Setting /></el-icon>配置
        </el-button>
        <el-tooltip :content="runDisabled ? (nodeInvalid || (running ? '运行中' : '')) : ''">
          <el-button
            size="small" type="primary" :loading="running" :disabled="runDisabled"
            @click="$emit('run', task)"
          >
            <el-icon><VideoPlay /></el-icon>运行
          </el-button>
        </el-tooltip>
      </div>
      <el-button class="tc-art" size="small" text @click="$emit('artifacts', task.id)">
        <el-icon><Files /></el-icon>查看产物
      </el-button>
    </div>

    <div v-if="last" class="tc-last">
      <el-icon><Clock /></el-icon><span :title="lastText">{{ lastText }}</span>
    </div>
  </el-card>
</template>

<script setup>
import { computed } from 'vue';
import { useTasksStore } from '../../stores/tasks.js';
import { useRunsStore } from '../../stores/runs.js';
import { STATUS_TXT, RISK_LABEL, GROUP_ICONS } from '../../utils/tokens.js';

const props = defineProps({ task: { type: Object, required: true } });
defineEmits(['config', 'run', 'artifacts']);

const tasks = useTasksStore();
const runs = useRunsStore();

const groupColor = computed(() => { const g = tasks.groupById(props.task.group); return g ? g.color : '#999'; });
const groupName = computed(() => { const g = tasks.groupById(props.task.group); return g ? g.name : props.task.group; });
const groupIcon = computed(() => GROUP_ICONS[props.task.group] || 'Grid');

const status = computed(() => {
  if (runs.runningTaskId === props.task.id) return 'running';
  return props.task.status || '';
});
const statusText = computed(() => STATUS_TXT[status.value] || status.value || '未运行');
const riskLabel = computed(() => RISK_LABEL[props.task.risk] || '只读');
const riskTag = computed(() => (props.task.risk === 'danger' ? 'danger' : 'success'));

const running = computed(() => status.value === 'running');
const nodes = computed(() => props.task.nodes || []);
const beginVal = computed(() => tasks.argValue(props.task.id, '--begin', beginParam.value && beginParam.value.default || ''));
const endVal = computed(() => tasks.argValue(props.task.id, '--end', endParam.value && endParam.value.default || ''));
const beginParam = computed(() => (props.task.params || []).find((p) => p.flag === '--begin'));
const endParam = computed(() => (props.task.params || []).find((p) => p.flag === '--end'));
const nodeInvalid = computed(() => {
  const b = beginVal.value, e = endVal.value;
  if (!b && !e) return '未选择节点';
  const bi = nodes.value.findIndex((n) => n.id === b);
  const ei = nodes.value.findIndex((n) => n.id === e);
  if (bi < 0) return '开始节点不在列表中';
  if (ei >= 0 && ei < bi) return '结束节点不得早于开始节点';
  return '';
});
function setNode(which, val) { tasks.setArg(props.task.id, which === 'begin' ? '--begin' : '--end', val || ''); }
const runDisabled = computed(() => running.value || !!nodeInvalid.value);
const missingText = computed(() => (props.task.missing || []).map((m) => m.name || m).join('、'));
const last = computed(() => runs.history.filter((h) => h.task_id === props.task.id)[0] || null);
const lastText = computed(() => {
  const h = last.value; if (!h) return '';
  return (h.start || '') + ' · ' + (h.duration || 0) + 's · ' + (h.error_kind || h.status);
});
</script>

<style scoped>
.task-card {
  position: relative;
  overflow: hidden;
  margin-bottom: var(--sp-12);
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  background: var(--card);
  box-shadow: var(--shadow-1);
  transition: box-shadow var(--dur-slow) ease, transform var(--dur-slow) ease;
}
.task-card:hover { box-shadow: var(--shadow-2); transform: translateY(-2px); }

.tc-accent {
  position: absolute; left: 0; right: 0; top: 0;
  height: 3px;
  border-radius: var(--r-card) var(--r-card) 0 0;
  opacity: .92;
}

.tc-head { display: flex; flex-direction: column; gap: var(--sp-8); }
.tc-title { display: flex; align-items: center; gap: var(--sp-10); }
.tc-ico {
  width: var(--sz-30); height: var(--sz-30); flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--r-xl);
  background: var(--tone-soft, #eee); color: var(--tone, #666);
}
.tc-ico :deep(.el-icon) { font-size: 17px; }
.tc-name {
  margin: 0; flex: 1; min-width: 0;
  font-weight: var(--fw-bold); font-size: var(--fs-subtitle);
  color: var(--text); line-height: var(--lh-tight);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tc-badge {
  margin-left: auto; flex: none;
  display: inline-flex; align-items: center; gap: var(--sp-5);
  font-size: var(--fs-caption); font-weight: var(--fw-medium);
  padding: 2px var(--sp-8); border-radius: var(--r-pill);
  line-height: 1.5; white-space: nowrap;
}
.tc-badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.tc-badge--ok   { color: var(--ok);        background: var(--ok-soft); }
.tc-badge--err  { color: var(--err-deep);  background: var(--err-soft); }
.tc-badge--warn { color: var(--warn-deep); background: var(--warn-soft); }
.tc-badge--info { color: var(--info);      background: var(--info-soft); }
.tc-badge--muted{ color: var(--muted);     background: var(--surface-sunken); }
.is-running .tc-badge-dot { animation: tc-pulse 1.4s ease-in-out infinite; }
@keyframes tc-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--warn); }
  50%      { box-shadow: 0 0 0 4px transparent; }
}

.tc-meta { display: flex; align-items: center; gap: var(--sp-6); flex-wrap: wrap; }
.gchip {
  font-size: 11px; padding: 1px var(--sp-8); border-radius: var(--r-pill);
  background: var(--tone-soft, #eee); color: var(--tone, #666); font-weight: var(--fw-semibold);
}

.tc-desc { color: var(--muted); font-size: var(--fs-body); margin: var(--sp-10) 0 0; line-height: var(--lh-base); }
.tc-outs { display: flex; align-items: center; gap: var(--sp-6); color: var(--muted); font-size: var(--fs-caption); margin-top: var(--sp-10); }
.tc-outs :deep(.el-icon) { color: var(--accent-neutral); }
.tc-note { display: flex; align-items: center; gap: var(--sp-6); color: var(--warn-deep); background: var(--warn-soft); padding: var(--sp-6) var(--sp-8); border-radius: var(--r-md); font-size: var(--fs-caption); margin-top: var(--sp-8); }
.tc-note :deep(.el-icon) { color: var(--warn); flex: none; }

.tc-nodes { display: flex; align-items: center; gap: var(--sp-8); margin-top: var(--sp-10); font-size: var(--fs-caption); color: var(--muted); flex-wrap: wrap; }
.tc-nodes-label { font-weight: var(--fw-medium); color: var(--text-body); }
.tc-nodes-sels { display: flex; align-items: center; gap: var(--sp-6); flex-wrap: wrap; }
.tc-arrow { color: var(--muted); }
.tc-nodes-err { color: var(--err); }

.tc-foot {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-8);
  margin-top: var(--sp-14); padding-top: var(--sp-12);
  border-top: 1px dashed var(--border-soft);
}
.tc-actions { display: flex; gap: var(--sp-8); }
.tc-actions :deep(.el-button) { display: inline-flex; align-items: center; gap: var(--sp-4); }
.tc-art { margin: 0; color: var(--muted); }
.tc-art:hover { color: var(--brand); }
.tc-art :deep(.el-icon) { font-size: 14px; }

.tc-last { display: flex; align-items: center; gap: var(--sp-6); color: var(--muted); font-size: var(--fs-caption); margin-top: var(--sp-10); }
.tc-last :deep(.el-icon) { color: var(--accent-neutral); font-size: 14px; }

@media (max-width: 560px) {
  .tc-title { gap: var(--sp-8); }
  .tc-ico { width: var(--sz-26); height: var(--sz-26); }
  .tc-ico :deep(.el-icon) { font-size: 15px; }
}
</style>
