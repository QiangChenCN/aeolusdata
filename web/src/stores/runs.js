import { defineStore } from 'pinia';
import { fetchLog, fetchArtifacts, runTask as apiRun, stopRun as apiStop } from '../api/runs.js';
import { useTasksStore } from './tasks.js';

// 运行记录 / 实时日志 / 产物：接收 SSE 事件增量更新
export const useRunsStore = defineStore('runs', {
  state: () => ({
    runs: {},        // run_id -> { run_id,task_id,name,cmd,status,lines,startedAt,error_kind,error_advice }
    current: null,   // { task_id, run_id }
    queuedIds: [],
    history: [],
    last: null,
    modalRunId: null,
    modalTaskId: null,
    modalAutoScroll: true,
  }),
  getters: {
    runningTaskId: (s) => (s.current ? s.current.task_id : null),
    modalRun: (s) => (s.modalRunId ? s.runs[s.modalRunId] : null),
  },
  actions: {
    applyState(data) {
      if (data.registry) useTasksStore().registry = data.registry;
      // /api/state 快照字段名（与单体契约一致）
      this.current = data.current || null;
      this.queuedIds = data.queued_ids || [];
      this.history = data.history || [];
      this.last = data.last || null;
      // 若启动时有正在跑的任务，预填 runs 映射，便于日志弹窗直接回看
      if (data.current && data.current.runId) {
        this.runs[data.current.runId] = Object.assign({}, data.current, {
          lines: data.current_lines || data.current.lines || [],
        });
      }
    },
    // SSE: { type:'run_start', run:{runId,taskId,status,name,lines,...} }
    evRunStart(d) {
      const run = d || {};
      const cur = this.runs[run.runId] || {};
      this.runs[run.runId] = Object.assign({}, cur, run, {
        run_id: run.runId, task_id: run.taskId,
        lines: cur.lines || run.lines || [],
      });
      if (run.runId) this.current = { task_id: run.taskId, run_id: run.runId };
      if (run.taskId) useTasksStore().setTaskStatus(run.taskId, run.status || 'running');
    },
    // SSE: { type:'log', run_id, line }（注意是 run_id 而非 run.runId）
    evRunLine(d) {
      const rid = d.run_id;
      const r = this.runs[rid] || { run_id: rid, lines: [] };
      r.lines = r.lines || [];
      r.lines.push(d.line);
      this.runs[rid] = r;
    },
    // SSE: { type:'run_end', run:{runId,taskId,status,errorKind,errorAdvice} }
    evRunEnd(d) {
      const run = d || {};
      const rid = run.runId;
      const r = this.runs[rid];
      if (r) {
        r.status = run.status;
        r.errorKind = run.errorKind || null;
        r.errorAdvice = run.errorAdvice || null;
        this.runs[rid] = r;
      }
      if (this.current && this.current.run_id === rid) this.current = null;
      if (run.taskId) useTasksStore().setTaskStatus(run.taskId, run.status);
      // 回填：实时任务（SSE 增量推送）在末尾可能因快速完成而丢行，
      // 跑完后以服务端完整日志（/api/log 内存+落盘）为准补齐，避免「日志显示不全」。
      this.syncLog(rid);
    },
    // SSE: { type:'history', history:[...] }
    evHistory(history) { this.history = history || []; },
    // SSE: { type:'queue', queue:[{runId,taskId,name}] }
    evQueue(queue) { this.queuedIds = (queue || []).map((q) => q.taskId); },
    evState(data) { this.applyState(data); },
    openLog(runId) {
      if (!this.runs[runId]) {
        this.runs[runId] = {
          run_id: runId, task_id: null, name: '运行日志', status: 'queued',
          lines: ['已加入执行队列，等待脚本启动…'], cmd: '', startedAt: Date.now(),
        };
      }
      this.modalRunId = runId;
      const r = this.runs[runId];
      let tid = r.task_id;
      if (!tid) { const h = (this.history || []).find((x) => x.run_id === runId); tid = h ? h.task_id : null; }
      this.modalTaskId = tid;
      this.syncLog(runId);
    },
    closeLog() { this.modalRunId = null; this.modalTaskId = null; },
    // 弹窗日志兜底：拉一次；后续由 SSE 接管
    async syncLog(runId) {
      try {
        const res = await fetchLog(runId);
        if (!res || !res.ok) return;
        const cur = this.runs[runId] || {
          run_id: runId, task_id: null, name: '运行日志', status: 'running', lines: [], cmd: '', startedAt: Date.now(),
        };
        // 仅当服务端行数不少于本地才覆盖，避免极端情况下较短快照覆盖已收到的 SSE 行。
        cur.lines = (res.lines && res.lines.length >= cur.lines.length) ? res.lines : cur.lines;
        cur.status = res.status || cur.status;
        cur.error_kind = res.error_kind || cur.error_kind;
        cur.error_advice = res.error_advice || cur.error_advice;
        if (res.task_id) cur.task_id = res.task_id;
        if (res.name) cur.name = res.name;
        this.runs[runId] = cur;
      } catch (e) { /* 拉取失败不打断主流程 */ }
    },
    async run(taskId, args) {
      const res = await apiRun(taskId, args);
      // 后端返回 run_ids（数组），取首个；兼容旧的单 run_id 字段
      const rid = res && (res.run_id || (res.run_ids && res.run_ids[0])) || null;
      if (rid) this.openLog(rid);
      return res;
    },
    async stop(runId) { return apiStop(runId); },
    async artifacts(taskId) { return fetchArtifacts(taskId); },
  },
});
