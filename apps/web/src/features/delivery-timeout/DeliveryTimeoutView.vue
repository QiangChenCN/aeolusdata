<template>
  <div class="dv">
    <TimeoutToolbar
      v-model="teamSel"
      :team-options="teamOptions"
      :fetched-at="fetchedAt"
      :refreshing="refreshing"
      :cooldown="cooldown"
      @change="onTeamChange"
      @open-config="cfgVisible = true"
      @refresh="handleRefresh"
    />

    <el-alert v-if="loadErrMsg" type="warning" :closable="false" show-icon class="dv-hint">{{ loadErrMsg }}</el-alert>
    <el-alert v-else-if="needRefresh" type="info" :closable="false" show-icon class="dv-hint">
      当前站点今日运单明细尚未入库{{ justRefreshed ? '（刚刷新过仍无数据：请确认该站今日确有接单，且运单取数正常）' : '，请点「刷新数据」拉取最新订单明细后查看配送超时' }}。
    </el-alert>
    <el-alert v-else-if="dataNote" type="warning" :closable="false" show-icon class="dv-hint">{{ dataNote }}</el-alert>

    <!-- 卡片式标签页（与标准达成看板同款 Edge 风格）：只用其头部做切换，
         内容区仍由 .dv-body + v-show 承载，保持 bodyRef 高度测量链不变 -->
    <el-tabs v-model="activeTab" type="card" class="dv-tabs">
      <el-tab-pane label="站点数据" name="station" />
      <el-tab-pane label="骑手数据" name="rider" />
      <el-tab-pane label="运单明细" name="order" />
    </el-tabs>

    <div ref="bodyRef" class="dv-body">
      <StationPane v-show="activeTab === 'station'" :rows="rows" :loading="loading" @drill="openStation" />
      <RiderPane v-show="activeTab === 'rider'" :rows="rows" :loading="loading" :body-h="bodyH" />
      <OrderPane
        v-show="activeTab === 'order'"
        v-model:typeFilter="orderTypeFilter"
        :rows="rows"
        :loading="loading"
        :body-h="bodyH"
      />
    </div>

    <TimeoutDrillDrawer v-model="drawerOpen" :station="drawerStation" />
    <TimeoutTeamsDialog v-model="cfgVisible" :teams="teams" :teams-cfg="teamsCfg" @saved="onTeamsSaved" />
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref, nextTick } from 'vue';
import { ElMessage } from 'element-plus';
import TimeoutToolbar from './components/TimeoutToolbar.vue';
import TimeoutTeamsDialog from './components/TimeoutTeamsDialog.vue';
import StationPane from './components/StationPane.vue';
import RiderPane from './components/RiderPane.vue';
import OrderPane from './components/OrderPane.vue';
import TimeoutDrillDrawer from './components/TimeoutDrillDrawer.vue';
import { useDeliveryTimeout } from './useDeliveryTimeout.js';

const {
  teams, teamsCfg, teamSel, teamOptions,
  rows, loading, fetchedAt, loadErrMsg, needRefresh, dataNote, justRefreshed,
  activeTab, orderTypeFilter, bodyRef, bodyH,
  refreshing, cooldown,
  load, onRefresh, onTeamChange, init, initMeasure, dispose,
} = useDeliveryTimeout();

/* 站点设置弹窗 */
const cfgVisible = ref(false);
function onTeamsSaved(savedTeams) {
  teamsCfg.value = savedTeams || [];
  teamSel.value = '__all__'; // 重置到全部站点，避免选中项被移出后下拉空白
  load();
}

/* 站点 → 骑手 → 订单 两级下钻的抽屉 */
const drawerOpen = ref(false);
const drawerStation = ref({ team_name: '', riders: [] });
function openStation(row) {
  drawerStation.value = row;
  drawerOpen.value = true;
}

/** 刷新：拉全站运单入库后重算（与报警文案配合，失败时按冷却提示）。 */
async function handleRefresh() {
  const r = await onRefresh();
  if (!r.ok) {
    ElMessage.error(r.error);
    return;
  }
  const res = r.data || {};
  const empty = (res.perTeam || []).filter((p) => !p.rows);
  if (empty.length) {
    ElMessage.warning(`刷新完成，但以下站点 0 条：${empty.map((p) => p.team).join('；')}`);
  } else {
    ElMessage.success(
      `刷新完成：导出 ${res.total} 条，入库 ${res.saved} 条，覆盖 ${(res.perTeam || []).length} 个站点`,
    );
  }
  load();
}

onMounted(async () => {
  await init();
  await nextTick();
  initMeasure();
});
onUnmounted(dispose);

// 供需要时手动重取（如外部刷新完成后调用）。
defineExpose({ reload: load });
</script>

<style scoped>
.dv { padding: var(--sp-20); display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
.dv-hint { margin-bottom: var(--sp-12); }
/* 卡片式标签页：与标准达成看板共用 element-overrides.css 里的 Edge 风格
   （type="card" 自动生效）。这里只取头部做切换，故固定高度、隐藏空 content，
   间距沿用原菜单的节奏。 */
.dv-tabs { margin-top: var(--sp-4); flex: none; }
.dv-tabs :deep(.el-tabs__header) { margin-bottom: var(--sp-12); }
.dv-tabs :deep(.el-tabs__content) { display: none; }
/* 内容区：撑满剩余高度，骑手 / 运单表格据此计算固定高度 */
.dv-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
</style>
