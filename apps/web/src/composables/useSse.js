import { useAppStore } from '../stores/app.js';
import { useRunsStore } from '../stores/runs.js';
import { useTasksStore } from '../stores/tasks.js';
import { getBearerToken } from '../api/request.js';

// 超过这个时间没收到任何事件（含服务端 15s 心跳 ping）→ 判定事件流半开 / 服务端假死。
// 取心跳间隔的 3 倍：容忍一次丢包 + 一次网络抖动，不至于误判。
const STALE_MS = 45_000;
// 看门狗巡查间隔（只做本地判断，不发请求）
const WATCH_MS = 5_000;
// 健康探测间隔与超时：SSE 只能证明"事件流通"，证明不了"后端还能应答"，
// 这里用 /api/health 兜底，把「后端挂了」与「仅事件流断开」区分开。
// 10s 是为了让 Python / worker 的状态尽快可见（探测本身只是一次 PG count + 一次本地 HTTP）。
const HEALTH_MS = 10_000;
const HEALTH_TIMEOUT_MS = 5_000;
// EventSource.OPEN（不用全局常量：SSR / 非浏览器环境没有 EventSource）
const ES_OPEN = 1;

// SSE 实时事件：连接 / 指数退避重连 / 心跳看门狗 / 健康探测 / 事件分发到 stores
export function useSse() {
  let es = null;
  let reconnectDelay = 1000;
  let lastEventAt = 0;
  let watchTimer = null;
  let healthTimer = null;
  const app = useAppStore();
  const runs = useRunsStore();
  const tasks = useTasksStore();

  function connect() {
    if (es) return;
    startTimers();
    // 同源 EventSource 自动携带会话 Cookie；跨站 iframe 下 Cookie 可能被拦，
    // 此时改用 ?token= 查询参数携带 X-Token（extractToken 已支持）。
    let url = '/api/events';
    const tk = getBearerToken();
    if (tk) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tk);
    es = new EventSource(url);

    es.onopen = () => {
      lastEventAt = Date.now();
      app.setConnected(true);
      app.setSseStale(false);
      app.setSseBroken(false);
      reconnectDelay = 1000;
    };
    es.onerror = () => {
      app.setSseBroken(true);
      try { es.close(); } catch (e) { /* ignore */ }
      es = null;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      // SSE 断了 ≠ 后端挂了：立刻探测一次，避免把「事件流重连中」误报成「后端已断开」，
      // 也避免后端真挂了时胶囊还停留在上一次的 true（旧逻辑的主要缺陷）。
      refreshStatus();
    };
    // 兜底：未命名帧（服务端未带 type 时）也刷新"最后活跃时间"
    es.onmessage = () => { touch(); };

    const on = (type, fn) =>
      es.addEventListener(type, (e) => {
        touch();
        try { fn(JSON.parse(e.data)); } catch (err) { /* ignore */ }
      });

    // 后端事件形态（迁移不变量，见 task-runner.service.ts）：
    //   run_start / run_end  → { type, run:{runId,taskId,status,...} }
    //   log                  → { type, run_id, line, ts }
    //   history / queue      → { type, history:[...] } / { type, queue:[...] }
    // 心跳帧（服务端 15s 一发）：只刷新活跃时间，watchdog 靠它判断连接是否真的活着
    on('ping', () => { /* 已在 on() 内 touch */ });
    on('state', (d) => { if (d.registry) tasks.registry = d.registry; runs.evState(d); });
    on('run_start', (d) => runs.evRunStart(d.run));
    on('log', (d) => runs.evRunLine(d));
    on('run_end', (d) => runs.evRunEnd(d.run));
    on('history', (d) => runs.evHistory(d.history));
    on('queue', (d) => runs.evQueue(d.queue));

    // 立即探一次：否则 Python / worker 的状态要等下一个探测周期（10s）才出现，
    // 打开页面后胶囊会先显示一整段「未知」。
    void refreshStatus();
  }

  /** 标记为刚收到数据；若此前被判为静默，收到数据即恢复。 */
  function touch() {
    lastEventAt = Date.now();
    if (app.sseStale && es && es.readyState === ES_OPEN) app.setSseStale(false);
  }

  /** 事件流是否"真活着"：连接 OPEN 且近期有帧到达（含心跳）。
   *  尚未收到任何帧（连接刚建立、还没到一个心跳周期）不算静默，避免首探误标"重连中"。 */
  function streamHealthy() {
    if (!es || es.readyState !== ES_OPEN) return false;
    if (!lastEventAt) return true;
    return Date.now() - lastEventAt < STALE_MS;
  }

  /** 探测后端可达性并据此刷新胶囊状态（含后端代探的 Python / worker 状态）。 */
  async function refreshStatus() {
    const r = await probeHealth();
    if (!r.ok) {
      // 后端不可达：权威判据，直接判红（旧逻辑在这里会一直显示"已连接"）
      app.setConnected(false);
      app.setSseStale(false);
      app.setServices(null);
      return false;
    }
    app.setConnected(true);
    app.setSseStale(!streamHealthy());
    if (r.services) app.setServices(r.services);
    return true;
  }

  async function probeHealth() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    try {
      const headers = {};
      const tk = getBearerToken();
      if (tk) headers['X-Token'] = tk; // 跨站 iframe 下 Cookie 被拦时的会话兜底
      const res = await fetch('/api/health', {
        method: 'GET',
        headers,
        signal: ctrl.signal,
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) return { ok: false, services: null };
      // 后端顺带把 Python / worker 的探测结果带回来（前端无法直连 8900）
      const data = await res.json().catch(() => null);
      return { ok: true, services: (data && data.services) || null };
    } catch (e) {
      return { ok: false, services: null }; // 网络错误 / 超时 都算不可达
    } finally {
      clearTimeout(timer);
    }
  }

  function startTimers() {
    if (watchTimer) return;
    watchTimer = setInterval(() => {
      // 半开连接：TCP 还开着但服务端不再推送（进程假死、代理缓冲、NAT 静默断连）。
      // 浏览器不会报错，只能靠"多久没收到帧"发现 —— 强制重建。
      if (es && lastEventAt && Date.now() - lastEventAt > STALE_MS) {
        app.setSseStale(true);
        try { es.close(); } catch (e) { /* ignore */ }
        es = null;
        connect();
      }
    }, WATCH_MS);
    healthTimer = setInterval(refreshStatus, HEALTH_MS);
  }

  function stop() {
    if (es) { try { es.close(); } catch (e) { /* ignore */ } es = null; }
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  }
  return { connect, stop, refreshStatus };
}
