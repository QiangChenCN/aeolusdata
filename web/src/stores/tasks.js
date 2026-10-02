import { defineStore } from 'pinia';
import { fetchState, fetchTeams } from '../api/tasks.js';

const PREFS_KEY = 'wb_fengshen_hub_v1'; // 沿用旧偏好键，兼容已有存档

// 任务注册表 + 参数偏好（localStorage 持久，键名兼容旧版）
export const useTasksStore = defineStore('tasks', {
  state: () => ({
    registry: { groups: [], tasks: [] },
    teams: { teams: [], source: '' },
    args: JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'),
    loaded: false,
  }),
  getters: {
    groups: (s) => s.registry.groups || [],
    tasks: (s) => s.registry.tasks || [],
    groupById: (s) => (id) => (s.registry.groups || []).find((g) => g.id === id),
    taskById: (s) => (id) => (s.registry.tasks || []).find((t) => t.id === id),
    countInGroup: (s) => (id) =>
      id === 'all' ? (s.registry.tasks || []).length
        : (s.registry.tasks || []).filter((t) => t.group === id).length,
    // 列表筛选/排序：group 过滤、关键字 q、filter(状态/名称/分组)、sortDir
    visibleTasks: (s) => (opt = {}) => {
      let list = s.registry.tasks || [];
      if (opt.group && opt.group !== 'all') list = list.filter((t) => t.group === opt.group);
      if (opt.q) {
        const q = String(opt.q).toLowerCase();
        list = list.filter((t) =>
          (t.name + ' ' + t.id + ' ' + (t.tags || []).join(' ')).toLowerCase().includes(q));
      }
      const f = opt.filter, dir = opt.sortDir || 'asc';
      const arr = list.slice();
      if (f === 'status') {
        const o = { running: 0, queued: 1, stopped: 1, failed: 2, success: 3 };
        arr.sort((a, b) => (o[a.status] ?? 9) - (o[b.status] ?? 9));
      } else if (f === 'name') arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
      else if (f === 'group') arr.sort((a, b) => (a.group || '').localeCompare(b.group || '', 'zh'));
      if (dir === 'desc') arr.reverse();
      return arr;
    },
  },
  actions: {
    argValue(taskId, key, def) {
      const a = this.args[taskId] || {};
      return a[key] !== undefined ? a[key] : def;
    },
    setArg(taskId, key, val) {
      this.args = Object.assign({}, this.args, {
        [taskId]: Object.assign({}, this.args[taskId], { [key]: val }),
      });
      this.persist();
    },
    /** 运行一次后清掉该任务的持久化参数，使其回到 tasks.json 的 default。
     *  满足「任务配置仅在本次运行中有效，运行后自动恢复默认」：
     *  删除键后 argValue 回退到 p.default（含 --begin/--end 节点区间）。 */
    resetArgs(taskId) {
      if (!this.args[taskId]) return;
      const next = Object.assign({}, this.args);
      delete next[taskId];
      this.args = next;
      this.persist();
    },
    persist() { localStorage.setItem(PREFS_KEY, JSON.stringify(this.args)); },
    async loadState() {
      const data = await fetchState();
      this.registry = data.registry || { groups: [], tasks: [] };
      this.loaded = true;
      return data;
    },
    async loadTeams() { try { this.teams = await fetchTeams(); } catch (e) { /* ignore */ } },
    setTaskStatus(taskId, status) {
      const t = (this.registry.tasks || []).find((x) => x.id === taskId);
      if (t) t.status = status;
    },
  },
});
