<template>
  <nav class="side">
    <template v-for="it in navItems" :key="it.key">
      <!-- 一级叶子 -->
      <RouterLink v-if="it.type === 'leaf'" :to="to(it)" class="nv" :class="{ on: isActive(it) }">
        <el-icon class="ic"><component :is="it.icon" /></el-icon>
        <span class="nm">{{ it.name }}</span>
        <span v-if="it.count != null" class="ct">{{ it.count }}</span>
        <span v-if="busy(it)" class="nv-dot nv-dot--busy"></span>
      </RouterLink>

      <!-- 一级父容器（手风琴） -->
      <template v-else>
        <div class="nv nv-parent" :class="{ open: open(it), 'parent-on': parentOn(it) }" @click="onParent(it)">
          <el-icon class="ic"><component :is="it.icon" /></el-icon>
          <span class="nm">{{ it.name }}</span>
          <span v-if="it.count != null" class="ct">{{ it.count }}</span>
          <el-icon class="nv-arw"><ArrowRight /></el-icon>
        </div>
        <div class="nv-subs-wrap" :class="{ open: open(it) }">
          <div class="nv-subs">
            <RouterLink
              v-for="c in it.children" :key="c.kind + c.id"
              :to="to(c)" class="nv-sub" :class="{ on: isActive(c) }"
            >
              <el-icon class="ic"><component :is="c.icon" /></el-icon>
              <span class="nm">{{ c.name }}</span>
              <span v-if="c.count != null" class="ct">{{ c.count }}</span>
              <span v-if="busy(c)" class="nv-dot nv-dot--busy"></span>
            </RouterLink>
          </div>
        </div>
      </template>
    </template>
  </nav>
</template>

<script setup>
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useTasksStore } from '../../stores/tasks.js';
import { useAppStore } from '../../stores/app.js';
import { useAuthStore } from '../../stores/auth.js';
import { useRunsStore } from '../../stores/runs.js';
import { GROUP_ICONS } from '../../utils/tokens.js';

const route = useRoute();
const tasks = useTasksStore();
const app = useAppStore();
const auth = useAuthStore();
const runs = useRunsStore();

function to(it) {
  switch (it.kind) {
    case 'home': return '/home';
    case 'tasks': return it.id === 'all' ? '/tasks' : '/tasks/' + encodeURIComponent(it.id);
    case 'history': return '/history';
    case 'standard': return '/standard';
    case 'attendPeriod': return '/attend-period';
    case 'realtime': return '/realtime';
    case 'unsatisfied': return '/unsatisfied';
    case 'todo': return '/todo';
    case 'assessService': return '/assess/service';
    case 'assessStandard': return '/assess/standard';
    case 'admin': return '/admin';
    case 'botcfg': return '/bot/' + it.id;
    default: return '/home';
  }
}

const navItems = computed(() => {
  const items = [];
  items.push({ type: 'leaf', key: 'home', kind: 'home', id: '', name: '首页', icon: 'HomeFilled' });

  const subs = [{ type: 'leaf', kind: 'tasks', id: 'all', name: '全部任务', icon: 'Grid', count: tasks.tasks.length }];
  tasks.groups.forEach((g) =>
    subs.push({ type: 'leaf', kind: 'tasks', id: g.id, name: g.name, icon: GROUP_ICONS[g.id] || 'Grid', count: tasks.countInGroup(g.id) }));
  subs.push({ type: 'leaf', kind: 'history', id: '', name: '运行记录', icon: 'Clock', count: runs.history.length });
  items.push({ type: 'parent', key: 'hub', name: '任务中心', icon: 'Grid', children: subs });

  const dashSubs = [
    { type: 'leaf', kind: 'standard', id: '', name: '标准达成', icon: 'Aim' },
    { type: 'leaf', kind: 'attendPeriod', id: '', name: '时段出勤', icon: 'Calendar' },
    { type: 'leaf', kind: 'realtime', id: '', name: '实时数据', icon: 'DataLine' },
    { type: 'leaf', kind: 'unsatisfied', id: '', name: '不满意单', icon: 'Warning' },
  ];
  items.push({ type: 'parent', key: 'dash', name: '数据看板', icon: 'DataLine', children: dashSubs });

  items.push({ type: 'leaf', key: 'todo', kind: 'todo', id: '', name: '工作内容', icon: 'List' });

  const assessSubs = [
    { type: 'leaf', kind: 'assessService', id: '', name: '服务质量设置', icon: 'Medal' },
    { type: 'leaf', kind: 'assessStandard', id: '', name: '标准达成设置', icon: 'Aim' },
  ];
  items.push({ type: 'parent', key: 'assess', name: '考核设置', icon: 'Trophy', children: assessSubs });
  if (auth.isAdmin) {
    const botSubs = [
      { type: 'leaf', kind: 'botcfg', id: 'global', name: '全局配置', icon: 'Setting' },
      { type: 'leaf', kind: 'botcfg', id: 'robot', name: '机器人配置', icon: 'Key' },
      { type: 'leaf', kind: 'botcfg', id: 'instance', name: '实例配置', icon: 'Cpu' },
    ];
    items.push({ type: 'parent', key: 'botcfg', name: '机器人配置', icon: 'ChatDotRound', children: botSubs });
    items.push({ type: 'leaf', key: 'admin', kind: 'admin', id: '', name: '系统设置', icon: 'Tools' });
  }
  return items;
});

function routeKind() { return route.meta && route.meta.kind; }
function routeId() {
  if (route.params.groupId != null) return route.params.groupId;
  return route.meta && route.meta.id;
}
function isActive(it) {
  if (it.type === 'parent') return it.children.some((c) => match(c));
  return match(it);
}
function match(it) {
  return it.kind === routeKind() && (it.id || '') === (routeId() != null ? routeId() : '');
}
function parentOn(it) { return it.children.some((c) => isActive(c)); }
function open(it) { return app.navOpen[it.key] === true; }
/**
 * 手风琴：展开一个分组时自动收起其它分组（互斥）；只做展开/收起，不跳转。
 * （旧行为会在展开时跳到第一个子项，手风琴语义下已去掉。）
 */
function onParent(it) {
  const willOpen = !open(it);
  navItems.value.forEach((o) => {
    if (o.type === 'parent' && o.key !== it.key) app.setNavOpen(o.key, false);
  });
  app.setNavOpen(it.key, willOpen);
}
function busy(it) {
  const rid = runs.runningTaskId;
  if (!rid) return false;
  const ids = it.kind === 'tasks'
    ? (it.id === 'all' ? tasks.tasks.map((t) => t.id) : tasks.tasks.filter((t) => t.group === it.id).map((t) => t.id))
    : [];
  return ids.includes(rid);
}

/**
 * 深链/刷新进入某子页时，自动**展开**其所属父级导航（避免子项不可见）。
 *
 * 只展开、不收起：互斥是用户主动点击父项时（onParent）才发生的语义，
 * 路由变化不应把用户手动展开的分组收起来（例如在首页展开「数据看板」后
 * 点进「标准达成」，该分组必须保持展开）。
 */
function ensureActiveParents() {
  navItems.value.forEach((it) => {
    if (it.type === 'parent' && parentOn(it) && !open(it)) {
      app.setNavOpen(it.key, true);
    }
  });
}
watch(() => route.fullPath, ensureActiveParents, { immediate: true });
</script>

<style scoped>
.side { padding: var(--sp-12) var(--sp-8); display: flex; flex-direction: column; gap: 2px; }
.nv, .nv-sub {
  display: flex; align-items: center; gap: var(--sp-10);
  padding: var(--sp-10) var(--sp-12);
  border-radius: var(--r-xl);
  color: var(--text-body); cursor: pointer;
  text-decoration: none; font-size: var(--fs-control);
  position: relative;
}
.nv:hover, .nv-sub:hover { background: var(--surface-sunken); color: var(--text); }
.nv.on, .nv-sub.on { background: var(--brand-soft); color: var(--brand); font-weight: var(--fw-semibold); }
.nv .ic, .nv-sub .ic { font-size: 17px; }
.nv .nm, .nv-sub .nm { flex: 1; }
.nv .ct, .nv-sub .ct {
  font-size: 11px; color: var(--muted); background: var(--surface-sunken);
  padding: 1px var(--sp-8); border-radius: var(--r-pill); min-width: 20px; text-align: center;
}
.nv-sub { padding-left: var(--sp-32); font-size: var(--fs-body); }
.nv-parent { font-weight: var(--fw-semibold); }
.nv-parent .nv-arw { transition: transform 0.18s ease; color: var(--muted); }
.nv-parent.open .nv-arw { transform: rotate(90deg); }
.nv-parent.parent-on { color: var(--brand); }
/* 手风琴折叠动画：用 grid-template-rows 0fr→1fr 过渡到「内容真实高度」，
   无需知道子项数量（任务中心分组数不定）。旧浏览器不支持插值时仍能正常折叠，只是无动画。 */
.nv-subs-wrap { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.22s ease; }
.nv-subs-wrap.open { grid-template-rows: 1fr; }
.nv-subs { overflow: hidden; min-height: 0; display: flex; flex-direction: column; gap: 2px; margin: 0; }
.nv-subs-wrap.open .nv-subs { margin: 2px 0 var(--sp-4); }
.nv-dot--busy {
  position: absolute; right: var(--sp-10); top: 50%; transform: translateY(-50%);
  width: 7px; height: 7px; border-radius: 50%; background: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-soft);
}
</style>
