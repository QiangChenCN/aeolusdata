import { createRouter, createWebHashHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import TaskCenterView from '../views/TaskCenterView.vue';
import HistoryView from '../views/HistoryView.vue';
import PresetView from '../views/PresetView.vue';
import TodoView from '../views/TodoView.vue';
import StandardView from '../views/StandardView.vue';
import AttendPeriodView from '../views/AttendPeriodView.vue';
import OverviewView from '../views/OverviewView.vue';
import RealtimeView from '../views/RealtimeView.vue';
import GroupsView from '../views/GroupsView.vue';
import AdminView from '../views/AdminView.vue';
import BotConfigView from '../views/BotConfigView.vue';

// 导航 kind 与路由对应（hub/dash 仅侧栏容器，不单独成路由）
const routes = [
  { path: '/', redirect: '/home' },
  { path: '/home', name: 'home', component: HomeView, meta: { title: '首页', kind: 'home' } },
  { path: '/tasks', name: 'tasks-all', component: TaskCenterView, meta: { title: '全部任务', kind: 'tasks', id: 'all' } },
  { path: '/tasks/:groupId', name: 'tasks-group', component: TaskCenterView, meta: { title: '任务中心', kind: 'tasks' }, props: true },
  { path: '/history', name: 'history', component: HistoryView, meta: { title: '运行记录' } },
  { path: '/preset', name: 'preset', component: PresetView, meta: { title: '预设' } },
  { path: '/todo', name: 'todo', component: TodoView, meta: { title: '工作内容' } },
  { path: '/standard', name: 'standard', component: StandardView, meta: { title: '标准达成' } },
  { path: '/attend-period', name: 'attend-period', component: AttendPeriodView, meta: { title: '时段出勤' } },
  { path: '/overview', name: 'overview', component: OverviewView, meta: { title: '总览' } },
  { path: '/realtime', name: 'realtime', component: RealtimeView, meta: { title: '实时数据' } },
  { path: '/groups', name: 'groups', component: GroupsView, meta: { title: '群组' } },
  { path: '/admin', name: 'admin', component: AdminView, meta: { title: '系统设置' } },
  { path: '/bot', name: 'bot', component: BotConfigView, meta: { title: '机器人配置', kind: 'botconfig' } },
];

export default createRouter({
  history: createWebHashHistory(),
  routes,
});
