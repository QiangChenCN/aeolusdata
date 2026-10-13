import { useRoute } from 'vue-router';
import { useTasksStore } from '../stores/tasks.js';
import { useRunsStore } from '../stores/runs.js';
import { useAppStore } from '../stores/app.js';

export function navTo(it) {
  switch (it.kind) {
    case 'home': return '/';
    case 'tasks': return it.id === 'all' ? '/tasks' : '/tasks/' + encodeURIComponent(it.id);
    case 'history': return '/history';
    case 'standard': return '/standard';
    case 'attendPeriod': return '/attend-period';
    case 'realtime': return '/realtime';
    case 'timeout': return '/timeout';
    case 'unsatisfied': return '/unsatisfied';
    case 'todo': return '/todo';
    case 'assessService': return '/assess/service';
    case 'assessStandard': return '/assess/standard';
    case 'rbac-users': return '/rbac/users';
    case 'rbac-roles': return '/rbac/roles';
    case 'rbac-policy': return '/rbac/policy';
    case 'rbac-pw': return '/rbac/pw';
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
