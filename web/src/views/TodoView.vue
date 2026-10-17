<template>
  <div class="auto">
    <div class="auto-bar">
      <h2 class="v-title">自动任务</h2>
      <span class="v-sub">按时间线管理自动任务，绑定手动任务后可定时 / 自动执行</span>
      <span class="sp" />
      <el-button type="primary" @click="openCreate()">
        <el-icon><Plus /></el-icon> 新建任务
      </el-button>
    </div>

    <div v-if="loading" class="auto-state">
      <el-icon class="is-loading"><Loading /></el-icon> 加载中…
    </div>

    <el-timeline v-else-if="sortedItems.length" class="auto-tl">
      <el-timeline-item
        v-for="it in sortedItems" :key="it.id"
        :timestamp="scheduleText(it)" placement="top"
        :type="nodeType(it)" :hollow="it.status === 'done'"
      >
        <div class="node" :class="{ done: it.status === 'done' }">
          <div class="node-head">
            <span class="node-title">
              <el-icon v-if="it.flag" class="node-star" title="重点"><StarFilled /></el-icon>
              {{ it.title }}
            </span>
            <el-tag v-if="!it.taskId" size="small" type="info" effect="plain">未绑定任务</el-tag>
            <el-tag v-else-if="it.linkState === 'missing'" size="small" type="danger" effect="plain">任务缺失</el-tag>
            <el-tag v-else-if="it.linkState === 'disabled'" size="small" type="warning" effect="plain">任务已禁用</el-tag>
            <el-tag v-else size="small" type="success" effect="plain">
              手动任务：{{ taskName(it.taskId) }}
            </el-tag>
            <el-tag v-if="it.lastRunStatus" size="small"
              :type="it.lastRunStatus === 'success' ? 'success' : 'danger'">
              {{ it.lastRunStatus }}
            </el-tag>
            <span v-if="it.lastRunAt" class="node-runat">上次：{{ it.lastRunAt }}</span>
          </div>
          <div v-if="it.note" class="node-note">{{ it.note }}</div>
          <div class="node-acts">
            <el-button v-if="it.taskId" size="small" type="primary" plain :loading="it._running" @click="trigger(it)">
              <el-icon><VideoPlay /></el-icon> 运行
            </el-button>
            <el-button size="small" text @click="openCreate(it)"><el-icon><Edit /></el-icon> 编辑</el-button>
            <el-button size="small" text type="danger" @click="removeItem(it)"><el-icon><Delete /></el-icon> 删除</el-button>
          </div>
        </div>
      </el-timeline-item>
    </el-timeline>

    <div v-else class="auto-state auto-empty">还没有自动任务，点击右上角「新建任务」开始。</div>

    <!-- 新建 / 编辑任务 -->
    <el-dialog v-model="dlg" :title="form.id ? '编辑自动任务' : '新建自动任务'" width="520px">
      <el-form label-width="92px">
        <el-form-item label="任务名称">
          <el-input v-model="form.title" placeholder="留空则使用所绑定手动任务的名称" />
          <div class="form-hint">不填时，保存将自动取「绑定手动任务」的名称作为任务名。</div>
        </el-form-item>
        <el-form-item label="绑定手动任务">
          <el-select v-model="form.taskId" clearable filterable placeholder="选择已创建的手动任务（可选）" style="width:100%">
            <el-option v-for="t in tasks.tasks" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
          <div class="form-hint">绑定后可在时间线直接「运行」该手动任务，并支持自动执行。</div>
        </el-form-item>
        <el-form-item label="执行时间">
          <el-date-picker v-model="form.remindAt" type="datetime"
            format="YYYY-MM-DD HH:mm" :clearable="true"
            placeholder="定时执行的起始时间" style="width:100%" />
        </el-form-item>
        <el-form-item label="重复">
          <div class="repeat">
            <el-select v-model="form.repeatType" style="width:140px">
              <el-option label="不重复" value="none" />
              <el-option label="每天" value="daily" />
              <el-option label="每周" value="weekly" />
              <el-option label="每月" value="monthly" />
              <el-option label="自定义（小时）" value="custom" />
            </el-select>
            <template v-if="form.repeatType !== 'none'">
              <span class="repeat-pre">每</span>
              <el-input-number v-model="form.repeatInterval" :min="1" :max="999" :controls="false" style="width:80px" />
              <span class="repeat-unit">
                {{ form.repeatType === 'daily' ? '天' : form.repeatType === 'weekly' ? '周'
                  : form.repeatType === 'monthly' ? '个月' : '小时' }}
              </span>
            </template>
          </div>
        </el-form-item>
        <el-form-item v-if="form.repeatType === 'weekly'" label="星期">
          <el-checkbox-group v-model="form.repeatWeekdays">
            <el-checkbox-button v-for="d in weekDays" :key="d.v" :value="d.v">{{ d.l }}</el-checkbox-button>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item v-if="form.repeatType === 'monthly'" label="每月">
          <el-radio-group v-model="form.repeatMonthLast">
            <el-radio :value="true">最后一天</el-radio>
            <el-radio :value="false">
              第
              <el-input-number v-model="form.repeatMonthDay" :min="1" :max="31" :controls="false" style="width:70px" />
              日
            </el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="结束日期">
          <el-date-picker v-model="form.repeatEnd" type="date" value-format="YYYY-MM-DD"
            placeholder="可选，留空表示长期" style="width:100%" />
        </el-form-item>
        <el-form-item label="自动运行">
          <el-switch v-model="form.autoRun" />
          <span class="form-hint">开启后调度器到点自动执行（需已绑定手动任务）。</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { Plus, Edit, Delete, VideoPlay, Loading, StarFilled } from '@element-plus/icons-vue';
import { useAppStore } from '../stores/app.js';
import { useTasksStore } from '../stores/tasks.js';
import { fetchTodo, postTodoItem, triggerTodoItem } from '../api/dashboards.js';

const app = useAppStore();
const tasks = useTasksStore();

const items = ref([]);
const loading = ref(false);
const dlg = ref(false);
const dlgEdit = ref(false);
const form = ref(emptyForm());

// 选择手动任务且未填任务名时，自动取手动任务名
watch(() => form.value.taskId, (v) => {
  if (v && !form.value.title) form.value.title = taskName(v);
});

const weekDays = [
  { v: 1, l: '一' }, { v: 2, l: '二' }, { v: 3, l: '三' }, { v: 4, l: '四' },
  { v: 5, l: '五' }, { v: 6, l: '六' }, { v: 7, l: '日' },
];

function emptyForm() {
  return {
    id: null, title: '', note: '', taskId: null,
    autoRun: true, remindAt: null, repeatType: 'daily',
    repeatInterval: 1, repeatWeekdays: [1, 2, 3, 4, 5],
    repeatMonthDay: 1, repeatMonthLast: false, repeatEnd: '',
  };
}

const sortedItems = computed(() =>
  [...items.value].sort((a, b) => {
    const ta = a.remindAt ? Date.parse(a.remindAt) : Infinity;
    const tb = b.remindAt ? Date.parse(b.remindAt) : Infinity;
    return ta - tb;
  }),
);

function taskName(id) {
  if (!id) return '';
  const t = tasks.taskById(id);
  return t ? t.name : '未知任务';
}
function scheduleText(it) {
  if (it.repeatType && it.repeatType !== 'none') {
    return `${it.autoRun ? '自动' : '定时'} · ${it.repeatLabel}`;
  }
  return it.remindAt ? `一次性 · ${it.remindAt}` : '未排程';
}
function nodeType(it) {
  if (it.status === 'done') return 'info';
  if (!it.taskId) return 'warning';
  if (it.autoRun) return 'primary';
  return 'success';
}

// 原生 Date -> 后端所需 "YYYY-MM-DDTHH:mm"（与后端 fmtLocal 对齐）
function toBackendDt(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

function buildRepeat() {
  const t = form.value.repeatType;
  const n = Math.max(1, Number(form.value.repeatInterval) || 1);
  const end = form.value.repeatEnd || '';
  if (t === 'daily') return { type: 'daily', interval: n, by: '', end };
  if (t === 'weekly') return { type: 'weekly', interval: n, by: (form.value.repeatWeekdays || []).join(','), end };
  if (t === 'monthly') return {
    type: 'monthly', interval: n,
    by: form.value.repeatMonthLast ? 'L' : String(form.value.repeatMonthDay), end,
  };
  if (t === 'custom') return { type: 'custom', interval: n, by: '', end };
  return { type: 'none', interval: 1, by: '', end: '' };
}

async function load() {
  loading.value = true;
  try {
    if (!tasks.loaded) await tasks.loadState();
    const res = await fetchTodo();
    items.value = (res && res.todo && res.todo.items) || [];
  } catch (e) {
    ElMessage.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function openCreate(it) {
  form.value = it
    ? {
      id: it.id, title: it.title, note: it.note || '', taskId: it.taskId || null,
      autoRun: !!it.autoRun, remindAt: it.remindAt ? new Date(it.remindAt) : null,
      repeatType: it.repeatType || 'none', repeatInterval: it.repeatInterval || 1,
      repeatWeekdays: (it.repeatBy ? String(it.repeatBy).split(',').map(Number) : [1, 2, 3, 4, 5]),
      repeatMonthDay: it.repeatBy ? Number(it.repeatBy) || 1 : 1,
      repeatMonthLast: it.repeatBy === 'L', repeatEnd: it.repeatEnd || '',
    }
    : emptyForm();
  dlgEdit.value = !!it;
  dlg.value = true;
}

async function save() {
  // 任务名留空时，自动取所绑定手动任务的名称
  if (!form.value.title && form.value.taskId) form.value.title = taskName(form.value.taskId);
  if (!form.value.title) { ElMessage.warning('请填写任务名称，或先绑定一个手动任务'); return; }
  if (form.value.repeatType !== 'none' && !form.value.remindAt) {
    ElMessage.warning('请选择执行时间'); return;
  }
  try {
    const op = form.value.id ? 'update' : 'create';
    const payload = {
      title: form.value.title,
      note: form.value.note,
      list_id: '',
      remind_at: toBackendDt(form.value.remindAt),
      repeat: buildRepeat(),
      auto_run: form.value.autoRun ? 1 : 0,
    };
    if (form.value.taskId) payload.task_id = form.value.taskId;
    if (form.value.id) payload.id = form.value.id;
    await postTodoItem(op, payload);
    dlg.value = false;
    ElMessage.success('已保存');
    await load();
  } catch (e) { ElMessage.error(e.message || '保存失败'); }
}

async function removeItem(it) {
  if (!(await app.confirmDialog({ message: `删除自动任务「${it.title}」？` }))) return;
  try { await postTodoItem('delete', { id: it.id }); ElMessage.success('已删除'); await load(); }
  catch (e) { ElMessage.error(e.message || '删除失败'); }
}

async function trigger(it) {
  it._running = true;
  try { await triggerTodoItem(it.id); ElMessage.success('已触发：' + it.title); }
  catch (e) { ElMessage.error(e.message || '触发失败'); }
  finally { it._running = false; }
}

onMounted(load);
</script>

<style scoped>
.auto { padding: var(--sp-20); }
.auto-bar { display: flex; align-items: baseline; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.v-sub { color: var(--el-text-color-secondary); font-size: var(--el-font-size-base); }
.auto-bar .sp { flex: 1; }
.auto-tl { padding: var(--sp-8) var(--sp-4); max-width: 880px; }
.node { border: 1px solid var(--el-border-color-lighter); border-radius: var(--el-border-radius-base); background: var(--el-bg-color); padding: var(--sp-12) var(--sp-14); }
.node.done .node-title { text-decoration: line-through; color: var(--el-text-color-secondary); }
.node-head { display: flex; align-items: center; gap: var(--sp-6); flex-wrap: wrap; }
.node-title { font-weight: var(--fw-semibold); display: inline-flex; align-items: center; gap: 4px; }
.node-star { color: var(--el-color-warning); }
.node-runat { color: var(--el-text-color-secondary); font-size: var(--el-font-size-extra-small); }
.node-note { color: var(--el-text-color-secondary); font-size: var(--el-font-size-extra-small); margin-top: 4px; }
.node-acts { display: flex; gap: var(--sp-4); margin-top: var(--sp-8); }
.repeat { display: flex; align-items: center; gap: var(--sp-8); flex-wrap: wrap; }
.repeat-pre { color: var(--el-text-color-secondary); }
.repeat-unit { color: var(--el-text-color-secondary); }
.form-hint { color: var(--el-text-color-secondary); font-size: var(--el-font-size-extra-small); margin-top: 4px; }
.auto-state { padding: var(--sp-40); text-align: center; color: var(--el-text-color-secondary); display: flex; gap: var(--sp-8); justify-content: center; align-items: center; }
.auto-empty { border: 1px dashed var(--el-border-color); border-radius: var(--el-border-radius-base); }
</style>
