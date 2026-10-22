import { useRoute } from 'vue-router';
import { useTasksStore } from '../stores/tasks.js';
import { useRunsStore } from '../stores/runs.js';
import { useAppStore } from '../stores/app.js';

export function navTo(it) {
  switch (it.kind) {
    case 'home': return '/';
    case 'tasks': return '/tasks';
    case 'history': return '/history';
    case 'standard': return '/standard';
    case 'attendPeriod': return '/attend-period';
    case 'assessment': return '/assessment';
    case 'timeout': return '/timeout';
    case 'imContact': return '/im-contact';
    case 'unsatisfied': return '/unsatisfied';
    case 'cron': return '/cron';
    case 'assessService': return '/assess/service';
    case 'assessStandard': return '/assess/standard';
    case 'assess': return '/assess';
    case 'rbac-users': return '/settings/rbac/users';
    case 'rbac-roles': return '/settings/rbac/roles';
    case 'rbac-policy': return '/settings/rbac/policy';
    case 'rbac-pw': return '/settings/rbac/pw';
    case 'rbac': return '/settings/rbac';
    case 'profile': return '/settings/profile';
    case 'bots': return '/bot';
    case 'syscfg': return '/settings';
    case 'sys-dingtalk': return '/settings/dingtalk';
    case 'sys-aeolus': return '/settings/aeolus';
    case 'botcfg': return '/bot/' + it.id;
    default: return '/';
  }
}

export function navMatch(it) {
  const route = useRoute();
  const kind = route.meta && route.meta.kind;
  const id = route.params.groupId != null ? route.params.groupId : (route.meta && route.meta.id);
  return it.kind === kind && (it.id || '') === (id != null ? id : '');
}

export function navIsActive(it) {
  if (it.type === 'parent') {
    return it.children.some((c) => navIsActive(c)) || !!(it.kind && navMatch(it));
  }
  // 权限管理（侧栏叶子项）：其下任一 rbac-* 子页命中即高亮
  if (it.kind === 'rbac') {
    const r = useRoute();
    const k = r.meta && r.meta.kind;
    return typeof k === 'string' && k.startsWith('rbac');
  }
  // 考核设置（侧栏叶子项，位于数据看板下）：其下任一 assess* 子页命中即高亮
  if (it.kind === 'assess') {
    const r = useRoute();
    const k = r.meta && r.meta.kind;
    return k === 'assess' || k === 'assessService' || k === 'assessStandard';
  }
  // 机器人配置（侧栏叶子项，位于系统设置下）：其下任一 botcfg 子页命中即高亮
  if (it.kind === 'bots') {
    const r = useRoute();
    const k = r.meta && r.meta.kind;
    return k === 'bots' || k === 'botcfg';
  }
  // 个人中心（侧栏叶子项，位于系统设置下）：profile 单页命中即高亮
  if (it.kind === 'profile') {
    const r = useRoute();
    const k = r.meta && r.meta.kind;
    return k === 'profile';
  }
  return navMatch(it);
}

export function navParentOn(it) {
  return it.children.some((c) => navIsActive(c));
}

export function navBusy(it) {
  const runs = useRunsStore();
  const tasks = useTasksStore();
  const rid = runs.runningTaskId;
  if (!rid) return false;
  if (it.kind !== 'tasks') return false;
  const ids = it.id === 'all'
    ? tasks.tasks.map((t) => t.id)
    : tasks.tasks.filter((t) => t.group === it.id).map((t) => t.id);
  return ids.includes(rid);
}

/** 深链/刷新进入子页时，展开其所有祖先父级（含嵌套）。只展开、不收起。 */
export function openActiveAncestors(list) {
  const app = useAppStore();
  for (const it of list) {
    if (it.type === 'parent') {
      if (it.children.some((c) => navIsActive(c))) app.setNavOpen(it.key, true);
      openActiveAncestors(it.children);
    }
  }
}
