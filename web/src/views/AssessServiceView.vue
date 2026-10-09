<template>
  <div class="asq">
    <div class="asq-bar">
      <h2 class="v-title">服务质量设置</h2>
      <el-date-picker
        v-model="month" type="month" value-format="YYYY-MM"
        placeholder="选择月份" class="asq-month" @change="load"
      />
      <span class="asq-tip">各考核项在周中 / 周末、不同天气下的 0分 / 60分 / 100分 阈值</span>
      <span class="sp" />
      <span v-if="savedInfo" class="asq-saved">已保存</span>
      <span v-if="updatedAt" class="asq-updated">最后更新：{{ updatedAt }}（{{ updatedBy || '—' }}）</span>
      <el-button type="primary" :loading="saving" @click="save">保存设置</el-button>
    </div>

    <el-card class="asq-card" shadow="never">
      <template #header>
        <span class="asq-card-h">考核项目标值</span>
        <span v-if="!configured" class="asq-warn">{{ month }} 月份尚未保存过配置，保存后生效</span>
        <span v-if="weightSum.filled" class="asq-sum" :class="{ 'is-bad': Math.abs(weightSum.sum - 100) > 0.1 }">
          权重项合计 {{ weightSum.sum }}%
        </span>
        <span class="asq-legend">
          <span class="asq-legend-item"><i class="asq-dot is-pos" />越高越好（0&lt;60&lt;100）</span>
          <span class="asq-legend-item"><i class="asq-dot is-neg" />越低越好（0&gt;60&gt;100）</span>
        </span>
      </template>

      <el-table
        :data="rows" border height="100%" class="asq-table"
        :span-method="spanMethod" :row-key="rowKey"
      >
        <el-table-column label="考核项" fixed="left" min-width="150" align="center">
          <template #default="{ row }">
            <div class="asq-metric">
              <span class="asq-metric-name">{{ row.name }}</span>
              <el-tag size="small" :type="row.direction === 'pos' ? 'success' : 'danger'" effect="plain">
                {{ row.direction === 'pos' ? '越高越好' : '越低越好' }}
              </el-tag>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="计分方式" fixed="left" min-width="112" align="center">
          <template #default="{ row }">
            <el-select
              v-model="kinds[row.metricKey]" size="small" placeholder="请选择"
              class="asq-kind"
            >
              <el-option v-for="k in kindOptions" :key="k.key" :label="k.name" :value="k.key" />
            </el-select>
          </template>
        </el-table-column>

        <el-table-column label="指标权重 / 得分区间" fixed="left" min-width="168" align="center">
          <template #default="{ row }">
            <!-- 权重项：指标权重 = 百分比（0~100） -->
            <div v-if="kinds[row.metricKey] === 'weight'" class="asq-weight-cell">
              <el-input-number
                v-model="weights[row.metricKey]" :min="0" :max="100"
                :controls="false" size="small" placeholder="—"
              />
              <span class="asq-unit">%</span>
            </div>
            <!-- 调分项：指标权重 = 得分区间（可负，如 -5 ~ +5） -->
            <div v-else-if="kinds[row.metricKey] === 'adjust'" class="asq-range-cell">
              <el-input-number
                v-model="ranges[row.metricKey].min" :controls="false" size="small" placeholder="下限"
              />
              <span class="asq-tilde">~</span>
              <el-input-number
                v-model="ranges[row.metricKey].max" :controls="false" size="small" placeholder="上限"
              />
              <span class="asq-unit">分</span>
            </div>
            <span v-else class="asq-unit">先选计分方式</span>
          </template>
        </el-table-column>

        <el-table-column label="分层方式" fixed="left" min-width="128" align="center">
          <template #default="{ row }">
            <el-select v-model="layering[row.metricKey]" size="small" class="asq-layer">
              <el-option v-for="l in layeringOptions" :key="l.key" :label="l.name" :value="l.key" />
            </el-select>
          </template>
        </el-table-column>

        <el-table-column label="档位" fixed="left" min-width="88" align="center">
          <template #default="{ row }">
            <span class="asq-tier" :class="'is-' + row.tier">{{ row.tierLabel }}</span>
          </template>
        </el-table-column>

        <!-- 值列：物理固定 8 列（周中 4 + 周末 4），按每行「分层方式」由 span-method 合并单元格 -->
        <el-table-column v-for="dt in dateTypes" :key="dt.key" :label="dt.name" align="center">
          <el-table-column
            v-for="wx in weather" :key="wx.key" :label="wx.name"
            min-width="112" align="center"
          >
            <template #default="{ row }">
              <div class="asq-cell">
                <el-input-number
                  :model-value="tierValue(row.metricKey, dt.key, wx.key, row.tier)"
                  :min="0"
                  :max="row.unit === '%' ? 100 : undefined"
                  :controls="false" size="small" placeholder="—"
                  :disabled="!isEditable(row.metricKey, dt.key, wx.key)"
                  @change="(v) => setTier(row.metricKey, dt.key, wx.key, row.tier, v)"
                />
                <span v-if="row.unit" class="asq-unit">{{ unitLabel(row.unit) }}</span>
              </div>
            </template>
          </el-table-column>
        </el-table-column>
      </el-table>

      <p class="asq-note">
        留空表示「未设置」；百分比类指标范围 0~100，时长类（秒）不限上限。三档全填时才会校验顺序。
        指标权重按计分方式取不同含义：<strong>权重项 = 百分比</strong>（所有权重项合计须 100%）；<strong>调分项 = 得分区间</strong>（可负，如 -5 ~ +5）。
        「分层方式」按考核项设置：不分层（该行 8 格合并为 1 格，全部场景共用一套值）／日期分层（合并为周中、周末 2 格）／天气分层（周中 4 格可填，周末 4 格只读并随周中变化）／日期天气分层（8 格各自独立）。保存时按各自分层方式展开成完整矩阵。
      </p>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import {
  fetchServiceQualityTargets, saveServiceQualityTargets,
} from '../api/dashboards.js';
import { useAppStore } from '../stores/app.js';

const app = useAppStore();
const TIERS = [
  { key: 't0', label: '0 分档' },
  { key: 't60', label: '60 分档' },
  { key: 't100', label: '100 分档' },
];

const month = ref(currentMonth());
const metrics = ref([]);
const dateTypes = ref([]);
const weather = ref([]);
const targets = ref({});
const weights = ref({});
const ranges = ref({});
const layering = ref({});
const layeringOptions = ref([]);
const kinds = ref({});
const kindOptions = ref([]);
const configured = ref(false);
const updatedAt = ref('');
const updatedBy = ref('');
const saving = ref(false);
const savedInfo = ref(false);

function currentMonth() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

function fmtTime(v) {
  if (!v) return '';
  return String(v).replace('T', ' ').slice(0, 19);
}

function emptyTiers() {
  return { t0: null, t60: null, t100: null };
}

/** 单位显示：'%'→%，'s'→秒 */
function unitLabel(u) {
  return u === 's' ? '秒' : u;
}

// ===================== 分层方式 =====================
// 四个选项决定三档阈值在「日期类型 / 天气」两维上的区分粒度：
//   none 不分层        → 只有「周中/正常天」是锚点，其余 7 格镜像只读
//   date 日期分层      → 每个日期类型一套（锚点在「正常天」列）
//   weather 天气分层   → 每个天气一套（锚点在「周中」组）
//   date_weather       → 8 格各自独立（默认）
/** 值列定义（由整表「分层方式」决定，故所有考核项共用一套列）：
 *  none 不分层→ 1 列（全部场景）      date 日期分层 → 2 列（周中 / 周末）
 *  weather 天气分层 → 4 列（正常天…）  date_weather   → 8 列（周中/周末 × 4 天气）
 *  未分层的维度在保存时按此表展开成完整 8 格矩阵。 */
function layeringOf(mk) {
  return layering.value[mk] || 'date_weather';
}
/** 该 (dt, wx) 在本项分层方式下由哪个格子代表（未分层维度回落到 周中 / 正常天）。 */
function repFor(mk, dtKey, wxKey) {
  const L = layeringOf(mk);
  if (L === 'none') return ['weekday', 'normal'];
  if (L === 'date') return [dtKey, 'normal'];
  if (L === 'weather') return ['weekday', wxKey];
  return [dtKey, wxKey];
}
/** 周末列在「天气分层」下只读镜像（由 span-method 合并的格子已隐藏，无需再禁用）。 */
function isEditable(mk, dtKey, wxKey) {
  const L = layeringOf(mk);
  if (L === 'none' || L === 'date') return true; // 合并后仅剩代表格
  if (L === 'weather') return dtKey === 'weekday';
  return true;
}
/** 取某格某档的显示值。 */
function tierValue(mk, dtKey, wxKey, tier) {
  const cell = targets.value[mk]?.[dtKey]?.[wxKey];
  const v = cell ? cell[tier] : null;
  return v === null || v === undefined || v === '' ? null : Number(v);
}
function setTier(mk, dtKey, wxKey, tier, v) {
  if (!targets.value[mk]) targets.value[mk] = {};
  if (!targets.value[mk][dtKey]) targets.value[mk][dtKey] = {};
  if (!targets.value[mk][dtKey][wxKey]) targets.value[mk][dtKey][wxKey] = { t0: null, t60: null, t100: null };
  targets.value[mk][dtKey][wxKey][tier] = _num(v);
}

/** 权重项合计（用于页面提示；保存时后端也会校验 100%） */
const weightSum = computed(() => {
  let sum = 0;
  let filled = 0;
  for (const m of metrics.value) {
    if (kinds.value[m.key] !== 'weight') continue;
    const w = weights.value[m.key];
    if (w !== null && w !== undefined && w !== '') {
      sum += Number(w);
      filled += 1;
    }
  }
  return { sum: Math.round(sum * 100) / 100, filled };
});

/** 行 = 考核项 × 档位（7 × 3 = 21 行）；考核项列按3 行合并 */
const rows = computed(() => {
  const out = [];
  for (const m of metrics.value) {
    const cells = targets.value[m.key] || {};
    TIERS.forEach((t, i) => {
      out.push({
        rowKey: `${m.key}__${t.key}`,
        metricKey: m.key,
        tier: t.key,
        tierLabel: t.label,
        tierIndex: i,
        name: m.name,
        unit: m.unit,
        direction: m.direction,
        cells,
      });
    });
  }
  return out;
});

function rowKey(row) {
  return row.rowKey;
}

/**
 * 单元格合并（两件事）：
 *  ① 前 4 列（考核项 / 计分方式 / 指标权重 / 分层方式）按 3 档行合并；
 *  ② 值列（index>=5，共 8 列：周中4 + 周末4）按**本行**分层方式合并：
 *     不层→ 1 格(colspan 8)；日期分层 → 2 格(各 colspan 4)；
 *     天气分层 → 8 格但周末 4 格只读镜像；日期天气分层 → 8 格各自独立。
 */
function spanMethod({ row, columnIndex }) {
  if (columnIndex <= 3) {
    if (row.tierIndex === 0) return { rowspan: TIERS.length, colspan: 1 };
    return { rowspan: 0, colspan: 0 };
  }
  if (columnIndex === 4) return { rowspan: 1, colspan: 1 }; // 档位列
  const L = layeringOf(row.metricKey);
  const vi = columnIndex - 5; // 值列序号 0..7
  if (L === 'none') {
    if (vi === 0) return { rowspan: 1, colspan: 8 };
    return { rowspan: 0, colspan: 0 };
  }
  if (L === 'date') {
    if (vi === 0) return { rowspan: 1, colspan: 4 };
    if (vi === 4) return { rowspan: 1, colspan: 4 };
    return { rowspan: 0, colspan: 0 };
  }
  return { rowspan: 1, colspan: 1 };
}

function buildEditable(raw) {
  const t = raw || {};
  const editable = {};
  for (const m of metrics.value) {
    const src = t[m.key] || {};
    editable[m.key] = {};
    for (const dt of dateTypes.value) {
      editable[m.key][dt.key] = {};
      const srcDt = src[dt.key] || {};
      for (const wx of weather.value) {
        const cell = srcDt[wx.key] || {};
        const cellOut = {};
        for (const tier of TIERS) {
          const v = cell[tier.key];
          cellOut[tier.key] = v === null || v === undefined ? null : Number(v);
        }
        editable[m.key][dt.key][wx.key] = cellOut;
      }
    }
  }
  return editable;
}

async function load() {
  try {
    const res = await fetchServiceQualityTargets(month.value);
    metrics.value = (res && res.metrics) || [];
    dateTypes.value = (res && res.date_types) || [];
    weather.value = (res && res.weather) || [];
    configured.value = !!(res && res.configured);
    targets.value = buildEditable(res && res.targets);
    const w = (res && res.weights) || {};
    const wEdit = {};
    for (const m of metrics.value) {
      const v = w[m.key];
      wEdit[m.key] = v === null || v === undefined ? null : Number(v);
    }
    weights.value = wEdit;
    const rg = (res && res.ranges) || {};
    const rgEdit = {};
    for (const m of metrics.value) {
      const r = rg[m.key] || {};
      rgEdit[m.key] = {
        min: r.min === null || r.min === undefined ? null : Number(r.min),
        max: r.max === null || r.max === undefined ? null : Number(r.max),
      };
    }
    ranges.value = rgEdit;
    kindOptions.value = (res && res.kinds_meta) || [];
    layeringOptions.value = (res && res.layering_meta) || [];
    const lv = (res && res.layering) || {};
    const lvEdit = {};
    for (const m of metrics.value) lvEdit[m.key] = lv[m.key] || 'date_weather';
    layering.value = lvEdit;
    const k = (res && res.kinds) || {};
    const kEdit = {};
    for (const m of metrics.value) {
      kEdit[m.key] = k[m.key] === undefined ? null : k[m.key];
    }
    kinds.value = kEdit;
    updatedAt.value = fmtTime(res && res.updated_at);
    updatedBy.value = (res && res.updated_by) || '';
  } catch (e) {
    app.toast(e.message || '加载服务质量设置失败', 'error');
  }
}

function _num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function save() {
  saving.value = true;
  savedInfo.value = false;
  try {
    const body = {
      month: month.value, targets: {}, weights: {}, ranges: {}, kinds: {}, layering: {},
    };
    for (const m of metrics.value) {
      const kind = kinds.value[m.key] ?? null;
      const w = weights.value[m.key];
      const r = ranges.value[m.key] || {};
      body.kinds[m.key] = kind;
      body.layering[m.key] = layeringOf(m.key);
      // 权重项存百分比；调分项存得分区间（权重留空）
      body.weights[m.key] = kind === 'weight' ? _num(w) : null;
      body.ranges[m.key] = kind === 'adjust'
        ? { min: _num(r.min), max: _num(r.max) }
        : { min: null, max: null };
      // 按分层方式展开成完整 8 格矩阵（非代表格取其代表列的值）
      const perMetric = {};
      for (const dt of dateTypes.value) {
        const perWx = {};
        for (const wx of weather.value) {
          const [rDt, rWx] = repFor(m.key, dt.key, wx.key);
          perWx[wx.key] = {
            t0: tierValue(m.key, rDt, rWx, 't0'),
            t60: tierValue(m.key, rDt, rWx, 't60'),
            t100: tierValue(m.key, rDt, rWx, 't100'),
          };
        }
        perMetric[dt.key] = perWx;
      }
      body.targets[m.key] = perMetric;
    }
    const res = await saveServiceQualityTargets(body);
    if (res && res.ok) {
      app.toast('服务质量设置已保存', 'success');
      savedInfo.value = true;
      configured.value = true;
      updatedAt.value = fmtTime(res.updated_at);
      updatedBy.value = res.updated_by || '';
    } else if (res && res.error) {
      app.toast(res.error, 'error');
    }
  } catch (e) {
    app.toast(e.message || '保存失败', 'error');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.asq {
  padding: var(--sp-20);
  display: flex;
  flex-direction: column;
  gap: var(--sp-12);
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
}
.asq-bar { display: flex; align-items: center; gap: var(--sp-12); flex-wrap: wrap; }
.asq-bar .sp { flex: 1; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.asq-month { width: 150px; }
.asq-card { width: 100%; box-sizing: border-box; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.asq-card :deep(.el-card__header) { flex: 0 0 auto; }
.asq-card :deep(.el-card__body) { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.asq-card-h { font-weight: 600; }
.asq-warn { margin-left: var(--sp-12); font-size: var(--el-font-size-extra-small); color: var(--warn); }
/* 权重项合计提示（需 100%） */
.asq-sum { margin-left: var(--sp-12); font-size: var(--el-font-size-extra-small); color: var(--muted); }
.asq-sum.is-bad { color: var(--el-color-danger); font-weight: 600; }
/* 分层方式下拉 */
.asq-layer { width: 112px; }
.asq-legend { margin-left: auto; display: flex; gap: var(--sp-12); }
.asq-legend-item { display: inline-flex; align-items: center; gap: 4px; font-size: var(--el-font-size-extra-small); color: var(--muted); }
.asq-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.asq-dot.is-pos { background: var(--el-color-success); }
.asq-dot.is-neg { background: var(--el-color-danger); }
.asq-tip { font-size: var(--el-font-size-extra-small); color: var(--muted); }
.asq-table { flex: 1 1 auto; min-height: 0; --el-component-size: 28px; }
.asq-table :deep(.el-table__cell) { padding: 6px 0; }
/* 全部列用 min-width（flex 列）→ fit 时剩余宽度按各列 min-width 比例分配；
   nowrap 保证列变窄时内容不换行、不撑高行 */
.asq-table :deep(.cell) { white-space: nowrap; }
.asq-table :deep(.el-table__header th) { padding: 8px 0; }
.asq-cell { display: flex; align-items: center; justify-content: center; gap: 4px; }
.asq-cell :deep(.el-input-number) { width: 68px; }
.asq-unit { color: var(--muted); font-size: 12px; }
.asq-metric { display: flex; flex-direction: column; gap: 4px; align-items: center; }
.asq-metric-name { font-weight: 600; }
/* 计分方式下拉 */
.asq-kind { width: 92px; }
/* 权重列：权重项=百分比单输入；调分项=得分区间双输入 */
.asq-weight-cell, .asq-range-cell {
  display: flex; align-items: center; justify-content: center; gap: 4px;
}
.asq-weight-cell :deep(.el-input-number) { width: 64px; }
.asq-range-cell :deep(.el-input-number) { width: 52px; }
.asq-tilde { color: var(--muted); font-size: 12px; }
.asq-tier { font-size: 12px; color: var(--muted); }
.asq-tier.is-t100 { color: var(--el-color-success); }
.asq-tier.is-t0 { color: var(--el-color-danger); }
.asq-note { margin: var(--sp-8) 0 0; font-size: var(--el-font-size-extra-small); color: var(--muted); }
.asq-updated { font-size: var(--el-font-size-extra-small); color: var(--muted); }
.asq-saved { font-size: var(--el-font-size-extra-small); color: #1aac5a; }
</style>