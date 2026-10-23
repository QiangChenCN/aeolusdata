import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkerHeartbeatService } from '../jobs/worker-heartbeat.service';

/** Python 探测超时：健康探测不能拖慢端点，也不能因上游假死把调用方挂住。 */
const PY_TIMEOUT_MS = 2500;
/** 探测结果短缓存：SSE 断连时可能并发触发多次探测，1s 内复用同一次结果。
 *  不能调大 —— 它直接决定「Python 挂了」多久能在界面上看到。 */
const CACHE_MS = 1000;

export interface ServiceState {
  ok: boolean;
  detail: string;
  [k: string]: unknown;
}

/**
 * 系统健康快照：后端自身 + Python 计算服务 + worker 进程。
 *
 * 前端「服务」胶囊据此显示：后端与 Python 任一挂 → 黄，两个都挂 → 红，全绿 → 绿；
 * worker 不参与配色（它不承载看板读请求），只在 tooltip 里如实展示 —— 它挂了的表现是
 * 「任务一直排队中」，而非看板打不开。
 *
 * 探测只做最轻量的事：Python 打它自己的 /api/health（不触发任何计算），
 * worker 读 `worker_heartbeat` 的 last_seen（不连 worker 进程本身）。
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private pyCache: { at: number; state: ServiceState } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly heartbeat: WorkerHeartbeatService,
  ) {}

  async snapshot() {
    const [python, worker] = await Promise.all([this.checkPython(), this.checkWorker()]);
    return {
      ok: true, // 能应答即后端活着
      ts: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      services: {
        api: { ok: true, detail: 'NestJS 8787 正常应答' } as ServiceState,
        python,
        worker,
      },
    };
  }

  async checkPython(): Promise<ServiceState> {
    const base = (this.config.get<string>('PYTHON_COMPUTE_URL') || '').replace(/\/+$/, '');
    if (!base) return { ok: false, detail: 'PYTHON_COMPUTE_URL 未配置', url: '' };

    const now = Date.now();
    if (this.pyCache && now - this.pyCache.at < CACHE_MS) return this.pyCache.state;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PY_TIMEOUT_MS);
    let state: ServiceState;
    try {
      const res = await fetch(`${base}/api/health`, { signal: ctrl.signal });
      state = res.ok
        ? { ok: true, detail: `${res.status} OK`, url: base }
        : { ok: false, detail: `HTTP ${res.status}`, url: base };
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? `探测超时（>${PY_TIMEOUT_MS}ms）` : (e as Error).message;
      state = { ok: false, detail: msg || '网络不可达', url: base };
    } finally {
      clearTimeout(timer);
    }
    this.pyCache = { at: now, state };
    return state;
  }

  async checkWorker(): Promise<ServiceState> {
    try {
      const p = await this.heartbeat.active();
      return {
        ok: p.count > 0,
        count: p.count,
        lastSeen: p.lastSeen,
        workers: p.workers,
        detail: p.count > 0 ? `${p.count} 个在线` : '无心跳（提交的任务会一直排队）',
      };
    } catch (e) {
      this.logger.warn(`worker 状态查询失败：${(e as Error).message}`);
      return { ok: false, count: 0, lastSeen: null, workers: [], detail: '心跳表不可用' };
    }
  }
}
