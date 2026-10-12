import { useAppStore } from '../stores/app.js';
import { useRunsStore } from '../stores/runs.js';
import { useTasksStore } from '../stores/tasks.js';
import { getBearerToken } from '../api/request.js';

// SSE 实时事件：连接 / 指数退避重连 / 事件分发到 stores
export function useSse() {
  let es = null;
  let reconnectDelay = 1000;
  const app = useAppStore();
  const runs = useRunsStore();
  const tasks = useTasksStore();

  function connect() {
    if (es) return;
    // 同源 EventSource 自动携带会话 Cookie；跨站 iframe 下 Cookie 可能被拦，
    // 此时改用 ?token= 查询参数携带 X-Token（extractToken 已支持）。
    let url = '/api/events';
    const tk = getBearerToken();
    if (tk) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tk);
    es = new EventSource(url);

    es.onopen = () => { app.setConnected(true); app.setSseBroken(false); reconnectDelay = 1000; };
    es.onerror = () => {
      app.setConnected(false); app.setSseBroken(true);
      try { es.close(); } catch (e) { /* ignore */ }
      es = null;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    };

    const on = (type, fn) =>
      es.addEventListener(type, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { /* ignore */ } });

    // 后端事件形态（迁移不变量，见 task-runner.service.ts）：
    //   run_start / run_end  → { type, run:{runId,taskId,status,...} }
    //   log                  → { type, run_id, line, ts }
    //   history / queue      → { type, history:[...] } / { type, queue:[...] }
    on('state', (d) => { if (d.registry) tasks.registry = d.registry; runs.evState(d); });
    on('run_start', (d) => runs.evRunStart(d.run));
    on('log', (d) => runs.evRunLine(d));
    on('run_end', (d) => runs.evRunEnd(d.run));
    on('history', (d) => runs.evHistory(d.history));
    on('queue', (d) => runs.evQueue(d.queue));
  }

  function stop() { if (es) { es.close(); es = null; } }
  return { connect, stop };
}
