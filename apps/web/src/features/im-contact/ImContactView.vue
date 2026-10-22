<template>
  <div class="dv">
    <div class="dv-bar">
      <h2 class="v-title">IM 电联</h2>
      <el-select v-model="teamSel" class="dv-sel" placeholder="站点" @change="onTeamChange">
        <el-option label="全部站点" value="__all__" />
        <el-option v-for="t in teamOptions" :key="t.id" :label="t.name" :value="t.id" />
      </el-select>
      <span class="dv-range-wrap">
        <el-date-picker
          v-model="range"
          type="daterange"
          range-separator="~"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          value-format="YYYY-MM-DD"
          :clearable="false"
          @change="onRangeChange"
        />
      </span>
      <el-button @click="openCfg"><el-icon><Setting /></el-icon> 站点设置</el-button>
      <span v-if="fetchedAt" class="dv-date-tag">取数时间：{{ fetchedAt }}</span>
      <span v-if="landedLabel" class="dv-range-tag">数据区间：{{ landedLabel }}</span>
      <span class="sp" />
      <el-button
        type="primary"
        :loading="refreshing"
        :disabled="refreshing || cooldown > 0"
        :title="cooldown > 0 ? `刷新过于频繁，请等待 ${cooldown} 秒` : '拉取 T-1 所在月 IM 电联数据（累计入库）后重新计算'"
        @click="refresh"
      >
        <el-icon><Refresh /></el-icon>
        <span v-if="refreshing">刷新中…</span>
        <span v-else-if="cooldown > 0">请等待 {{ cooldown }}s</span>
        <span v-else>刷新数据</span>
      </el-button>
    </div>

    <el-alert v-if="needRefresh" type="info" :closable="false" show-icon class="dv-hint">
      {{ needRefreshNote }}
    </el-alert>
    <el-alert v-else-if="staleHint" type="info" :closable="false" show-icon class="dv-hint">
      {{ staleHint }}
    </el-alert>
    <el-alert v-else-if="dataNote" type="warning" :closable="false" show-icon class="dv-hint">{{ dataNote }}</el-alert>
    <el-alert v-if="refreshNote" type="error" :closable="false" show-icon class="dv-hint">{{ refreshNote }}</el-alert>

    <!-- KPI 汇总卡片（随选中站点聚合；el-card + el-statistic，与考核看板同风格） -->
    <div v-if="cards.length" class="dv-cards">
      <el-card v-for="c in cards" :key="c.label" class="dv-card" shadow="never">
        <el-statistic :title="c.label" :value="c.value" :formatter="(v) => cardFmt(v, c)" :suffix="c.suffix" />
      </el-card>
    </div>

    <el-menu mode="horizontal" :default-active="activeTab" class="dv-menu" @select="(k) => (activeTab = k)">
      <el-menu-item index="station">站点数据</el-menu-item>
      <el-menu-item index="rider">骑手数据</el-menu-item>
    </el-menu>

    <div class="dv-body" ref="bodyRef">
      <!-- ① 站点数据 -->
      <div v-show="activeTab === 'station'" class="dv-pane">
        <el-table
          v-loading="loading"
          :data="rows"
          stripe
          border
          class="dv-table"
          empty-text="暂无 IM 电联数据"
          :max-height="560"
          :default-sort="{ prop: 'im_consult_cnt', order: 'descending' }"
        >
          <el-table-column prop="team_id" label="站点ID" min-width="130" fixed sortable show-overflow-tooltip />
          <el-table-column prop="team_name" label="站点" min-width="200" fixed sortable show-overflow-tooltip />
          <el-table-column label="昨日电联率" min-width="110" align="center" sortable :sort-method="numSortPath('period.y.call_rate')">
            <template #default="{ row }"><span class="rt">{{ fmtRate(row.period && row.period.y && row.period.y.call_rate) }}</span></template>
          </el-table-column>
          <el-table-column label="昨日剔除后接单量" min-width="140" align="center" sortable :sort-method="numSortPath('period.y.after_exclude_orders')">
            <template #default="{ row }">{{ row.period && row.period.y ? (row.period.y.after_exclude_orders || 0) : '' }}</template>
          </el-table-column>
          <el-table-column label="昨日剔除后有效电联单量" min-width="170" align="center" sortable :sort-method="numSortPath('period.y.valid_call_orders')">
            <template #default="{ row }">{{ row.period && row.period.y ? (row.period.y.valid_call_orders || 0) : '' }}</template>
          </el-table-column>
          <el-table-column
            v-for="(d, i) in periodDates"
            :key="i"
            :label="d.label"
            min-width="92"
            align="center"
          >
            <template #default="{ row }">
              <span class="rt">{{ fmtRate(row.period && row.period.deltas && row.period.deltas[i] && row.period.deltas[i].call_rate) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="本月电联率" min-width="110" align="center" sortable :sort-method="numSortPath('period.month_rate')">
            <template #default="{ row }"><span class="rt">{{ fmtRate(row.period && row.period.month_rate) }}</span></template>
          </el-table-column>
          <!-- 展开行：该站点的每日明细 + 较前日环比 -->
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="dv-daily">
                <div class="dv-daily-hd">
                  {{ row.team_name }} · 每日明细（{{ row.display_range && row.display_range.start ? `${row.display_range.start} ~ ${row.display_range.end}` : '所选区间' }}，含较前日环比）
                </div>
                <el-table :data="row.daily" stripe border size="small" class="dv-table dv-daily-table" empty-text="暂无每日数据">
                  <el-table-column prop="date" label="日期" min-width="120" fixed />
                  <el-table-column label="送达电联率" min-width="110" align="center">
                    <template #default="{ row: d }"><span class="rt">{{ fmtRate(d.call_rate) }}</span></template>
                  </el-table-column>
                  <el-table-column label="较前日" min-width="100" align="center">
                    <template #default="{ row: d }"><span :class="ppCls(d.dod && d.dod.call_rate)">{{ fmtPp(d.dod && d.dod.call_rate) }}</span></template>
                  </el-table-column>
                  <el-table-column label="IM及时回复率" min-width="120" align="center">
                    <template #default="{ row: d }"><span class="rt">{{ fmtRate(d.im_reply_rate) }}</span></template>
                  </el-table-column>
                  <el-table-column label="较前日" min-width="100" align="center">
                    <template #default="{ row: d }"><span :class="ppCls(d.dod && d.dod.im_reply_rate)">{{ fmtPp(d.dod && d.dod.im_reply_rate) }}</span></template>
                  </el-table-column>
                  <el-table-column prop="im_consult_cnt" label="IM咨询单量" min-width="110" align="center" />
                  <el-table-column label="较前日" min-width="120" align="center">
                    <template #default="{ row: d }"><span class="dod-cnt">{{ fmtCnt(d.dod && d.dod.im_consult_cnt) }}</span></template>
                  </el-table-column>
                  <el-table-column prop="im_reply_cnt" label="IM及时回复单量" min-width="130" align="center" />
                  <el-table-column prop="call_excluded_cnt" label="电联剔除单量" min-width="120" align="center" />
                  <el-table-column prop="after_exclude_orders" label="剔除后接单量" min-width="120" align="center" />
                  <el-table-column prop="valid_call_orders" label="剔除后有效电联单量" min-width="150" align="center" />
                </el-table>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <!-- ② 骑手数据：跨所选站点聚合所有骑手，分页 -->
      <div v-show="activeTab === 'rider'" class="dv-pane">
        <el-table
          v-loading="loading"
          :data="pagedRiderRows"
          :height="riderH"
          stripe
          border
          class="dv-table"
          empty-text="暂无骑手 IM 电联数据"
          :default-sort="{ prop: 'im_consult_cnt', order: 'descending' }"
        >
          <el-table-column prop="rider_id" label="骑手ID" min-width="150" fixed sortable show-overflow-tooltip />
          <el-table-column prop="rider_name" label="骑手姓名" min-width="120" fixed sortable show-overflow-tooltip />
          <el-table-column prop="team_id" label="站点ID" min-width="130" sortable show-overflow-tooltip />
          <el-table-column prop="team_name" label="站点" min-width="170" sortable show-overflow-tooltip />
          <el-table-column label="昨日电联率" min-width="110" align="center" sortable :sort-method="numSortPath('period.y.call_rate')">
            <template #default="{ row }"><span class="rt">{{ fmtRate(row.period && row.period.y && row.period.y.call_rate) }}</span></template>
          </el-table-column>
          <el-table-column label="昨日剔除后接单量" min-width="140" align="center" sortable :sort-method="numSortPath('period.y.after_exclude_orders')">
            <template #default="{ row }">{{ row.period && row.period.y ? (row.period.y.after_exclude_orders || 0) : '' }}</template>
          </el-table-column>
          <el-table-column label="昨日剔除后有效电联单量" min-width="170" align="center" sortable :sort-method="numSortPath('period.y.valid_call_orders')">
            <template #default="{ row }">{{ row.period && row.period.y ? (row.period.y.valid_call_orders || 0) : '' }}</template>
          </el-table-column>
          <el-table-column
            v-for="(d, i) in periodDates"
            :key="i"
            :label="d.label"
            min-width="92"
            align="center"
          >
            <template #default="{ row }">
              <span class="rt">{{ fmtRate(row.period && row.period.deltas && row.period.deltas[i] && row.period.deltas[i].call_rate) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="本月电联率" min-width="110" align="center" sortable :sort-method="numSortPath('period.month_rate')">
            <template #default="{ row }"><span class="rt">{{ fmtRate(row.period && row.period.month_rate) }}</span></template>
          </el-table-column>
          <!-- 展开行：该骑手的每日明细 + 较前日环比 -->
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="dv-daily">
                <div class="dv-daily-hd">
                  {{ row.rider_name || row.rider_id }}（{{ row.team_name }}）· 每日明细（含较前日环比）
                </div>
                <el-table :data="row.daily" stripe border size="small" class="dv-table dv-daily-table" empty-text="暂无每日数据">
                  <el-table-column prop="date" label="日期" min-width="120" fixed />
                  <el-table-column label="送达电联率" min-width="110" align="center">
                    <template #default="{ row: d }"><span class="rt">{{ fmtRate(d.call_rate) }}</span></template>
                  </el-table-column>
                  <el-table-column label="较前日" min-width="100" align="center">
                    <template #default="{ row: d }"><span :class="ppCls(d.dod && d.dod.call_rate)">{{ fmtPp(d.dod && d.dod.call_rate) }}</span></template>
                  </el-table-column>
                  <el-table-column label="IM及时回复率" min-width="120" align="center">
                    <template #default="{ row: d }"><span class="rt">{{ fmtRate(d.im_reply_rate) }}</span></template>
                  </el-table-column>
                  <el-table-column label="较前日" min-width="100" align="center">
                    <template #default="{ row: d }"><span :class="ppCls(d.dod && d.dod.im_reply_rate)">{{ fmtPp(d.dod && d.dod.im_reply_rate) }}</span></template>
                  </el-table-column>
                  <el-table-column prop="im_consult_cnt" label="IM咨询单量" min-width="110" align="center" />
                  <el-table-column label="较前日" min-width="120" align="center">
                    <template #default="{ row: d }"><span class="dod-cnt">{{ fmtCnt(d.dod && d.dod.im_consult_cnt) }}</span></template>
                  </el-table-column>
                  <el-table-column prop="im_reply_cnt" label="IM及时回复单量" min-width="130" align="center" />
                  <el-table-column prop="call_excluded_cnt" label="电联剔除单量" min-width="120" align="center" />
                  <el-table-column prop="after_exclude_orders" label="剔除后接单量" min-width="120" align="center" />
                  <el-table-column prop="valid_call_orders" label="剔除后有效电联单量" min-width="150" align="center" />
                </el-table>
              </div>
            </template>
          </el-table-column>
        </el-table>
        <div class="dv-pg">
          <el-pagination
            v-model:current-page="riderPage"
            v-model:page-size="riderPageSize"
            :total="riderRows.length"
            :page-sizes="[25, 50, 75, 100]"
            layout="total, sizes, prev, pager, next, jumper"
            background
          />
        </div>
      </div>
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
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue';
import { Refresh, Setting } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { fetchTeams } from '../../api/dashboards.js';
// 本看板自有接口（/im-contact/* 数据 + /im-contact-fetch/* 取数）
import {
  fetchImContact, refreshImContact, fetchImContactStatus,
  fetchImContactTeams, saveImContactTeams,
} from '../../api/im-contact.js';

/* ── 站点 ─────────────────────────────────────────────────────────────── */
const teams = ref([]);
const teamSel = ref('__all__');
/* 展示站点配置：teamsCfg = 已配置展示的站点 id；未配置任何站点时回落全部（teamOptions 兜底）。 */
const teamsCfg = ref([]);
const teamOptions = computed(() =>
  teams.value.filter((t) => !teamsCfg.value.length || teamsCfg.value.includes(String(t.id)))
);
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
    const res = await saveImContactTeams(cfgSel.value);
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

/* ── 日期区间 ─────────────────────────────────────────────────────────────
   默认单日 T-1（昨日）。周期列（昨日/T-2~T-8/本月电联率）以**选择器末日**为基准从全量落盘算，改选择器即变。
   取数（「刷新数据」）默认拉取 T-1 所在月**整月**数据，累计落库到 SQLite
   （apps/api/runtime/db/im_contact.db，按 送达日期+骑手id 去重，跨月累计），并每月导出
   可读备份 IM电联明细.YYYY-MM.json。落库数据持久化（重启/部署都不清）。
   切换区间或刷新页面都只是从已落库数据「按所选区间重算」，不反复取数；要看最新
   T-1 时点「刷新数据」即可（该按钮才真正拉取整月并累计入库）。 */
function shiftDay(offset) {
  const d = new Date(Date.now() + offset * 86400000 + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
function defaultRange() {
  // 默认单日 T-1（昨日）；周期列以选择器末日为基准从全量落盘数据计算。
  return [shiftDay(-1), shiftDay(-1)];
}
const range = ref(defaultRange());
/* 任意 YYYY-MM-DD 偏移 offset 天（正后移 / 负前移），纯日期运算（UTC 避开时区误差）。 */
function shiftDate(base, offset) {
  const [y, m, d] = base.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + offset);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}
/* 周期列表头：以选择器末日(end)为「昨日」基准，生成 T-2~T-8 共 7 天真实日期标签(M-D)，
   顺序 = end-1 … end-7，与后端 period.deltas 顺序一致。 */
const periodDates = computed(() => {
  const end = range.value && range.value[1];
  if (!end) return [];
  const out = [];
  for (let k = 1; k <= 7; k++) {
    const dd = shiftDate(end, -k);
    out.push({ label: dd.slice(5), date: dd });
  }
  return out;
});
const landed = ref({ start: '', end: '' });   // 已落盘的数据区间（整月）
const landedLabel = computed(() =>
  landed.value.start ? `${landed.value.start} ~ ${landed.value.end}` : '');
const fetchedAt = ref('');
/* 默认展示「站点数据」面板（之前未声明 activeTab 导致其初始为 undefined，两个面板被 v-show 隐藏） */
const activeTab = ref('station');

/* ── 数据 ─────────────────────────────────────────────────────────────── */
const rows = ref([]);
const loading = ref(false);
const loaded = ref(false);
const attempted = ref(0);

const needRefresh = computed(() => loaded.value && attempted.value > 0 && rows.value.length === 0);
const needRefreshNote = computed(() => {
  const n = rows.value.find((x) => x.data_status === 'no_data');
  return (n && n.data_note) || '当前站点该区间 IM 电联数据尚未落盘，请点「刷新数据」拉取';
});
/* 数据已落盘但滞后（结束日早于所选区间结束日 T-1）：提示用户点刷新获取近 7 天，
   不自动取数（报表 T-1 才出数，按用户要求「不用每次都取数」）。 */
const staleHint = computed(() => {
  if (!loaded.value || !landed.value.end || !range.value || !range.value[1]) return '';
  if (range.value[1] && landed.value.end < range.value[1]) {
    return `当前落盘数据截至 ${landed.value.end}（非最新），点「刷新数据」拉取近 7 天`;
  }
  return '';
});
const dataNote = computed(() => {
  const p = rows.value.find((x) => x.data_status === 'partial');
  return p ? p.data_note || '' : '';
});
/* 失败提示（常驻，不只弹 toast）：取数失败 / 数据读取失败。
   读侧对 fetch_ok=false 一律按不可用处理（不展示旧数据），故失败时看板为空 + 本提示。 */
const refreshNote = ref('');

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const ids = teamSel.value === '__all__'
      ? teamOptions.value.map((t) => t.id)
      : [teamSel.value];
    attempted.value = ids.length;
    const results = await Promise.all(
      ids.map((id) =>
        fetchImContact({ team: id, start: range.value[0], end: range.value[1] }).catch((e) => ({ __err: e })),
      ),
    );
    const good = [];
    const errs = [];
    for (const res of results) {
      if (!res || res.__err) { errs.push('请求失败'); continue; }
      if (!res.ok) { errs.push(res.error || '计算返回错误'); continue; }
      if (res.fetched_at && (!fetchedAt.value || res.fetched_at > fetchedAt.value)) {
        fetchedAt.value = res.fetched_at;
      }
      if (res.start && res.end) landed.value = { start: res.start, end: res.end };
      if (!res.rows || !res.rows.length) continue;   // need_refresh 等无数据行，不计入错误
      good.push(res.rows[0]);
    }
    rows.value = good;
    if (errs.length) {
      refreshNote.value = `数据读取失败（${errs.length} 个站点${good.length ? `，其余 ${good.length} 个站点正常` : ''}），请稍后重试`;
    } else {
      refreshNote.value = '';
    }
  } catch (e) {
    refreshNote.value = `数据读取失败：${e?.message || '未知错误'}`;
  } finally {
    loading.value = false;
    loaded.value = true;
    await nextTick();
    measureBody();
  }
}

/* 刷新：拉取 T-1 所在月整月 → 累计落库 → 重算（Quark 报表较慢，按钮 loading 期间禁用）。
   展示区间（默认 T-1）由选择器决定，只影响计算，不影响取数范围。 */
const refreshing = ref(false);
const cooldown = ref(0);
let cooldownTimer = null;
const REFRESH_COOLDOWN_SEC = 60;
function startCooldown(sec) {
  const s = Math.max(1, Math.ceil(Number(sec) || REFRESH_COOLDOWN_SEC));
  cooldown.value = s;
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1;
    if (cooldown.value <= 0) { clearInterval(cooldownTimer); cooldownTimer = null; cooldown.value = 0; }
  }, 1000);
}
async function refresh() {
  refreshing.value = true;
  try {
    // 取数默认 T-1 所在月总数据，累计落库；展示区间（近 7 天）只用于计算。
    const res = await refreshImContact({});
    if (res && res.ok) {
      ElMessage.success(res.msg || '拉取成功');
      startCooldown(REFRESH_COOLDOWN_SEC);
    } else {
      ElMessage.error((res && (res.error || res.msg)) || '拉取失败');
      refreshNote.value = `本次拉取失败：${(res && (res.error || res.msg)) || '未知错误'}（看板不展示旧数据，请重试）`;
    }
    await load(true);
  } catch (err) {
    ElMessage.error(err?.message || '拉取失败');
    refreshNote.value = `本次拉取失败：${err?.message || '未知错误'}（看板不展示旧数据，请重试）`;
  } finally {
    refreshing.value = false;
  }
}
function onTeamChange() { load(); }
/* 切换日期区间：仅从已落盘数据「重算」（不重新取数）。报表 T-1 才出数，所选区间
   已落盘则直接展示；若尚未落盘，看板留空并提示「点刷新数据」拉取。 */
function onRangeChange() {
  const [s, e] = range.value || [];
  if (s && e) load();
}

/* ── 聚合：全部站点时对各站计数求和，比率按口径重算（不跨站平均） ────────── */
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
const agg = computed(() => {
  const r = rows.value;
  const sum = (k) => r.reduce((a, x) => a + num(x[k]), 0);
  const consult = sum('im_consult_cnt');
  const reply = sum('im_reply_cnt');
  const orders = sum('after_exclude_orders');
  const validCall = sum('valid_call_orders');
  return {
    consult, reply, orders, validCall,
    callRate: orders > 0 ? (validCall * 100) / orders : null,
    replyRate: consult > 0 ? (reply * 100) / consult : null,
  };
});
const cards = computed(() => {
  const mk = (label, value, digits) => ({
    label,
    value: value == null ? 0 : value,
    none: value == null,
    digits,
    suffix: digits > 0 ? '%' : '',
  });
  return [
    mk('送达电联率', agg.value.callRate, 3),
    mk('IM及时回复率', agg.value.replyRate, 3),
    mk('IM咨询单量', agg.value.consult, 0),
    mk('IM及时回复单量', agg.value.reply, 0),
    mk('剔除后有效电联单量', agg.value.validCall, 0),
  ];
});
/* 卡片数值格式化（el-statistic formatter）：接管 EP 默认补零逻辑 —— 无数据「—」、
   比率最多 3 位小数、不足不补零（与表格列口径一致）。 */
function cardFmt(v, c) {
  if (c.none) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return c.digits > 0 ? String(Number(n.toFixed(c.digits))) : String(n);
}
function fmtRate(v, digits = 3) {
  if (v == null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toFixed(digits))) + '%' : '—';
}
/* 环比（较前日）展示：比率用百分点差(pp)，计数用绝对差 + 涨幅% */
function fmtPp(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + Number(n.toFixed(2)) + 'pp';
}
function fmtCnt(v) {
  if (!v || v.diff == null) return '—';
  const d = Number(v.diff);
  if (!Number.isFinite(d)) return '—';
  const pctTxt = v.pct == null ? '' : `（${d > 0 ? '+' : ''}${Number(v.pct)}%）`;
  return (d > 0 ? '+' : '') + d + pctTxt;
}
/* 比率环比着色：≥0 绿、<0 红（比率越高越好）；计数环比不着色（中性） */
function ppCls(v) {
  if (v == null) return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n >= 0 ? 'dod-up' : 'dod-down';
}

/* ── 骑手数据：跨所选站点聚合所有骑手（每行 row.riders 已含骑手指标） ────── */
const riderRows = computed(() => {
  const out = [];
  for (const r of rows.value) {
    const teamName = r.team_name || r.team_id;
    for (const rd of (r.riders || [])) {
      out.push({ team_id: r.team_id, team_name: teamName, ...rd });
    }
  }
  return out;
});
const riderPage = ref(1);
const riderPageSize = ref(25);
const pagedRiderRows = computed(() => {
  const start = (riderPage.value - 1) * riderPageSize.value;
  return riderRows.value.slice(start, start + riderPageSize.value);
});
watch(() => riderRows.value.length, () => { riderPage.value = 1; });

/* 数值列排序：null 永远排最后（无论升/降序），便于把「暂无数据」沉底 */
function numSort(key) {
  return (a, b) => {
    const va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return va - vb;
  };
}
/* 嵌套路径排序（如 'period.y.call_rate' / 'period.month_rate'），null 永远沉底。 */
function numSortPath(path) {
  const ks = path.split('.');
  return (a, b) => {
    let va = a, vb = b;
    for (const k of ks) { va = va == null ? null : va[k]; vb = vb == null ? null : vb[k]; }
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return va - vb;
  };
}

/* ── 内容区可用高度：测量 .dv-body，使骑手表格撑满内容页 ────────────────── */
const bodyRef = ref(null);
const riderH = ref(520);
let bodyRO = null;
function measureBody() {
  const el = bodyRef.value;
  if (!el) return;
  const h = el.clientHeight;
  if (h > 0) riderH.value = Math.max(240, h - 56); // 减去分页器高度
}

onMounted(async () => {
  try { const t = await fetchTeams(); teams.value = (t && t.teams) || []; } catch (e) { /* ignore */ }
  try {
    const tc = await fetchImContactTeams();
    teamsCfg.value = (tc && tc.teams) || [];
  } catch (e) { /* ignore：取不到配置则回落全部站点 */ }
  try {
    const st = await fetchImContactStatus();
    // 仅用于展示「已落盘区间 / 取数时间」；**不**把选择器恢复成上次选择 —— 默认固定 T-1。
    if (st && st.landed) {
      landed.value = { start: st.start, end: st.end };
      fetchedAt.value = st.fetched_at || '';
    }
  } catch (e) { /* ignore */ }
  await load();
  await nextTick();
  measureBody();
  if (typeof ResizeObserver !== 'undefined' && bodyRef.value) {
    bodyRO = new ResizeObserver(() => measureBody());
    bodyRO.observe(bodyRef.value);
  }
});

onUnmounted(() => {
  if (cooldownTimer) clearInterval(cooldownTimer);
  if (bodyRO) bodyRO.disconnect();
});
</script>

<style scoped>
.dv { padding: var(--sp-20); display: flex; flex-direction: column; height: 100%; box-sizing: border-box; overflow: hidden; }
.dv-bar { display: flex; align-items: center; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.dv-sel { width: 160px; }
/* EP 的 daterange 默认宽度 350px 过长，压到 220px（仍容得下两个日期 + 分隔符），
   flex:none 防止在窄屏被拉伸撑长整条工具栏。 */
/* daterange 真实宽度由 EP 变量 --el-date-editor-daterange-width(默认350px) 控制，且 class
   不透传到 date-picker 根元素；用外层包裹 + :deep 命中 .el-date-editor 改该变量。 */
.dv-range-wrap :deep(.el-date-editor) {
  --el-date-editor-daterange-width: 220px !important;
}
.dv-date-tag { font-size: var(--el-font-size-small); color: var(--el-text-color-secondary); }
.dv-range-tag { font-size: var(--el-font-size-small); color: var(--el-text-color-secondary); }
.dv-bar .sp { flex: 1; }
.dv-hint { margin-bottom: var(--sp-12); }

/* ── KPI 汇总卡片（el-card + el-statistic，与考核看板同风格） ──────────── */
.dv-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-12); margin-bottom: var(--sp-16); }
.dv-card :deep(.el-card__body) { padding: var(--sp-16); text-align: center; }
.dv-card :deep(.el-statistic__head) { font-size: var(--el-font-size-extra-small); color: var(--el-text-color-secondary); }
.dv-card :deep(.el-statistic__content) { font-size: 24px; font-weight: var(--fw-bold); color: var(--el-color-primary); line-height: 1.2; }

.dv-menu { border-bottom: 1px solid var(--el-border-color-light); margin-bottom: var(--sp-12); }
.dv-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dv-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dv-table { border-radius: var(--el-border-radius-base); }
.dv-pg { flex: none; padding-top: var(--sp-12); display: flex; justify-content: flex-end; }
.rt { font-weight: var(--fw-bold); }
/* 环比着色：比率 ≥0 绿 / <0 红；计数中性 */
.dod-up { color: var(--ok, #2e7d32); font-weight: var(--fw-bold); }
.dod-down { color: var(--danger, #d32f2f); font-weight: var(--fw-bold); }
.dod-cnt { color: var(--el-text-color-secondary); }
/* 展开行内的每日明细表 */
.dv-daily { padding: var(--sp-12); background: var(--el-fill-color-lighter); }
.dv-daily-hd { font-size: var(--el-font-size-small); color: var(--el-text-color-secondary); margin-bottom: var(--sp-8); }
.dv-daily-table { border-radius: var(--el-border-radius-base); }
.dv-cfg-group { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow: auto; }
</style>
