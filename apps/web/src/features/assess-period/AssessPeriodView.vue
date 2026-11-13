<template>
  <div class="apv">
    <div class="apv-bar">
      <h2 class="v-title">时段设置</h2>
      <el-date-picker
        v-model="month" type="month" value-format="YYYY-MM"
        placeholder="选择月份" class="apv-month" @change="load"
      />
      <span class="sp" />
      <span v-if="savedInfo" class="apv-saved">已保存</span>
      <span v-if="updatedAt" class="apv-updated">最后更新：{{ updatedAt }}（{{ updatedBy || '—' }}）</span>
      <el-button type="primary" :loading="saving" :disabled="!editable" @click="save">保存设置</el-button>
    </div>

    <el-card class="apv-card" shadow="never">
      <template #header>
        <span class="apv-card-h">考核时段（{{ rows.length }} 个）</span>
        <span v-if="!configured" class="apv-warn">{{ month }} 月份尚未保存过配置，请添加时段或复制上月配置，保存后生效</span>
        <span v-if="!editable" class="apv-warn">历史月份只读，不可修改</span>
        <div class="apv-tools">
          <el-button size="small" :disabled="!editable" @click="copyPrevMonth">复制上月配置</el-button>
          <el-button size="small" :disabled="!editable" @click="clearRows">恢复默认</el-button>
        </div>
      </template>

      <el-table :data="rows" border height="100%" row-key="id" class="apv-table">
        <el-table-column label="序号" width="64" align="center">
          <template #default="{ $index }"><span class="apv-idx">{{ $index + 1 }}</span></template>
        </el-table-column>
        <el-table-column label="时段名称" min-width="150">
          <template #default="{ row }">
            <el-input v-model="row.name" :disabled="!editable" placeholder="如 午高峰" maxlength="20" />
          </template>
        </el-table-column>
        <el-table-column label="开始时间" min-width="126" align="center">
          <template #default="{ row }">
            <el-time-picker
              v-model="row.start" format="HH:mm" value-format="HH:mm"
              :clearable="false" :disabled="!editable" placeholder="HH:mm" class="apv-time"
            />
          </template>
        </el-table-column>
        <el-table-column label="结束时间" min-width="126" align="center">
          <template #default="{ row }">
            <el-time-picker
              v-model="row.end" format="HH:mm" value-format="HH:mm"
              :clearable="false" :disabled="!editable" placeholder="HH:mm" class="apv-time"
            />
          </template>
        </el-table-column>
        <el-table-column label="时段时长(h)" min-width="112" align="center">
          <template #default="{ row }"><span class="apv-dur">{{ durationLabel(row) }}</span></template>
        </el-table-column>
        <el-table-column label="单量要求" min-width="110" align="center">
          <template #default="{ row }">
            <el-input-number
              v-model="row.orders" :min="0" :max="999" :precision="0"
              :controls="false" :disabled="!editable"
            />
          </template>
        </el-table-column>
        <el-table-column label="有效在线时长要求(h)" min-width="176" align="center">
          <template #default="{ row }">
            <el-input-number
              v-model="row.online" :min="0" :max="24" :step="0.5" :precision="2"
              :controls="false" :disabled="!editable"
            />
          </template>
        </el-table-column>
        <el-table-column label="时段权重" min-width="136" align="center">
          <template #default="{ row }">
            <div class="apv-pct">
              <el-input-number
                v-model="row.weight" :min="0" :max="100" :precision="2"
                :controls="false" :disabled="!editable"
              />
              <span class="apv-unit">%</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" align="center" fixed="right">
          <template #default="{ $index }">
            <el-button link :disabled="!editable || $index === 0" @click="move($index, -1)">上移</el-button>
            <el-button link :disabled="!editable || $index === rows.length - 1" @click="move($index, 1)">下移</el-button>
            <el-button link type="danger" :disabled="!editable" @click="removeRow($index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="apv-actions">
        <el-button size="small" :disabled="!editable" @click="addRow">+ 添加时段</el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import {
  fetchPeriodConfig, savePeriodConfig,
} from '../../api/dashboards.js';

const month = ref(currentMonth());
const rows = ref([]);
const configured = ref(false);
const editable = ref(true);
const updatedAt = ref('');
const updatedBy = ref('');
const saving = ref(false);
const savedInfo = ref(false);
let _rid = 0;

function currentMonth() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

function fmtTime(v) {
  if (!v) return '';
  return String(v).replace('T', ' ').slice(0, 19);
}

function numOr(v, fallback) {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toMin(v) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 与后端 periodDurationH 同口径：左闭右开，end <= start 视为次日。 */
function durationValue(start, end) {
  const a = toMin(start);
  const b = toMin(end);
  if (a === null || b === null) return null;
  let d = b - a;
  if (d <= 0) d += 1440;
  return Math.round((d / 60) * 100) / 100;
}

function durationLabel(row) {
  const d = durationValue(row.start, row.end);
  return d === null ? '—' : d.toFixed(2);
}

function addHours(hhmm, hours) {
  const a = toMin(hhmm);
  if (a === null) return '00:00';
  const total = (a + Math.round(hours * 60)) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function toRow(p = {}) {
  const start = p.start || '00:00';
  const end = p.end || '00:00';
  return {
    id: ++_rid,
    name: p.name || '',
    start,
    end,
    orders: numOr(p.orders, 0),
    online: numOr(p.effective_online_req_h, durationValue(start, end) ?? 0),
    weight: numOr(p.weight, 100),
  };
}

function fillRows(list) {
  rows.value = (list || []).map((p) => toRow(p));
  savedInfo.value = false;
}

async function load() {
  savedInfo.value = false;
  try {
    const res = await fetchPeriodConfig(month.value);
    configured.value = !!(res && res.configured);
    editable.value = !res || res.editable !== false;
    updatedAt.value = fmtTime(res && res.updated_at);
    updatedBy.value = (res && res.updated_by) || '';
    // 未保存过的月份不预填任何默认时段：从空列表开始，或复制上月配置。
    fillRows(configured.value ? (res && res.periods) : []);
  } catch (e) {
    ElMessage.error(e.message || '加载时段设置失败');
  }
}

function validate() {
  const seen = new Set();
  for (let i = 0; i < rows.value.length; i++) {
    const r = rows.value[i];
    const no = `第 ${i + 1} 行`;
    const name = String(r.name || '').trim();
    if (!name) return `${no}：时段名称不能为空`;
    if (seen.has(name)) return `${no}：时段名称「${name}」重复`;
    seen.add(name);
    if (toMin(r.start) === null || toMin(r.end) === null) return `${no}：起止时间格式须为 HH:MM`;
    const o = numOr(r.orders, null);
    if (o === null || o < 0 || !Number.isInteger(o)) return `${no}：单量要求须为非负整数`;
    const h = numOr(r.online, null);
    if (h === null || h < 0) return `${no}：有效在线时长要求须为非负数字`;
    const w = numOr(r.weight, null);
    if (w === null || w < 0 || w > 100) return `${no}：时段权重须在 0~100 之间`;
  }
  return '';
}

async function save() {
  if (!editable.value) return;
  const err = validate();
  if (err) {
    ElMessage.warning(err);
    return;
  }
  saving.value = true;
  savedInfo.value = false;
  try {
    const periods = rows.value.map((r) => ({
      start: r.start,
      end: r.end,
      name: String(r.name).trim(),
      orders: numOr(r.orders, 0),
      effective_online_req_h: numOr(r.online, 0),
      weight: numOr(r.weight, 100),
    }));
    const res = await savePeriodConfig({ month: month.value, periods });
    if (res && res.ok) {
      ElMessage.success('时段设置已保存');
      savedInfo.value = true;
      configured.value = true;
      updatedAt.value = fmtTime(res.updated_at);
      updatedBy.value = res.updated_by || '';
      fillRows(res.periods);
      savedInfo.value = true;
    } else {
      ElMessage.error((res && res.error) || '保存失败');
    }
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

/** 当前选中月份的上一个月（YYYY-MM），跨年自动回落到上年 12 月。 */
function prevMonthOf(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 复制上月配置：载入上月已保存的时段列表，点「保存设置」后写入当前月。 */
async function copyPrevMonth() {
  if (!editable.value) return;
  const src = prevMonthOf(month.value);
  try {
    const res = await fetchPeriodConfig(src);
    if (!res || !res.configured || !Array.isArray(res.periods) || !res.periods.length) {
      ElMessage.warning(`${src}（上月）尚未保存过配置，无可复制`);
      return;
    }
    fillRows(res.periods);
    ElMessage.success(`已载入 ${src}（上月）的配置，点击「保存设置」后生效`);
  } catch (e) {
    ElMessage.error(e.message || '复制上月配置失败');
  }
}

/** 「恢复默认」= 清空该月所有时段（无内置默认模板需回填），危险操作先弹窗确认。 */
async function clearRows() {
  if (!editable.value) return;
  if (!rows.value.length) {
    ElMessage.info('当前没有时段');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将清空 ${month.value} 月份的全部 ${rows.value.length} 个时段。清空后需点击「保存设置」才会生效，保存后该月不包含任何时段。`,
      '清空时段配置',
      { type: 'warning', confirmButtonText: '确定清空', cancelButtonText: '取消' },
    );
  } catch (e) {
    return; // 取消
  }
  fillRows([]);
  ElMessage.info('已清空，点击「保存设置」后生效');
}

function addRow() {
  if (!editable.value) return;
  const last = rows.value[rows.value.length - 1];
  const start = last ? last.end : '00:00';
  rows.value.push(toRow({
    start,
    end: addHours(start, 2),
    name: '',
    orders: 0,
    weight: 100,
    effective_online_req_h: 2,
  }));
  savedInfo.value = false;
}

function move(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= rows.value.length) return;
  const arr = rows.value.slice();
  [arr[i], arr[j]] = [arr[j], arr[i]];
  rows.value = arr;
  savedInfo.value = false;
}

function removeRow(i) {
  rows.value.splice(i, 1);
  savedInfo.value = false;
}

onMounted(load);
</script>

<style scoped>
.apv {
  padding: var(--sp-20);
  display: flex;
  flex-direction: column;
  gap: var(--sp-12);
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
}
.apv-bar { display: flex; align-items: center; gap: var(--sp-12); flex-wrap: wrap; }
.apv-bar .sp { flex: 1; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.apv-month { width: 150px; }
.apv-card { width: 100%; box-sizing: border-box; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.apv-card :deep(.el-card__header) { flex: 0 0 auto; display: flex; align-items: center; gap: var(--sp-8); flex-wrap: wrap; }
.apv-card :deep(.el-card__body) { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.apv-card-h { font-weight: 600; }
.apv-warn { font-size: var(--el-font-size-extra-small); color: var(--el-color-warning); }
.apv-tools { margin-left: auto; display: flex; align-items: center; gap: var(--sp-8); }
.apv-table { flex: 1 1 auto; min-height: 0; --el-component-size: 32px; }
.apv-table :deep(.cell) { white-space: nowrap; }
.apv-table :deep(.el-table__cell) { padding: 8px 0; }
.apv-table :deep(.el-table__header th) { padding: 8px 0; }
.apv-table :deep(.cell) > .el-input-number { width: 100%; }
.apv-time { width: 100% !important; }
.apv-time :deep(.el-input__wrapper) { padding-left: 8px; padding-right: 8px; }
.apv-pct { display: flex; align-items: center; justify-content: center; gap: 4px; }
.apv-pct :deep(.el-input-number) { flex: 1 1 auto; min-width: 0; }
.apv-unit { color: var(--el-text-color-secondary); font-size: 12px; }
.apv-dur { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--el-text-color-secondary); }
.apv-idx { color: var(--el-text-color-secondary); font-size: 12px; }
.apv-actions { display: flex; align-items: center; gap: var(--sp-8); padding-top: var(--sp-12); }
.apv-updated { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.apv-saved { font-size: var(--el-font-size-extra-small); color: #1aac5a; }
</style>
