<template>
  <nav class="side">
    <NavNode
      v-for="it in navItems"
      :key="it.key"
      :node="it"
      :depth="0"
      :siblings="topParentKeys"
    />
  </nav>
</template>

<script setup>
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import NavNode from './NavNode.vue';
import { useTasksStore } from '../../stores/tasks.js';
import { useAuthStore } from '../../stores/auth.js';
import { useRunsStore } from '../../stores/runs.js';
import { openActiveAncestors } from '../../utils/nav.js';

const route = useRoute();
const tasks = useTasksStore();
const auth = useAuthStore();
const runs = useRunsStore();

const navItems = computed(() => {
  const items = [];
  items.push({ type: 'leaf', key: 'home', kind: 'home', id: '', name: '首页', icon: 'HomeFilled' });

  const dashSubs = [
    { type: 'leaf', kind: 'assessment', id: '', name: '考核看板', icon: 'DataLine' },
    { type: 'leaf', kind: 'timeout', id: '', name: '配送超时', icon: 'Timer' },
    { type: 'leaf', kind: 'imContact', id: '', name: 'IM 电联', icon: 'ChatDotRound' },
    { type: 'leaf', kind: 'standard', id: '', name: '标准达成', icon: 'Aim' },
    { type: 'leaf', kind: 'attendPeriod', id: '', name: '时段出勤', icon: 'Calendar' },
    { type: 'leaf', kind: 'unsatisfied', id: '', name: '违规处罚', icon: 'Warning' },
    { type: 'leaf', kind: 'assess', id: '', name: '考核设置', icon: 'Trophy' },
  ];
  items.push({ type: 'parent', key: 'dash', name: '数据看板', icon: 'DataLine', children: dashSubs });

  // 任务中心：单页入口（不再按分组拆分），点击进入全部任务视图
  const workChildren = [
    { type: 'leaf', key: 'hub', kind: 'tasks', id: 'all', name: '任务中心', icon: 'Grid', count: tasks.tasks.length },
    { type: 'leaf', key: 'history', kind: 'history', id: '', name: '运行记录', icon: 'Clock', count: runs.history.length },
    { type: 'leaf', key: 'todo', kind: 'todo', id: '', name: '自动任务', icon: 'List' },
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
      { type: 'leaf', kind: 'rbac', id: '', name: '权限管理', icon: 'Tools' },
      { type: 'leaf', kind: 'bots', id: '', name: '调度设置', icon: 'ChatDotRound' },
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
.side { padding: var(--sp-12) var(--sp-8); display: flex; flex-direction: column; gap: 2px; }
</style>
