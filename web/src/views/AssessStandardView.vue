<template>
  <div class="asv">
    <div class="asv-bar">
      <h2 class="v-title">标准达成设置</h2>
      <el-date-picker
        v-model="month" type="month" value-format="YYYY-MM"
        placeholder="选择月份" class="asv-month" @change="load"
      />
      <span class="asv-tip">为所选月份单独配置参与站点与各自标准</span>
      <span class="sp" />
      <span v-if="savedInfo" class="asv-saved">已保存</span>
      <span v-if="updatedAt" class="asv-updated">最后更新：{{ updatedAt }}（{{ updatedBy || '—' }}）</span>
      <el-button type="primary" :loading="saving" @click="save">保存设置</el-button>
    </div>

    <el-card class="asv-card asv-site-card" shadow="never">
      <template #header>
        <span class="asv-card-h">参与站点考核设置（{{ teamRows.length }} 个）</span>
        <span v-if="!configured" class="asv-warn">{{ month }} 月份尚未保存过配置，保存后生效</span>
        <el-select v-model="addTeam" filterable placeholder="添加站点" class="asv-add" @change="onAddTeam">
          <el-option v-for="t in availableToAdd" :key="t.id" :label="t.name" :value="String(t.id)" />
        </el-select>
      </template>

      <div v-if="!teamRows.length" class="asv-empty">
        <template v-if="!configured">
          {{ month }} 月份<strong>尚未保存过考核配置</strong>：用右上角「添加站点」选择参与考核的站点，保存后该月才生效。
        </template>
        <template v-else>
          {{ month }} 月份已保存为空（无参与站点）。用右上角「添加站点」加入站点；留空表示该月不参与考核。
        </template>
      </div>

      <el-table
        v-else :data="teamRows" border height="100%"
        class="asv-team-table"
      >
        <el-table-column label="站点ID" fixed="left" min-width="112">
          <template #default="{ row }">
            <span class="asv-tid">{{ row.tid }}</span>
          </template>
        </el-table-column>
        <el-table-column label="站点" fixed="left" min-width="130">
          <template #default="{ row }">
            <span class="asv-tname">{{ teamName(row.tid) }}</span>
          </template>
        </el-table-column>
        <el-table-column v-for="lv in LEVEL_NO" :key="lv" :label="'标准' + lv" align="center">
          <el-table-column label="单量" min-width="88" align="center">
            <template #default="{ row }">
              <el-input-number
                v-model="row.cfg.levels[lv - 1].orders" :min="0" :max="999"
                :controls="false"
              />
            </template>
          </el-table-column>
          <el-table-column label="时长(h)" min-width="88" align="center">
            <template #default="{ row }">
              <el-input-number
                v-model="row.cfg.levels[lv - 1].hours" :min="0" :max="24" :step="0.5" :precision="1"
                :controls="false"
              />
            </template>
          </el-table-column>
        </el-table-column>
        <el-table-column label="门槛" min-width="140" align="center">
          <template #default="{ row }">
            <div class="asv-pct">
              <el-input-number
                v-model="row.cfg.thresholdPct" :min="0" :max="100" :controls="false"
                placeholder="未设置"
              />
              <span class="asv-unit">%</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="封顶" min-width="140" align="center">
          <template #default="{ row }">
            <div class="asv-pct">
              <el-input-number
                v-model="row.cfg.capPct" :min="0" :max="200" :controls="false"
                placeholder="未设置"
              />
              <span class="asv-unit">%</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="76" align="center">
          <template #default="{ row }">
            <el-button link type="danger" @click="onRemoveTeam(row.tid)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { fetchTeams, fetchStandardGradeGlobal, saveStandardGradeGlobal } from '../api/dashboards.js';



const LEVEL_NO = [1, 2, 3, 4, 5];
/* 新增站点时的初始值（仅作填充，用户可随意改；不构成"默认档位"） */
const FILL_LEVELS = [
  { level: 1, orders: 18, hours: 6 },
  { level: 2, orders: 21, hours: 6 },
  { level: 3, orders: 26, hours: 6 },
  { level: 4, orders: 32, hours: 7 },
  { level: 5, orders: 39, hours: 8 },
];
const FILL_THRESHOLD = 80;
const FILL_CAP = 100;

const allTeams = ref([]);
const month = ref(currentMonth());
const teams = ref({});
const configured = ref(false);
const addTeam = ref('');
const updatedAt = ref('');
const updatedBy = ref('');
const saving = ref(false);
const savedInfo = ref(false);

function currentMonth() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

function teamName(tid) {
  const t = (allTeams.value || []).find((x) => String(x.id) === String(tid));
  return t ? t.name : String(tid);
}

const availableToAdd = computed(() =>
  (allTeams.value || []).filter((t) => !(String(t.id) in teams.value)),
);
/* 站点表格数据：每行一个站点（{ tid, cfg }），cfg 即该站点的档位 / 门槛配置 */
const teamRows = computed(() =>
  Object.entries(teams.value).map(([tid, cfg]) => ({ tid, cfg })),
);

function fmtTime(v) {
  if (!v) return '';
  return String(v).replace('T', ' ').slice(0, 19);
}

function newSite() {
  return {
    levels: FILL_LEVELS.map((l) => ({ ...l })),
    thresholdPct: FILL_THRESHOLD,
    capPct: FILL_CAP,
  };
}

function onAddTeam(tid) {
  if (!tid) return;
  if (!(String(tid) in teams.value)) teams.value[String(tid)] = newSite();
  addTeam.value = '';
}

function onRemoveTeam(tid) {
  delete teams.value[String(tid)];
}

async function load() {
  try {
    const t = await fetchTeams();
    allTeams.value = (t && t.teams) || [];
  } catch (e) { /* 忽略：站点列表不影响核心配置 */ }
  try {
    const res = await fetchStandardGradeGlobal(month.value);
    configured.value = !!(res && res.configured);
    const nt = {};
    for (const [tid, cfg] of Object.entries((res && res.teams) || {})) {
      const lv = (cfg.levels || []).slice(0, 5);
      while (lv.length < 5) lv.push(FILL_LEVELS[lv.length]);
      nt[String(tid)] = {
        levels: lv.map((x, i) => ({
          level: i + 1, orders: Number(x.orders) || 0, hours: Number(x.hours) || 0,
        })),
        thresholdPct: cfg.threshold_pct != null ? Number(cfg.threshold_pct) : null,
        capPct: cfg.cap_pct != null ? Number(cfg.cap_pct) : null,
      };
    }
    teams.value = nt;
    updatedAt.value = fmtTime(res && res.updated_at);
    updatedBy.value = (res && res.updated_by) || '';
  } catch (e) {
    ElMessage.error(e.message || '加载标准达成设置失败');
  }
}

function _levels(arr) {
  return (arr || []).map((l) => ({
    level: l.level, orders: Number(l.orders) || 0, hours: Number(l.hours) || 0,
  }));
}

/** 门槛/封顶：清空输入框 = 未设置（存null），与后端「未设置」语义一致。 */
function _pct(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function save() {
  saving.value = true;
  savedInfo.value = false;
  try {
    const body = { month: month.value, teams: {} };
    for (const [tid, cfg] of Object.entries(teams.value)) {
      body.teams[tid] = {
        levels: _levels(cfg.levels),
        threshold_pct: _pct(cfg.thresholdPct),
        cap_pct: _pct(cfg.capPct),
      };
    }
    const res = await saveStandardGradeGlobal(body);
    if (res && res.ok) {
      ElMessage.success('标准达成设置已保存');
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
.asv {
  padding: var(--sp-20);
  display: flex;
  flex-direction: column;
  gap: var(--sp-12);
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
}
.asv-bar { display: flex; align-items: center; gap: var(--sp-12); flex-wrap: wrap; }
.asv-bar .sp { flex: 1; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.asv-month { width: 150px; }
.asv-card { width: 100%; box-sizing: border-box; flex: 0 0 auto; }
.asv-card-h { font-weight: 600; }
.asv-warn { margin-left: var(--sp-12); font-size: var(--el-font-size-extra-small); color: var(--el-color-warning); }
.asv-add { width: 200px; margin-left: auto; }
.asv-tip { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
/* 站点表格卡片：撑满剩余高度，表格内部滚动 */
.asv-site-card { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.asv-site-card :deep(.el-card__header) { flex: 0 0 auto; }
.asv-site-card :deep(.el-card__body) { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
/* 全部列用 min-width（flex 列）→ fit 时多余宽度按各列 min-width 比例分配 */
.asv-team-table {
  flex: 1 1 auto;
  min-height: 0;
  /* 统一控件尺寸基准：表内所有 el-input-number / el-checkbox 都以此为准（32px），
     避免「单量/时长」与「门槛/封顶」两类控件出现高度差异 */
  --el-component-size: 32px;
}
.asv-team-table :deep(.cell) { white-space: nowrap; }
/* 门槛/封顶单元格：输入框 + 百分号水平排列并垂直居中 */
.asv-pct { display: flex; align-items: center; justify-content: center; gap: 4px; }
.asv-pct :deep(.el-input-number) { flex: 1 1 auto; min-width: 0; }
/* 单量/时长单元格：输入框撑满列宽，与门槛/封顶的观感一致 */
.asv-team-table :deep(.cell) > .el-input-number { width: 100%; }
/* 行高：控件 32px + 上下各 11px 内边距 ≈ 54px，手工录入更从容 */
.asv-team-table :deep(.el-table__cell) { padding: 11px 0; }
.asv-team-table :deep(.el-table__header th) { padding: 8px 0; }
.asv-empty { color: var(--el-text-color-secondary); font-size: var(--el-font-size-extra-small); padding: var(--sp-12) 0; }
.asv-tname { font-weight: 600; }
/* 门槛/封顶单元格内的百分号单位 */
.asv-unit { color: var(--el-text-color-secondary); font-size: 12px; margin-left: 2px; }
/* 站点ID：等宽数字，两列并排时对齐更整齐 */
.asv-tid { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--el-text-color-secondary); }
.asv-updated { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.asv-saved { font-size: var(--el-font-size-extra-small); color: #1aac5a; }
</style>