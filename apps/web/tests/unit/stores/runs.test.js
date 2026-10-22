import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRunsStore } from '../../../src/stores/runs.js';
import { useTasksStore } from '../../../src/stores/tasks.js';

// runs store：接收 /api/state 快照与 SSE 事件增量更新运行态。
// 注意 SSE 层会先把事件 payload 的 .run 解开再调 evRunStart/evRunEnd，
// 所以这两个 action 的入参直接是 run 对象（含 runId/taskId/status），
// 而 evRunLine 入参是 {run_id, line}，evQueue 入参是 [{runId,taskId}]。
// 纯状态归约，不依赖 DOM / 网络（syncLog 的 fetch 失败会被内部 catch 吞掉）。
beforeEach(() => {
  setActivePinia(createPinia());
});

describe('runs store', () => {
  it('applyState 装载快照并预填当前运行日志', () => {
    const s = useRunsStore();
    s.applyState({
      current: { runId: 'r1', taskId: 't1', name: '任务1', status: 'running' },
      current_lines: ['line1', 'line2'],
      queued_ids: ['t2'],
      history: [{ run_id: 'h1' }],
      last: { t1: { status: 'running' } },
      registry: { groups: [], tasks: [] },
    });
    // applyState 把 API 快照的 camelCase current 规整为内部形状 { task_id, run_id }，
    // 与 evRunStart 写入的形状保持一致（runningTaskId / evRunEnd 都依赖 task_id/run_id）
    expect(s.current).toEqual({ task_id: 't1', run_id: 'r1' });
    expect(s.runningTaskId).toBe('t1');
    expect(s.runs.r1.runId).toBe('r1');
    expect(s.runs.r1.lines).toEqual(['line1', 'line2']);
    expect(s.queuedIds).toEqual(['t2']);
    expect(s.history).toEqual([{ run_id: 'h1' }]);
    expect(s.last).toEqual({ t1: { status: 'running' } });
    // 回归：快照装载的当前运行结束后，evRunEnd 能按 run_id 匹配并清空 current
    s.evRunEnd({ runId: 'r1', taskId: 't1', status: 'success' });
    expect(s.current).toBeNull();
  });

  it('evRunStart 建立 run 并置为当前（action 入参即 run 对象）', () => {
    const s = useRunsStore();
    s.evRunStart({ runId: 'r2', taskId: 't2', status: 'running', lines: ['a'] });
    expect(s.runs.r2.run_id).toBe('r2');
    expect(s.runs.r2.task_id).toBe('t2');
    expect(s.runs.r2.lines).toEqual(['a']);
    expect(s.current).toEqual({ task_id: 't2', run_id: 'r2' });
  });

  it('evRunLine 增量追加日志行', () => {
    const s = useRunsStore();
    s.evRunStart({ runId: 'r3', taskId: 't3' });
    s.evRunLine({ run_id: 'r3', line: 'hello' });
    s.evRunLine({ run_id: 'r3', line: 'world' });
    expect(s.runs.r3.lines).toEqual(['hello', 'world']);
  });

  it('evRunEnd 更新状态并清空当前', () => {
    const s = useRunsStore();
    s.evRunStart({ runId: 'r4', taskId: 't4', status: 'running' });
    s.evRunEnd({ runId: 'r4', taskId: 't4', status: 'success' });
    expect(s.runs.r4.status).toBe('success');
    expect(s.current).toBeNull();
  });

  it('evQueue 提取排队 taskId 列表', () => {
    const s = useRunsStore();
    s.evQueue([{ runId: 'r5', taskId: 't5' }, { runId: 'r6', taskId: 't6' }]);
    expect(s.queuedIds).toEqual(['t5', 't6']);
  });

  it('runningTaskId getter 反映当前任务', () => {
    const s = useRunsStore();
    expect(s.runningTaskId).toBeNull();
    s.evRunStart({ runId: 'r7', taskId: 't7', status: 'running' });
    expect(s.runningTaskId).toBe('t7');
  });

  it('与 tasks store 协同：evRunStart 同步任务状态', () => {
    const s = useRunsStore();
    const tasks = useTasksStore();
    tasks.registry = { groups: [], tasks: [{ id: 't8', name: 'x', group: 'g', status: 'queued' }] };
    s.evRunStart({ runId: 'r8', taskId: 't8', status: 'running' });
    expect(tasks.taskById('t8').status).toBe('running');
  });
});
