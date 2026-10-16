<template>
  <div class="dv">
    <div class="dv-bar">
      <h2 class="v-title">考核看板</h2>
      <el-select v-model="teamSel" class="dv-sel" placeholder="站点" @change="load">
        <el-option label="全部站点" value="__all__" />
        <el-option v-for="t in teamOptions" :key="t.id" :label="t.name" :value="t.id" />
      </el-select>
      <el-button @click="openCfg"><el-icon><Setting /></el-icon> 站点设置</el-button>
      <el-text v-if="lastUpdated" type="info" size="small" class="dv-updated">
        更新时间 {{ lastUpdated }}
      </el-text>
      <span class="sp" />
      <el-select v-if="autoRefresh" v-model="intervalSec" class="dv-sel" style="width: 120px" @change="restartPoll">
        <el-option label="5 分钟" :value="300" />
        <el-option label="10 分钟" :value="600" />
        <el-option label="15 分钟" :value="900" />
      </el-select>
      <el-switch v-model="autoRefresh" inline-prompt active-text="自动" inactive-text="手动" @change="onAutoToggle" />
      <el-button :loading="loading" :disabled="cooldownRemaining > 0" class="dv-refresh-btn" @click="load(false, true, true)">
        <template v-if="autoRefresh">
          <span class="dv-cd">（{{ countdown }}s）</span>
        </template>
        <template v-else-if="cooldownRemaining > 0">
          <span class="dv-cd">（{{ cooldownRemaining }}s）</span>
        </template>
        <template v-else>
          <el-icon><Refresh /></el-icon>刷新
        </template>
      </el-button>
    </div>

    <el-alert v-if="needRefresh" type="info" :closable="false" show-icon class="dv-hint">
      当前站点今日运单明细尚未落盘。运单数据请在「标准达成」中点「刷新数据」拉取；违规数据由本看板「刷新」按钮独立拉取。
    </el-alert>
    <el-alert v-else-if="dataNote" type="warning" :closable="false" show-icon class="dv-hint">{{ dataNote }}</el-alert>

    <!-- KPI 汇总卡片（随选中站点聚合，全部站点=各站求和后重算比率） -->
    <div v-if="cards.length" class="dv-cards">
        <div v-for="c in cards" :key="c.label" class="dv-card">
          <span class="dv-card-num" :class="c.cls">{{ c.value }}</span>
          <span class="dv-card-label">{{ c.label }}</span>
        </div>
      </div>

      <!-- 站点明细对比表（列可排序，默认按推配送单量降序） -->
      <div class="dv-table-wrap">
      <el-table
        v-loading="loading"
        :data="rows"
        size="large"
        stripe
        border
        class="dv-table"
        empty-text="暂无实时数据"
        height="100%"
        :default-sort="{ prop: 'pushed_order_volume', order: 'descending' }"
      >
        <el-table-column prop="team_name" label="站点" :min-width="teamNameMinWidth" fixed sortable className="dv-col-team" />
        <el-table-column prop="pushed_order_volume" label="推配送单量" sortable>
          <template #default="{ row }">
            <el-text :class="{ 'dv-zero': num(row.pushed_order_volume) === 0 }">{{ row.pushed_order_volume }}</el-text>
          </template>
        </el-table-column>
        <el-table-column prop="delivery_completed" label="配送完成单" sortable>
          <template #default="{ row }">
            <el-text :class="{ 'dv-zero': num(row.delivery_completed) === 0 }">{{ row.delivery_completed }}</el-text>
          </template>
        </el-table-column>
        <el-table-column prop="weather_level" label="天气等级" sortable :sort-method="weatherSort" min-width="110">
          <template #default="{ row }">
            <el-tag v-if="row.weather_level" :type="weatherTagType(row.weather_level)" size="small" effect="light">{{ row.weather_level }}</el-tag>
            <span v-else class="dv-muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="adverse_ratio" label="恶单占比" sortable min-width="100" className="dv-grp-end">
          <template #default="{ row }">
            <span v-if="row.adverse_ratio != null" :class="adverseRatioCls(row.adverse_ratio)">{{ row.adverse_ratio }}%</span>
            <span v-else class="dv-muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="预估得分" className="dv-grp-score">
          <el-table-column label="总分" align="center" sortable :sort-method="rateSort('total_score')" className="dv-g-score dv-g-total">
            <template #default="{ row }">
              <div class="score-bg" :style="scoreBgStyle(row.total_score)">
                <el-text :class="['rt', { 'dv-zero': num(row.total_score) === 0 }]">{{ fmtMin(row.total_score) }}</el-text>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="T8准时率得分" align="center" sortable :sort-method="rateSort('t8_ontime_score')" className="dv-g-score">
            <template #default="{ row }">
              <el-text :class="['rt', { 'dv-zero': num(row.t8_ontime_score) === 0, 'is-bad': scoreBelowFull(row.t8_ontime_score) }]">{{ fmtMin(row.t8_ontime_score) }}</el-text>
            </template>
          </el-table-column>
          <el-table-column label="物流妥投率得分" align="center" sortable :sort-method="rateSort('fulfillment_score')" className="dv-g-score">
            <template #default="{ row }">
              <el-text :class="['rt', { 'dv-zero': num(row.fulfillment_score) === 0, 'is-bad': scoreBelowFull(row.fulfillment_score) }]">{{ fmtMin(row.fulfillment_score) }}</el-text>
            </template>
          </el-table-column>
          <el-table-column label="不满意得分" align="center" sortable :sort-method="rateSort('unsat_score')" className="dv-g-score">
            <template #default="{ row }">
              <el-text :class="['rt', { 'dv-zero': num(row.unsat_score) === 0, 'is-bad': scoreBelowFull(row.unsat_score) }]">{{ fmtMin(row.unsat_score) }}</el-text>
            </template>
          </el-table-column>
          <el-table-column label="复合超时时长得分" align="center" sortable :sort-method="rateSort('compound_overtime_score')" className="dv-g-score">
            <template #default="{ row }">
              <el-text :class="['rt', { 'dv-zero': num(row.compound_overtime_score) === 0, 'is-bad': scoreBelowFull(row.compound_overtime_score) }]">{{ fmtMin(row.compound_overtime_score) }}</el-text>
            </template>
          </el-table-column>
        </el-table-column>
        <el-table-column label="达成率" className="dv-grp-rate">
          <el-table-column label="T8准时率" align="center" sortable :sort-method="rateSort('t8_ontime_rate')" className="dv-g-rate">
            <template #default="{ row }">
              <span class="rt" :class="rateClsUp(row.t8_ontime_rate)">{{ fmtRate(row.t8_ontime_rate, 2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="物流妥投率" align="center" sortable :sort-method="rateSort('fulfillment_rate')" className="dv-g-rate">
            <template #default="{ row }">
              <span class="rt" :class="rateClsUp(row.fulfillment_rate)">{{ fmtRate(row.fulfillment_rate) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="不满意率" align="center" sortable :sort-method="rateSort('unsat_rate')" className="dv-g-rate">
            <template #default="{ row }">
              <span class="rt" :class="rateClsDown(row.unsat_rate)">{{ fmtRate(row.unsat_rate) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="复合超时时长(秒)" align="center" sortable :sort-method="rateSort('avg_compound_overtime_sec')" className="dv-g-rate">
            <template #default="{ row }">
              <el-text :class="['rt', { 'dv-zero': num(row.avg_compound_overtime_sec) === 0 }]">{{ fmtMin(row.avg_compound_overtime_sec) }}</el-text>
            </template>
          </el-table-column>
        </el-table-column>
        <el-table-column label="违规运单" className="dv-grp-other">
          <el-table-column prop="early_delivered" label="提前点送达" sortable className="dv-g-other">
            <template #default="{ row }">
              <span v-if="num(row.early_delivered) > 0" class="dv-drill" @click="drillTo(row, 'early_delivered')" :title="'查看「' + row.team_name + '」的 ' + row.early_delivered + ' 单提前点送达（违规处罚看板）'">{{ row.early_delivered }}</span>
              <el-text v-else :class="{ 'dv-zero': true }">0</el-text>
            </template>
          </el-table-column>
          <el-table-column prop="t8_timeout" label="T8超时" sortable className="dv-g-other">
            <template #default="{ row }">
              <el-text :class="{ 'dv-zero': num(row.t8_timeout) === 0 }">{{ row.t8_timeout }}</el-text>
            </template>
          </el-table-column>
          <el-table-column prop="gaobi_order" label="高比单T8超时" sortable className="dv-g-other">
            <template #default="{ row }">
              <el-text :class="{ 'dv-zero': num(row.gaobi_order) === 0 }">{{ row.gaobi_order }}</el-text>
            </template>
          </el-table-column>
          <el-table-column prop="false_report_slow_unfinished" label="虚假报备商户出餐慢取消" sortable className="dv-col-fake dv-g-other">
            <template #default="{ row }">
              <el-text :class="{ 'dv-zero': num(row.false_report_slow_unfinished) === 0 }">{{ row.false_report_slow_unfinished }}</el-text>
            </template>
          </el-table-column>
          <el-table-column prop="cancel_liable" label="物流责取消" sortable className="dv-g-other">
            <template #default="{ row }">
              <span v-if="num(row.cancel_liable) > 0" class="dv-drill" @click="drillTo(row, 'cancel_liable')" :title="'查看「' + row.team_name + '」的 ' + row.cancel_liable + ' 单物流责取消（违规处罚看板）'">{{ row.cancel_liable }}</span>
              <el-text v-else :class="{ 'dv-zero': true }">0</el-text>
            </template>
          </el-table-column>
          <el-table-column prop="gaobi_cancel_liable" label="高比单物流责取消" sortable className="dv-g-other">
            <template #default="{ row }">
              <el-text :class="{ 'dv-zero': num(row.gaobi_cancel_liable) === 0 }">{{ row.gaobi_cancel_liable }}</el-text>
            </template>
          </el-table-column>
          <el-table-column prop="complaint" label="投诉" sortable className="dv-g-other">
            <template #default="{ row }">
              <span v-if="num(row.complaint) > 0" class="dv-drill" @click="drillTo(row, 'complaint')" :title="'查看「' + row.team_name + '」的 ' + row.complaint + ' 单投诉（违规处罚看板）'">{{ row.complaint }}</span>
              <el-text v-else :class="{ 'dv-zero': true }">0</el-text>
            </template>
          </el-table-column>
          <el-table-column prop="bad_review" label="差评" sortable className="dv-g-other">
            <template #default="{ row }">
              <el-text :class="{ 'dv-zero': num(row.bad_review) === 0 }">{{ row.bad_review }}</el-text>
            </template>
          </el-table-column>
          <el-table-column prop="claim" label="索赔" sortable className="dv-g-other">
            <template #default="{ row }">
              <el-text :class="{ 'dv-zero': num(row.claim) === 0 }">{{ row.claim }}</el-text>
            </template>
          </el-table-column>
        </el-table-column>
      </el-table>
      </div>

      <!-- 站点设置：选择需要在看板展示的站点（持久化） -->
      <el-dialog v-model="cfgVisible" title="站点设置（选择需要在看板展示的站点）" width="440px">
      <el-checkbox-group v-model="cfgSel" class="dv-cfg-group">
      <el-checkbox v-for="t in teams" :key="t.id" :value="t.id">{{ t.name }}</el-checkbox>
      </el-checkbox-group>
      <template #footer>
      <el-button @click="cfgVisible = false">取消</el-button>
      <el-button type="primary" :loading="cfgSaving" @click="saveCfg">保存</el-button>
      </template>
      </el-dialog>
      </div>
      </template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchTeams, fetchAssessmentStation, refreshAssessment, refreshAssessmentDelivery, fetchRefreshCooldown, markRefreshCooldown, fetchAssessmentTeams, saveAssessmentTeams } from '../api/dashboards.js';
import { useRouter } from 'vue-router';

const router = useRouter();

/* 违规运单下钻：点击考核看板某站点的违规计数，跳转到「违规处罚」看板（实时 tab）并按
   站点 + 违规分类/类型 + 成立状态 筛选逐单明细。仅违规分类/类型可干净映射的列支持下钻。 */
const DRILL = {
  complaint: { cat: 'COMPLAIN' },        // 投诉 → 违规分类 COMPLAIN
  cancel_liable: { cat: 'CANCEL' },      // 物流责取消 → 违规分类 CANCEL
  early_delivered: { type: '1039' },     // 提前点送达 → 违规类型 1039（提前点送达（索赔））
};
function drillTo(row, metric) {
  const d = DRILL[metric];
  if (!d || num(row[metric]) === 0) return;
  const q = { tab: 'realtime', site: row.team_name, status: '10' };
  if (d.cat) q.cat = d.cat;
  if (d.type) q.type = d.type;
  router.push({ name: 'unsatisfied', query: q });
}


const teams = ref([]);
const teamSel = ref('__all__');
/* 展示站点配置：teamsCfg = 已配置展示的站点 id；未配置任何站点时回落全部（teamOptions 兜底）。 */
const teamsCfg = ref([]);
const teamOptions = computed(() =>
  teams.value.filter((t) => !teamsCfg.value.length || teamsCfg.value.includes(String(t.id)))
);
/* 站点设置弹窗状态 */
const cfgVisible = ref(false);
const cfgSel = ref([]);
const cfgSaving = ref(false);
function openCfg() {
  cfgSel.value = [...teamsCfg.value];
  cfgVisible.value = true;
}
async function saveCfg() {
  cfgSaving.value = true;
  try {
    const res = await saveAssessmentTeams(cfgSel.value);
    if (res && res.ok) {
      teamsCfg.value = res.teams || [...cfgSel.value];
      ElMessage.success('站点配置已保存');
      cfgVisible.value = false;
      teamSel.value = '__all__';   // 重置到全部站点，避免选中项被移出后下拉空白
      load();
    } else {
      ElMessage.error((res && res.error) || '保存失败');
    }
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    cfgSaving.value = false;
  }
}
const rows = ref([]);          // 有数据的站点行（已过滤 need_refresh）
const loading = ref(false);
const loaded = ref(false);
const attempted = ref(0);      // 本次实际请求的站点数
const lastUpdated = ref('');   // 最近一次成功取数时间（YYYY-MM-DD HH:MM:SS，北京时间）

/* —— 自动刷新（照搬 BotGlobalView 约定：setInterval + onUnmounted 清理）—— */
const autoRefresh = ref(localStorage.getItem('assessment.autoRefresh') !== 'false');
const intervalSec = ref(300);
const countdown = ref(0);     // 距下次自动刷新的剩余秒数（仅自动刷新时有效）
let pollTimer = null;
let tickTimer = null;

/* —— 手动刷新冷却（后端持久化冷却时间戳，页面刷新不失效）—— */
const cooldownRemaining = ref(0); // 距可再次手动刷新的剩余秒数（≥0）
let cooldownTimer = null;
function startCooldownTick() {
  stopCooldownTick();
  cooldownTimer = setInterval(() => {
    if (cooldownRemaining.value > 0) cooldownRemaining.value--;
    else stopCooldownTick();
  }, 1000);
}
function stopCooldownTick() {
  if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => void load(true, true, false), intervalSec.value * 1000);
  startTick();
  countdown.value = intervalSec.value;
}
function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  stopTick();
  countdown.value = 0;
}
function startTick() {
  stopTick();
  tickTimer = setInterval(() => { if (countdown.value > 0) countdown.value--; }, 1000);
}
function stopTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}
function restartPoll() {
  if (autoRefresh.value) startPoll();
}
async function onAutoToggle(on) {
  // 持久化自动/手动切换状态，刷新页面后不丢失
  localStorage.setItem('assessment.autoRefresh', on ? 'true' : 'false');
  if (on) {
    startPoll();
  } else {
    stopPoll();
    // 从自动切回手动：默认进入 1 分钟冷却，避免刚切回就手动重算；后端落盘保证刷新页面也不失效
    try {
      const s = await markRefreshCooldown();
      cooldownRemaining.value = s && s.remaining_sec != null ? s.remaining_sec : 60;
    } catch (e) {
      cooldownRemaining.value = 60;
    }
    startCooldownTick();
  }
}

const needRefresh = computed(() => loaded.value && attempted.value > 0 && rows.value.length === 0);
const dataNote = computed(() => {
  const p = rows.value.find((x) => x.data_status === 'partial');
  return p ? p.data_note || '' : '';
});

/* —— 聚合：全部站点时对各站计数求和，比率按口径重算（非直接平均比率）—— */
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }

const agg = computed(() => {
  const r = rows.value;
  const pushed = r.reduce((a, x) => a + num(x.pushed_order_volume), 0);
  const completed = r.reduce((a, x) => a + num(x.delivery_completed), 0);
  const t8 = r.reduce((a, x) => a + num(x.t8_timeout), 0);
  const complaint = r.reduce((a, x) => a + num(x.complaint), 0);
  const bad = r.reduce((a, x) => a + num(x.bad_review), 0);
  const claim = r.reduce((a, x) => a + num(x.claim), 0);
  const cancel = r.reduce((a, x) => a + num(x.cancel_liable), 0);
  const early = r.reduce((a, x) => a + num(x.early_delivered), 0);
  return {
    pushed, completed, t8, complaint, bad, claim, cancel, early,
    ontime: pct(completed - t8, completed),
    unsat: pct(complaint * 5 + bad * 5 + claim, pushed),
    fulfill: pct(completed, completed + cancel + early * 2),
  };
});

const cards = computed(() => [
  { label: '推配送单量', value: agg.value.pushed },
  { label: '配送完成单', value: agg.value.completed },
  { label: 'T8超时单', value: agg.value.t8 },
  { label: 'T8准时率', value: fmtRate(agg.value.ontime, 2), cls: rateClsUp(agg.value.ontime) },
  { label: '投诉', value: agg.value.complaint },
  { label: '差评', value: agg.value.bad },
  { label: '索赔', value: agg.value.claim },
  { label: '物流责取消', value: agg.value.cancel },
  { label: '提前点送达', value: agg.value.early },
  { label: '不满意率', value: fmtRate(agg.value.unsat), cls: rateClsDown(agg.value.unsat) },
  { label: '物流妥投率', value: fmtRate(agg.value.fulfill), cls: rateClsUp(agg.value.fulfill) },
]);

/* 比率列排序：null 永远排最后（无论升/降序），便于把「暂无数据」沉底 */
function rateSort(key) {
  return (a, b) => {
    const va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return va - vb;
  };
}

/* 比率展示：最多保留 digits 位小数（默认 3），超出截断、不足按实际显示、不补零。
   计算层（后端）存的是全精度，此函数只影响展示、不改变数值与排序。
   - 物流妥投率 / 不满意率 用默认 3 位；
   - T8准时率 用 fmtRate(v, 2) 最多 2 位（见列绑定）。 */
function fmtRate(v, digits = 3) {
  if (v == null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toFixed(digits))) + '%' : (v + '%');
}
function fmtMin(v) { return v == null ? '—' : v; }

/** 各考核项得分满分为 100：低于 100 标红（null 显示「—」时不标红）。
    配合 .rt.is-bad 使用；0 分同时带 .dv-zero，但 .rt.is-bad 优先级更高，仍显示红色。 */
function scoreBelowFull(v) {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n < 100;
}
/* ── 预估得分·总分 取色（纯红 → 纯橙 → 纯绿） ──────────────
   按分数值在 HSL 空间线性插值取色：分数越低越红、越高越绿。
   三个锚点均为高饱和纯色（s=100% l=50%）：h=0 纯红、h=30 纯橙、h=120 纯绿。
   看板满分 100（4 项算得加分后满分 85 + 其余 3 项满分 15），故绿色锚点落在 100；
   0 为纯红、50 为纯橙（取 0~100 中点）。该取色用于「总分单元格背景」铺色。 */
const SCORE_STOPS = [
  { v: 0,   h: 0,   s: 100, l: 50 }, // 纯红
  { v: 50,  h: 30,  s: 100, l: 50 }, // 纯橙
  { v: 100, h: 120, s: 100, l: 50 }, // 纯绿
];
function scoreColor(v, alpha = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const x = Math.min(100, Math.max(0, n));
  for (let i = 1; i < SCORE_STOPS.length; i++) {
    const a = SCORE_STOPS[i - 1], b = SCORE_STOPS[i];
    if (x <= b.v) {
      const t = (x - a.v) / (b.v - a.v);
      const h = a.h + (b.h - a.h) * t;
      const s = a.s + (b.s - a.s) * t;
      const l = a.l + (b.l - a.l) * t;
      return `hsla(${h.toFixed(1)}, ${s.toFixed(1)}%, ${l.toFixed(1)}%, ${alpha})`;
    }
  }
  const last = SCORE_STOPS[SCORE_STOPS.length - 1];
  return `hsla(${last.h}, ${last.s}%, ${last.l}%, ${alpha})`;
}
/** 总分单元格背景：用 scoreColor 的纯色按 85% 透明度（alpha 0.15）铺底，作淡色提示；
    文字保持默认深色以确保在淡底上可读。null（显示「—」）与 0 分沿用 .dv-zero 置灰，不铺色。
    同时 CSS 中已将总分列「本来的」.dv-g-score 浅底去除，避免与色阶背景叠加。 */
function scoreBgStyle(v) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n) || n === 0) return {};
  const c = scoreColor(v, 0.15);
  if (!c) return {};
  return { background: c };
}

/* 天气等级列：标签配色 + 排序（严重度递增，null 沉底） */
const WEATHER_TAG = {
  '正常天': 'success',
  '轻微恶天': 'info',
  '一般恶天': 'warning',
  '严重恶天': 'danger',
};
const WEATHER_RANK = { '正常天': 0, '轻微恶天': 1, '一般恶天': 2, '严重恶天': 3 };
function weatherTagType(v) { return WEATHER_TAG[v] || 'info'; }
function weatherSort(a, b) {
  const ra = WEATHER_RANK[a.weather_level], rb = WEATHER_RANK[b.weather_level];
  if (ra == null && rb == null) return 0;
  if (ra == null) return 1;
  if (rb == null) return -1;
  return ra - rb;
}
/* 恶单占比：>10% 即脱离正常天进入恶天判定区间（高亮）；≥35% 命中严重恶天（更醒目） */
function adverseRatioCls(v) {
  if (v >= 35) return 'dv-ratio-danger';
  if (v > 10) return 'dv-ratio-warn';
  return 'dv-ratio-ok';
}
/* 站点列 min-width = 该列最长站点名实际宽度（用表格同款字体测量，再补单元格左右内边距）。
   下限 120 保证表头「站点」+ 排序箭头可读。 */
function measureTextWidth(text) {
  const cs = getComputedStyle(document.documentElement);
  const fam = cs.getPropertyValue('--el-font-family') || 'inherit';
  const size = cs.getPropertyValue('--el-font-size-base') || '14px';
  const span = document.createElement('span');
  span.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;'
    + 'font-family:' + fam + ';font-size:' + size + ';';
  span.textContent = text;
  document.body.appendChild(span);
  const w = span.getBoundingClientRect().width;
  document.body.removeChild(span);
  return w;
}
const teamNameMinWidth = computed(() => {
  let max = 0;
  for (const r of (rows.value || [])) {
    const w = measureTextWidth(String(r.team_name || ''));
    if (w > max) max = w;
  }
  return Math.max(120, Math.ceil(max) + 28);
});
/* 越高越好的比率着色（T8准时率 / 物流妥投率） */
function rateClsUp(v) { if (v == null) return 'is-none'; if (v >= 95) return 'is-ok'; if (v >= 90) return 'is-warn'; return 'is-bad'; }
/* 越低越好的比率着色（不满意率） */
function rateClsDown(v) { if (v == null) return 'is-none'; if (v <= 2) return 'is-ok'; if (v <= 5) return 'is-warn'; return 'is-bad'; }

function todayYmd() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function load(silent = false, fetch = false, manual = false) {
  loading.value = true;
  try {
    const ids = teamSel.value === '__all__'
      ? teamOptions.value.map((t) => t.id)
      : [teamSel.value];
    attempted.value = ids.length;
    // 取数触发条件（fetch）：手动刷新（manual=true）与自动轮询都要「取数 + 计算」；
    // 仅页面加载（fetch=false）只读已落盘数据并重新计算，不触发取数。
    // 手动冷却（manual）只针对用户点刷新按钮：manual=true 时后端走 1 分钟冷却，
    // 冷却中返回 {cooldown}，成功返回 {remaining_sec}；自动轮询 manual=false 不受冷却限制。
    if (fetch) {
      // 违规 + 运单两路取数并发触发（互不依赖、落盘到不同文件），最后统一回读重算。
      // 各自 catch 内部错误，保证一路失败不影响另一路，且 Promise.all 不会整体 reject。
      const [violationRes, deliveryRes] = await Promise.all([
        refreshAssessment({ teams: ids, date: todayYmd(), manual }).catch((e) => {
          if (!silent) ElMessage.warning('违规数据拉取失败：' + (e?.message || e));
          return null;
        }),
        refreshAssessmentDelivery({ manual }).catch((e) => {
          if (!silent) ElMessage.warning('运单数据拉取失败：' + (e?.message || e));
          return null;
        }),
      ]);
      if (violationRes && violationRes.cooldown) {
        cooldownRemaining.value = violationRes.remaining_sec || 0;
        startCooldownTick();
      } else if (violationRes && violationRes.remaining_sec != null) {
        cooldownRemaining.value = violationRes.remaining_sec;
        startCooldownTick();
      }
    }
    const results = await Promise.all(
      ids.map((id) => fetchAssessmentStation({ team: id }).catch(() => null)),
    );
    const good = [];
    for (const res of results) {
      if (!res || !res.ok || !res.rows || !res.rows.length) continue;
      const row = res.rows[0];
      // 推配送单量为 0 的站点前端不展示（后端仍照常计算）；其余站点正常展示
      if (num(row.pushed_order_volume) === 0) continue;
      good.push(row);
    }
    rows.value = good;
    // 「更新时间」= 数据实际取数/落盘时间（后端 fetched_at，北京时间），取自各站点响应取较大者
    // （考核数据为全站单文件落盘，各站点一致）。刷新页面（仅读盘重算）不再跳动，只有真正重新取数、
    // 底层数据文件被覆盖写后才更新 —— 即「取数重算后的时间」。
    const times = results.map((r) => r && r.fetched_at).filter(Boolean);
    if (times.length) lastUpdated.value = times.reduce((a, b) => (a > b ? a : b));
  } catch (e) {
    if (!silent) ElMessage.error(e.message || '加载失败');
    if (!silent) rows.value = [];
  } finally {
    loaded.value = true;
    loading.value = false;
    if (autoRefresh.value) countdown.value = intervalSec.value;
  }
}

onMounted(async () => {
  try { const t = await fetchTeams(); teams.value = (t && t.teams) || []; } catch (e) { /* ignore */ }
  // 考核看板「展示站点」配置：取已配置的展示站点 id（未配置则回落全部，teamOptions 兜底）
  try {
    const tc = await fetchAssessmentTeams();
    teamsCfg.value = (tc && tc.teams) || [];
  } catch (e) { /* ignore：取不到配置则回落全部站点 */ }
  // 页面加载时从后端恢复手动刷新冷却剩余（后端持久化，刷新页面不失效）
  try {
    const s = await fetchRefreshCooldown();
    if (s && s.remaining_sec > 0) {
      cooldownRemaining.value = s.remaining_sec;
      startCooldownTick();
    }
  } catch (e) { /* ignore */ }
  await load();
  if (autoRefresh.value) startPoll();
});

onUnmounted(() => { stopPoll(); stopCooldownTick(); });
</script>

<style scoped>
.dv { padding: var(--sp-20); display: flex; flex-direction: column; height: 100%; box-sizing: border-box; overflow: hidden; }
.dv-bar { display: flex; align-items: center; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.dv-sel { width: 160px; }
.dv-bar .sp { flex: 1; }
.dv-updated { margin-left: var(--sp-4); white-space: nowrap; }
.dv-hint { margin-bottom: var(--sp-12); }


/* ── KPI 汇总卡片（对齐时段出勤看板的卡片风格）──── */
.dv-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-12); margin-bottom: var(--sp-16); }
.dv-card { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: var(--el-border-radius-base); padding: var(--sp-16); display: flex; flex-direction: column; gap: 4px; }
.dv-card-num { font-size: 24px; font-weight: var(--fw-bold); color: var(--el-color-primary); }
.dv-card-label { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.dv-card-num.is-ok { color: var(--ok, #2e7d32); }
.dv-card-num.is-warn { color: var(--warn, #ed6c02); }
.dv-card-num.is-bad { color: var(--danger, #d32f2f); }
.dv-card-num.is-none { color: var(--el-text-color-secondary); }

/* ── 比率单元格 ──────────────────────────────── */
.rt { font-weight: var(--fw-bold); }
/* 非百分比数值为 0 时置灰（配合单元格内 el-text 使用） */
.dv-zero { color: var(--el-text-color-placeholder); }
/* 违规计数可下钻：>0 时显示为蓝色可点击链接，hover 加下划线 */
.dv-drill {
  color: var(--el-color-primary);
  cursor: pointer;
  font-weight: var(--fw-semibold);
}
.dv-drill:hover { text-decoration: underline; }
.dv-muted { color: var(--el-text-color-secondary); }
.dv-ratio-ok { color: var(--el-text-color-regular); }
.dv-ratio-warn { color: var(--el-color-warning); font-weight: var(--fw-semibold); }
.dv-ratio-danger { color: var(--el-color-danger); font-weight: var(--fw-semibold); }
/* 三组指标分组区分：组头用不同强调色 + 3px 粗下边框；组边界列加竖向分隔线 */
.dv-table :deep(.dv-grp-score) .cell { color: var(--el-color-primary); font-weight: 700; }
.dv-table :deep(.dv-grp-rate) .cell { color: #1a9e6f; font-weight: 700; }
.dv-table :deep(.dv-grp-other) .cell { color: var(--el-text-color-regular); font-weight: 700; }
/* 整组纵向色带：表头用更明显的"内容对应色"，数据行用更浅的同色，滚动也能一眼分块
   注意：表头选择器加 tr 提升特异度，压过其后定义的全局 light-9 表头背景规则 */
/* —— 表头（内容对应色，明显一档） —— */
.dv-table :deep(.el-table__header-wrapper tr th.dv-g-score),
.dv-table :deep(.el-table__header-wrapper tr th.dv-grp-score) { background-color: color-mix(in srgb, var(--el-color-primary) 16%, #fff); }
.dv-table :deep(.el-table__header-wrapper tr th.dv-g-rate),
.dv-table :deep(.el-table__header-wrapper tr th.dv-grp-rate) { background-color: color-mix(in srgb, #1a9e6f 16%, #fff); }
.dv-table :deep(.el-table__header-wrapper tr th.dv-g-other),
.dv-table :deep(.el-table__header-wrapper tr th.dv-grp-other) { background-color: color-mix(in srgb, #909399 16%, #fff); }
/* —— 数据行（更浅的同色） —— */
.dv-table :deep(.el-table__body-wrapper td.dv-g-score) { background-color: color-mix(in srgb, var(--el-color-primary) 7%, #fff); }
/* 总分列：去除本来的 .dv-g-score 浅底（避免与下方色阶背景叠加），仅保留定位与文字居中 */
.dv-table :deep(.el-table__body-wrapper td.dv-g-total) { position: relative; background-color: transparent; }
.score-bg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.dv-table :deep(.el-table__body-wrapper td.dv-g-rate) { background-color: color-mix(in srgb, #1a9e6f 7%, #fff); }
.dv-table :deep(.el-table__body-wrapper td.dv-g-other) { background-color: color-mix(in srgb, #909399 9%, #fff); }
.rt.is-ok { color: var(--ok, #2e7d32); }
.rt.is-warn { color: var(--warn, #ed6c02); }
.rt.is-bad { color: var(--danger, #d32f2f); }
.rt.is-none { color: var(--el-text-color-secondary); font-weight: var(--fw-normal); }

.dv-table { border-radius: var(--el-border-radius-base); width: 100%; }
/* 表格包裹层：占满 .dv 剩余高度，让 el-table(height=100%) 底部贴合视口 */
.dv-table-wrap { flex: 1; min-height: 0; display: flex; }

/* ── 表头填充主题色（降一级：primary-light-9 + 深蓝文字/箭头保证对比）──── */
.dv-table :deep(.el-table__header-wrapper th.el-table__cell),
.dv-table :deep(.el-table__fixed-header-wrapper th.el-table__cell) {
  background-color: var(--el-color-primary-light-9);
}
.dv-table :deep(.el-table__header-wrapper th.el-table__cell .cell),
.dv-table :deep(.el-table__fixed-header-wrapper th.el-table__cell .cell) {
  color: var(--el-color-primary);
  font-weight: var(--fw-semibold);
}
/* 表头网线加深：列间竖向分隔更明显（仅作用于表头，不改动 body 网格） */
.dv-table :deep(.el-table__header-wrapper th.el-table__cell),
.dv-table :deep(.el-table__fixed-header-wrapper th.el-table__cell) {
  border-color: var(--el-border-color);
}
/* 排序箭头在浅色表头上改为主色，保证可见 */
.dv-table :deep(.el-table__header .sort-caret.ascending) { border-bottom-color: var(--el-color-primary); }
.dv-table :deep(.el-table__header .sort-caret.descending) { border-top-color: var(--el-color-primary); }

/* 默认隐藏排序图标及占位，仅当前排序列展示 */
.dv-table :deep(.caret-wrapper) { display: none; }
.dv-table :deep(th.ascending .caret-wrapper),
.dv-table :deep(th.descending .caret-wrapper) { display: inline-flex; }

/* 表头内容居中（仅表头，不影响单元格正文对齐） */
.dv-table :deep(.el-table__header-wrapper th.el-table__cell .cell),
.dv-table :deep(.el-table__fixed-header-wrapper th.el-table__cell .cell) {
  text-align: center;
}

/* 除站点列外，其余列正文居中（含固定列体） */
.dv-table :deep(.el-table__body-wrapper .cell),
.dv-table :deep(.el-table__fixed-body-wrapper .cell) {
  text-align: center;
}
/* 站点列保持左对齐 */
.dv-table :deep(.dv-col-team .cell) {
  text-align: left;
}
/* 新增列：长表头允许强制换行（中文按字断行） */
.dv-table :deep(.dv-col-fake .cell) {
  white-space: normal;
  word-break: break-all;
  line-height: 1.3;
}

.dv-refresh-btn { min-width: 92px; }
.dv-refresh-btn.is-disabled { color: var(--el-text-color-regular); }
.dv-cd { font-size: 12px; opacity: .75; }
</style>
