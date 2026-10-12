<template>
  <div class="dv">
    <div class="dv-bar">
      <h2 class="v-title">配送超时</h2>
      <el-select v-model="teamSel" class="dv-sel" placeholder="站点" @change="onTeamChange">
        <el-option label="全部站点" value="__all__" />
        <el-option v-for="t in teamOptions" :key="t.id" :label="t.name" :value="t.id" />
      </el-select>
      <el-button @click="openCfg"><el-icon><Setting /></el-icon> 站点设置</el-button>
      <span v-if="fetchedAt" class="dv-date-tag">取数时间：{{ fetchedAt }}</span>
      <span class="sp" />
      <el-button
        type="primary"
        :loading="refreshing"
        :disabled="refreshing || cooldown > 0"
        :title="cooldown > 0 ? `刷新过于频繁，请等待 ${cooldown} 秒` : '拉取今日运单明细后重新计算'"
        @click="onRefresh"
      >
        <el-icon><Refresh /></el-icon>
        <span v-if="refreshing">刷新中…</span>
        <span v-else-if="cooldown > 0">请等待 {{ cooldown }}s</span>
        <span v-else>刷新数据</span>
      </el-button>
    </div>

    <el-alert v-if="loadErrMsg" type="warning" :closable="false" show-icon class="dv-hint">{{ loadErrMsg }}</el-alert>
    <el-alert v-else-if="needRefresh" type="info" :closable="false" show-icon class="dv-hint">
      当前站点今日运单明细尚未落盘{{ justRefreshed ? '（刚刷新过仍无数据：请确认该站今日确有接单，且「标准达成」看板也能正常出数）' : '，请点「刷新数据」拉取最新订单明细后查看配送超时' }}。
    </el-alert>
    <el-alert v-else-if="dataNote" type="warning" :closable="false" show-icon class="dv-hint">{{ dataNote }}</el-alert>

    <el-menu mode="horizontal" :default-active="activeTab" class="dv-menu" @select="(k) => (activeTab = k)">
        <el-menu-item index="station">站点数据</el-menu-item>
        <el-menu-item index="rider">骑手数据</el-menu-item>
        <el-menu-item index="order">运单明细</el-menu-item>
      </el-menu>

      <div class="dv-body" ref="bodyRef">
        <!-- ① 站点数据：KPI 汇总 + 站点配送时效对比表（点击站点名下钻看骑手/订单） -->
        <div v-show="activeTab === 'station'" class="dv-pane">
          <div v-if="cards.length" class="dv-cards">
            <div v-for="c in cards" :key="c.label" class="dv-card">
              <span class="dv-card-num" :class="c.cls">{{ c.value }}</span>
              <span class="dv-card-label">{{ c.label }}</span>
            </div>
          </div>
          <el-table
            v-loading="loading"
            :data="rows"
            stripe
            border
            class="dv-table"
            empty-text="暂无配送超时数据"
            :max-height="560"
            :default-sort="{ prop: 'timeout_total', order: 'descending' }"
          >
            <el-table-column prop="team_id" label="站点ID" min-width="130" fixed sortable />
            <el-table-column label="站点" min-width="170" fixed sortable>
              <template #default="{ row }">
                <el-button link type="primary" class="dv-link" @click="openStation(row)">
                  {{ row.team_name }}
                </el-button>
              </template>
            </el-table-column>
            <el-table-column prop="pushed_order_volume" label="推配送单量" min-width="120" sortable />
            <el-table-column prop="delivery_completed" label="配送成功单量" min-width="130" sortable />
            <el-table-column prop="timeout_total" label="超时单量" min-width="110" sortable />
            <el-table-column label="准时率" min-width="110" align="center" sortable :sort-method="numSort('ontime_rate')">
              <template #default="{ row }">
                <span class="rt" :class="rateClsUp(row.ontime_rate)">{{ fmtRate(row.ontime_rate) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="单均复合超时时长(秒)" min-width="160" align="center" sortable :sort-method="numSort('avg_compound_overtime_sec')">
              <template #default="{ row }">
                <span class="rt rt--bad">{{ fmtMin(row.avg_compound_overtime_sec) }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- ② 骑手数据：跨所选站点聚合所有骑手（准时率未达100%），分页 + 全量排序后再分页 -->
        <div v-show="activeTab === 'rider'" class="dv-pane">
            <el-table
              v-loading="loading"
              :data="pagedRiderRows"
              :height="riderH"
              stripe
              border
              class="dv-table"
              empty-text="暂无骑手超时数据"
              :default-sort="{ prop: 'overtime_sec', order: 'descending' }"
              @sort-change="onRiderSort"
            >
              <el-table-column prop="rider_id" label="骑手ID" min-width="150" fixed sortable />
              <el-table-column prop="rider_name" label="骑手姓名" min-width="150" fixed sortable />
              <el-table-column prop="team_id" label="站点ID" min-width="130" fixed sortable />
              <el-table-column prop="team_name" label="站点名称" min-width="170" sortable />
              <el-table-column prop="delivered" label="配送成功单量" min-width="130" align="center" sortable />
              <el-table-column prop="timeout" label="T8超时单量" min-width="120" align="center" sortable />
              <el-table-column prop="ontime_rate" label="准时率" min-width="110" align="center" sortable>
                <template #default="{ row }"><span class="rt" :class="rateClsUp(row.ontime_rate)">{{ fmtRate(row.ontime_rate) }}</span></template>
              </el-table-column>
              <el-table-column prop="overtime_sec" label="单均复合超时时长(秒)" min-width="150" align="center" sortable>
                <template #default="{ row }"><span class="rt rt--bad">{{ fmtMin(row.overtime_sec) }}</span></template>
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

        <!-- ③ 运单明细：跨所选站点聚合所有超时订单 -->
        <div v-show="activeTab === 'order'" class="dv-pane">
          <el-table
            v-loading="loading"
            :data="pagedOrderRows"
            :height="orderH"
            stripe
            border
            class="dv-table"
            empty-text="暂无超时运单明细"
            :fit="false"
            :default-sort="{ prop: 'deliver_dur_sec', order: 'descending' }"
            @sort-change="onOrderSort"
          >
            <el-table-column prop="order_id" label="运单ID" :width="colW.order_id" fixed sortable="custom" />
            <el-table-column prop="rider_id" label="骑手ID" :width="colW.rider_id" fixed sortable="custom" />
            <el-table-column prop="rider_name" label="骑手姓名" :width="colW.rider_name" fixed sortable="custom" />
            <el-table-column prop="team_id" label="站点ID" :width="colW.team_id" fixed sortable="custom" />
            <el-table-column prop="team_name" label="站点姓名" :width="colW.team_name" sortable="custom" />
            <el-table-column prop="merchant_id" label="商家ID" :width="colW.merchant_id" sortable="custom" />
            <el-table-column prop="merchant_name" label="商家名称" :width="colW.merchant_name" sortable="custom" />
            <el-table-column prop="flow_no" label="流水号" :width="colW.flow_no" sortable="custom" />
            <el-table-column label="超时分钟" :width="colW.over_min" align="center" sortable="custom">
              <template #default="{ row }">{{ fmtMin(row.over_min) }}</template>
            </el-table-column>
            <el-table-column label="复合超时时长(秒)" :width="colW.compound" align="center" sortable="custom">
              <template #default="{ row }"><span class="rt rt--bad">{{ fmtMin(row.compound_overtime_sec) }}</span></template>
            </el-table-column>
            <el-table-column label="到店时长" :width="colW.arrive_dur" align="center" sortable="custom">
              <template #default="{ row }">{{ fmtSecToMin(row.arrive_dur_sec) }}</template>
            </el-table-column>
            <el-table-column label="等餐时长" :width="colW.wait_dur" align="center" sortable="custom">
              <template #default="{ row }">{{ fmtSecToMin(row.wait_dur_sec) }}</template>
            </el-table-column>
            <el-table-column label="配送时长" :width="colW.deliver_dur" align="center" sortable="custom">
              <template #default="{ row }">{{ fmtSecToMin(row.deliver_dur_sec) }}</template>
            </el-table-column>
            <el-table-column prop="accept_time" label="骑手接单时间" :width="colW.accept_time" align="center" sortable="custom" />
            <el-table-column prop="arrive_time" label="骑手到店时间" :width="colW.arrive_time" align="center" sortable="custom" />
            <el-table-column prop="pickup_time" label="骑手取餐时间" :width="colW.pickup_time" align="center" sortable="custom" />
            <el-table-column prop="deliver_time" label="骑手送达时间" :width="colW.deliver_time" align="center" sortable="custom" />
            <el-table-column prop="expect_time" label="平台期望时间" :width="colW.expect_time" align="center" sortable="custom" />
          </el-table>
          <div class="dv-pg">
            <el-pagination
              v-model:current-page="orderPage"
              v-model:page-size="orderPageSize"
              :total="orderRows.length"
              :page-sizes="[25, 50, 75, 100]"
              layout="total, sizes, prev, pager, next, jumper"
              background
            />
          </div>
        </div>
      </div>

    <!-- 两级下钻抽屉：站点 → 准时率未达100%骑手 → 超时订单明细 -->
    <el-drawer v-model="drawerOpen" :title="drawerTitle" size="46%" :with-header="true">
      <div v-if="drillLevel === 'riders'">
        <div class="dv-drill-hd">
          共 {{ drawerStation.riders.length }} 名骑手准时率未达 100%（按超平台期望分钟降序），点击骑手查看超时订单
        </div>
        <el-table :data="drawerStation.riders" stripe border class="dv-drill-table"
                  :default-sort="{ prop: 'overtime_min', order: 'descending' }" @row-click="onRiderRow">
          <el-table-column label="骑手" min-width="150" fixed sortable>
            <template #default="{ row }">
              <el-button link type="primary" class="dv-link">{{ row.rider_name || row.rider_id || '未知' }}</el-button>
            </template>
          </el-table-column>
          <el-table-column prop="delivered" label="配送成功单量" min-width="130" align="center" sortable />
          <el-table-column prop="timeout" label="超时单量" min-width="110" align="center" sortable />
          <el-table-column label="准时率" min-width="110" align="center" sortable :sort-method="numSort('ontime_rate')">
            <template #default="{ row }"><span class="rt" :class="rateClsUp(row.ontime_rate)">{{ fmtRate(row.ontime_rate) }}</span></template>
          </el-table-column>
          <el-table-column label="单均复合超时时长(秒)" min-width="150" align="center" sortable :sort-method="numSort('avg_overtime_min')">
              <template #default="{ row }"><span class="rt rt--bad">{{ row.avg_overtime_min == null ? '—' : Math.round(row.avg_overtime_min * 60) }}</span></template>
          </el-table-column>
        </el-table>
      </div>
      <div v-else-if="drillLevel === 'orders'">
        <el-button text class="dv-back" @click="backToRiders"><el-icon><ArrowLeft /></el-icon> 返回骑手列表</el-button>
        <div class="dv-drill-hd">
          {{ selectedRider.rider_name || selectedRider.rider_id }} ·
          配送成功 {{ selectedRider.delivered }} 单 · 超时 {{ selectedRider.timeout }} 单 ·
          准时率 {{ fmtRate(selectedRider.ontime_rate) }}
        </div>
        <el-table :data="selectedRider.timeout_orders" stripe border class="dv-drill-table"
                  :default-sort="{ prop: 'over_min', order: 'descending' }">
          <el-table-column prop="tracking_id" label="运单号" min-width="200" />
          <el-table-column label="超时分钟" min-width="110" align="center" sortable>
            <template #default="{ row }"><span class="rt rt--bad">{{ fmtMin(row.over_min) }}</span></template>
          </el-table-column>
          <el-table-column label="严重度" min-width="100" align="center">
            <template #default="{ row }"><span class="sev" :class="sevCls(row.severity)">{{ sevText(row.severity) }}</span></template>
          </el-table-column>
        </el-table>
      </div>
    </el-drawer>

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
import { Refresh, ArrowLeft, Setting } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import {
  fetchTeams, fetchRealtimeTimeout, refreshDeliveryTimeout,
  fetchTimeoutTeams, saveTimeoutTeams,
} from '../api/dashboards.js';

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
    const res = await saveTimeoutTeams(cfgSel.value);
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
const rows = ref([]);
const loading = ref(false);
const loaded = ref(false);
const attempted = ref(0);
const fetchedAt = ref('');
/* 顶层横向标签页：站点数据 / 骑手数据 / 运单明细 */
const activeTab = ref('station');
/* 内容区可用高度：测量 .dv-body，使骑手表格撑满内容页 */
const bodyRef = ref(null);
const bodyH = ref(520);
const bodyW = ref(0); // 内容区宽度：用于判断列总宽是否不足，从而按比例填充（消除行末空白）
let tabRO = null;
function measureTabs() {
  const el = bodyRef.value;
  if (!el) return;
  const h = el.clientHeight;
  if (h > 0) bodyH.value = Math.max(240, h - 8);
  const w = el.clientWidth;
  if (w > 0) bodyW.value = w;
}
/* 各站加载错误 / 是否刚刷新过（用于区分「从未取数」与「取数了仍无数据」） */
const loadErrMsg = ref('');
const justRefreshed = ref(false);

/* —— 刷新数据（拉取今日订单明细后重算）：独立刷新端点，导出全站运单落盘 —— */
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

/* 站点 id → 名称（来自风神全量站点目录 GET /api/teams，含账号可见的全部站点名称）。
   后端 timeout 接口对未登记在 TEAM_NAMES 的站点会把 team_name 回退成 id，
   这里用前端权威名称覆盖，确保表格「站点」列统一显示名称、不出现裸 id。 */
const teamsNameMap = computed(() => {
  const m = new Map();
  for (const t of teams.value) m.set(String(t.id), t.name);
  return m;
});

const needRefresh = computed(() => loaded.value && attempted.value > 0 && rows.value.length === 0);
const dataNote = computed(() => {
  const p = rows.value.find((x) => x.data_status === 'partial');
  return p ? p.data_note || '' : '';
});

/* —— 聚合：全部站点时对各站计数求和，比率/均值按口径重算 —— */
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }

const agg = computed(() => {
  const r = rows.value;
  const pushed = r.reduce((a, x) => a + num(x.pushed_order_volume), 0);
  const completed = r.reduce((a, x) => a + num(x.delivery_completed), 0);
  const timeout = r.reduce((a, x) => a + num(x.timeout_total), 0);
  // 单均复合超时时长（考核口径，单位秒）：各站分子/分母求和后重算均值
  const cNum = r.reduce((a, x) => a + num(x.compound_overtime_sec), 0);
  const cDen = r.reduce((a, x) => a + num(x.compound_detail && x.compound_detail.denominator), 0);
  const avgCompound = cDen > 0 ? Math.round((cNum / cDen) * 100) / 100 : null;
  // T8 加权准时率（与每行 ontime_rate 同源）：对各项分子/分母求和后重算
  const dt = (k) => r.reduce((a, x) => a + num(x.t8_rate_detail && x.t8_rate_detail[k]), 0);
  const t8Num = dt('t8_ontime') - dt('false_slow_cancel') - dt('early_delivered') * 2;
  const t8Den = dt('valid_completed') + dt('high_value_timeout') * 1 + dt('starbucks_timeout') * 2;
  return {
    pushed, completed, timeout, avgCompound,
    // 明细缺失（旧缓存/未刷新）时退化为简单口径，避免汇总显示「-」
    ontime: t8Den > 0
      ? Math.round((t8Num / t8Den) * 1000) / 10
      : (completed > 0 ? pct(completed - timeout, completed) : null),
  };
});

const cards = computed(() => [
  { label: '推配送单量', value: agg.value.pushed },
  { label: '配送成功单量', value: agg.value.completed },
  { label: '超时单量', value: agg.value.timeout, cls: 'is-bad' },
  { label: '准时率', value: fmtRate(agg.value.ontime), cls: rateClsUp(agg.value.ontime) },
  { label: '单均复合超时时长(秒)', value: fmtMin(agg.value.avgCompound), cls: 'is-bad' },
]);

/* —— 骑手数据：跨所选站点聚合所有「准时率未达100%」骑手（每行 row.riders 已含骑手与超时订单） —— */
const riderRows = computed(() => {
  const out = [];
  for (const r of rows.value) {
    const teamName = r.team_name || r.team_id;
    for (const rd of (r.riders || [])) {
      // 后端 rider.avg_overtime_min 为「单均复合超时时长(分钟)」= 超时单复合超时总时长 / 配送成功单量；看板按「秒」展示 → ×60
      const min = rd.avg_overtime_min;
      out.push({
        team_id: r.team_id,
        team_name: teamName,
        rider_id: rd.rider_id,
        rider_name: rd.rider_name,
        delivered: rd.delivered,
        timeout: rd.timeout,
        ontime_rate: rd.ontime_rate,
        overtime_sec: min == null ? null : Math.round(min * 60),
      });
    }
  }
  return out;
});

/* —— 骑手数据分页 + 全量排序后再分页（el-table 自带排序仅作用于当前页，故手动排序） —— */
const riderPage = ref(1);
const riderPageSize = ref(25);
const riderSort = ref({ prop: 'overtime_sec', order: 'descending' });
const riderH = computed(() => Math.max(200, bodyH.value - 56));
function onRiderSort({ prop, order }) {
  riderSort.value = { prop, order };
  riderPage.value = 1;
}
const sortedRiderRows = computed(() => {
  const { prop, order } = riderSort.value;
  const arr = riderRows.value.slice();
  if (!prop || !order) return arr;
  const dir = order === 'ascending' ? 1 : -1;
  arr.sort((a, b) => {
    let va = a[prop], vb = b[prop];
    if (typeof va === 'string' || typeof vb === 'string') {
      va = va == null ? '' : String(va);
      vb = vb == null ? '' : String(vb);
      return va.localeCompare(vb, 'zh') * dir;
    }
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va - vb) * dir;
  });
  return arr;
});
const pagedRiderRows = computed(() => {
  const start = (riderPage.value - 1) * riderPageSize.value;
  return sortedRiderRows.value.slice(start, start + riderPageSize.value);
});
/* 数据重载后回到第一页 */
watch(() => riderRows.value.length, () => { riderPage.value = 1; });

/* —— 运单明细：跨所选站点聚合所有超时订单（来自各骑手的 timeout_orders） —— */
const orderRows = computed(() => {
  const out = [];
  for (const r of rows.value) {
    const teamName = r.team_name || r.team_id;
    for (const rd of (r.riders || [])) {
      const riderName = rd.rider_name || rd.rider_id || '未知';
      for (const o of (rd.timeout_orders || [])) {
        out.push({
          team_id: r.team_id,
          team_name: teamName,
          order_id: o.order_id,
          flow_no: o.flow_no,
          over_min: o.over_min,
          compound_overtime_sec: o.compound_overtime_sec,
          rider_id: rd.rider_id,
          rider_name: riderName,
          merchant_id: o.merchant_id,
          merchant_name: o.merchant_name,
          accept_time: o.accept_time,
          arrive_time: o.arrive_time,
          pickup_time: o.pickup_time,
          deliver_time: o.deliver_time,
          expect_time: o.expect_time,
          arrive_dur_sec: o.arrive_dur_sec,
          wait_dur_sec: o.wait_dur_sec,
          deliver_dur_sec: o.deliver_dur_sec,
        });
      }
    }
  }
  return out;
});

/* —— 运单明细列宽自适应：按每列实际最长内容（含表头）测算像素宽度，固定渲染、超宽横向滚动，杜绝换行 —— */
const orderColDefs = [
  { id: 'order_id',    label: '运单ID',        get: (r) => r.order_id },
  { id: 'rider_id',    label: '骑手ID',        get: (r) => r.rider_id },
  { id: 'rider_name',  label: '骑手姓名',      get: (r) => r.rider_name },
  { id: 'team_id',     label: '站点ID',        get: (r) => r.team_id },
  { id: 'team_name',   label: '站点姓名',      get: (r) => r.team_name },
  { id: 'merchant_id', label: '商家ID',        get: (r) => r.merchant_id },
  { id: 'merchant_name', label: '商家名称',    get: (r) => r.merchant_name },
  { id: 'flow_no',     label: '流水号',        get: (r) => r.flow_no },
  { id: 'over_min',    label: '超时分钟',      get: (r) => fmtMin(r.over_min) },
  { id: 'compound',    label: '复合超时时长(秒)', get: (r) => fmtMin(r.compound_overtime_sec) },
  { id: 'arrive_dur',  label: '到店时长',  get: (r) => fmtSecToMin(r.arrive_dur_sec) },
  { id: 'wait_dur',    label: '等餐时长',  get: (r) => fmtSecToMin(r.wait_dur_sec) },
  { id: 'deliver_dur', label: '配送时长',  get: (r) => fmtSecToMin(r.deliver_dur_sec) },
  { id: 'accept_time', label: '骑手接单时间',  get: (r) => r.accept_time },
  { id: 'arrive_time', label: '骑手到店时间',  get: (r) => r.arrive_time },
  { id: 'pickup_time', label: '骑手取餐时间',  get: (r) => r.pickup_time },
  { id: 'deliver_time', label: '骑手送达时间', get: (r) => r.deliver_time },
  { id: 'expect_time', label: '平台期望时间',  get: (r) => r.expect_time },
];

/* 用真实 DOM 探测每列最长内容的自然像素宽度（复制 el-table 实际字号字体，避免 canvas 估算偏差） */
const rawColW = ref({});
// 浏览器滚动条宽度（一次测量）：填充时扣除它，避免产生横向滚动条
const SBW = (() => {
  const d = document.createElement('div');
  d.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll;';
  document.body.appendChild(d);
  const w = d.offsetWidth - d.clientWidth;
  document.body.removeChild(d);
  return w || 0;
})();
// 列宽自适应 + 剩余宽度按比例分配：当“所有列按内容算出的总宽 < 内容区宽度(扣滚动条)”时，
// 把剩余空间按各列内容占比放大到刚好填满容器（杜绝行末空白）；总宽已超出则保持贴合内容、横向滚动。
const colW = computed(() => {
  const map = rawColW.value;
  const ids = Object.keys(map);
  if (!ids.length) return map;
  const sum = ids.reduce((a, k) => a + (map[k] || 0), 0);
  // 仅当本页行数多到撑出表格固定高度（出现纵向滚动条）时才扣除其宽度，否则不扣，避免凭空留白
  const vScroll = pagedOrderRows.value.length * 48 + 44 > orderH.value;
  const target = bodyW.value - (vScroll ? SBW : 0) - 1; // 实际可用宽度（再留 1px 防亚像素溢出）
  // 只要内容总宽 < 容器就按需填充到 target（无空白、无横向滚动）；总宽 ≥ 容器才是真溢出，允许横向滚动
  if (bodyW.value > 0 && sum > 0 && sum < bodyW.value) {
    const factor = target / sum;
    const out = {};
    let acc = 0;
    ids.forEach((k, i) => {
      const w = Math.round((map[k] || 0) * factor);
      out[k] = w;
      acc += w;
    });
    out[ids[ids.length - 1]] += target - acc; // 取整余量精确凑到 target（可负，杜绝溢出成横向滚动）
    return out;
  }
  return map;
});
function measureColWidths() {
  const map = {};
  let probe = null;
  try {
    probe = document.createElement('div');
    // 复制表格单元格的真实字体（含中文/字号），保证测量与渲染一致
    const refCell = document.querySelector('.dv-table .el-table__body .cell')
      || document.querySelector('.dv-table .el-table__header .cell');
    const font = refCell ? getComputedStyle(refCell).font : '14px Arial, sans-serif';
    probe.style.cssText =
      'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;' +
      'padding:0;margin:0;font:' + font + ';';
    document.body.appendChild(probe);
  } catch (e) {
    probe = null;
  }
  if (!probe) { for (const c of orderColDefs) map[c.id] = 120; return map; }
  const data = orderRows.value;
  const sample = data.length > 500 ? data.slice(0, 500) : data; // 抽样测算，兼顾性能
  for (const c of orderColDefs) {
    probe.textContent = c.label;
    let max = probe.offsetWidth; // 表头
    for (const r of sample) {
      probe.textContent = c.get(r);
      const w = probe.offsetWidth;
      if (w > max) max = w;
    }
    map[c.id] = Math.ceil(max) + 26; // 单元格左右内边距 + 余量，确保不换行
  }
  document.body.removeChild(probe);
  return map;
}
// 数据变化后等表格渲染完再测算（字体/单元格已就绪）
watch(orderRows, () => {
  nextTick(() => { rawColW.value = measureColWidths(); });
}, { immediate: true });

/* 秒 → 分钟（用于到店/等餐/配送时长展示） */
function fmtSecToMin(v) {
  if (v == null) return '—';
  const m = v / 60;
  return Number.isInteger(m) ? m : Math.round(m * 10) / 10;
}

/* —— 运单明细：全量排序后再分页（el-table 自带排序仅作用于当前页，故手动排序；sortable="custom"） —— */
const orderPage = ref(1);
const orderPageSize = ref(25); // 默认 25 条/页
const orderSort = ref({ prop: 'deliver_dur_sec', order: 'descending' });
const orderH = computed(() => Math.max(200, bodyH.value - 56)); // 撑满内容页（减去分页器高度）
const ORDER_NUMERIC = new Set(['over_min', 'compound_overtime_sec', 'arrive_dur_sec', 'wait_dur_sec', 'deliver_dur_sec']);
function onOrderSort({ prop, order }) {
  orderSort.value = { prop, order };
  orderPage.value = 1;
}
const sortedOrderRows = computed(() => {
  const { prop, order } = orderSort.value;
  if (!prop || !order) return orderRows.value;
  const dir = order === 'ascending' ? 1 : -1;
  const arr = orderRows.value.slice();
  arr.sort((a, b) => {
    const an = a[prop] == null, bn = b[prop] == null;
    if (an && bn) return 0;
    if (an) return 1;  // null 永远排最后（升/降序均如此）
    if (bn) return -1;
    let c;
    if (ORDER_NUMERIC.has(prop)) c = a[prop] - b[prop];
    else c = String(a[prop]).localeCompare(String(b[prop]), 'zh');
    return dir * c;
  });
  return arr;
});
const pagedOrderRows = computed(() => {
  const start = (orderPage.value - 1) * orderPageSize.value;
  return sortedOrderRows.value.slice(start, start + orderPageSize.value);
});
// 数据重载后回到第一页
watch(() => orderRows.value.length, () => { orderPage.value = 1; });

/* 数值列排序：null 永远排最后 */
function numSort(key) {
  return (a, b) => {
    const va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return va - vb;
  };
}
function fmtRate(v) { return v == null ? '—' : (v + '%'); }
function fmtMin(v) { return v == null ? '—' : v; }
/* 越高越好的比率着色（准时率 / 预估准时率） */
function rateClsUp(v) { if (v == null) return 'is-none'; if (v >= 95) return 'is-ok'; if (v >= 90) return 'is-warn'; return 'is-bad'; }
/* 严重度着色：8-15 较轻、15-30 偏重、≥30 严重 */
function sevCls(s) {
  if (s === '>=30') return 'sev--heavy';
  if (s === '15-30') return 'sev--mid';
  return 'sev--light';
}
function sevText(s) { if (s === '>=30') return '≥30分'; if (s === '15-30') return '15-30分'; return '8-15分'; }

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const ids = teamSel.value === '__all__'
      ? teamOptions.value.map((t) => t.id)
      : [teamSel.value];
    attempted.value = ids.length;
    fetchedAt.value = '';
    const results = await Promise.all(
      ids.map((id) => fetchRealtimeTimeout({ team: id }).catch((e) => ({ __err: e }))),
    );
    const good = [];
    const errs = [];
    for (const res of results) {
      if (!res || res.__err) { errs.push('请求失败'); continue; }
      if (!res.ok) { errs.push(res.error || '计算返回错误'); continue; }
      if (!res.rows || !res.rows.length) continue;   // need_refresh 等无数据行，不计入错误
      const row = res.rows[0];
      const nm = teamsNameMap.value.get(String(row.team_id ?? res.team));
      if (nm) row.team_name = nm;                    // 统一站点名称，避免裸 id
      good.push(row);
      // 取数时间：全部站点取各站最近落盘时间的最大值（最新一次取数）
      if (res.fetched_at && (!fetchedAt.value || res.fetched_at > fetchedAt.value)) {
        fetchedAt.value = res.fetched_at;
      }
    }
    rows.value = good;
    loadErrMsg.value = errs.length ? '部分站点计算/请求失败：' + errs.join('；') : '';
  } catch (e) {
    if (!silent) ElMessage.error(e.message || '加载失败');
    if (!silent) rows.value = [];
  } finally {
    loaded.value = true;
    if (!silent) loading.value = false;
  }
}

/* —— 刷新数据：调独立的全站运单导出落盘端点，同步返回后重算 —— */
async function onRefresh() {
  if (refreshing.value || cooldown.value > 0) return;
  refreshing.value = true;
  loading.value = true;   // 刷新端点（拉运单落盘）耗时最长，覆盖此等待期让表格全程有 loading 反馈
  justRefreshed.value = true;
  try {
    // 独立端点按抓取回来的 teamId 分组落盘，覆盖账号可见全部站点（不受标准达成参与站点约束）。
    const res = await refreshDeliveryTimeout({});
    if (!res || !res.ok) {
      ElMessage.error((res && res.error) || '刷新失败');
      startCooldown(REFRESH_COOLDOWN_SEC);
      loading.value = false;   // 失败分支不调用 load，手动复位表格 loading
      return;
    }
    const failed = (res.perTeam || []).filter((p) => !p.saved);
    if (failed.length) {
      ElMessage.warning(`刷新完成，但以下站点未落盘（0 条或写入失败）：`
        + failed.map((p) => `${p.team}（${p.rows} 条）`).join('；'));
    } else {
      ElMessage.success(`刷新完成：导出 ${res.total} 条，落盘 ${res.saved} 个站点`);
    }
    startCooldown(REFRESH_COOLDOWN_SEC);
    load();
  } catch (e) {
    const ra = e && e.data && e.data.retry_after;
    startCooldown(ra && ra > 0 ? ra : REFRESH_COOLDOWN_SEC);
    ElMessage.error(e.message || '刷新失败');
    loading.value = false;   // 异常分支不调用 load，手动复位表格 loading
  } finally {
    refreshing.value = false;
  }
}

/* —— 两级下钻 —— */
const drawerOpen = ref(false);
const drillLevel = ref('riders');
const drawerStation = ref({ team_name: '', riders: [] });
const selectedRider = ref({ timeout_orders: [] });
const drawerTitle = computed(() => {
  if (drillLevel.value === 'orders') {
    const r = selectedRider.value;
    return `${r.rider_name || r.rider_id || '骑手'} · 超时订单明细`;
  }
  return `${drawerStation.value.team_name} · 准时率未达100%骑手`;
});
function openStation(row) {
  drawerStation.value = row;
  drillLevel.value = 'riders';
  selectedRider.value = { timeout_orders: [] };
  drawerOpen.value = true;
}
function onRiderRow(row) { openRider(row); }
function openRider(rider) {
  selectedRider.value = rider;
  drillLevel.value = 'orders';
}
function backToRiders() {
  drillLevel.value = 'riders';
  selectedRider.value = { timeout_orders: [] };
}

function onTeamChange() {
  justRefreshed.value = false;
  load();
}

onMounted(async () => {
  try { const t = await fetchTeams(); teams.value = (t && t.teams) || []; } catch (e) { /* ignore */ }
  try {
    const tc = await fetchTimeoutTeams();
    teamsCfg.value = (tc && tc.teams) || [];
  } catch (e) { /* ignore：取不到配置则回落全部站点 */ }
  await load();
  // 标签页内容区高度测量（撑满内容页）；窗口/容器尺寸变化时自动重测
  await nextTick();
  measureTabs();
  if (typeof ResizeObserver !== 'undefined' && bodyRef.value) {
    tabRO = new ResizeObserver(() => measureTabs());
    tabRO.observe(bodyRef.value);
  }
});

onUnmounted(() => {
  if (cooldownTimer) clearInterval(cooldownTimer);
  if (tabRO) tabRO.disconnect();
});
</script>

<style scoped>
.dv { padding: var(--sp-20); display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
.dv-bar { display: flex; align-items: center; gap: var(--sp-12); margin-bottom: var(--sp-16); flex-wrap: wrap; }
.v-title { margin: 0; font-size: var(--el-font-size-extra-large); }
.dv-sel { width: 160px; }
.dv-date-tag { font-size: var(--el-font-size-small); color: var(--muted); }
.dv-bar .sp { flex: 1; }
.dv-hint { margin-bottom: var(--sp-12); }


/* ── KPI 汇总卡片 ──── */
.dv-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-12); margin-bottom: var(--sp-16); }
.dv-card { background: var(--white); border: 1px solid var(--border-soft); border-radius: var(--r-md); padding: var(--sp-16); display: flex; flex-direction: column; gap: 4px; }
.dv-card-num { font-size: 24px; font-weight: var(--fw-bold); color: var(--brand); }
.dv-card-label { font-size: var(--el-font-size-extra-small); color: var(--muted); }
.dv-card-num.is-ok { color: var(--ok, #2e7d32); }
.dv-card-num.is-warn { color: var(--warn, #ed6c02); }
.dv-card-num.is-bad { color: var(--danger, #d32f2f); }
.dv-card-num.is-none { color: var(--muted); }

/* ── 比率单元格 ──────────────────────────────── */
.rt { font-weight: var(--fw-bold); }
.rt.is-ok { color: var(--ok, #2e7d32); }
.rt.is-warn { color: var(--warn, #ed6c02); }
.rt.is-bad { color: var(--danger, #d32f2f); }
.rt.is-none { color: var(--muted); font-weight: var(--fw-normal); }
.rt--bad { color: var(--danger, #d32f2f); }

/* ── 下钻抽屉 ──────────────────────────────── */
.dv-drill-hd { font-size: var(--el-font-size-small); color: var(--muted); margin: var(--sp-4) 0 var(--sp-12); }
.dv-drill-table { width: 100%; }
.dv-link { padding: 0; }
.dv-back { margin-bottom: var(--sp-12); }
.sev { display: inline-block; padding: 1px var(--sp-8); border-radius: var(--r-pill); font-size: var(--el-font-size-extra-small); font-weight: var(--fw-semibold); }
.sev--light { background: color-mix(in srgb, var(--warn, #ed6c02) 14%, transparent); color: var(--warn, #ed6c02); }
.sev--mid { background: color-mix(in srgb, #f57c00 16%, transparent); color: #f57c00; }
.sev--heavy { background: color-mix(in srgb, var(--danger, #d32f2f) 16%, transparent); color: var(--danger, #d32f2f); }

.dv-table { border-radius: var(--r-md); }
/* 表格行高：放宽单元格上下内边距与行内文字行高，避免内容过密、密密麻麻 */
.dv-table :deep(.el-table th.el-table__cell),
.dv-table :deep(.el-table td.el-table__cell) {
  padding: 14px 0;
}
.dv-table :deep(.el-table .cell) {
  line-height: 22px;
}
/* 排序图标：仅被点击排序（ascending/descending）的列显示图标，未排序列不预留图标位置 */
.dv-table :deep(.el-table__cell.is-sortable .caret-wrapper) { display: none; }
.dv-table :deep(.el-table__cell.is-sortable.ascending .caret-wrapper),
.dv-table :deep(.el-table__cell.is-sortable.descending .caret-wrapper) { display: inline-flex; }
/* 去掉可排序列右侧为图标预留的内边距（图标已按需显示，避免空占位） */
.dv-table :deep(.el-table__header th.el-table__cell.is-sortable .cell) { padding-right: 10px; }
/* 顶层横向菜单（顶栏菜单）：站点数据 / 骑手数据 / 运单明细 */
.dv-menu { border-bottom: 1px solid #ebeef5; margin-top: var(--sp-4); margin-bottom: var(--sp-12); }
/* 内容区：撑满剩余高度，骑手表格据此计算固定高度（撑满内容页） */
.dv-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dv-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dv-pg { flex: none; padding-top: var(--sp-12); display: flex; justify-content: flex-end; }
</style>
