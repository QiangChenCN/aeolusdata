<template>
  <div class="auto">
    <div class="auto-bar">
      <h2 class="v-title">自动任务</h2>
      <span class="v-sub">按时间线管理自动任务，绑定手动任务后可定时 / 自动执行</span>
      <el-switch v-model="autoRunEnabled" @change="toggleAuto" inline-prompt
        active-text="自动开" inactive-text="已暂停" class="auto-sw" title="总开关：关闭后暂停所有自动任务的自动执行" />
      <span class="sp" />
      <el-button type="primary" @click="openCreate()">
        <el-icon><Plus /></el-icon> 新建任务
      </el-button>
    </div>

    <div v-if="loading" class="auto-state">
      <el-icon class="is-loading"><Loading /></el-icon> 加载中…
    </div>

    <el-timeline v-else-if="timeSlots.length" class="auto-tl">
      <el-timeline-item
        v-for="slot in timeSlots" :key="slot.key"
        :timestamp="slot.label" placement="top"
        :type="slotType(slot)" :hollow="slot.key === '~unsched'"
      >
        <div v-for="it in slot.items" :key="it.id" class="node" :class="{ done: it.status === 'done' }">
          <div class="node-head">
            <span class="node-title">
              <el-icon v-if="it.flag" class="node-star" title="重点"><StarFilled /></el-icon>
              {{ it.title }}
            </span>
            <el-tag v-if="!it.taskId" size="small" type="info" effect="plain">未绑定任务</el-tag>
            <el-tag v-else-if="it.linkState === 'missing'" size="small" type="danger" effect="plain">任务缺失</el-tag>
            <el-tag v-else-if="it.linkState === 'disabled'" size="small" type="warning" effect="plain">任务已禁用</el-tag>
            <el-tag v-if="it.timeout" size="small" type="warning" effect="plain">{{ Math.round(it.timeout / 60) }}分钟超时</el-tag>
            <el-tag v-if="it.lastRunStatus" size="small"
              :type="it.lastRunStatus === 'success' ? 'success' : 'danger'">
              {{ it.lastRunStatus }}
            </el-tag>
            <span v-if="it.lastRunAt" class="node-runat">上次：{{ it.lastRunAt }}</span>
          </div>
          <div v-if="it.note" class="node-note">{{ it.note }}</div>
          <div v-if="it.repeatType !== 'none'" class="node-rep">{{ it.repeatLabel }}</div>
          <div class="node-acts">
            <el-button size="small" text @click="openCreate(it)"><el-icon><Edit /></el-icon> 编辑</el-button>
            <el-button size="small" text type="danger" @click="removeItem(it)"><el-icon><Delete /></el-icon> 删除</el-button>
          </div>
        </div>
      </el-timeline-item>
    </el-timeline>

    <div v-else class="auto-state auto-empty">还没有自动任务，点击右上角「新建任务」开始。</div>

    <!-- 新建 / 编辑任务 -->
    <el-dialog v-model="dlg" :title="form.id ? '编辑自动任务' : '新建自动任务'" width="640px">
      <el-form label-width="92px">
        <el-form-item label="绑定任务" required>
          <el-select v-model="form.taskId" clearable filterable placeholder="选择已创建的手动任务（必选，任务名即取自它）" style="width:100%">
            <el-option v-for="t in tasks.tasks" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="argParams.length" label="任务参数">
          <div class="arg-wrap">
            <ParamForm :task="argTask" :form="taskArgForm" :params="argParams"
              label-position="left" label-width="110px" />
          </div>
        </el-form-item>
        <el-form-item label="重复">
          <div class="repeat">
            <el-switch v-model="form.repeatEnabled" />
            <span class="repeat-pre">启用重复</span>
            <template v-if="form.repeatEnabled">
              <el-select v-model="form.repeatType" style="width:140px">
                <el-option label="每天" value="daily" />
                <el-option label="每周" value="weekly" />
                <el-option label="每月" value="monthly" />
                <el-option label="自定义（小时）" value="custom" />
              </el-select>
              <span class="repeat-pre">每</span>
              <el-input-number v-model="form.repeatInterval" :min="1" :max="999" :controls="false" style="width:80px" />
              <span class="repeat-unit">
                {{ form.repeatType === 'daily' ? '天' : form.repeatType === 'weekly' ? '周'
                  : form.repeatType === 'monthly' ? '个月' : '小时' }}
              </span>
            </template>
          </div>
        </el-form-item>
        <el-form-item label="开始日期">
          <el-date-picker v-model="form.startDate" type="date" value-format="YYYY-MM-DD"
            placeholder="请选择开始日期" style="width:100%" />
        </el-form-item>
        <el-form-item label="执行时间">
          <div class="times">
            <div v-for="(t, i) in form.times" :key="i" class="time-row">
              <el-time-picker v-model="form.times[i]" format="HH:mm:ss" value-format="HH:mm:ss"
                :clearable="false" placeholder="时间" style="width:160px" />
              <el-button size="small" text type="danger" :disabled="form.times.length <= 1"
                @click="form.times.splice(i, 1)"><el-icon><Delete /></el-icon></el-button>
            </div>
            <el-button @click="form.times.push('09:00:00')"><el-icon><Plus /></el-icon> 添加时间</el-button>
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
        </el-form-item>
        <el-form-item label="排队执行">
          <el-switch v-model="form.queueRun" />
        </el-form-item>
        <el-form-item label="超时时长">
          <el-input-number v-model="form.timeout" :min="0" :max="600" :step="5" />
          <span class="repeat-unit">分钟</span>
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
import { Plus, Edit, Delete, Loading, StarFilled } from '@element-plus/icons-vue';
import { useAppStore } from '../../stores/app.js';
import { useTasksStore } from '../../stores/tasks.js';
import ParamForm from '../../components/tasks/ParamForm.vue';
import { fetchCron, postCronItem, setCronAutoPaused } from '../../api/dashboards.js';

const app = useAppStore();
const tasks = useTasksStore();

const items = ref([]);
const loading = ref(false);
const dlg = ref(false);
const dlgEdit = ref(false);
const form = ref(emptyForm());
// 全局「自动执行」总开关（false = 暂停所有自动任务的点火与重试）
const autoRunEnabled = ref(true);

const weekDays = [
  { v: 1, l: '一' }, { v: 2, l: '二' }, { v: 3, l: '三' }, { v: 4, l: '四' },
  { v: 5, l: '五' }, { v: 6, l: '六' }, { v: 7, l: '日' },
];

function emptyForm() {
  return {
    id: null, taskId: null, note: '',
    autoRun: true, queueRun: false, startDate: '', times: ['09:00:00'], timeout: 0,
    repeatEnabled: true, repeatType: 'daily',
    repeatInterval: 1, repeatWeekdays: [1, 2, 3, 4, 5],
    repeatMonthDay: 1, repeatMonthLast: false, repeatEnd: '',
  };
}

/* ---------------- 任务参数（task_args） ---------------- */
// 所绑手动任务的 params（tasks.json 声明），剔除 --begin/--end 节点区间（与任务中心配置一致）
const argTask = computed(() => tasks.taskById(form.value.taskId));
const argParams = computed(() =>
  ((argTask.value && argTask.value.params) || [])
    .filter((p) => p.flag !== '--begin' && p.flag !== '--end'));
const taskArgForm = ref({});
// 编辑时暂存已保存的参数：仅当所选任务与保存时是同一个任务才回显
let savedArgsRef = null;

function buildArgs(saved) {
  const f = {};
  argParams.value.forEach((p) => {
    const v = saved && saved[p.flag] !== undefined ? saved[p.flag] : p.default;
    if (p.type === 'switch') f[p.flag] = !!v;
    else if (p.type === 'multi-team') f[p.flag] = v ? String(v).split(',').filter(Boolean) : [];
    else f[p.flag] = v == null ? '' : String(v);
  });
  taskArgForm.value = f;
}

watch(() => form.value.taskId, (tid) => {
  const saved = savedArgsRef;
  buildArgs(saved && saved.taskId === tid ? saved.args : null);
});

function collectArgs() {
  const out = {};
  argParams.value.forEach((p) => {
    let v = taskArgForm.value[p.flag];
    if (p.type === 'multi-team') v = (v || []).join(',');
    if (p.type === 'switch') v = !!v;
    else v = v == null ? '' : String(v);
    out[p.flag] = v;
  });
  return out;
}

/**
 * 按时间分槽：把每个自动任务拆到它的各个执行时间点，相同时间点归到一个槽，
 * 时间线按时间排序（每日时段在前、具体日期在后）。同一时刻要跑哪些任务一目了然。
 * 完全没有时间信息的事项归到末尾的「未排程」槽。
 */
const timeSlots = computed(() => {
  const map = new Map();
  for (const it of items.value) {
    const datePart = it.remindAt ? it.remindAt.slice(0, 10) : '';
    const times = (it.remindTimes && it.remindTimes.length)
      ? it.remindTimes.slice().sort()
      : (it.remindAt ? [it.remindAt.slice(11, 19)] : []);
    const isOnce = it.repeatType === 'none';
    if (!times.length) {
      if (!map.has('~unsched')) {
        map.set('~unsched', { key: '~unsched', label: '未排程', isOnce: false, items: [] });
      }
      map.get('~unsched').items.push(it);
      continue;
    }
    for (const t of times) {
      let key;
      let label;
      if (isOnce) {
        key = `${datePart || '0000-00-00'}T${t}`;
        label = `${datePart || ''} ${t}`.trim();
      } else {
        key = `0000-00-00T${t}`;
        label = `${t}`;
      }
      if (!map.has(key)) map.set(key, { key, label, isOnce, items: [] });
      map.get(key).items.push(it);
    }
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
});

function taskName(id) {
  if (!id) return '';
  const t = tasks.taskById(id);
  return t ? t.name : '未知任务';
}
// 时间字符串统一补齐到「HH:mm:ss」（兼容旧数据只有分钟的情况）
function padSec(t) {
  const s = (t || '').trim();
  if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(s)) return s + ':00';
  return s;
}
function slotType(slot) {
  if (slot.key === '~unsched') return 'info';
  if (slot.items.some((i) => !i.taskId)) return 'warning';
  if (slot.items.every((i) => i.autoRun)) return 'primary';
  return 'success';
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
    if (!tasks.teams || !(tasks.teams.teams || []).length) tasks.loadTeams(); // 站点多选参数需要站点列表
    const res = await fetchCron();
    items.value = (res && res.cron && res.cron.items) || [];
    autoRunEnabled.value = !(res && res.cron && res.cron.scheduler && res.cron.scheduler.auto_paused);
  } catch (e) {
    ElMessage.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function openCreate(it) {
  // 先暂存已保存的任务参数（仅在同任务时回显），再赋 form 触发 taskId watcher 重建参数表单
  savedArgsRef = it && it.taskId ? { taskId: it.taskId, args: it.taskArgs || {} } : null;
  form.value = it
    ? {
      id: it.id, taskId: it.taskId || null, note: it.note || '',
      autoRun: !!it.autoRun, queueRun: !!it.queueRun, timeout: Math.round((Number(it.timeout) || 0) / 60),
      // 开始日期：重复任务一律显示持久化值（可空，删空保存后保持空）；
      // 仅旧的单次事项（repeat none，remind_at 是真实计划时间且不会顺延）才从 remindAt 反推
      startDate: it.startDate
        || ((it.repeatType || 'none') === 'none' && it.remindAt ? it.remindAt.slice(0, 10) : ''),
      times: (it.remindTimes && it.remindTimes.length)
        ? it.remindTimes.slice().map(padSec)
        : (it.remindAt ? [padSec(it.remindAt.slice(11, 19))] : ['09:00:00']),
      repeatEnabled: !!(it.repeatType && it.repeatType !== 'none'), repeatInterval: it.repeatInterval || 1,
      repeatType: it.repeatType || 'daily',
      repeatWeekdays: (it.repeatBy ? String(it.repeatBy).split(',').map(Number) : [1, 2, 3, 4, 5]),
      repeatMonthDay: it.repeatBy ? Number(it.repeatBy) || 1 : 1,
      repeatMonthLast: it.repeatBy === 'L', repeatEnd: it.repeatEnd || '',
    }
    : emptyForm();
  dlgEdit.value = !!it;
  dlg.value = true;
}

async function save() {
  if (!form.value.taskId) { ElMessage.warning('请先绑定一个手动任务（任务名即取自它）'); return; }
  if (!form.value.times.length) { ElMessage.warning('请至少添加一个执行时间'); return; }
  if (!form.value.startDate && !form.value.repeatEnabled) {
    ElMessage.warning('请选择开始日期（一次性任务需要）'); return;
  }
  try {
    const op = form.value.id ? 'update' : 'create';
    const times = [...new Set(form.value.times)].filter(Boolean).sort();
    const firstTime = times[0];
    const baseDate = form.value.startDate || new Date().toISOString().slice(0, 10);
    const remindAt = `${baseDate}T${firstTime}`;
    const payload = {
      title: taskName(form.value.taskId),
      note: form.value.note,
      list_id: '',
      // 开始日期原样持久化（可空）；remind_at 是调度锚点（重复任务后端会重算为下一个未来时点）
      start_date: form.value.startDate || '',
      remind_at: remindAt,
      remind_times: times,
      repeat: form.value.repeatEnabled ? buildRepeat() : { type: 'none', interval: 1, by: '', end: '' },
      auto_run: form.value.autoRun ? 1 : 0,
      queue_run: form.value.queueRun ? 1 : 0,
      timeout: form.value.timeout * 60,
      task_id: form.value.taskId,
      task_args: collectArgs(),
    };
    if (form.value.id) payload.id = form.value.id;
    await postCronItem(op, payload);
    dlg.value = false;
    ElMessage.success('已保存');
    await load();
  } catch (e) { ElMessage.error(e.message || '保存失败'); }
}

async function removeItem(it) {
  if (!(await app.confirmDialog({ message: `删除自动任务「${it.title}」？` }))) return;
  try { await postCronItem('delete', { id: it.id }); ElMessage.success('已删除'); await load(); }
  catch (e) { ElMessage.error(e.message || '删除失败'); }
}

async function toggleAuto(val) {
  const paused = !val;
  try {
    const r = await setCronAutoPaused(paused);
    autoRunEnabled.value = !(r && r.paused);
    ElMessage.success(paused ? '已暂停全部自动任务' : '已恢复全部自动任务');
  } catch (e) {
    autoRunEnabled.value = val; // 失败回滚
    ElMessage.error(e.message || '操作失败');
  }
}

onMounted(load);
</script>

<style scoped>
.auto { padding: var(--sp-20); }
.auto-bar { display: flex; align-items: baseline; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.v-sub { color: var(--el-text-color-secondary); font-size: var(--el-font-size-base); }
.auto-bar .sp { flex: 1; }
.auto-sw { margin-left: var(--sp-12); }
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
.times { display: flex; flex-direction: column; gap: var(--sp-6); }
.time-row { display: flex; align-items: center; gap: var(--sp-6); }
.arg-wrap { width: 100%; }
.arg-wrap :deep(.el-form-item) { margin-bottom: 22px; }
/* 统一参数 label 的纵向对齐：与输入框垂直居中，不再随控件高度（textarea/多行）上下漂移 */
.arg-wrap :deep(.el-form-item__label) {
  display: inline-flex;
  align-items: center;
  justify-content: flex-start; /* label 左对齐（默认右对齐贴输入框） */
  min-height: 32px;
  line-height: 1.4;
}
</style>
