<template>
  <nav class="side" :class="{ collapsed: !app.sideOpen }">
    <NavNode
      v-for="it in navItems"
      :key="it.key"
      :node="it"
      :depth="0"
      :siblings="topParentKeys"
    />
    <button class="side-collapse" @click="$emit('toggle-nav')" :title="app.sideOpen ? '折叠侧栏' : '展开侧栏'">
      <el-icon v-if="app.sideOpen"><Fold /></el-icon>
      <el-icon v-else><Expand /></el-icon>
    </button>
  </nav>
</template>

<script setup>
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import NavNode from './NavNode.vue';
import { useTasksStore } from '../../stores/tasks.js';
import { useAuthStore } from '../../stores/auth.js';
import { useRunsStore } from '../../stores/runs.js';
import { useAppStore } from '../../stores/app.js';
import { openActiveAncestors } from '../../utils/nav.js';

const route = useRoute();
const app = useAppStore();
defineEmits(['toggle-nav']);
const tasks = useTasksStore();
const auth = useAuthStore();
const runs = useRunsStore();

const navItems = computed(() => {
  const items = [];
  items.push({ type: 'leaf', key: 'home', kind: 'home', id: '', name: '首页', icon: 'HomeFilled' });

  const dashSubs = [
    { type: 'leaf', kind: 'assessment', id: '', name: '考核看板', icon: 'DataLine' },
    { type: 'leaf', kind: 'standard', id: '', name: '标准达成', icon: 'Aim' },
    { type: 'leaf', kind: 'attendPeriod', id: '', name: '时段出勤', icon: 'Calendar' },
    { type: 'leaf', kind: 'timeout', id: '', name: '配送超时', icon: 'Timer' },
    { type: 'leaf', kind: 'unsatisfied', id: '', name: '违规处罚', icon: 'Warning' },
    { type: 'leaf', kind: 'imContact', id: '', name: 'IM 电联', icon: 'ChatDotRound' },
    { type: 'leaf', kind: 'delivery', id: '', name: '运单明细', icon: 'Tickets' },
    { type: 'leaf', kind: 'assess', id: '', name: '考核设置', icon: 'Trophy' },
  ];
  items.push({ type: 'parent', key: 'dash', name: '数据看板', icon: 'DataLine', children: dashSubs });

  // 任务中心：单页入口（不再按分组拆分），点击进入全部任务视图
  const workChildren = [
    { type: 'leaf', key: 'hub', kind: 'tasks', id: 'all', name: '任务中心', icon: 'Grid', count: tasks.tasks.length },
    { type: 'leaf', key: 'history', kind: 'history', id: '', name: '运行记录', icon: 'Clock', count: runs.history.length },
    { type: 'leaf', key: 'cron', kind: 'cron', id: '', name: '自动任务', icon: 'List' },
  ];
  items.push({ type: 'parent', key: 'work', name: '工作任务', icon: 'List', children: workChildren });

  // 系统设置：个人中心对所有登录用户可见（账号信息 + 个人改密），置于分组首位便于快速找到；
  // 其余管理类子项（钉钉/风神/权限/调度）仅管理员可见，排在个人中心之后。
  const sysSubs = [];
  sysSubs.push({ type: 'leaf', kind: 'profile', id: '', key: 'profile', name: '个人中心', icon: 'User' });
  if (auth.isAdmin) {
    sysSubs.push(
      { type: 'leaf', kind: 'sys-dingtalk', id: '', name: '钉钉设置', icon: 'ChatDotRound' },
      { type: 'leaf', kind: 'sys-aeolus', id: '', name: '风神设置', icon: 'Key' },
      { type: 'leaf', kind: 'sys-minio', id: '', name: 'MinIO 设置', icon: 'Picture' },
      { type: 'leaf', kind: 'rbac', id: '', name: '权限管理', icon: 'Tools' },
      { type: 'leaf', kind: 'bots', id: '', name: '调度设置', icon: 'ChatDotRound' },
      { type: 'leaf', kind: 'operationLog', id: '', key: 'operationLog', name: '操作日志', icon: 'Document' },
    );
  }
  items.push({ type: 'parent', key: 'sys', name: '系统设置', icon: 'Setting', kind: 'syscfg', children: sysSubs });
  return items;
});

const topParentKeys = computed(() => navItems.value.filter((i) => i.type === 'parent').map((i) => i.key));

// 深链/刷新进入子页时自动展开所属父级（含嵌套层级），只展开不收起
watch(() => route.fullPath, () => openActiveAncestors(navItems.value), { immediate: true });
</script>

<style scoped>
.side { padding: var(--sp-12) var(--sp-8); display: flex; flex-direction: column; gap: 2px; height: 100%; }
/* 折叠按钮：固定在侧栏右下角，margin-top:auto 把它顶到底部，align-self:flex-end 靠右 */
.side-collapse {
  margin-top: auto;
  align-self: flex-end;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px; height: 32px;
  border: none; border-radius: var(--el-border-radius-base);
  background: transparent; color: var(--el-text-color-regular);
  cursor: pointer;
}
.side-collapse:hover { background: var(--el-fill-color); }
/* 折叠为图标栏：仅显示图标，隐藏文字/计数/箭头，图标居中 */
.side.collapsed :deep(.nv) { justify-content: center; padding-left: 0 !important; padding-right: 0 !important; }
.side.collapsed :deep(.nm),
.side.collapsed :deep(.ct),
.side.collapsed :deep(.nv-arw) { display: none; }
</style>
