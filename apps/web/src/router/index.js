import { createRouter, createWebHistory } from 'vue-router';
import MainLayout from '../layouts/MainLayout.vue';
import LoginView from '../features/login/LoginView.vue';
import HomeView from '../features/home/HomeView.vue';
import TaskCenterView from '../features/task-center/TaskCenterView.vue';
import HistoryView from '../features/history/HistoryView.vue';
import PresetView from '../features/preset/PresetView.vue';
import CronView from '../features/cron/CronView.vue';
import StandardView from '../features/standard/StandardView.vue';
import AssessServiceView from '../features/assess-service/AssessServiceView.vue';
import AssessStandardView from '../features/assess-standard/AssessStandardView.vue';
import AssessView from '../features/assess/AssessView.vue';
import AttendPeriodView from '../features/attend-period/AttendPeriodView.vue';
import OverviewView from '../features/overview/OverviewView.vue';
import AssessmentBoardView from '../features/assessment-board/AssessmentBoardView.vue';
import DeliveryTimeoutView from '../features/delivery-timeout/DeliveryTimeoutView.vue';
import DeliveryView from '../features/delivery/DeliveryView.vue';
import ImContactView from '../features/im-contact/ImContactView.vue';
import UnsatisfiedView from '../features/unsatisfied/UnsatisfiedView.vue';
import GroupsView from '../features/groups/GroupsView.vue';
import UsersView from '../features/users/UsersView.vue';
import RolesView from '../features/roles/RolesView.vue';
import PolicyView from '../features/policy/PolicyView.vue';
import SystemSettingsView from '../features/system-settings/SystemSettingsView.vue';
import RbacView from '../features/rbac/RbacView.vue';
import DingtalkSettingsView from '../features/dingtalk-settings/DingtalkSettingsView.vue';
import AeolusSettingsView from '../features/aeolus-settings/AeolusSettingsView.vue';
import BotGlobalView from '../features/bot-global/BotGlobalView.vue';
import BotRobotView from '../features/bot-robot/BotRobotView.vue';
import BotInstanceView from '../features/bot-instance/BotInstanceView.vue';
import BotView from '../features/bot/BotView.vue';
import ProfileInfoView from '../features/profile-info/ProfileInfoView.vue';
import NotFoundView from '../features/not-found/NotFoundView.vue';
import OperationLogView from '../features/operation-log/OperationLogView.vue';
import { useAuthStore } from '../stores/auth.js';

// 单一出口架构：所有受保护页挂在 MainLayout 之下（壳 + 内部 router-view），
// 登录页为顶层独立路由。避免同一组件内出现多个未命名 router-view 导致匹配错乱。
const routes = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true, title: '登录' } },
  {
    path: '/',
    component: MainLayout,
    children: [
      // 根路径直接渲染首页（首页即根路由 /）
      { path: '', name: 'home', component: HomeView, meta: { title: '首页', kind: 'home' } },
      { path: 'tasks', name: 'tasks-all', component: TaskCenterView, meta: { title: '全部任务', kind: 'tasks', id: 'all' } },
      { path: 'history', name: 'history', component: HistoryView, meta: { title: '运行记录', kind: 'history', id: '' } },
      { path: 'preset', name: 'preset', component: PresetView, meta: { title: '预设' } },
      { path: 'cron', name: 'cron', component: CronView, meta: { title: '自动任务', kind: 'cron' } },
      { path: 'assess', name: 'assess', component: AssessView, redirect: { name: 'assess-service' }, meta: { title: '考核设置', kind: 'assess' },
        children: [
          { path: 'service', name: 'assess-service', component: AssessServiceView, meta: { title: '服务质量设置', kind: 'assessService', id: '' } },
          { path: 'standard', name: 'assess-standard', component: AssessStandardView, meta: { title: '标准达成设置', kind: 'assessStandard', id: '' } },
        ] },
      { path: 'standard', name: 'standard', component: StandardView, meta: { title: '标准达成', kind: 'standard', id: '' } },
      { path: 'attend-period', name: 'attend-period', component: AttendPeriodView, meta: { title: '时段出勤', kind: 'attendPeriod', id: '' } },
      { path: 'overview', name: 'overview', component: OverviewView, meta: { title: '总览' } },
      { path: 'assessment', name: 'assessment', component: AssessmentBoardView, meta: { title: '考核看板', kind: 'assessment', id: '' } },
      { path: 'delivery', name: 'delivery', component: DeliveryView, meta: { title: '运单明细', kind: 'delivery', id: '' } },
      { path: 'timeout', name: 'timeout', component: DeliveryTimeoutView, meta: { title: '配送超时', kind: 'timeout', id: '' } },
      { path: 'im-contact', name: 'im-contact', component: ImContactView, meta: { title: 'IM 电联', kind: 'imContact', id: '' } },
      { path: 'unsatisfied', name: 'unsatisfied', component: UnsatisfiedView, meta: { title: '违规处罚', kind: 'unsatisfied', id: '' } },
      { path: 'operation-log', name: 'operation-log', component: OperationLogView, meta: { title: '操作日志', kind: 'operationLog', id: '' } },
      { path: 'groups', name: 'groups', component: GroupsView, meta: { title: '群组' } },
      { path: 'settings', name: 'system-settings', component: SystemSettingsView, meta: { title: '系统设置', kind: 'syscfg' } },
      { path: 'settings/dingtalk', name: 'dingtalk-settings', component: DingtalkSettingsView, meta: { title: '钉钉设置', kind: 'sys-dingtalk' } },
      { path: 'settings/aeolus', name: 'aeolus-settings', component: AeolusSettingsView, meta: { title: '风神设置', kind: 'sys-aeolus' } },
      {
        path: 'settings/rbac',
        name: 'rbac',
        component: RbacView,
        redirect: { name: 'rbac-users' },
        meta: { title: '权限管理', kind: 'rbac' },
        children: [
          { path: 'users', name: 'rbac-users', component: UsersView, meta: { title: '账号管理', kind: 'rbac-users' } },
          { path: 'roles', name: 'rbac-roles', component: RolesView, meta: { title: '角色管理', kind: 'rbac-roles' } },
          { path: 'policy', name: 'rbac-policy', component: PolicyView, meta: { title: '密码策略', kind: 'rbac-policy' } },
        ],
      },
      {
        path: 'settings/profile',
        name: 'profile',
        component: ProfileInfoView,
        meta: { title: '个人中心', kind: 'profile' },
      },
      { path: 'bot', name: 'bots', component: BotView, redirect: { name: 'bot-global' }, meta: { title: '调度设置', kind: 'bots' },
        children: [
          { path: 'global', name: 'bot-global', component: BotGlobalView, meta: { title: '全局配置', kind: 'botcfg', id: 'global' } },
          { path: 'robot', name: 'bot-robot', component: BotRobotView, meta: { title: '凭证配置', kind: 'botcfg', id: 'robot' } },
          { path: 'instance', name: 'bot-instance', component: BotInstanceView, meta: { title: '实例配置', kind: 'botcfg', id: 'instance' } },
        ] },
    ],
  },
  // 兜底：未知路径（含拼写错误/已删除路由）渲染 404 页面，而非空白或静默跳首页
  { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundView, meta: { title: '页面不存在' } },
];

// History 模式（无 #）：深链接需服务端回退到 index.html。
//   · 开发环境：Vite(appType='spa') 自带 history 回退，且会把 index.html 里的相对资源
//     重写为绝对路径，嵌套路由（/bot/global）也不会取错资源。
//   · 生产环境：由 Nest 的 SPA 回退中间件负责（apps/api/src/main.ts）。
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
