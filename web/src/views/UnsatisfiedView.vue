<template>
  <div class="dv">
    <div class="dv-topbar">
      <span class="dv-title">违规处罚</span>
      <el-menu mode="horizontal" :default-active="tab" class="dv-menu" @select="(k) => (tab = k)">
        <el-menu-item index="realtime">实时</el-menu-item>
        <el-menu-item index="monthly">月累计</el-menu-item>
      </el-menu>
    </div>

    <!-- 月累计 -->
    <div v-show="tab === 'monthly'" class="dv-pane">
      <div class="dv-controls">
        <span class="dv-ctl-label">日期范围</span>
        <div class="dv-range-wrap">
          <el-date-picker
            v-model="monthRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            format="YYYY-MM-DD"
            :clearable="false"
            :shortcuts="monthRangeShortcuts"
            @change="loadMonthly"
          />
        </div>
        <span class="dv-ctl-label">违规分类</span>
        <el-select
          v-model="monthlyCats"
          multiple
          collapse-tags
          collapse-tags-tooltip
          clearable
          style="width: 240px"
          filterable
          placeholder="违规分类"
          @change="onMonthlyCatChange"
        >
          <el-option label="全选" :value="SELECT_ALL" />
          <el-option
            v-for="o in monthlyCatOptions"
            :key="o.value"
            :label="o.label"
            :value="o.value"
          />
        </el-select>
        <span class="dv-ctl-label">违规类型</span>
        <el-select
          v-model="monthlyTypes"
          multiple
          collapse-tags
          collapse-tags-tooltip
          clearable
          style="width: 240px"
          filterable
          placeholder="违规类型"
          @change="onMonthlyTypeChange"
        >
          <el-option label="全选" :value="SELECT_ALL" />
          <el-option
            v-for="o in monthlyTypeOptions"
            :key="o.value"
            :label="o.label"
            :value="o.value"
          />
        </el-select>
        <span class="dv-ctl-label">站点</span>
        <el-select
          v-model="monthlySites"
          multiple
          collapse-tags
          collapse-tags-tooltip
          clearable
          filterable
          style="width: 200px"
          placeholder="站点"
          @change="onMonthlySiteChange"
        >
          <el-option label="全选" :value="SELECT_ALL" />
          <el-option
            v-for="o in monthlySiteOptions"
            :key="o.value"
            :label="o.label"
            :value="o.value"
          />
        </el-select>
        <span class="dv-ctl-label">骑手</span>
        <el-select
          v-model="monthlyRiders"
          multiple
          collapse-tags
          collapse-tags-tooltip
          clearable
          filterable
          style="width: 200px"
          placeholder="骑手"
          @change="onMonthlyRiderChange"
        >
          <el-option label="全选" :value="SELECT_ALL" />
          <el-option
            v-for="o in monthlyRiderOptions"
            :key="o.value"
            :label="o.label"
            :value="o.value"
          />
        </el-select>
        <span v-if="monthDays" class="dv-date" style="margin-left:auto">已入库 {{ monthDays }} 天</span>
      </div>
      <div class="dv-table-wrap">
        <el-table
          ref="monthlyTableRef"
          :data="monthlyPagedRows"
          v-loading="loadingMonthly"
          border
          height="100%"
          empty-text="暂无数据，每日 03:00 自动同步至 T-1"
        >
          <el-table-column
            v-for="(col, idx) in monthlyColumns"
            :key="col.key"
            :prop="col.key"
            :label="col.label"
            :min-width="monthlyNatural[idx]"
            :formatter="col.key === 'violationTime' ? fmtDateTime
              : CODE_FIELDS.has(col.key) ? fmtCode : undefined"
            show-overflow-tooltip
          />
        </el-table>
      </div>
      <div class="dv-foot">
        <el-pagination
          v-model:current-page="monthlyPage"
          :page-size="monthlyPageSize"
          :total="monthlyFilteredRows.length"
          :page-sizes="[25, 50, 75, 100]"
          layout="total, prev, pager, next, jumper, sizes"
          background
          @size-change="monthlyPage = 1"
        />
      </div>
    </div>

    <!-- 实时 -->
    <div v-show="tab === 'realtime'" class="dv-pane">
      <div class="dv-controls">
        <span class="dv-ctl-label">取数时间</span>
        <span class="dv-date">{{ fetchedAt || '—' }}</span>
        <el-button type="primary" :loading="loadingRealtime" @click="refreshRealtime">
          刷新
        </el-button>
        <el-button v-if="!isToday" @click="backToToday">回到今天</el-button>
        <span class="dv-ctl-label">违规分类</span>
        <el-select
          v-model="realtimeCats"
          multiple
          collapse-tags
          collapse-tags-tooltip
          clearable
          style="width: 240px"
          filterable
          placeholder="违规分类"
          @change="onRealtimeCatChange"
        >
          <el-option label="全选" :value="SELECT_ALL" />
          <el-option
            v-for="o in realtimeCatOptions"
            :key="o.value"
            :label="o.label"
            :value="o.value"
          />
        </el-select>
        <span class="dv-ctl-label">违规类型</span>
        <el-select
          v-model="realtimeTypes"
          multiple
          collapse-tags
          collapse-tags-tooltip
          clearable
          style="width: 240px"
          filterable
          placeholder="违规类型"
          @change="onRealtimeTypeChange"
        >
          <el-option label="全选" :value="SELECT_ALL" />
          <el-option
            v-for="o in realtimeTypeOptions"
            :key="o.value"
            :label="o.label"
            :value="o.value"
          />
        </el-select>
        <span class="dv-ctl-label">站点</span>
        <el-select
          v-model="realtimeSites"
          multiple
          collapse-tags
          collapse-tags-tooltip
          clearable
          filterable
          style="width: 200px"
          placeholder="站点"
          @change="onRealtimeSiteChange"
        >
          <el-option label="全选" :value="SELECT_ALL" />
          <el-option
            v-for="o in realtimeSiteOptions"
            :key="o.value"
            :label="o.label"
            :value="o.value"
          />
        </el-select>
      </div>
      <div class="dv-table-wrap">
        <el-table
          ref="realtimeTableRef"
          :data="realtimePagedRows"
          v-loading="loadingRealtime"
          border
          height="100%"
          empty-text="暂无数据，点「刷新」获取最新并落盘"
        >
          <el-table-column
            v-for="(col, idx) in realtimeColumns"
            :key="col.key"
            :prop="col.key"
            :label="col.label"
            :min-width="realtimeNatural[idx]"
            :formatter="col.key === 'violationTime' ? fmtDateTime
              : CODE_FIELDS.has(col.key) ? fmtCode : undefined"
            show-overflow-tooltip
          />
        </el-table>
      </div>
      <div class="dv-foot">
        <el-pagination
          v-model:current-page="realtimePage"
          :page-size="realtimePageSize"
          :total="realtimeFilteredRows.length"
          :page-sizes="[25, 50, 75, 100]"
          layout="total, prev, pager, next, jumper, sizes"
          background
          @size-change="realtimePage = 1"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, computed, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  fetchViolationRange,
  fetchViolationMonthRange,
  fetchViolationRangeDb,
  saveViolationRows,
} from '../api/unsatisfied.js';

const route = useRoute();

const tab = ref('realtime');
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// 月累计：日期范围选择器（带快捷选项），默认本月 1 号 ~ 今天
const monthRange = ref([`${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`]);
const monthRangeShortcuts = [
  {
    text: '本月',
    value: () => {
      const d = new Date();
      return [new Date(d.getFullYear(), d.getMonth(), 1), new Date()];
    },
  },
  {
    text: '上月',
    value: () => {
      const d = new Date();
      return [new Date(d.getFullYear(), d.getMonth() - 1, 1), new Date(d.getFullYear(), d.getMonth(), 0)];
    },
  },
  {
    text: '近7天',
    value: () => {
      const e = new Date();
      const s = new Date();
      s.setDate(s.getDate() - 6);
      return [s, e];
    },
  },
  {
    text: '近30天',
    value: () => {
      const e = new Date();
      const s = new Date();
      s.setDate(s.getDate() - 29);
      return [s, e];
    },
  },
];
// 实时标签只盯今天：默认查当天；打开即从落盘读取，无缓存时自动拉取最新并落盘。点刷新才拉风神最新。
const realtimeRange = ref([todayStr(), todayStr()]);
const realtimeRangeText = computed(() => realtimeRange.value.join(' ~ '));
const isToday = computed(() => {
  const t = todayStr();
  return realtimeRange.value[0] === t && realtimeRange.value[1] === t;
});
// 上次成功取数的时间（取数时间）。
const fetchedAt = ref('');
const loadingMonthly = ref(false);
const loadingRealtime = ref(false);
const monthlyRows = ref([]);
const monthlyColumns = ref([]);
const monthDays = ref(0);
// 月累计分页：整月常有上千行，全量渲染会卡数秒，故分页渲染
const monthlyPage = ref(1);
const monthlyPageSize = ref(25);
const monthlyTableRef = ref(null);
const realtimeTableRef = ref(null);
const monthlyPagedRows = computed(() => {
  const start = (monthlyPage.value - 1) * monthlyPageSize.value;
  return monthlyFilteredRows.value.slice(start, start + monthlyPageSize.value);
});
const realtimeRows = ref([]);
const realtimeColumns = ref([]);
// 实时分页：默认 25，候选 25/50/75/100
const realtimePage = ref(1);
const realtimePageSize = ref(25);
const realtimePagedRows = computed(() => {
  const start = (realtimePage.value - 1) * realtimePageSize.value;
  return realtimeFilteredRows.value.slice(start, start + realtimePageSize.value);
});

/* ===== 筛选（选项取自当前数据，默认全选，可多选） ===== */
const catLabel = (code) =>
  (CODE_LABELS.violationCategory && CODE_LABELS.violationCategory[code]) || code || '—';
const catOf = (r) => String(r?.violationCategory ?? '');
const typeOf = (r) => String(r?.violationType ?? '');
const typeLabel = (code) =>
  (CODE_LABELS.violationType && CODE_LABELS.violationType[code]) || code || '—';
const siteOf = (r) => String(r?.teamName ?? '');
const siteLabel = (v) => v || '—';
// 站点ID（teamInfo 拆分出的「站点ID-站点名称」前半）。下钻时考核看板按站点名命中，
// 这里附带 ID 匹配作为兜底（站点名极端情况下不一致也能命中）。
const teamIdOf = (r) => String(r?.teamId ?? '');
// 违规状态（10=成立 / 20=不成立）；仅下钻时传 status=10，普通浏览不受此过滤影响。
const statusOf = (r) => String(r?.violationStatus ?? '');
const distinctOf = (rows, fn) => [...new Set((rows || []).map(fn))];
// 数据刷新后：保留仍存在的旧选择；若此前未选择（含首次加载）则保持为空，默认不筛选
const mergeSel = (prev, available) => {
  if (!prev || prev.length === 0) return [];
  return (prev || []).filter((c) => available.includes(c));
};

// 违规分类
const realtimeCats = ref([]);
const realtimeCatOptions = computed(() =>
  distinctOf(realtimeRows.value, catOf).map((v) => ({ value: v, label: catLabel(v) })),
);
const monthlyCats = ref([]);
const monthlyCatOptions = computed(() =>
  distinctOf(monthlyRows.value, catOf).map((v) => ({ value: v, label: catLabel(v) })),
);

// 违规类型（按数值排序，便于查找）
const realtimeTypes = ref([]);
const realtimeTypeOptions = computed(() =>
  distinctOf(realtimeRows.value, typeOf)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((v) => ({ value: v, label: typeLabel(v) })),
);
const monthlyTypes = ref([]);
const monthlyTypeOptions = computed(() =>
  distinctOf(monthlyRows.value, typeOf)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((v) => ({ value: v, label: typeLabel(v) })),
);

// 站点（teamName）。站点较多，选项支持搜索过滤。
const realtimeSites = ref([]);
const realtimeSiteOptions = computed(() =>
  distinctOf(realtimeRows.value, siteOf).map((v) => ({ value: v, label: siteLabel(v) })),
);
// 违规状态过滤（仅下钻带 status 参数时生效；为空=不过滤，保持普通浏览默认行为）。
const realtimeStatus = ref([]);
const monthlySites = ref([]);
const monthlySiteOptions = computed(() =>
  distinctOf(monthlyRows.value, siteOf).map((v) => ({ value: v, label: siteLabel(v) })),
);

// 骑手（knightId 唯一，label 取骑手姓名）
const riderOf = (r) => String(r?.knightId ?? '');
function riderOptions(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const v = riderOf(r);
    if (!v) continue;
    if (!m.has(v)) m.set(v, (r?.knightName ?? '') || v);
  }
  return [...m.entries()].map(([value, label]) => ({ value, label }));
}
const monthlyRiders = ref([]);
const monthlyRiderOptions = computed(() => riderOptions(monthlyRows.value));

// 过滤：违规分类 ∧ 违规类型 ∧ 站点 ∧ 骑手 ∧ 状态 同时命中；某维度为空（已清空）视为不过滤该维度
const matchSel = (sel, val) => sel.length === 0 || sel.includes(val);
const realtimeFilteredRows = computed(() =>
  realtimeRows.value.filter(
    (r) =>
      matchSel(realtimeCats.value, catOf(r)) &&
      matchSel(realtimeTypes.value, typeOf(r)) &&
      (matchSel(realtimeSites.value, siteOf(r)) || matchSel(realtimeSites.value, teamIdOf(r))) &&
      matchSel(realtimeStatus.value, statusOf(r)),
  ),
);
const monthlyFilteredRows = computed(() =>
  monthlyRows.value.filter(
    (r) =>
      matchSel(monthlyCats.value, catOf(r)) &&
      matchSel(monthlyTypes.value, typeOf(r)) &&
      (matchSel(monthlySites.value, siteOf(r)) || matchSel(monthlySites.value, teamIdOf(r))) &&
      matchSel(monthlyRiders.value, riderOf(r)),
  ),
);

// 多选框“全选”：选中占位项 SELECT_ALL 即选中全部真实值，并剔除占位项本身（避免参与过滤）
const SELECT_ALL = '__ALL__';
// 注意：必须在 <script setup> 作用域里捕获真实 ref（模板里直接传 monthlyCats 会被自动解包成数组，
// 导致下面的 modelRef.value = ... 写到了数组上而非响应式 ref，全选失效）。
function handleSelectAll(modelRef, optionsRef, selected) {
  const allValues = optionsRef.value.filter((o) => o.value !== SELECT_ALL).map((o) => o.value);
  modelRef.value = selected.includes(SELECT_ALL)
    ? allValues.slice()
    : selected.filter((v) => v !== SELECT_ALL);
}
const onMonthlyCatChange = (sel) => handleSelectAll(monthlyCats, monthlyCatOptions, sel);
const onMonthlyTypeChange = (sel) => handleSelectAll(monthlyTypes, monthlyTypeOptions, sel);
const onMonthlySiteChange = (sel) => handleSelectAll(monthlySites, monthlySiteOptions, sel);
const onMonthlyRiderChange = (sel) => handleSelectAll(monthlyRiders, monthlyRiderOptions, sel);
const onRealtimeCatChange = (sel) => handleSelectAll(realtimeCats, realtimeCatOptions, sel);
const onRealtimeTypeChange = (sel) => handleSelectAll(realtimeTypes, realtimeTypeOptions, sel);
const onRealtimeSiteChange = (sel) => handleSelectAll(realtimeSites, realtimeSiteOptions, sel);

const nowDtStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const toMs = (d) => Date.parse(`${d}T00:00:00+08:00`);
const toMsEnd = (d) => Date.parse(`${d}T23:59:59.999+08:00`);
// 违规时间：上游返回 ISO（含 T / 可能带 Z），展示为普通日期时间 "2026-10-07 23:41:28"
function fmtDateTime(_row, _col, value) {
  if (!value) return '';
  return String(value).replace('T', ' ').replace(/Z$/, '');
}
// 骑手：上游合并为 "骑手ID-骑手姓名"，拆分为两列
function splitKnight(info) {
  const s = info == null ? '' : String(info);
  const i = s.indexOf('-');
  if (i < 0) return { knightId: s, knightName: '' };
  return { knightId: s.slice(0, i).trim(), knightName: s.slice(i + 1).trim() };
}
// 团队/站点：上游合并为 "站点ID-站点名称"，拆分为两列
function splitTeam(info) {
  const s = info == null ? '' : String(info);
  const i = s.indexOf('-');
  if (i < 0) return { teamId: s, teamName: '' };
  return { teamId: s.slice(0, i).trim(), teamName: s.slice(i + 1).trim() };
}
// 需要把英文代码转中文的列
const CODE_FIELDS = new Set([
  'violationCategory', 'violationType', 'violationStatus',
  'appealStatus', 'eventSource',
]);
// 英文代码 → 中文。取值来自风神真实数据（按 violationOrderId 关联 download CSV 的中文，已覆盖全量样本）。
const CODE_LABELS = {
  eventSource: {
    APOLLO: '运单平台',
    RIDER: '骑士作业',
    USER: '用户',
    SPZT: '索赔中台',
    KFPT: '开放平台',
  },
  violationCategory: {
    OVERTIME: '超时',
    COMPLAIN: '投诉',
    BAD_REVIEW: '差评',
    CLAIM: '餐货损',
    CANCEL: '取消',
  },
  violationType: {
    1001: '超时送达',
    1004: '违规取消',
    1005: '违规送达',
    1028: '少餐错餐 (差评)',
    1029: '送达不通知',
    1030: '不送上门 (差评)',
    1035: '未保持餐品完整（索赔）',
    1036: '送错位置（索赔）',
    1037: '少餐错餐（索赔）',
    1038: '丢餐（索赔）',
    1039: '提前点送达（索赔）',
    1053: '配送超时（索赔）',
  },
  violationStatus: {
    10: '成立',
    20: '不成立',
  },
  appealStatus: {
    10: '待申诉',
    20: '申诉中',
    30: '申诉成功',
    40: '申诉失败',
    50: '申诉过期',
    '-1': '不可申诉',
  },
};
// 代码列 formatter：命中映射则显示中文，否则原样显示（避免误标）
function fmtCode(_row, column, value) {
  if (!value) return '';
  const key = column && column.property;
  const m = key && CODE_LABELS[key];
  return (m && m[value]) || value;
}
function normalizeRows(rows) {
  return (rows || []).map(({ knightInfo, teamInfo, ...rest }) => ({
    ...rest,
    ...splitKnight(knightInfo),
    ...splitTeam(teamInfo),
  }));
}

// 明确不展示的字段（数据里有但表格不渲染）
const HIDDEN_FIELDS = new Set(['agentInfo', 'cancelType']);

// extraHidden：调用方可追加的隐藏字段（如月累计不展示"申诉截止"）
function buildColumns(rows, extraHidden = []) {
  const hidden = new Set([...HIDDEN_FIELDS, ...extraHidden]);
  const keys = new Set();
  rows.slice(0, 50).forEach((r) =>
    Object.keys(r).forEach((k) => {
      if (!hidden.has(k)) keys.add(k);
    }),
  );
  // 真实字段（风神 queryList 返回，英文 key）→ 友好中文标签，按业务顺序排列
  const LABELS = {
    violationTime: '违规时间',
    violationOrderId: '违规编号',
    trackingId: '运单号',
    knightId: '骑手ID',
    knightName: '骑手姓名',
    teamId: '站点ID',
    teamName: '站点名称',
    violationCategory: '违规分类',
    violationType: '违规类型',
    violationStatus: '违规状态',
    bonus: '处罚',
    violationReason: '违规原因',
    appealStatus: '申诉状态',
    appealExpireTime: '申诉截止',
    eventSource: '数据来源',
  };
  const ORDER = [
    'violationTime', 'violationOrderId', 'trackingId', 'knightId', 'knightName', 'teamId', 'teamName',
    'violationCategory', 'violationType', 'violationStatus', 'bonus',
    'violationReason', 'appealStatus', 'appealExpireTime', 'eventSource',
  ];
  const ordered = ORDER.filter((k) => keys.has(k));
  const rest = [...keys].filter((k) => !ordered.includes(k));

  return [...ordered, ...rest].map((k) => ({
    key: k,
    label: LABELS[k] || k,
  }));
}

/* ===== 列宽自适应：真实内容测量，交给 el-table fit 填满容器 ===== */
// 各列“内容自然宽度”（按真实渲染测量，等于内容真实宽度，无最小宽度）
const monthlyNatural = ref([]);
const realtimeNatural = ref([]);

// 单元格展示文本（与表格 formatter 保持一致）：时间列格式化、代码列转中文
function cellText(col, r) {
  const v = r == null ? null : r[col.key];
  if (col.key === 'violationTime') return fmtDateTime(null, null, v);
  if (CODE_FIELDS.has(col.key)) return fmtCode(null, { property: col.key }, v);
  return v == null ? '' : String(v);
}

// 基于“全量数据”测量每列真实内容宽度（不随当前翻页变化，列宽在各页保持一致）。
// 用隐藏容器复刻 el-table 单元格字体与内边距，逐列取表头+抽样正文的最长单行宽度。
function measureNaturalFromData(tableRef, columns, rows) {
  const el = tableRef && tableRef.value && tableRef.value.$el;
  if (!el || !columns.length) return [];
  const probe = el.querySelector('.el-table__body-wrapper .cell')
    || el.querySelector('.el-table__header-wrapper .cell');
  const cs = probe ? getComputedStyle(probe) : null;
  const fontStyle = cs
    ? `font-size:${cs.fontSize};font-family:${cs.fontFamily};font-weight:${cs.fontWeight};letter-spacing:${cs.letterSpacing};`
    : 'font-size:14px;';
  const pad = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 24;

  const wrap = document.createElement('div');
  wrap.style.cssText = `position:absolute;top:-9999px;left:-9999px;visibility:hidden;white-space:nowrap;${fontStyle}`;
  document.body.appendChild(wrap);

  // 逐列取展示文本最长（按字符数近似宽度）的若干候选，全部测量取最大，
  // 避免步长抽样漏掉最宽的一行（如超长站点名称）导致该列被压窄折叠。
  const out = columns.map((col) => {
    const all = rows.map((r) => cellText(col, r));
    all.push(col.label);
    const candidates = all.sort((a, b) => b.length - a.length).slice(0, 12);
    let max = 0;
    for (const t of candidates) {
      const s = document.createElement('span');
      s.style.cssText = `display:inline-block;white-space:nowrap;${fontStyle}`;
      s.textContent = t;
      wrap.appendChild(s);
      if (s.scrollWidth > max) max = s.scrollWidth;
      wrap.removeChild(s);
    }
    return Math.ceil(max) + pad + 6; // +边框与取整容差，防止个别列被压窄
  });
  document.body.removeChild(wrap);
  return out;
}

// 数据加载/页签切换后，按全量数据重测自然宽度（与可见性无关，隐藏表也能测）。
// 之后由 el-table 的 fit（默认开启）把容器剩余宽度按列宽比例填满，无需手动缩放。
function remeasure(tableRef, naturalRef, columnsRef, rowsRef) {
  nextTick(() => {
    naturalRef.value = measureNaturalFromData(tableRef, columnsRef.value, rowsRef.value);
  });
}

async function loadMonthly() {
  const [s, e] = monthRange.value || [];
  if (!s || !e) return;
  loadingMonthly.value = true;
  try {
    const r = await fetchViolationMonthRange({ start: s, end: e });
    if (!r.ok) {
      ElMessage.error(r.error || '查询失败');
      return;
    }
    monthlyRows.value = normalizeRows(r.rows || []);
    monthlyColumns.value = buildColumns(monthlyRows.value, ['appealExpireTime']);
    monthlyCats.value = mergeSel(monthlyCats.value, distinctOf(monthlyRows.value, catOf));
    monthlyTypes.value = mergeSel(monthlyTypes.value, distinctOf(monthlyRows.value, typeOf));
    monthlySites.value = mergeSel(monthlySites.value, distinctOf(monthlyRows.value, siteOf));
    monthlyRiders.value = mergeSel(monthlyRiders.value, riderOptions(monthlyRows.value).map((o) => o.value));
    monthlyPage.value = 1;
    // 已入库天数（区间内按 stat_date 去重统计，优先用后端返回）
    monthDays.value =
      r.days ??
      new Set(monthlyRows.value.map((x) => String(x.violationTime || '').slice(0, 10))).size;
  } catch (e) {
    ElMessage.error(e?.message || '查询失败');
  } finally {
    loadingMonthly.value = false;
  }
}

// 渲染一批原始行为表格（拆骑手/站点列）
function renderRealtime(rows) {
  realtimeRows.value = normalizeRows(rows);
  realtimeColumns.value = buildColumns(realtimeRows.value);
  realtimeCats.value = mergeSel(realtimeCats.value, distinctOf(realtimeRows.value, catOf));
  realtimeTypes.value = mergeSel(realtimeTypes.value, distinctOf(realtimeRows.value, typeOf));
  realtimeSites.value = mergeSel(realtimeSites.value, distinctOf(realtimeRows.value, siteOf));
}

// 读本地已落盘缓存（不请求风神）：切换标签/改区间时调用
async function loadRealtimeCache() {
  const [s, e] = realtimeRange.value;
  if (!s || !e) return;
  loadingRealtime.value = true;
  try {
    const r = await fetchViolationRangeDb({ start: s, end: e });
    if (!r.ok) {
      ElMessage.error(r.error || '读取缓存失败');
      return;
    }
    renderRealtime(r.rows || []);
    // 取数时间 = 该区间最近一次落盘时间
    fetchedAt.value = r.fetchedAt || '—';
    if ((r.rows || []).length === 0) {
      // 本地该区间无缓存，自动拉取最新并落盘，避免打开即空白
      ElMessage.info('本地暂无缓存，正在拉取最新数据并落盘…');
      await refreshRealtime();
    }
  } catch (err) {
    ElMessage.error(err?.message || '读取缓存失败');
  } finally {
    loadingRealtime.value = false;
  }
}

// 实时拉取最新并落盘（刷新按钮）：请求风神 → 写入 violation.db → 展示
async function refreshRealtime() {
  const [s, e] = realtimeRange.value;
  if (!s || !e) return;
  loadingRealtime.value = true;
  try {
    const r = await fetchViolationRange({ start_ms: toMs(s), end_ms: toMsEnd(e), page_size: 200 });
    if (!r.ok) {
      ElMessage.error(r.error || '查询失败');
      return;
    }
    const rows = r.rows || [];
    try {
      await saveViolationRows(rows);
    } catch (_) {
      /* 落盘失败不影响本次展示 */
    }
    renderRealtime(rows);
    fetchedAt.value = nowDtStr();
  } catch (err) {
    ElMessage.error(err?.message || '查询失败');
  } finally {
    loadingRealtime.value = false;
  }
}

function backToToday() {
  realtimeRange.value = [todayStr(), todayStr()];
  loadRealtimeCache();
}

// 筛选变化后回到第一页，避免停留在超出范围的页码
watch(monthlyCats, () => {
  monthlyPage.value = 1;
});
watch(monthlyTypes, () => {
  monthlyPage.value = 1;
});
watch(monthlySites, () => {
  monthlyPage.value = 1;
});
watch(monthlyRiders, () => {
  monthlyPage.value = 1;
});
watch(realtimeCats, () => {
  realtimePage.value = 1;
});
watch(realtimeTypes, () => {
  realtimePage.value = 1;
});
watch(realtimeSites, () => {
  realtimePage.value = 1;
});
watch(realtimeStatus, () => {
  realtimePage.value = 1;
});

/* ===== 下钻入口：考核看板点击某站点违规计数后，带 query 跳转到本看板并自动套用筛选 =====
   参数：tab(realtime/monthly，默认 realtime)、site(站点名)、teamId(站点ID，兜底匹配)、
   cat(违规分类代码，逗号分隔)、type(违规类型代码，逗号分隔)、status(违规状态代码，逗号分隔)。
   仅实时 tab 支持 status 过滤（月累计无状态维度）；站点同时按 名称/ID 命中。 */
function applyDrillQuery() {
  const q = route.query || {};
  const targetTab = q.tab === 'monthly' ? 'monthly' : 'realtime';
  tab.value = targetTab;
  const site = q.site ? String(q.site) : '';
  const teamId = q.teamId ? String(q.teamId) : '';
  const cats = q.cat ? String(q.cat).split(',').filter(Boolean) : [];
  const types = q.type ? String(q.type).split(',').filter(Boolean) : [];
  const status = q.status ? String(q.status).split(',').filter(Boolean) : [];
  const sites = [site, teamId].filter(Boolean);
  if (targetTab === 'monthly') {
    if (sites.length) monthlySites.value = sites;
    if (cats.length) monthlyCats.value = cats;
    if (types.length) monthlyTypes.value = types;
  } else {
    if (sites.length) realtimeSites.value = sites;
    if (cats.length) realtimeCats.value = cats;
    if (types.length) realtimeTypes.value = types;
    if (status.length) realtimeStatus.value = status;
  }
}
// 同一路由内再次下钻（query 变化但组件不卸载）：重新套用筛选（数据已加载，仅筛选变化即生效）。
watch(
  () => route.query,
  () => applyDrillQuery(),
);

// 列宽自适应：数据加载后按“全量数据”重测列宽（与翻页无关，各页列宽保持一致）
watch(monthlyColumns, () => {
  remeasure(monthlyTableRef, monthlyNatural, monthlyColumns, monthlyRows);
});
watch(realtimeColumns, () => {
  remeasure(realtimeTableRef, realtimeNatural, realtimeColumns, realtimeRows);
});
// 切换页签后重测（数据可能尚未加载时也先按已有数据测一遍）
watch(tab, () => {
  if (tab.value === 'monthly') remeasure(monthlyTableRef, monthlyNatural, monthlyColumns, monthlyRows);
  else remeasure(realtimeTableRef, realtimeNatural, realtimeColumns, realtimeRows);
});

watch(tab, async () => {
  if (tab.value === 'monthly') loadMonthly();
  else loadRealtimeCache();
  // v-show 隐藏时表格拿不到高度，切回后需重算才能撑满内容区
  await nextTick();
  const t = tab.value === 'monthly' ? monthlyTableRef.value : realtimeTableRef.value;
  t?.doLayout?.();
});

onMounted(() => {
  // 下钻优先：若带 query（考核看板点计数跳入），先套用筛选再加载，保证首次渲染即过滤。
  applyDrillQuery();
  // 必须按**当前标签**主动加载一次：watch(tab) 只在标签切换时触发，
  // 首次进入（默认停在「实时」）不会触发 —— 否则即使 violation.db/realtime.db
  // 已有落盘数据，实时表格也会一直空白，必须切到月累计再切回来才显示。
  if (tab.value === 'monthly') loadMonthly();
  else loadRealtimeCache();
  // 列宽自适应：按当前页签首次测量列宽（之后由 el-table fit 负责填满/分配）
  if (tab.value === 'monthly') remeasure(monthlyTableRef, monthlyNatural, monthlyColumns, monthlyRows);
  else remeasure(realtimeTableRef, realtimeNatural, realtimeColumns, realtimeRows);
});
</script>

<style scoped>
.dv {
  padding: 16px;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}
.dv-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.dv-topbar {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  border-bottom: 1px solid #ebeef5;
  margin-bottom: 12px;
}
.dv-title {
  font-size: 18px;
  font-weight: 600;
  white-space: nowrap;
}
.dv-menu {
  width: 100%;
  border-bottom: none;
}
.dv-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.dv-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
/* 表格撑满内容区：flex:1 + min-height:0 让 el-table 的 height:100% 能解析出确定高度 */
.dv-table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.dv-table-wrap :deep(.el-table) {
  flex: 1;
  min-height: 0;
}
/* 放宽行高，避免行过于紧凑 */
.dv-table-wrap :deep(.el-table th.el-table__cell),
.dv-table-wrap :deep(.el-table td.el-table__cell) {
  padding: 12px 0;
}
.dv-table-wrap :deep(.el-table .cell) {
  line-height: 20px;
}
.dv-ctl-label {
  color: #6e6e6e;
}
/* 日期范围选择器：Element 通过 --el-date-editor-daterange-width(350px) 控制宽度。
   class/style 不透传到 date-picker 根元素，故用外层包装 + :deep 命中 .el-date-editor；
   同时覆盖变量与 width（!important 兜底），并缩字号防 220px 下截断 */
.dv-range-wrap {
  flex: 0 0 auto;
}
.dv-range-wrap :deep(.el-date-editor) {
  --el-date-editor-daterange-width: 220px !important;
  width: 220px !important;
}
.dv-range-wrap :deep(.el-range-input) {
  font-size: 13px;
}
.dv-date {
  font-weight: 600;
}
.dv-foot {
  margin-top: 8px;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  color: #6e6e6e;
  font-size: 13px;
}
</style>
