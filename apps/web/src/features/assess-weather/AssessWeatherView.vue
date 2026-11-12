<template>
  <div class="awv">
    <div class="awv-bar">
      <h2 class="v-title">天气设置</h2>
      <el-date-picker
        v-model="month" type="month" value-format="YYYY-MM"
        placeholder="选择月份" class="awv-month" @change="onMonthChange"
      />
      <span class="sp" />
      <span v-if="savedInfo" class="awv-saved">已保存</span>
      <span v-if="updatedAt" class="awv-updated">最后更新：{{ updatedAt }}（{{ updatedBy || '—' }}）</span>
      <el-button type="primary" :loading="saving" @click="save">保存设置</el-button>
    </div>

    <!-- ① 天气等级设置：独立的天气等级标签库，与下方两张卡片互不影响 -->
    <el-card class="awv-card" shadow="never">
      <template #header>
        <div class="awv-head">
          <span class="awv-card-h">天气等级设置</span>
        </div>
      </template>

      <div class="awv-tags">
        <template v-for="(t, i) in gradeTags" :key="t.__id">
          <el-input
            v-if="editingIdx === i" v-model="editVal"
            maxlength="20" class="awv-tag-input" placeholder="等级名称"
            @keyup.enter="commitEdit(i)" @blur="commitEdit(i)"
          />
          <el-tag
            v-else :type="TAG_TYPE[i % TAG_TYPE.length]" effect="light"
            class="awv-tag" closable @close="confirmRemove(i)" @click="startEdit(i)"
          >{{ t.name }}</el-tag>
        </template>
        <el-input
          v-if="inputVisible" ref="gradeAddEl" v-model="inputVal"
          maxlength="20" class="awv-tag-input" placeholder="等级名称"
          @keyup.enter="commitAdd" @blur="commitAdd"
        />
        <el-button v-else class="awv-tag-add" @click="showAdd">+ 新增等级</el-button>
      </div>
    </el-card>

    <!-- ② 天气标签设置：独立维护的标签清单（手工标签 + 等级），与③互不影响 -->
    <el-card class="awv-card" shadow="never">
      <template #header>
        <div class="awv-head">
          <span class="awv-card-h">天气标签设置</span>
          <span class="sp" />
          <el-button type="primary" plain @click="addTag">+ 添加标签</el-button>
        </div>
      </template>

      <el-empty v-if="tagRows.length === 0" description="尚未配置天气标签，请点击「+ 添加标签」" :image-size="72" />
      <el-table v-else :data="tagRows" border row-key="__id" class="awv-table" style="width: 520px">
        <el-table-column label="天气标签" min-width="240" align="center">
          <template #default="{ row }">
            <div class="awv-label-cell">
              <el-input v-model="row.label" maxlength="20" placeholder="如 正常天" class="awv-center-input" />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="天气等级" min-width="200" align="center">
          <template #default="{ row }">
            <el-select
              v-model="row.name" filterable
              class="awv-full" placeholder="选择天气等级设置中的标签"
            >
              <el-option v-for="g in gradeTags" :key="g.__id" :label="g.name" :value="g.name" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="80" align="center">
          <template #default="{ $index }">
            <el-button link type="danger" @click="removeTag($index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- ③ 天气分层设置：独立维护判定链（等级 + 指标/判定符/阈值 + 顺序）→ 考核看板按此判定当天天气档位 -->
    <el-card class="awv-card" shadow="never">
      <template #header>
        <div class="awv-head">
          <span class="awv-card-h">天气分层设置</span>
          <span v-if="!configured" class="awv-warn">{{ month }} 月份尚未保存判定链，看板天气等级将为空（评分按不区分天气处理），保存后生效</span>
          <span class="sp" />
          <el-button type="primary" plain @click="addTier">+ 添加分层</el-button>
        </div>
      </template>

      <el-table v-if="tiers.length" :data="tiers" border row-key="__id" class="awv-table awv-tiers" style="width: 850px">
        <el-table-column label="天气分层" width="140" align="center">
          <template #default="{ row, $index }">
            <div class="awv-label-cell">
              <el-input v-model="row.name" maxlength="20" placeholder="如 正常天" class="awv-center-input" />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="判定条件" min-width="520" align="center">
          <template #default="{ row }">
            <div class="awv-conds">
              <div v-for="(c, ci) in row.conditions" :key="c.__cid" class="awv-cond-row">
                <span class="awv-join">{{ ci === 0 ? '当' : (row.logic === 'or' ? '或' : '且') }}</span>
                <el-select
                  v-model="c.tags" multiple filterable collapse-tags collapse-tags-tooltip
                  placeholder="勾选天气标签" class="awv-cond-grades"
                >
                  <el-option v-for="t in tagOptions" :key="t.v" :label="t.l" :value="t.v" />
                </el-select>
                <span class="awv-cond-unit">占比</span>
                <el-select v-model="c.cmp" placeholder="判定符" class="awv-cond-cmp">
                  <el-option v-for="x in CMPS" :key="x.v" :label="x.l" :value="x.v" />
                </el-select>
                <el-input-number
                  v-model="c.value" :min="0" :max="100" :precision="2"
                  :controls="false" class="awv-cond-val" placeholder="阈值"
                />
                <span class="awv-cond-unit">%</span>
                <el-button link type="danger" :disabled="row.conditions.length <= 1" @click="removeCond(row, ci)">删除</el-button>
              </div>
              <div class="awv-cond-ops">
                <el-button link type="primary" :disabled="row.conditions.length >= 10" @click="addCond(row)">+ 添加条件</el-button>
                <span v-if="!tagOptions.length" class="awv-warn">请先在上方「天气标签设置」添加天气标签</span>
                <el-select v-if="row.conditions.length > 1" v-model="row.logic" class="awv-logic" size="small">
                  <el-option label="满足全部条件（且）" value="and" />
                  <el-option label="满足任一条件（或）" value="or" />
                </el-select>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" align="center" fixed="right">
          <template #default="{ $index }">
            <div class="awv-ops">
              <el-button link :disabled="$index === 0" @click="move($index, -1)">上移</el-button>
              <el-button link :disabled="$index === tiers.length - 1" @click="move($index, 1)">下移</el-button>
              <el-button link type="danger" @click="removeTier($index)">删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="尚未配置天气分层，请点击「+ 添加分层」；未配置时看板不判定天气分层" :image-size="72" />
    </el-card>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { fetchWeatherLayering, saveWeatherLayering } from '../../api/dashboards.js';

/* 天气标签配色（按严重度循环）：与考核看板 WEATHER_TAG 的四级配色一致 */
const TAG_TYPE = ['success', 'info', 'warning', 'danger'];
/* 历史固定口径 → 天气等级序号（仅用于兼容旧配置的展示） */
const METRIC_GRADES = { r1234: [1, 2, 3, 4], r234: [2, 3, 4], r34: [3, 4], r4: [4] };
const CMPS = [
  { v: 'lte', l: '≤' },
  { v: 'lt', l: '<' },
  { v: 'gte', l: '≥' },
  { v: 'gt', l: '>' },
];

const month = ref(currentMonth());
const configured = ref(false);
const updatedAt = ref('');
const updatedBy = ref('');
const saving = ref(false);
const savedInfo = ref(false);
/* ① 天气等级设置：独立的等级标签库（只有名称，不影响下面两卡） */
const gradeTags = ref([]);
/* ② 天气标签设置：独立的标签行（手工标签 + 等级），不参与判定 */
const tagRows = ref([]);
/* ③ 天气分层设置：独立的判定链（分层 + 条件），考核看板按它判定 */
const tiers = ref([]);
let _rid = 0;
let _savedTimer = null;
/* 判定条件可勾选的天气标签：取自②「天气标签设置」的天气标签（只展示标签本身） */
const tagOptions = computed(() => {
  const out = [];
  for (const r of tagRows.value) {
    const v = (r.label || '').trim();
    if (!v || out.some((x) => x.v === v)) continue;
    out.push({ v, l: v });
  }
  return out;
});

/* ① 卡片的内联编辑/新增状态 */
const editingIdx = ref(-1);
const editVal = ref('');
const inputVisible = ref(false);
const inputVal = ref('');
const gradeAddEl = ref(null);

function currentMonth() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}


/* —— ① 天气等级设置（独立标签库） —— */
function startEdit(i) {
  editingIdx.value = i;
  editVal.value = gradeTags.value[i].name;
  nextTick(() => {
    const el = document.querySelector('.awv-tag-input input');
    if (el) el.focus();
  });
}

function commitEdit(i) {
  if (editingIdx.value !== i) return;
  const v = editVal.value.trim();
  if (v && !gradeTags.value.some((t, k) => k !== i && t.name === v)) gradeTags.value[i].name = v;
  editingIdx.value = -1;
  editVal.value = '';
}

function showAdd() {
  inputVisible.value = true;
  nextTick(() => {
    if (gradeAddEl.value && gradeAddEl.value.focus) gradeAddEl.value.focus();
    else {
      const el = document.querySelector('.awv-tags .awv-tag-input input');
      if (el) el.focus();
    }
  });
}

function commitAdd() {
  if (!inputVisible.value) return;
  const v = inputVal.value.trim();
  if (v) {
    if (gradeTags.value.some((t) => t.name === v)) {
      ElMessage.warning(`天气等级「${v}」已存在`);
    } else {
      gradeTags.value.push({ __id: ++_rid, name: v });
    }
  }
  inputVisible.value = false;
  inputVal.value = '';
}

function removeGradeTag(i) {
  gradeTags.value.splice(i, 1);
}

function confirmRemove(i) {
  const name = gradeTags.value[i].name;
  ElMessageBox.confirm(
    `确定删除天气等级「${name}」吗？保存设置后生效。`,
    '删除确认',
    { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
  )
    .then(() => removeGradeTag(i))
    .catch(() => {});
}

/* —— ② 天气标签设置（独立，只维护标签） —— */
/* 新增行默认取「天气等级设置」里尚未使用的第一个标签；天气标签由用户手工输入 */
function addTag() {
  const used = new Set(tagRows.value.map((t) => t.name));
  const next = gradeTags.value.find((g) => !used.has(g.name));
  tagRows.value.push({ __id: ++_rid, label: '', name: next ? next.name : '' });
}

function removeTag(i) {
  tagRows.value.splice(i, 1);
}

/* —— ③ 天气分层设置（独立判定链，分层名称手工输入，每层可配多个条件） —— */
function newCond() {
  return { __cid: ++_rid, tags: [], cmp: '', value: null };
}

function addTier() {
  tiers.value.push({ __id: ++_rid, name: '', logic: 'and', conditions: [newCond()] });
}

function removeTier(i) {
  tiers.value.splice(i, 1);
}

function addCond(row) {
  if (row.conditions.length >= 10) return;
  row.conditions.push(newCond());
}

function removeCond(row, i) {
  if (row.conditions.length <= 1) return;
  row.conditions.splice(i, 1);
}

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= tiers.value.length) return;
  const arr = tiers.value;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function fmtTime(v) {
  if (!v) return '';
  return String(v).replace('T', ' ').slice(0, 19);
}

/* —— 未保存修改检测：加载/保存成功后的快照 vs 当前编辑态 —— */
function snap() {
  return JSON.stringify([
    gradeTags.value.map((t) => t.name),
    tagRows.value.map((r) => ({ label: r.label, name: r.name })),
    tiers.value.map((t) => ({
      name: t.name,
      logic: t.logic,
      conditions: t.conditions.map((c) => ({ tags: [...(c.tags || [])], cmp: c.cmp, value: c.value })),
    })),
  ]);
}
const savedSnap = ref('');
const dirty = computed(() => savedSnap.value !== '' && snap() !== savedSnap.value);

/* 切换月份：有未保存修改时先确认，取消则回退到原月份 */
let _prevMonth = month.value;
async function onMonthChange(v) {
  if (!dirty.value) {
    _prevMonth = v;
    await load();
    return;
  }
  try {
    await ElMessageBox.confirm(
      `「${_prevMonth}」的修改尚未保存，切换月份将丢弃这些修改，是否继续？`,
      '未保存提醒',
      { confirmButtonText: '仍要切换', cancelButtonText: '留在此页', type: 'warning' },
    );
  } catch {
    month.value = _prevMonth;
    return;
  }
  _prevMonth = v;
  await load();
}

async function load() {
  try {
    const res = await fetchWeatherLayering(month.value);
    const rows = Array.isArray(res && res.tags) ? res.tags : [];
    tagRows.value = rows.map((t) => ({
      __id: ++_rid,
      label: t.label || '',
      name: t.name || '',
    }));
    const tagNames = tagRows.value.map((r) => (r.label || '').trim() || (r.name || '').trim());
    /* 旧配置可能只有等级序号（grades）或固定口径（metric），按天气标签的严重度顺序换算成标签 */
    const labelOfGrade = (g) => tagNames[Number(g) - 1] || '';
    const list = Array.isArray(res && res.tiers) ? res.tiers : [];
    tiers.value = list.map((t) => {
      const rawConds = Array.isArray(t.conditions) && t.conditions.length
        ? t.conditions
        : [{ grades: METRIC_GRADES[t.metric], cmp: t.cmp, value: t.value }];
      const conditions = rawConds.map((c) => {
        let useTags = Array.isArray(c.tags) ? c.tags.filter((s) => typeof s === 'string' && s.trim()) : [];
        if (!useTags.length) {
          const gs = Array.isArray(c.grades) && c.grades.length ? c.grades : (METRIC_GRADES[c.metric] || []);
          useTags = gs.map(labelOfGrade).filter(Boolean);
        }
        return { __cid: ++_rid, tags: useTags, cmp: c.cmp || '', value: c.value ?? null };
      });
      return {
        __id: ++_rid,
        name: t.name || '',
        logic: t.logic === 'or' ? 'or' : 'and',
        conditions: conditions.length ? conditions : [newCond()],
      };
    });
    const gradeList = Array.isArray(res && res.grade_tags) ? res.grade_tags : [];
    gradeTags.value = gradeList.map((n) => ({ __id: ++_rid, name: String(n) }));
    configured.value = !!(res && res.configured);
    updatedAt.value = fmtTime(res && res.updated_at);
    updatedBy.value = (res && res.updated_by) || '';
    savedInfo.value = false;
    editingIdx.value = -1;
    inputVisible.value = false;
    inputVal.value = '';
    _prevMonth = month.value;
    savedSnap.value = snap();
  } catch (e) {
    ElMessage.error(e.message || '加载天气设置失败');
  }
}

async function save() {
  if (tiers.value.length === 0) {
    try {
      await ElMessageBox.confirm(
        '天气分层设置为空，是否继续保存？',
        '提示',
        { confirmButtonText: '继续保存', cancelButtonText: '取消', type: 'warning' },
      );
    } catch {
      return;
    }
  }
  /* 天气标签行的有效标签集合：判定条件里勾选的标签必须仍然存在，否则判定时静默不命中 */
  const labelSet = new Set();
  for (const r of tagRows.value) {
    const v = (r.label || '').trim();
    if (v) labelSet.add(v);
  }
  const gradeNames = new Set(gradeTags.value.map((g) => g.name));
  const tierNames = new Set();
  for (let i = 0; i < tiers.value.length; i++) {
    const t = tiers.value[i];
    const name = (t.name || '').trim();
    if (!name) { ElMessage.error(`天气分层第 ${i + 1} 条：请填写天气分层`); return; }
    if (tierNames.has(name)) { ElMessage.error(`天气分层「${name}」重复，请修改名称`); return; }
    tierNames.add(name);
    if (!t.conditions.length) { ElMessage.error(`天气分层第 ${i + 1} 条（${name}）：请至少配置一个判定条件`); return; }
    for (let j = 0; j < t.conditions.length; j++) {
      const c = t.conditions[j];
      if (!c.tags || !c.tags.length) { ElMessage.error(`天气分层第 ${i + 1} 条（${name}）第 ${j + 1} 个条件：请勾选天气标签`); return; }
      for (const tag of c.tags) {
        if (!labelSet.has(tag)) { ElMessage.error(`天气分层第 ${i + 1} 条（${name}）第 ${j + 1} 个条件：天气标签「${tag}」已不在「天气标签设置」中，请重新勾选`); return; }
      }
      if (!c.cmp) { ElMessage.error(`天气分层第 ${i + 1} 条（${name}）第 ${j + 1} 个条件：请选择判定符`); return; }
      if (c.value === null || c.value === undefined || c.value === '') { ElMessage.error(`天气分层第 ${i + 1} 条（${name}）第 ${j + 1} 个条件：请填写阈值`); return; }
    }
  }
  for (let i = 0; i < tagRows.value.length; i++) {
    const r = tagRows.value[i];
    const label = (r.label || '').trim();
    if (!label) { ElMessage.error(`天气标签第 ${i + 1} 行：请填写天气标签`); return; }
    if (tagRows.value.some((x, k) => k !== i && (x.label || '').trim() === label)) { ElMessage.error(`天气标签「${label}」重复，请修改`); return; }
    if (!r.name) { ElMessage.error(`天气标签第 ${i + 1} 行（${label}）：请选择天气等级`); return; }
    if (!gradeNames.has(r.name)) { ElMessage.error(`天气标签第 ${i + 1} 行（${label}）：天气等级「${r.name}」已不在「天气等级设置」中，请重新选择`); return; }
  }
  saving.value = true;
  savedInfo.value = false;
  try {
    const res = await saveWeatherLayering(
      month.value,
      tiers.value,
      gradeTags.value.map((t) => t.name),
      tagRows.value.map((r) => ({ label: (r.label || '').trim(), name: r.name })),
    );
    if (res && res.ok) {
      ElMessage.success('天气设置已保存');
      savedInfo.value = true;
      clearTimeout(_savedTimer);
      _savedTimer = setTimeout(() => { savedInfo.value = false; }, 3000);
      savedSnap.value = snap();
      configured.value = tiers.value.length > 0;
      updatedAt.value = fmtTime(res.updated_at);
      updatedBy.value = res.updated_by || '';
    } else if (res && res.error) {
      ElMessage.error(res.error);
    }
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.awv {
  padding: var(--sp-20);
  display: flex;
  flex-direction: column;
  gap: var(--sp-12);
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
}
.awv-bar { display: flex; align-items: center; gap: var(--sp-12); flex-wrap: wrap; }
.awv-bar .sp, .awv-head .sp { flex: 1; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.awv-month { width: 150px; }
.awv-card { width: 100%; box-sizing: border-box; }
.awv-head { display: flex; align-items: center; gap: var(--sp-12); flex-wrap: wrap; }
.awv-card-h { font-weight: 600; }
.awv-warn { font-size: var(--el-font-size-extra-small); color: var(--el-color-warning); }
.awv-table { width: 100%; }
.awv-label-cell { display: flex; align-items: center; gap: var(--sp-8); }
.awv-conds { display: flex; flex-direction: column; gap: var(--sp-8); }
.awv-cond-row { display: flex; align-items: center; gap: var(--sp-8); }
.awv-join { flex: none; width: 24px; font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); text-align: center; }
.awv-cond-grades { width: 176px; }
.awv-cond-cmp { width: 110px; }
.awv-cond-val { width: 72px; }
.awv-cond-unit { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.awv-cond-ops { display: flex; align-items: center; gap: var(--sp-12); }
.awv-ops { display: flex; align-items: center; justify-content: center; white-space: nowrap; }
.awv-ops .el-button + .el-button { margin-left: 8px; }
.awv-logic { width: 160px; }
.awv-full :deep(.el-select__wrapper) { width: 100%; }
.awv-full { width: 100%; }
.awv-center-input :deep(.el-input__inner) { text-align: center; }
.awv-tags { display: flex; align-items: center; gap: var(--sp-8); flex-wrap: wrap; }
.awv-tag { cursor: pointer; }
.awv-tag-input { width: 140px; }
.awv-tag-add { border-style: dashed; }
.awv-saved { font-size: var(--el-font-size-extra-small); color: #1aac5a; }
.awv-updated { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
</style>
