import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTasksStore } from '../../../src/stores/tasks.js';

// tasks store：任务注册表 + 参数偏好（localStorage 持久）。
// 偏好读写与列表筛选/排序是纯逻辑，最适合单元覆盖。
beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
});

describe('tasks store 参数偏好', () => {
  it('argValue 缺省回退到默认值', () => {
    const s = useTasksStore();
    expect(s.argValue('t1', 'begin', 'B')).toBe('B');
  });

  it('setArg 写入并持久化到 localStorage', () => {
    const s = useTasksStore();
    s.setArg('t1', 'begin', '2020-01-01');
    expect(s.argValue('t1', 'begin')).toBe('2020-01-01');
    expect(JSON.parse(localStorage.getItem('wb_fengshen_hub_v1'))).toEqual({
      t1: { begin: '2020-01-01' },
    });
  });

  it('resetArgs 清除任务参数使其回退默认', () => {
    const s = useTasksStore();
    s.setArg('t1', 'begin', 'x');
    s.resetArgs('t1');
    expect(s.args.t1).toBeUndefined();
  });
});

describe('tasks store 列表筛选 / 排序', () => {
  it('按关键字、分组、状态过滤与排序', () => {
    const s = useTasksStore();
    s.registry = {
      groups: [{ id: 'g1' }],
      tasks: [
        { id: 'a', name: '采集', group: 'g1', status: 'success', tags: [] },
        { id: 'b', name: '报表', group: 'g1', status: 'running', tags: [] },
        { id: 'c', name: '考核', group: 'g2', status: 'failed', tags: [] },
      ],
    };

    expect(s.visibleTasks({ q: '采集' })).toHaveLength(1);
    expect(s.visibleTasks({ group: 'g1' })).toHaveLength(2);

    // 状态排序权重：running(0)/queued(1)/stopped(1)/failed(2)/success(3)
    const byStatus = s.visibleTasks({ filter: 'status' }).map((t) => t.id);
    expect(byStatus).toEqual(['b', 'c', 'a']); // running, failed, success

    // 名称中文排序：报表 < 采集 < 考核
    const byName = s.visibleTasks({ filter: 'name' }).map((t) => t.id);
    expect(byName).toEqual(['b', 'a', 'c']);
  });
});
