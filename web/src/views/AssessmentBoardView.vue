<template>
  <div class="dv">
    <div class="dv-bar">
      <h2 class="v-title">考核看板</h2>
      <el-select v-model="teamSel" class="dv-sel" placeholder="站点" @change="load">
        <el-option label="全部站点" value="__all__" />
        <el-option v-for="t in teamOptions" :key="t.id" :label="t.name" :value="t.id" />
      </el-select>
      <div class="dv-range-wrap">
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          :clearable="false"
          unlink-panels
          range-separator="~"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          :shortcuts="dateShortcuts"
          :disabled-date="disableFutureDate"
        />
      </div>
      <el-tag v-if="isHistory" type="warning" size="small" effect="dark" class="dv-hist-badge">历史数据 · 只读</el-tag>
      <el-button @click="openCfg"><el-icon><Setting /></el-icon> 站点设置</el-button>
      <el-text v-if="!isHistory && lastUpdated" type="info" size="small" class="dv-updated">
        更新时间 {{ lastUpdated }}
      </el-text>
      <el-text v-else-if="isHistory" type="info" size="small" class="dv-updated">
        数据区间 {{ rangeLabel }}
      </el-text>
      <span class="sp" />
      <template v-if="!isHistory">
        <el-select v-if="autoRefresh" v-model="intervalSec" class="dv-sel" style="width: 120px" @change="restartPoll">
          <el-option label="5 分钟" :value="300" />
          <el-option label="10 分钟" :value="600" />
          <el-option label="15 分钟" :value="900" />
        </el-select>
        <el-switch v-model="autoRefresh" inline-prompt active-text="自动" inactive-text="手动" @change="onAutoToggle" />
      </template>
      <el-button :loading="loading" :disabled="isHistory || cooldownRemaining > 0" class="dv-refresh-btn" @click="load(false, true, true)">
        <template v-if="isHistory">
          历史只读
        </template>
        <template v-else-if="autoRefresh">
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

    <el-alert v-if="hasError" type="error" :closable="false" show-icon class="dv-hint">
      {{ errorMsg || '考核数据读取失败，请稍后重试' }}
    </el-alert>
    <el-alert v-else-if="needRefresh" type="info" :closable="false" show-icon class="dv-hint">
      {{ noDataNote || '当前站点今日运单明细尚未落盘，请点本看板「刷新」拉取运单明细' }}
    </el-alert>
    <el-alert v-else-if="dataNote" type="warning" :closable="false" show-icon class="dv-hint">{{ dataNote }}</el-alert>
    <el-alert v-if="refreshNote" type="error" :closable="false" show-icon class="dv-hint">{{ refreshNote }}</el-alert>
    <el-alert v-if="isHistory && periodNote" type="info" :closable="false" show-icon class="dv-hint">{{ periodNote }}</el-alert>

    <!-- KPI 汇总卡片（随选中站点聚合，全部站点=各站求和后重算比率） -->
    <div v-if="cards.length" class="dv-cards">
        <el-card
          v-for="c in cards"
          :key="c.label"
          class="dv-card"
          :class="c.cls"
          shadow="never"
        >
          <el-statistic
            :title="c.label"
            :value="c.value"
            :formatter="(v) => cardFmt(v, c)"
            :suffix="c.none ? '' : c.suffix"
          />
          <!-- 环比行（较昨日）：当前数值用「-」占位，后续接入昨日数据后由 cards 的 delta 给出 -->
          <span v-if="c.delta" class="dv-card-delta" :class="c.deltaCls">{{ c.delta }}</span>
        </el-card>
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
        :empty-text="isHistory ? '该区间暂无历史数据（历史明细自启用日起按日落库累积）' : '暂无实时数据'"
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
          <el-table-column label="电联率得分" align="center" sortable :sort-method="rateSort('call_rate_score')" className="dv-g-score">
            <template #default="{ row }">
              <el-text :class="['rt', { 'dv-zero': num(row.call_rate_score) === 0, 'is-bad': scoreBelowFull(row.call_rate_score) }]">{{ fmtMin(row.call_rate_score) }}</el-text>
            </template>
          </el-table-column>
          <el-table-column label="IM及时回复率得分" align="center" sortable :sort-method="rateSort('im_reply_rate_score')" className="dv-g-score">
            <template #default="{ row }">
              <el-text :class="['rt', { 'dv-zero': num(row.im_reply_rate_score) === 0, 'is-bad': scoreBelowFull(row.im_reply_rate_score) }]">{{ fmtMin(row.im_reply_rate_score) }}</el-text>
            </template>
          </el-table-column>
          <el-table-column label="商家拜访率得分" align="center" sortable :sort-method="rateSort('visit_rate_score')" className="dv-g-score">
            <template #default="{ row }">
              <el-text :class="['rt', { 'dv-zero': num(row.visit_rate_score) === 0, 'is-bad': scoreBelowFull(row.visit_rate_score) }]">{{ fmtMin(row.visit_rate_score) }}</el-text>
            </template>
          </el-table-column>
        </el-table-column>
        <el-table-column label="达成率" className="dv-grp-rate">
          <el-table-column label="T8准时率" align="center" sortable :sort-method="rateSort('t8_ontime_rate')" className="dv-g-rate">
            <template #default="{ row }">
              <span class="rt" :class="targetCls(row.t8_ontime_rate, row.t8_ontime_tiers, 'pos')">{{ fmtRate(row.t8_ontime_rate, 2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="物流妥投率" align="center" sortable :sort-method="rateSort('fulfillment_rate')" className="dv-g-rate">
            <template #default="{ row }">
              <span class="rt" :class="targetCls(row.fulfillment_rate, row.fulfillment_tiers, 'pos')">{{ fmtRate(row.fulfillment_rate) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="不满意率" align="center" sortable :sort-method="rateSort('unsat_rate')" className="dv-g-rate">
            <template #default="{ row }">
              <span class="rt" :class="targetCls(row.unsat_rate, row.unsat_tiers, 'neg')">{{ fmtRate(row.unsat_rate) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="复合超时时长(秒)" align="center" sortable :sort-method="rateSort('avg_compound_overtime_sec')" className="dv-g-rate">
            <template #default="{ row }">
              <el-text :class="['rt', targetCls(row.avg_compound_overtime_sec, row.compound_tiers, 'neg'), { 'dv-zero': num(row.avg_compound_overtime_sec) === 0 }]">{{ fmtMin(row.avg_compound_overtime_sec) }}</el-text>
            </template>
          </el-table-column>
          <el-table-column label="电联率" align="center" sortable :sort-method="rateSort('call_rate')" className="dv-g-rate">
            <template #default="{ row }">
              <span class="rt" :class="targetCls(row.call_rate, row.call_rate_tiers, 'pos')">{{ fmtRate(row.call_rate) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="IM及时回复率" align="center" sortable :sort-method="rateSort('im_reply_rate')" className="dv-g-rate">
            <template #default="{ row }">
              <span class="rt" :class="targetCls(row.im_reply_rate, row.im_reply_rate_tiers, 'pos')">{{ fmtRate(row.im_reply_rate) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="商家拜访率" align="center" sortable :sort-method="rateSort('visit_rate')" className="dv-g-rate">
            <template #default="{ row }">
              <span class="rt" :class="targetCls(row.visit_rate, row.visit_rate_tiers, 'pos')">{{ fmtRate(row.visit_rate) }}</span>
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
              <span v-if="num(row.t8_timeout) > 0" class="dv-drill" @click="drillTimeout(row, 't8_timeout')" :title="'查看「' + row.team_name + '」的 ' + row.t8_timeout + ' 单 T8 超时（配送超时看板·运单明细）'">{{ row.t8_timeout }}</span>
              <el-text v-else :class="{ 'dv-zero': num(row.t8_timeout) === 0 }">{{ row.t8_timeout }}</el-text>
            </template>
          </el-table-column>
          <el-table-column prop="gaobi_order" label="高比单T8超时" sortable className="dv-g-other">
            <template #default="{ row }">
              <span v-if="num(row.gaobi_order) > 0" class="dv-drill" @click="drillTimeout(row, 'gaobi_order')" :title="'查看「' + row.team_name + '」的 ' + row.gaobi_order + ' 单高比单 T8 超时（配送超时看板·运单明细，按是否高比单过滤）'">{{ row.gaobi_order }}</span>
              <el-text v-else :class="{ 'dv-zero': num(row.gaobi_order) === 0 }">{{ row.gaobi_order }}</el-text>
            </template>
          </el-table-column>
          <el-table-column prop="false_report_slow_unfinished" label="虚假报备商户出餐慢取消" sortable className="dv-col-fake dv-g-other">
            <template #default="{ row }">
              <span v-if="num(row.false_report_slow_unfinished) > 0" class="dv-drill" @click="drillTo(row, 'false_report_slow_unfinished')" :title="'查看「' + row.team_name + '」的 ' + row.false_report_slow_unfinished + ' 单违规取消（违规处罚看板，按违规类型=违规取消；含虚假报备，可再按违规原因手筛）'">{{ row.false_report_slow_unfinished }}</span>
              <el-text v-else :class="{ 'dv-zero': true }">0</el-text>
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
              <span v-if="num(row.gaobi_cancel_liable) > 0" class="dv-drill" @click="drillTo(row, 'gaobi_cancel_liable')" :title="'查看「' + row.team_name + '」的 ' + row.gaobi_cancel_liable + ' 单物流责取消（违规处罚看板，按违规分类=取消；无法在处罚看板再按高比单细分）'">{{ row.gaobi_cancel_liable }}</span>
              <el-text v-else :class="{ 'dv-zero': true }">0</el-text>
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
              <span v-if="num(row.bad_review) > 0" class="dv-drill" @click="drillTo(row, 'bad_review')" :title="'查看「' + row.team_name + '」的 ' + row.bad_review + ' 单差评（违规处罚看板）'">{{ row.bad_review }}</span>
              <el-text v-else :class="{ 'dv-zero': true }">0</el-text>
            </template>
          </el-table-column>
          <el-table-column prop="claim" label="索赔" sortable className="dv-g-other">
            <template #default="{ row }">
              <span v-if="num(row.claim) > 0" class="dv-drill" @click="drillTo(row, 'claim')" :title="'查看「' + row.team_name + '」的 ' + row.claim + ' 单索赔（违规处罚看板）'">{{ row.claim }}</span>
              <el-text v-else :class="{ 'dv-zero': true }">0</el-text>
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
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchTeams, fetchAssessmentStation, refreshAssessment, refreshAssessmentDelivery, fetchRefreshCooldown, markRefreshCooldown, fetchAssessmentTeams, saveAssessmentTeams, fetchServiceQualityTargets, fetchAssessmentAutoConfig, saveAssessmentAutoConfig } from '../api/dashboards.js';
import { useRouter } from 'vue-router';

const router = useRouter();

/* 违规运单下钻：点击考核看板某站点的违规计数，跳转到「违规处罚」看板（实时 tab）并按
   站点 + 违规分类/类型 + 成立状态 筛选逐单明细。
   映射以 python/analytics/assessment/violations.py 的计数口径为准：
     · 投诉/差评/索赔/物流责取消 → 违规分类 精确相等（COMPLAIN/BAD_REVIEW/CLAIM/CANCEL）
     · 提前点送达 → 违规类型 1039（提前点送达（索赔））
     · 虚假报备商户出餐慢取消 → 违规类型 1004（违规取消，含虚假报备，看板可按违规原因手筛）
     · 高比单物流责取消 → 违规分类 CANCEL（处罚看板无「高比单」字段，仅能落到取消大类）
   T8超时 / 高比单T8超时 是订单口径（非处罚明细），无对应处罚记录，改为下钻到「配送超时」看板·运单明细。 */
const DRILL = {
  complaint:                   { cat: 'COMPLAIN' },  // 投诉 → 违规分类 COMPLAIN
  bad_review:                  { cat: 'BAD_REVIEW' }, // 差评 → 违规分类 BAD_REVIEW
  claim:                       { cat: 'CLAIM' },     // 索赔 → 违规分类 CLAIM（餐货损）
  cancel_liable:               { cat: 'CANCEL' },    // 物流责取消 → 违规分类 CANCEL
  gaobi_cancel_liable:         { cat: 'CANCEL' },    // 高比单物流责取消 → 违规分类 CANCEL（无法再按高比单细分）
  early_delivered:             { type: '1039' },     // 提前点送达 → 违规类型 1039（提前点送达（索赔））
  false_report_slow_unfinished: { type: '1004' },     // 虚假报备商户出餐慢取消 → 违规类型 1004（违规取消）
};
function drillTo(row, metric) {
  const d = DRILL[metric];
  if (!d || num(row[metric]) === 0) return;
  // 历史模式下钻 → 违规处罚「月累计」页签 + 传入日期区间（看历史明细）；
  // 实时模式仍走「实时」页签（原行为）。
  const q = { site: row.team_name, status: '10' };
  if (isHistory.value) {
    q.tab = 'monthly';
    q.start = rangeStart();
    q.end = rangeEnd();
  } else {
    q.tab = 'realtime';
  }
  if (d.cat) q.cat = d.cat;
  if (d.type) q.type = d.type;
  router.push({ name: 'unsatisfied', query: q });
}
// T8超时 / 高比单T8超时：订单口径指标，下钻到「配送超时」看板的运单明细页
// （配送超时看板只存 T8 超时单明细，故 tt=gaobi 仅用于高比单子集的二次过滤）
function drillTimeout(row, metric) {
  if (num(row[metric]) === 0) return;
  const q = { tab: 'order', team: row.team_id };
  if (metric === 'gaobi_order') q.tt = 'gaobi';
  router.push({ name: 'timeout', query: q });
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

/* —— 自动刷新：SSE 推送优先，断开时回退前端定时取数 —— */
const autoRefresh = ref(localStorage.getItem('assessment.autoRefresh') !== 'false');
const intervalSec = ref(300);
const countdown = ref(0);     // 距下次取数的 ETA（SSE 在线=服务端间隔；离线=前端间隔）
let pollTimer = null;          // 前端回退取数定时器（仅 SSE 断开时使用）
let tickTimer = null;          // 倒计时显示

const sseConnected = ref(false);
let es = null;                 // EventSource 实例
let rbTimer = null;            // SSE「updated」防抖回读

/** SSE「updated」到达：重置 ETA 并防抖触发一次只读回读（不重复取数）。 */
function scheduleReadback() {
  if (rbTimer) clearTimeout(rbTimer);
  rbTimer = setTimeout(() => { rbTimer = null; void load(false, false, false); }, 600);
}
/** 订阅考核看板 SSE（/api/assessment-fetch/stream）：取数完成 → 服务端推 updated → 前端回读。 */
function initSse() {
  if (es) return;
  es = new EventSource('/api/assessment-fetch/stream');
  es.onopen = () => { sseConnected.value = true; applyPoll(); };
  es.onerror = () => { sseConnected.value = false; applyPoll(); };
  es.onmessage = (ev) => {
    let p = {};
    try { p = JSON.parse(ev.data); } catch { /* ignore */ }
    if (p && p.type === 'updated') {
      countdown.value = intervalSec.value; // 服务端刚取数，ETA 重新计满
      scheduleReadback();
    }
  };
}

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

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  stopTick();
  countdown.value = 0;
}
/** 前端回退取数定时器（仅 SSE 断开时启用，保持旧行为）。 */
function startLegacyPoll() {
  pollTimer = setInterval(() => void load(true, true, false), intervalSec.value * 1000);
  startTick();
  countdown.value = intervalSec.value;
}
function startTick() {
  stopTick();
  tickTimer = setInterval(() => { if (countdown.value > 0) countdown.value--; }, 1000);
}
function stopTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

// 已 POST 到服务端的配置，避免 SSE 反复重连时重复下发
let postedEnabled = null;
let postedInterval = null;
/**
 * 统一调度自动刷新：
 *   · SSE 在线 → 服务端按服务端配置定时取数并推送「updated」，前端只跑 ETA 倒计时（不自己打风神）；
 *   · SSE 断开 → 回退前端定时取数（旧行为），保证仍有数据。
 */
function applyPoll() {
  stopPoll();
  const enabled = autoRefresh.value;
  const sec = intervalSec.value;
  if (sseConnected.value) {
    if (postedEnabled !== enabled || postedInterval !== sec) {
      void saveAssessmentAutoConfig({ enabled, intervalSec: sec }).catch(() => {});
      postedEnabled = enabled; postedInterval = sec;
    }
    startTick();
    countdown.value = sec;
  } else {
    postedEnabled = null; postedInterval = null; // 重连后再下发
    startLegacyPoll();
  }
}
function restartPoll() { applyPoll(); }
async function onAutoToggle(on) {
  // 持久化自动/手动切换状态，刷新页面后不丢失
  localStorage.setItem('assessment.autoRefresh', on ? 'true' : 'false');
  if (!on) {
    // 从自动切回手动：默认进入 1 分钟冷却，避免刚切回就手动重算；后端落盘保证刷新页面也不失效
    try {
      const s = await markRefreshCooldown();
      cooldownRemaining.value = s && s.remaining_sec != null ? s.remaining_sec : 60;
    } catch (e) {
      cooldownRemaining.value = 60;
    }
    startCooldownTick();
  }
  applyPoll();
}

// 是否「全站无落盘数据」：由 station 响应顶层 data_status==='no_data' 判定，
// 而非 rows 是否为空——否则会把「所选站点当天真实 0 单」误判成「没落盘」而错弹提示。
const noData = ref(false);
const noDataNote = ref('');
// 读取/计算出错态：与「未落盘(no_data)」区分，避免把「计算报错」误显示成「没数据」。
const hasError = ref(false);
const errorMsg = ref('');
const needRefresh = computed(() => loaded.value && attempted.value > 0 && noData.value);
const dataNote = computed(() => {
  const p = rows.value.find((x) => x.data_status === 'partial');
  return p ? p.data_note || '' : '';
});
/* 本次刷新「部分失败」提示（两路取数只要一路失败就置位，成功或未取数时清空）。
   运单那路失败 → 订单类指标整行不可用（站点行不展示），违规指标是上一次成功数据；
   违规那路失败 → 违规类指标显示「—」，订单类指标是上一次成功数据。
   两者都失败 → 看板基本无可展示数据。提示必须常驻，不能只弹一次性 toast
   （自动轮询时用户根本看不到 toast，会以为看板就是当前数据）。 */
const refreshNote = ref('');

/* —— 聚合：全部站点时对各站计数求和，比率按口径重算（非直接平均比率）—— */
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
/* 聚合比率：全精度计算，不做任何四舍五入。
   展示精度统一由 fmtRate 决定（T8准时率最多 2 位小数，不满意率/物流妥投率最多 3 位），
   后端落库与排序也始终用全精度 —— 这里若预 round 到 1 位，卡片就会少显示一位
   （如 97.65% 被压成 97.6%），与「最多 N 位」的口径不符。 */
function pct(n, d) { return d > 0 ? (n / d) * 100 : null; }

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

/* KPI 卡片数据（供 el-statistic 渲染）。
   el-statistic 的 value 只接受 Number，故无数据时传 0、由 formatter 输出「—」（none 标记）；
   digits>0 表示比率卡（suffix 带 %，最多 digits 位小数）；digits=0 为计数卡；
   delta / deltaCls 为「较昨日」环比行（当前数值以「-」占位，后续接入昨日数据后给出真实值，
   颜色由调用方按指标语义传 is-good / is-bad，如准时率上升传 is-good）。 */
const cards = computed(() => {
  // 分层目标：与表格列同源 —— 按今日日型 × 所展示站点最严天气档位取 t0/t60/t100，直接比较。
  // 目标配置未拉到/未配置时 tiers 为空，卡片按 is-none 灰色显示（不臆断好坏）。
  const dateType = resolveDateType(rangeEnd());
  const weather = worstWeatherKey();
  const clsOf = (metric, value, direction) =>
    targetCls(value, metricTiers(metric, dateType, weather), direction);
  const mk = (label, raw, digits, cls, delta = '') => ({
    label,
    value: raw == null ? 0 : raw,
    none: raw == null,
    digits,
    suffix: digits > 0 ? '%' : '',
    cls: cls || '',
    delta,
    deltaCls: '',
  });
  return [
    mk('推配送单量', agg.value.pushed, 0, '', '较昨日 -'),
    mk('配送完成单', agg.value.completed, 0, '', '较昨日 -'),
    mk('T8超时单', agg.value.t8, 0),
    mk('T8准时率', agg.value.ontime, 2, clsOf('ontime_rate', agg.value.ontime, 'pos'), '较昨日 -'),
    mk('投诉', agg.value.complaint, 0),
    mk('差评', agg.value.bad, 0),
    mk('索赔', agg.value.claim, 0),
    mk('物流责取消', agg.value.cancel, 0),
    mk('提前点送达', agg.value.early, 0),
    mk('不满意率', agg.value.unsat, 3, clsOf('unsat_rate', agg.value.unsat, 'neg')),
    mk('物流妥投率', agg.value.fulfill, 3, clsOf('delivery_rate', agg.value.fulfill, 'pos')),
  ];
});

/* 卡片数值格式化（el-statistic 的 formatter）：接管 EP 默认的 padEnd 补零逻辑，
   口径与表格列完全一致 —— 无数据显示「—」、比率最多 digits 位小数、不足不补零。
   注意 EP 给 formatter 只传 value，位数等上下文由卡片对象 c 带上。 */
function cardFmt(v, c) {
  if (c.none) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return c.digits > 0 ? String(Number(n.toFixed(c.digits))) : String(n);
}

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
/* 达成列/卡片着色：**直接与「分层目标线」比较**(不经过得分公式)。
   目标线 = 考核设置里该指标在「今日日型 × 天气档位」下的 t0/t60/t100：
   · 达到 t100 满分目标线        → 绿 is-ok
   · 达到 t60 及格线、未到 t100   → 橙 is-warn
   · 超过 t0 零分线、未到 t60     → 红 is-bad
   · 未达 t0 零分线               → 深红 is-deep
   · 目标未配置 / 无数据          → 灰 is-none(不着色，不臆断好坏)
   direction: 'pos' 越高越好(准时率/妥投率，t0<t60<t100)；'neg' 越低越好(不满意率/复合超时，t0>t60>t100)。
   取代原先按固定阈值(95/90、2/5)着色的口径：目标随月份/日型/天气变，固定阈值会给出错误信号。 */
function targetCls(value, tiers, direction) {
  if (value == null || !tiers) return 'is-none';
  const t0 = Number(tiers.t0), t60 = Number(tiers.t60), t100 = Number(tiers.t100);
  if (![t0, t60, t100].every(Number.isFinite)) return 'is-none';
  const v = Number(value);
  if (!Number.isFinite(v)) return 'is-none';
  if (direction === 'pos') {
    if (v >= t100) return 'is-ok';
    if (v >= t60) return 'is-warn';
    return v > t0 ? 'is-bad' : 'is-deep';
  }
  if (v <= t100) return 'is-ok';
  if (v <= t60) return 'is-warn';
  return v < t0 ? 'is-bad' : 'is-deep';
}

/* ── 分层目标（考核设置：日期类型 × 天气）前端取数 ───────────────────────────
   表格列用后端随行返回的命中目标线(row.*_tiers)；顶部卡片是全站/多站聚合值，
   后端不按聚合算目标，故前端持有一份目标配置自行取格比较。
   口径与 Python 侧对应（board._WEATHER_KEY_MAP / resolve_date_type），改一边必须同步改另一边。 */
const sqTargets = ref(null);      // targets[metric][date_type][weather] = {t0,t60,t100}
const sqDateOverrides = ref({});  // 特殊日期覆盖表 { 'YYYY-MM-DD': 'weekday'|'weekend' }
/* 看板天气档位（中文标签）→ 配置 weather 键（与 board.py _WEATHER_KEY_MAP 一致） */
const WEATHER_KEY_MAP = { 正常天: 'normal', 轻微恶天: 'light', 一般恶天: 'moderate', 严重恶天: 'severe' };
/* 天气档位严重度升序（聚合时取所展示站点中最严档位） */
const WEATHER_SEVERITY = ['normal', 'light', 'moderate', 'severe'];
/* 日型：周六/周日 → weekend，其余 weekday；再套特殊日期覆盖表（与后端 resolve_date_type 一致） */
function resolveDateType(dateStr) {
  const ov = sqDateOverrides.value[dateStr];
  if (ov === 'weekday' || ov === 'weekend') return ov;
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.getUTCDay() >= 6 ? 'weekend' : 'weekday';
}
/* 取某指标在 (日型, 天气) 下的三档阈值；缺维度回落代表格（与后端 metric_tiers 一致） */
function metricTiers(metric, dateType, weather) {
  const m = sqTargets.value && sqTargets.value[metric];
  if (!m) return null;
  const dt = m[dateType] || m.weekday;
  if (!dt) return null;
  return dt[weather] || dt.normal || null;
}
/* 聚合卡片所用天气档位：所展示站点中的最严档位。
   聚合值混合了各站订单，只要有站点处于更差天气，就按更宽松的目标评，
   避免把恶天订单按正常天目标过严评判（各站同城同日，通常档位一致）。 */
function worstWeatherKey() {
  let w = 'normal';
  for (const r of rows.value) {
    const k = WEATHER_KEY_MAP[String(r.weather_level || '')];
    if (k && WEATHER_SEVERITY.indexOf(k) > WEATHER_SEVERITY.indexOf(w)) w = k;
  }
  return w;
}

function todayYmd() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
/* 昨天（北京时间 T-1）：看板默认展示昨日已完结的考核（较今日实时更稳定）。 */
function yesterYmd() {
  return new Date(Date.now() + 8 * 3600 * 1000 - 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/* ── 日期选择（实时 / 历史）────────────────────────────────────────────
   dateRange = [start, end]（YYYY-MM-DD，el-date-picker value-format 直出字符串）。
   默认 [今天, 今天] = 实时模式（SSE / 自动刷新可用）；
   选历史区间或过去单日 = 历史模式（只读：禁用刷新与轮询，标注「历史数据」）。 */
const dateRange = ref([todayYmd(), todayYmd()]);
function rangeStart() {
  const v = dateRange.value && dateRange.value[0];
  return v || todayYmd();
}
function rangeEnd() {
  const v = dateRange.value && dateRange.value[1];
  return v || todayYmd();
}
/* 实时模式：选中区间末日==今天且为单日；其余（历史区间 / 过去单日）为历史模式。 */
const isHistory = computed(() => !(rangeStart() === rangeEnd() && rangeEnd() === todayYmd()));
const rangeLabel = computed(() => (rangeStart() === rangeEnd() ? rangeStart() : `${rangeStart()} ~ ${rangeEnd()}`));

/* 日期选择器快捷项（Element Plus shortcuts 的 value 返回 Date/Date[]，经 value-format 归一为字符串）。 */
const dateShortcuts = [
  { text: '今天', value: () => [new Date(), new Date()] },
  { text: '近 7 天', value: () => { const e = new Date(); const s = new Date(); s.setDate(s.getDate() - 6); return [s, e]; } },
  { text: '近 30 天', value: () => { const e = new Date(); const s = new Date(); s.setDate(s.getDate() - 29); return [s, e]; } },
];
/* 不允许选未来日期（考核数据只可能落在今天及以前）。 */
function disableFutureDate(time) {
  const y = time.getFullYear();
  const m = String(time.getMonth() + 1).padStart(2, '0');
  const d = String(time.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}` > todayYmd();
}

/* 分层目标配置按所选区间「末日所在月份」取（历史模式下用历史月份的目标线）。 */
async function loadSqTargets(month) {
  try {
    const sq = await fetchServiceQualityTargets(month);
    if (sq && sq.ok) {
      sqTargets.value = sq.targets || null;
      sqDateOverrides.value = sq.date_overrides || {};
    }
  } catch (e) { /* ignore：目标配置不可用时卡片不着色 */ }
}

/* 历史区间「无明细数据」提示（区别于实时的未落盘 no_data）。 */
const periodNote = ref('');

async function load(silent = false, fetch = false, manual = false) {
  loading.value = true;
  // 每次加载先清掉上一次的「未落盘 / 出错」态，避免旧提示残留。
  hasError.value = false;
  errorMsg.value = '';
  noData.value = false;
  periodNote.value = '';
  const history = isHistory.value;
  const start = rangeStart();
  const end = rangeEnd();
  try {
    const ids = teamSel.value === '__all__'
      ? teamOptions.value.map((t) => t.id)
      : [teamSel.value];
    attempted.value = ids.length;
    // 取数触发条件（fetch）：手动刷新（manual=true）与自动轮询都要「取数 + 计算」；
    // 仅页面加载（fetch=false）只读已落盘数据并重新计算，不触发取数。
    // 历史模式为只读：绝不触发取数（fetch 被忽略），只按区间读历史库重算。
    if (fetch && !history) {
      // 手动冷却（manual）只针对用户点刷新按钮：manual=true 时后端走 1 分钟冷却，
      // 冷却中返回 {cooldown}，成功返回 {remaining_sec}；自动轮询 manual=false 不受冷却限制。
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
      // 任一路失败都要常驻提示：否则成功那一路的新数据会和失败那一路的旧数据/空数据
      // 混在一起展示，用户无从判断哪些数字是本次的、哪些是历史的。
      // 冷却中（cooldown）不算失败 —— 那一路本次压根没发起取数，盘上数据就是最新有效数据。
      const vFail = violationRes != null && violationRes.cooldown !== true && violationRes.ok !== true;
      const dFail = deliveryRes != null && deliveryRes.cooldown !== true && deliveryRes.ok !== true;
      const vErr = (violationRes && violationRes.error) || '';
      const dErr = (deliveryRes && deliveryRes.error) || '';
      if (vFail && dFail) {
        refreshNote.value = `本次刷新两路取数都失败（违规${vErr ? '：' + vErr : ''}；运单${dErr ? '：' + dErr : ''}），看板无可展示数据，请稍后重试`;
      } else if (vFail) {
        refreshNote.value = `违规处罚明细本次拉取失败${vErr ? '：' + vErr : ''}，投诉/差评/索赔等违规指标显示「—」，订单类指标仍为上一次成功拉取的数据`;
      } else if (dFail) {
        refreshNote.value = `运单明细本次拉取失败${dErr ? '：' + dErr : ''}，订单类指标暂不展示（站点行不显示），违规类指标仍为上一次成功拉取的数据`;
      } else {
        refreshNote.value = '';
      }
      if (violationRes && violationRes.cooldown) {
        cooldownRemaining.value = violationRes.remaining_sec || 0;
        startCooldownTick();
      } else if (violationRes && violationRes.remaining_sec != null) {
        cooldownRemaining.value = violationRes.remaining_sec;
        startCooldownTick();
      }
    }
    // 一次批量取回全部站点（替代逐站 N 次请求）；后端按 teams 聚合返回 rows 数组。
    // 注意：首刷后全站 cache miss 会触发整批重算，耗时明显，dashboards.js 已给该接口设了 30s 超时。
    const resp = await fetchAssessmentStation({ teams: ids, start, end }).catch((e) => {
      // 请求层异常（网络/超时/5xx）：显式进入错误态，不再静默吞成「空表」或误判「未落盘」。
      hasError.value = true;
      errorMsg.value = (e && e.message) || '读取考核数据失败（网络或超时），请稍后重试';
      return null;
    });
    let isNoData = false;
    let noDataNoteText = '';
    const good = [];
    if (resp && resp.ok && Array.isArray(resp.rows)) {
      // 顶层 data_status==='no_data' 判定「全站未落盘」，避免把「当天真实 0 单」误判为「没数据」。
      if (resp.data_status === 'no_data') {
        isNoData = true;
        if (resp.data_note) noDataNoteText = resp.data_note;
      }
      // 历史区间无明细（尚未落库）：只读提示，不触发取数。
      if (history && resp.data_status === 'empty' && resp.data_note) {
        periodNote.value = resp.data_note;
      }
      for (const row of resp.rows) {
        if (!row) continue;
        // 推配送单量为 0 的站点前端不展示（后端仍照常计算）；其余站点正常展示
        if (num(row.pushed_order_volume) === 0) continue;
        good.push(row);
      }
    } else if (resp && resp.ok === false) {
      // 计算层返回 200 但 ok:false（计算报错）：显式错误态，区别于「未落盘」。
      hasError.value = true;
      errorMsg.value = (resp.error && (resp.error.message || resp.error)) || '考核数据计算出错，请稍后重试';
    }
    rows.value = good;
    noData.value = isNoData;
    noDataNote.value = noDataNoteText;
    // 「更新时间」= 数据实际取数/落盘时间（后端 fetched_at，北京时间）。
    // 刷新页面（仅读盘重算）不再跳动，只有真正重新取数、底层数据文件被覆盖写后才更新。
    // 历史模式 fetched_at 为 null（数据来自历史库），不更新「更新时间」，改由区间标签标识。
    if (!history) {
      const times = resp && resp.fetched_at ? [resp.fetched_at] : [];
      if (times.length) lastUpdated.value = times.reduce((a, b) => (a > b ? a : b));
    }
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
  // 分层目标配置（考核设置：日期类型 × 天气的三档阈值）：供顶部卡片按目标算分着色。
  // 取不到时卡片得分为 null → 灰色，不影响数值展示；后端保存设置后需刷新页面才会拿到新阈值。
  await loadSqTargets(todayYmd().slice(0, 7));
  // 页面加载时从后端恢复手动刷新冷却剩余（后端持久化，刷新页面不失效）
  try {
    const s = await fetchRefreshCooldown();
    if (s && s.remaining_sec > 0) {
      cooldownRemaining.value = s.remaining_sec;
      startCooldownTick();
    }
  } catch (e) { /* ignore */ }
  // 考核看板自动刷新：与服务端配置同步（enabled / intervalSec），再建立 SSE 订阅。
  // SSE 在线时由服务端定时取数并推送「updated」驱动回读；断开时回退前端定时取数。
  try {
    const ac = await fetchAssessmentAutoConfig();
    if (ac && typeof ac.enabled === 'boolean') autoRefresh.value = ac.enabled;
    if (ac && ac.intervalSec) intervalSec.value = ac.intervalSec;
  } catch (e) { /* ignore：取不到则用本地默认 */ }
  // 页面加载即读盘展示：避免打开看板空白、要等最长 600s 自动取数推 updated 才出数。
  // fetch=false → 只读盘重算（不触发取数）；若返回 no_data（尚未落盘）上方信息栏会引导刷新，自动取数也会兜底。
  await load(false, false, false);
  if (!isHistory.value) { initSse(); applyPoll(); }
});

/* 日期切换：按新区间末日所在月份重取目标线；历史模式停掉实时轮询/SSE，实时模式恢复；随后重载。 */
watch(dateRange, () => {
  void loadSqTargets(rangeEnd().slice(0, 7));
  if (isHistory.value) {
    stopPoll();
    if (es) { es.close(); es = null; }
    sseConnected.value = false;
  } else {
    if (!es) initSse();
    applyPoll();
  }
  load(false, false, false);
});

onUnmounted(() => {
  if (es) { es.close(); es = null; }
  if (rbTimer) { clearTimeout(rbTimer); rbTimer = null; }
  stopPoll();
  stopCooldownTick();
});
</script>

<style scoped>
.dv { padding: var(--sp-20); display: flex; flex-direction: column; height: 100%; box-sizing: border-box; overflow: hidden; }
.dv-bar { display: flex; align-items: center; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.dv-sel { width: 160px; }
/* daterange 真实宽度由 EP 变量 --el-date-editor-daterange-width(默认 350px) 控制，且 class
   不透传到 date-picker 根元素；用外层包裹 + :deep 命中 .el-date-editor 改该变量（与
   UnsatisfiedView / ImContactView 同款写法）。flex:none 防窄屏被拉伸。 */
.dv-range-wrap { flex: 0 0 auto; }
.dv-range-wrap :deep(.el-date-editor) {
  --el-date-editor-daterange-width: 220px !important;
  width: 220px !important;
}
.dv-hist-badge { margin: 0 var(--sp-4); font-weight: 600; letter-spacing: 0.5px; }
.dv-bar .sp { flex: 1; }
.dv-updated { margin-left: var(--sp-4); white-space: nowrap; }
.dv-hint { margin-bottom: var(--sp-12); }


/* ── KPI 汇总卡片（el-card + el-statistic 统计卡片）──── */
.dv-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-12); margin-bottom: var(--sp-16); }
/* el-card 自带边框/圆角/背景（与设计令牌一致），仅去掉默认阴影、把默认 20px 内边距压回 16px；
   卡片内容整体居中（标题、数值、后续的环比行都跟着居中） */
.dv-card :deep(.el-card__body) { padding: var(--sp-16); text-align: center; }
/* 标题（标签）在上、数值在下：EP 默认顺序，也便于后续在数值下方加「环比」行 */
.dv-card :deep(.el-statistic__head) { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.dv-card :deep(.el-statistic__content) { font-size: 24px; font-weight: var(--fw-bold); color: var(--el-color-primary); line-height: 1.2; }
/* 配色挂在整个 content 上而非只挂数值：EP 把「%」拆成了独立的 .el-statistic__suffix
   （自身无 color、靠继承），只染 __number 会让 % 保持父级主色，与数值不同色 */
.dv-card.is-ok :deep(.el-statistic__content) { color: var(--ok, #2e7d32); }
.dv-card.is-warn :deep(.el-statistic__content) { color: var(--warn, #ed6c02); }
.dv-card.is-bad :deep(.el-statistic__content) { color: var(--danger, #d32f2f); }
.dv-card.is-none :deep(.el-statistic__content) { color: var(--el-text-color-secondary); }
.dv-card.is-deep :deep(.el-statistic__content) { color: var(--danger-deep, #b71c1c); }
/* 环比行（较昨日）：数值下方一行小字；颜色由调用方按指标语义传 is-good / is-bad */
.dv-card-delta { display: block; margin-top: 4px; font-size: var(--el-font-size-extra-small); font-weight: var(--fw-normal); color: var(--el-text-color-secondary); }
.dv-card-delta.is-good { color: var(--ok, #2e7d32); }
.dv-card-delta.is-bad { color: var(--danger, #d32f2f); }

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
.rt.is-deep { color: var(--danger-deep, #b71c1c); }

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
