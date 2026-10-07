import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import TaskCenterView from '../views/TaskCenterView.vue';
import HistoryView from '../views/HistoryView.vue';
import PresetView from '../views/PresetView.vue';
import TodoView from '../views/TodoView.vue';
import StandardView from '../views/StandardView.vue';
import AssessServiceView from '../views/AssessServiceView.vue';
import AssessStandardView from '../views/AssessStandardView.vue';
import AttendPeriodView from '../views/AttendPeriodView.vue';
import OverviewView from '../views/OverviewView.vue';
import RealtimeView from '../views/RealtimeView.vue';
import GroupsView from '../views/GroupsView.vue';
import AdminView from '../views/AdminView.vue';
import BotGlobalView from '../views/BotGlobalView.vue';
import BotRobotView from '../views/BotRobotView.vue';
import BotInstanceView from '../views/BotInstanceView.vue';
import LoginView from '../views/LoginView.vue';
import { useAuthStore } from '../stores/auth.js';

// 导航 kind 与路由对应（hub/dash 仅侧栏容器，不单独成路由）
const routes = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true, title: '登录' } },
  { path: '/', redirect: '/home' },
  { path: '/home', name: 'home', component: HomeView, meta: { title: '首页', kind: 'home' } },
  { path: '/tasks', name: 'tasks-all', component: TaskCenterView, meta: { title: '全部任务', kind: 'tasks', id: 'all' } },
  { path: '/tasks/:groupId', name: 'tasks-group', component: TaskCenterView, meta: { title: '任务中心', kind: 'tasks' }, props: true },
  { path: '/history', name: 'history', component: HistoryView, meta: { title: '运行记录' } },
  { path: '/preset', name: 'preset', component: PresetView, meta: { title: '预设' } },
  { path: '/todo', name: 'todo', component: TodoView, meta: { title: '工作内容' } },
  { path: '/assess', redirect: '/assess/service' },
  { path: '/assess/service', name: 'assess-service', component: AssessServiceView, meta: { title: '服务质量设置', kind: 'assessService', id: '' } },
  { path: '/assess/standard', name: 'assess-standard', component: AssessStandardView, meta: { title: '标准达成设置', kind: 'assessStandard', id: '' } },
  { path: '/standard', name: 'standard', component: StandardView, meta: { title: '标准达成' } },
  { path: '/attend-period', name: 'attend-period', component: AttendPeriodView, meta: { title: '时段出勤' } },
  { path: '/overview', name: 'overview', component: OverviewView, meta: { title: '总览' } },
  { path: '/realtime', name: 'realtime', component: RealtimeView, meta: { title: '实时数据' } },
  { path: '/groups', name: 'groups', component: GroupsView, meta: { title: '群组' } },
  { path: '/admin', name: 'admin', component: AdminView, meta: { title: '系统设置' } },
  { path: '/bot/global', name: 'bot-global', component: BotGlobalView, meta: { title: '全局配置', kind: 'botcfg', id: 'global' } },
  { path: '/bot/robot', name: 'bot-robot', component: BotRobotView, meta: { title: '机器人配置', kind: 'botcfg', id: 'robot' } },
  { path: '/bot/instance', name: 'bot-instance', component: BotInstanceView, meta: { title: '实例配置', kind: 'botcfg', id: 'instance' } },
  { path: '/bot', redirect: '/bot/global' },
];

// History 模式（无 #）：深链接需服务端回退到 index.html。
//   · 开发环境：Vite(appType='spa') 自带 history 回退，且会把 index.html 里的相对资源
//     重写为绝对路径，嵌套路由（/bot/global）也不会取错资源。
//   · 生产环境：由 Nest 的 SPA 回退中间件负责（backend/src/main.ts）。
//     缺少该回退时，刷新 /tasks 这类深层路由会 404。
const router = createRouter({
  history: createWebHistory(),
  routes,
});

// 全局鉴权守卫：未登录访问受保护页 → 重定向到登录页并保留来源；
// 已登录访问登录页 → 跳回首页；引导阶段确保会话校验完成。
router.beforeEach(async (to) => {
  const auth = useAuthStore();
  // 必须无条件 await：bootstrap 内部已幂等（共享 Promise），
  // 这里若改成「只在未引导时才等」，就会与 App.vue 的 onMounted 抢跑，
  // 拿到未填充的登录态而误判未登录。
  await auth.bootstrap();

  if (to.meta && to.meta.public) {
    if (auth.authenticated) return { path: '/' };
    return true;
  }
  if (!auth.authenticated) {
    const redirect = to.fullPath && to.fullPath !== '/' ? to.fullPath : null;
    return redirect
      ? { path: '/login', query: { redirect } }
      : { path: '/login' };
  }
  return true;
});

export default router;
