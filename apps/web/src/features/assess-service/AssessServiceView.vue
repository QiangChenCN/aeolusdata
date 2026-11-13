<template>
  <div class="asq">
    <div class="asq-bar">
      <h2 class="v-title">服务质量设置</h2>
      <el-date-picker
        v-model="month" type="month" value-format="YYYY-MM"
        placeholder="选择月份" class="asq-month" @change="load"
      />
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
      </template>

      <el-table
        :data="rows" border height="100%" class="asq-table"
        :span-method="spanMethod" :row-key="rowKey"
      >
        <el-table-column label="考核项" fixed="left" min-width="150" align="center">
          <template #default="{ row }">
            <div class="asq-metric">
              <span class="asq-metric-name">{{ row.name }}</span>
              <el-button
                size="small" text type="primary" class="asq-metric-add"
                @click="addTier(row.metricKey)"
              >+ 档位</el-button>
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

        <el-table-column label="档位（得分）" fixed="left" min-width="140" align="center">
          <template #default="{ row }">
            <span v-if="!row.tier" class="asq-unit">未设置，点「+ 档位」添加</span>
            <div v-else class="asq-tier-cell">
              <el-input-number
                :model-value="tierScoreOf(row.metricKey, row.tier)" :min="0" :max="100"
                :controls="false" size="small" placeholder="得分"
                class="asq-tier-score"
                @change="(v) => setTierScore(row.metricKey, row.tier, v)"
              />
              <span class="asq-unit">分档</span>
              <el-button
                v-if="tiersOf(row.metricKey).length > 2" size="small" text type="danger"
                class="asq-tier-del" @click="removeTier(row.metricKey, row.tier)"
              >删除</el-button>
            </div>
          </template>
        </el-table-column>

        <!-- 值列：已配置天气分层 → 每日型下按天气档位再分列（周中 N + 周末 N）；
             未配置 → 每日型仅 1 列（内部固定用 normal 键存取，天气维度不参与）。
             按每行「分层方式」由 span-method 合并单元格 -->
        <template v-if="weatherConfigured">
          <el-table-column v-for="dt in dateTypes" :key="dt.key" :label="dt.name" align="center">
            <el-table-column
              v-for="wx in weather" :key="wx.key" :label="wx.name"
              min-width="112" align="center"
            >
              <template #default="{ row }">
                <div class="asq-cell">
                  <el-input-number
                    v-if="row.tier"
                    :model-value="tierValue(row.metricKey, dt.key, wx.key, row.tier)"
                    :min="0"
                    :max="row.unit === '%' ? 100 : undefined"
                    :controls="false" size="small" placeholder="—"
                    :disabled="!isEditable(row.metricKey, dt.key, wx.key)"
                    @change="(v) => setTier(row.metricKey, dt.key, wx.key, row.tier, v)"
                  />
                  <span v-if="row.tier && row.unit" class="asq-unit">{{ unitLabel(row.unit) }}</span>
                </div>
              </template>
            </el-table-column>
          </el-table-column>
        </template>
        <template v-else>
          <el-table-column
            v-for="dt in dateTypes" :key="'flat-' + dt.key" :label="dt.name"
            min-width="112" align="center"
          >
            <template #default="{ row }">
              <div class="asq-cell">
                <el-input-number
                  v-if="row.tier"
                  :model-value="tierValue(row.metricKey, dt.key, 'normal', row.tier)"
                  :min="0"
                  :max="row.unit === '%' ? 100 : undefined"
                  :controls="false" size="small" placeholder="—"
                  :disabled="!isEditable(row.metricKey, dt.key, 'normal')"
                  @change="(v) => setTier(row.metricKey, dt.key, 'normal', row.tier, v)"
                />
                <span v-if="row.tier && row.unit" class="asq-unit">{{ unitLabel(row.unit) }}</span>
              </div>
            </template>
          </el-table-column>
        </template>
      </el-table>

    </el-card>

    <el-card class="asq-card asq-card--fixed" shadow="never">
      <template #header>
        <span class="asq-card-h">特殊日期设置</span>
      </template>
      <div class="asq-sp">
        <div v-for="(o, i) in dateOverrides" :key="o.id" class="asq-sp-row">
          <el-date-picker
            v-model="o.date" type="date" value-format="YYYY-MM-DD"
            :disabled-date="notInMonth" placeholder="选择日期" size="small" class="asq-sp-date"
          />
          <el-select v-model="o.treat_as" size="small" class="asq-sp-treat" placeholder="如何计算">
            <el-option label="按周中算" value="weekday" />
            <el-option label="按周末算" value="weekend" />
          </el-select>
          <el-button size="small" text type="danger" @click="removeOverride(i)">删除</el-button>
        </div>
        <div class="asq-sp-actions">
          <el-button type="primary" size="default" @click="addOverride">+ 添加特殊日期</el-button>
          <span v-if="!dateOverrides.length" class="asq-tip">暂无特殊日期</span>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import {
  fetchServiceQualityTargets, saveServiceQualityTargets,
} from '../../api/dashboards.js';

/** 档位（得分锚点）：按月、按考核项可配 {metricKey: [{key, score}]}；
 *  key 为阈值存储键；无固定/默认档位，空列表 = 该项未设置（由用户自行添加）。 */
const tiersMap = ref({});
let _tierSeq = 0;
function tiersOf(mk) {
  return tiersMap.value[mk] || [];
}

const month = ref(currentMonth());
const metrics = ref([]);
const dateTypes = ref([]);
const weather = ref([]);
/** 该月是否配置了天气分层（false = 天气维度不参与，仅展示周中/周末两列）。 */
const weatherConfigured = ref(false);
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
const dateOverrides = ref([]);
let _ovId = 0;
function addOverride() {
  dateOverrides.value.push({ id: _ovId++, date: '', treat_as: '' });
}
function removeOverride(i) {
  dateOverrides.value.splice(i, 1);
}
/** 日期选择器禁用非本月的日期。 */
function notInMonth(date) {
  const d = new Date(date);
  const [y, m] = month.value.split('-').map(Number);
  return d.getFullYear() !== y || d.getMonth() + 1 !== m;
}

function currentMonth() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

function fmtTime(v) {
  if (!v) return '';
  return String(v).replace('T', ' ').slice(0, 19);
}

function emptyTiers(mk) {
  const out = {};
  for (const t of tiersOf(mk)) out[t.key] = null;
  return out;
}

// ===================== 档位编辑（按考核项独立） =====================
function tierIndex(mk, key) {
  return tiersOf(mk).findIndex((t) => t.key === key);
}
function tierScoreOf(mk, key) {
  const t = tiersOf(mk).find((x) => x.key === key);
  return t && Number.isFinite(Number(t.score)) ? Number(t.score) : null;
}
function setTierScore(mk, key, v) {
  const t = tiersOf(mk).find((x) => x.key === key);
  if (!t) return;
  t.score = _num(v);
}
function addTier(mk) {
  _tierSeq += 1;
  if (!tiersMap.value[mk]) tiersMap.value[mk] = [];
  tiersMap.value[mk].push({ key: `tx${_tierSeq}_${Date.now()}`, score: null });
}
function removeTier(mk, key) {
  const list = tiersMap.value[mk] || [];
  const i = tierIndex(mk, key);
  if (i < 0 || list.length <= 2) return; // 每个考核项至少保留 2 档
  list.splice(i, 1);
}
/** 档位合法性（逐考核项）：留空 = 未设置放行；非空须 ≥2 档且每档得分 0~100 互不相同。 */
function tierListError() {
  for (const m of metrics.value) {
    const list = tiersOf(m.key);
    if (!list.length) continue; // 未设置：放行
    if (list.length < 2) return `${m.name}：至少需要 2 个档位（或全部删除表示未设置）`;
    const scores = [];
    for (const t of list) {
      const s = Number(t.score);
      if (!Number.isFinite(s) || s < 0 || s > 100) return `${m.name}：每个档位的得分须为 0~100 的数值`;
      scores.push(Math.round(s * 100) / 100);
    }
    if (new Set(scores).size !== scores.length) return `${m.name}：各档位的得分不能重复`;
  }
  return null;
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
 *  weather 天气分层 → N 列（各天气档） date_weather   → 2N 列（周中/周末 × 各天气档）
 *  未分层的维度在保存时按此表展开成完整矩阵；
 *  未配置天气分层时天气维度不参与（每日型仅 1 列，内部固定用 normal 键存取）。 */
function layeringOf(mk) {
  return layering.value[mk] || (weatherConfigured.value ? 'date_weather' : 'date');
}
/** 分层方式归一：未配置天气分层时天气维度不参与，weather / date_weather 一律按 date 展示与保存。 */
function coerceLayering(v) {
  const key = v || (weatherConfigured.value ? 'date_weather' : 'date');
  if (!weatherConfigured.value && key !== 'none') return 'date';
  return key;
}
/** 实际参与编辑/保存的天气列：未配置天气分层时只有内部固定列 normal（「不分天气」）。 */
const wxList = computed(() =>
  weatherConfigured.value ? weather.value : [{ key: 'normal', name: '不分天气' }]
);
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
  if (!targets.value[mk][dtKey][wxKey]) targets.value[mk][dtKey][wxKey] = emptyTiers(mk);
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

/** 行 = 考核项 × 该项档位；考核项列按该项档位行数合并（各考核项行数可不同）。
 *  该项未添加任何档位时生成一条占位行（tier=null），用于承载「+ 档位」入口与「未设置」提示。 */
const rows = computed(() => {
  const out = [];
  for (const m of metrics.value) {
    const cells = targets.value[m.key] || {};
    const list = tiersOf(m.key);
    if (!list.length) {
      out.push({
        rowKey: `${m.key}__placeholder`,
        metricKey: m.key,
        tier: null,
        tierIndex: 0,
        name: m.name,
        unit: m.unit,
        direction: m.direction,
        cells,
      });
      continue;
    }
    list.forEach((t, i) => {
      out.push({
        rowKey: `${m.key}__${t.key}`,
        metricKey: m.key,
        tier: t.key,
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
 *  ① 前 4 列（考核项 / 计分方式 / 指标权重 / 分层方式）按档位行数合并；
 *  ② 值列（index>=5，共 dateTypes × wxList 列）按**本行**分层方式合并：
 *     不层→ 1 格；日期分层 → 每日型 1 格；
 *     天气分层 → 全部格子但周末组只读镜像；日期天气分层 → 全部格子各自独立。
 */
function spanMethod({ row, columnIndex }) {
  if (columnIndex <= 3) {
    if (row.tierIndex === 0) return { rowspan: Math.max(1, tiersOf(row.metricKey).length), colspan: 1 };
    return { rowspan: 0, colspan: 0 };
  }
  if (columnIndex === 4) return { rowspan: 1, colspan: 1 }; // 档位列
  const L = layeringOf(row.metricKey);
  const wxCount = wxList.value.length;
  const vi = columnIndex - 5; // 值列序号 0..(dateTypes*wxCount-1)
  if (L === 'none') {
    if (vi === 0) return { rowspan: 1, colspan: dateTypes.value.length * wxCount };
    return { rowspan: 0, colspan: 0 };
  }
  if (L === 'date') {
    if (vi % wxCount === 0) return { rowspan: 1, colspan: wxCount };
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
      for (const wx of wxList.value) {
        const cell = srcDt[wx.key] || {};
        const cellOut = {};
        for (const tier of tiersOf(m.key)) {
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
    // 档位配置（按考核项 {metric: [{key,score}]}；空 = 该项未设置，不注入默认档位）
    const tRes = (res && res.tiers) || {};
    const tMap = {};
    for (const m of metrics.value) {
      const list = Array.isArray(tRes) ? tRes : (tRes[m.key] || []);
      tMap[m.key] = list.map((t) => ({ key: t.key, score: Number(t.score) }));
    }
    tiersMap.value = tMap;
    weatherConfigured.value = !!(res && res.weather_configured);
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
    // 未配置天气分层时，天气维度不参与 → 分层方式只保留「不分层 / 日期分层」
    layeringOptions.value = weatherConfigured.value
      ? (res && res.layering_meta) || []
      : ((res && res.layering_meta) || []).filter((l) => l.key === 'none' || l.key === 'date');
    const lv = (res && res.layering) || {};
    const lvEdit = {};
    for (const m of metrics.value) lvEdit[m.key] = coerceLayering(lv[m.key]);
    layering.value = lvEdit;
    const k = (res && res.kinds) || {};
    const kEdit = {};
    for (const m of metrics.value) {
      kEdit[m.key] = k[m.key] === undefined ? null : k[m.key];
    }
    kinds.value = kEdit;
    updatedAt.value = fmtTime(res && res.updated_at);
    updatedBy.value = (res && res.updated_by) || '';
    const ov = (res && res.date_overrides) || {};
    dateOverrides.value = Object.keys(ov).sort().map((date) => ({
      id: _ovId++, date, treat_as: ov[date] === 'weekend' ? 'weekend' : 'weekday',
    }));
  } catch (e) {
    ElMessage.error(e.message || '加载服务质量设置失败');
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
    // 档位合法性先校验（≥2 档、得分 0~100 且互不相同）
    const tierErr = tierListError();
    if (tierErr) {
      ElMessage.error(tierErr);
      return;
    }
    const body = {
      month: month.value, tiers: {}, targets: {}, weights: {}, ranges: {}, kinds: {}, layering: {},
      date_overrides: {},
    };
    for (const m of metrics.value) {
      const kind = kinds.value[m.key] ?? null;
      const w = weights.value[m.key];
      const r = ranges.value[m.key] || {};
      const metricTiers = tiersOf(m.key);
      // 该考核项的档位列表（key 稳定，分值可改；增删不影响其他考核项）
      body.tiers[m.key] = metricTiers.map((t) => ({ key: t.key, score: Number(t.score) }));
      body.kinds[m.key] = kind;
      body.layering[m.key] = layeringOf(m.key);
      // 权重项存百分比；调分项存得分区间（权重留空）
      body.weights[m.key] = kind === 'weight' ? _num(w) : null;
      body.ranges[m.key] = kind === 'adjust'
        ? { min: _num(r.min), max: _num(r.max) }
        : { min: null, max: null };
      // 按分层方式展开成完整矩阵（非代表格取其代表列的值）；阈值键 = 该考核项档位 key
      const perMetric = {};
      for (const dt of dateTypes.value) {
        const perWx = {};
        for (const wx of wxList.value) {
          const [rDt, rWx] = repFor(m.key, dt.key, wx.key);
          const cell = {};
          for (const t of metricTiers) cell[t.key] = tierValue(m.key, rDt, rWx, t.key);
          perWx[wx.key] = cell;
        }
        perMetric[dt.key] = perWx;
      }
      body.targets[m.key] = perMetric;
    }
    // 特殊日期覆盖表：日期 → 按周中/周末算（仅保留日期与计算方式都填了的条目）
    for (const o of dateOverrides.value) {
      if (o.date && (o.treat_as === 'weekday' || o.treat_as === 'weekend')) {
        body.date_overrides[o.date] = o.treat_as;
      }
    }
    const res = await saveServiceQualityTargets(body);
    if (res && res.ok) {
      ElMessage.success('服务质量设置已保存');
      savedInfo.value = true;
      configured.value = true;
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
.asq-warn { margin-left: var(--sp-12); font-size: var(--el-font-size-extra-small); color: var(--el-color-warning); }
/* 权重项合计提示（需 100%） */
.asq-sum { margin-left: var(--sp-12); font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.asq-sum.is-bad { color: var(--el-color-danger); font-weight: 600; }
/* 分层方式下拉 */
.asq-layer { width: 112px; }
.asq-tip { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.asq-table { flex: 1 1 auto; min-height: 0; --el-component-size: 28px; }
.asq-table :deep(.el-table__cell) { padding: 6px 0; }
/* 全部列用 min-width（flex 列）→ fit 时剩余宽度按各列 min-width 比例分配；
   nowrap 保证列变窄时内容不换行、不撑高行 */
.asq-table :deep(.cell) { white-space: nowrap; }
.asq-table :deep(.el-table__header th) { padding: 8px 0; }
.asq-cell { display: flex; align-items: center; justify-content: center; gap: 4px; }
.asq-cell :deep(.el-input-number) { width: 68px; }
.asq-unit { color: var(--el-text-color-secondary); font-size: 12px; }
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
.asq-tilde { color: var(--el-text-color-secondary); font-size: 12px; }
/* 档位列：得分可编辑 + 删除按钮；考核项合并格内加「+ 档位」 */
.asq-tier-cell { display: flex; align-items: center; justify-content: center; gap: 4px; }
.asq-tier-cell :deep(.el-input-number) { width: 56px; }
.asq-metric-add { padding: 0 4px; height: 20px; font-size: 12px; }
.asq-updated { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.asq-saved { font-size: var(--el-font-size-extra-small); color: #1aac5a; }
/* 特殊日期设置：卡片不撑满，按内容高度；列表行内联排列 */
.asq-card--fixed { flex: 0 0 auto; min-height: auto; }
.asq-sp { display: flex; flex-direction: column; gap: var(--sp-8); }
.asq-sp-row { display: flex; align-items: center; gap: var(--sp-8); }
.asq-sp-date { width: 170px; }
.asq-sp-treat { width: 132px; }
.asq-sp-actions { display: flex; align-items: center; gap: var(--sp-12); }
</style>