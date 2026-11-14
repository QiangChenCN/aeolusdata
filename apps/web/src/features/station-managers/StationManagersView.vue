<template>
  <div class="sm">
    <h2 class="v-title">站点负责人设置</h2>

    <!-- 站点映射 -->
    <el-card class="blk" shadow="never">
      <template #header>
        <div class="blk-h-wrap">
          <span class="blk-h">站点设置</span>
          <el-button type="primary" size="small" plain @click="addStation">添加站点</el-button>
        </div>
      </template>
      <el-table :data="form.stations" size="default" empty-text="暂无站点，请先添加">
        <el-table-column label="站点ID">
          <template #default="{ row }">
            <el-input v-model="row.id" size="default" />
          </template>
        </el-table-column>
        <el-table-column label="站点名称">
          <template #default="{ row }">
            <el-input v-model="row.stationName" size="default" />
          </template>
        </el-table-column>
        <el-table-column label="站点简称">
          <template #default="{ row }">
            <el-input v-model="row.name" size="default" />
          </template>
        </el-table-column>
        <el-table-column label="站点地址">
          <template #default="{ row }">
            <el-input v-model="row.address" size="default" />
          </template>
        </el-table-column>
        <el-table-column label="负责人">
          <template #default="{ row }">
            <el-select
              v-model="row.managers"
              multiple
              filterable
              allow-create
              default-first-option
              size="default"
              class="mgr-sel"
            >
              <el-option v-for="m in nameOptions" :key="m" :label="m" :value="m" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="操作" align="center">
          <template #default="{ $index }">
            <el-button type="danger" link @click="form.stations.splice($index, 1)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 负责人设置 -->
    <el-card class="blk" shadow="never">
      <template #header>
        <div class="blk-h-wrap">
          <span class="blk-h">负责人设置</span>
          <el-button type="primary" size="small" plain @click="addManager">添加负责人</el-button>
        </div>
      </template>
      <el-table :data="form.managers" size="default" empty-text="暂无负责人，请先添加">
        <el-table-column label="姓名">
          <template #default="{ row }">
            <el-input v-model="row.name" size="default" />
          </template>
        </el-table-column>
        <el-table-column label="手机号">
          <template #default="{ row }">
            <el-input v-model="row.mobile" size="default" />
          </template>
        </el-table-column>
        <el-table-column label="职位">
          <template #default="{ row }">
            <el-input v-model="row.title" size="default" />
          </template>
        </el-table-column>
        <el-table-column label="openDingTalkId">
          <template #default="{ row }">
            <span v-if="row.open_id" class="oid-text">{{ row.open_id }}</span>
            <span v-else class="muted">保存后自动解析</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" align="center">
          <template #default="{ $index }">
            <el-button type="danger" link @click="form.managers.splice($index, 1)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <div class="actions">
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      <el-button :disabled="saving" @click="load">重置（放弃修改）</el-button>
    </div>

    <el-card class="blk" shadow="never">
      <template #header><span class="blk-h">说明</span></template>
      <ul class="notes">
        <li>本页面是站点负责人映射的<strong>唯一维护入口</strong>，落盘在服务端 <code>apps/api/runtime/station_managers.json</code>（权限 0600，gitignored，属运行时产物）。未保存过配置时页面为空，站点与负责人均需手动添加；保存后即以此页面为唯一来源。</li>
        <li>「实时在线播报」：哪个站点有未上线骑手就只 @ 哪个站点的负责人；站点名按「站点简称或站点名称」匹配，匹配不到的站点会在任务日志里提示且不 @。</li>
        <li>「不满意单申诉提醒」「骑手装备点亮提醒」「站长任务看板」同样使用这份映射，换人只需改这里，无需改代码、无需重启。</li>
        <li>openDingTalkId 解析链：保存时自动解析并回填 → 任务发送时按姓名自动解析（结果缓存）。本页面是唯一来源，<strong>没有任何内置兜底表</strong>；解析不到的人会被跳过 @ 并在任务日志告警，不影响其他人正常 @。</li>
      </ul>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { fetchStationManagers, saveStationManagers } from '../../api/dashboards.js';

const saving = ref(false);

const form = reactive({
  stations: [], // [{id, stationName, name, address, managers: [姓名]}]
  managers: [], // [{name, mobile, title, no_at, open_id}] open_id 留空则保存后自动解析回填；no_at=true 不参与 @
});

const nameOptions = computed(() => {
  const s = new Set();
  for (const st of form.stations) for (const m of st.managers) if (m.trim()) s.add(m.trim());
  for (const m of form.managers) if (m.name.trim()) s.add(m.name.trim());
  return [...s];
});

function normalize(d) {
  form.managers = ((d && d.managers) || []).map((m) => ({ name: m.name || '', mobile: m.mobile || '', title: m.title || '', no_at: m.no_at === true, open_id: m.open_id || '' }));
  form.stations = ((d && d.stations) || []).map((st) => ({
    id: st.station_id || '',
    stationName: st.station_name || (st.teams || [])[0] || '',
    name: st.name || '',
    address: st.address || '',
    managers: [...(st.managers || [])],
  }));
}

async function load() {
  try {
    const r = await fetchStationManagers();
    normalize((r && r.data) || r || {});
  } catch (e) {
    ElMessage.error(e.message || '加载站点负责人配置失败');
  }
}

function addStation() {
  form.stations.push({ id: '', stationName: '', name: '', address: '', managers: [] });
}

function addManager() {
  form.managers.push({ name: '', mobile: '', title: '', no_at: false, open_id: '' });
}

async function save() {
  saving.value = true;
  try {
    const payload = {
      stations: form.stations
        .map((s) => ({
          station_id: s.id.trim(),
          station_name: s.stationName.trim(),
          name: s.name.trim(),
          address: s.address.trim(),
          managers: (s.managers || []).map((m) => m.trim()).filter(Boolean),
        }))
        .filter((s) => s.name || s.station_name || s.station_id || s.managers.length),
      managers: form.managers
        .map((m) => ({ name: m.name.trim(), mobile: m.mobile.trim(), title: m.title.trim(), no_at: m.no_at === true, open_id: m.open_id.trim() }))
        .filter((m) => m.name),
    };
    const r = await saveStationManagers(payload);
    const d = (r && r.data) || r || {};
    if (d && d.ok) {
      ElMessage.success('已保存，openDingTalkId 已自动解析');
      if (d.warning) ElMessage.warning({ message: d.warning, duration: 8000, showClose: true });
      if (Array.isArray(d.missing) && d.missing.length) {
        ElMessage.warning({
          message: `以下姓名未能自动解析 openDingTalkId：${d.missing.join('、')}（可能同名多人或通讯录查无此人，任务发送时会自动重试）`,
          duration: 8000,
          showClose: true,
        });
      }
      await load();
    } else {
      ElMessage.error(d?.error || '保存失败');
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
.sm { padding: var(--sp-20); }
.v-title { margin: 0 0 var(--sp-16); font-size: var(--el-font-size-extra-large); }
.blk { margin-bottom: var(--sp-16); }
.blk-h { font-size: var(--el-font-size-medium); font-weight: var(--fw-semibold); }
.blk-h-wrap { display: flex; align-items: center; justify-content: space-between; }
.muted { color: var(--el-text-color-secondary); font-size: var(--el-font-size-extra-small); }
.status {
  display: flex; align-items: center; gap: var(--sp-8);
  padding: var(--sp-12) var(--sp-16); border-radius: 8px; margin-bottom: var(--sp-12);
  font-size: var(--el-font-size-small);
}
.status--ok { background: #f0f9eb; color: #529b2e; border: 1px solid #e1f3d8; }
.status--warn { background: #fdf6ec; color: #b88230; border: 1px solid #faecd8; }
.st-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.status--ok .st-dot { background: #67c23a; }
.status--warn .st-dot { background: #e6a23c; }
.status code { background: rgba(0,0,0,.05); padding: 1px 6px; border-radius: 4px; }
.mgr-sel { width: 100%; }
.oid-text { font-family: monospace; font-size: var(--el-font-size-small); word-break: break-all; }
.actions { display: flex; gap: var(--sp-12); margin-bottom: var(--sp-16); }
.notes { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: var(--sp-6); font-size: var(--el-font-size-small); color: var(--el-text-color-regular); }
.notes code { background: rgba(0,0,0,.05); padding: 1px 6px; border-radius: 4px; }
</style>
