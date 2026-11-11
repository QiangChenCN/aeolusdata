import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ComputePort,
  ComputeTaskInput,
  ComputeResult,
  ProxyRequest,
} from '../compute.port';

/**
 * 计算端口的唯一实现：HTTP 转发独立 FastAPI 计算服务（ADR-2026-09-20 的"Python 接管"路线）。
 * 重计算一律下沉 8900；Nest 侧只做取数/轻计算/编排/权限闸门。
 */
@Injectable()
export class PythonComputeAdapter implements ComputePort {
  constructor(private readonly config: ConfigService) {}

  async run(input: ComputeTaskInput): Promise<ComputeResult> {
    return this.forward('/compute', 'POST', input);
  }

  async proxy(req: ProxyRequest): Promise<ComputeResult> {
    // 必须把 headers（x-scope / x-user）透传给 forward，否则数据权限头会在 Nest 侧算好
    // 却被丢弃，Python 侧拿到默认的 '*' 而返回全量数据（行级隔离失效）。
    return this.forward(req.endpoint, req.method, req.body, true, req.headers);
  }

  private async forward(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    rawPath = false,
    headers?: Record<string, string>,
  ): Promise<ComputeResult> {
    const base = this.config.get<string>('PYTHON_COMPUTE_URL');
    if (!base) {
      return { ok: false, error: 'PYTHON_COMPUTE_URL not configured' };
    }
    const url = rawPath ? `${base}${path}` : `${base}${path}`;
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', ...(headers || {}) },
        body: method === 'POST' && body != null ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text || undefined;
      }
      if (!res.ok) {
        // 保留上游状态码与响应体（如 403 + {code:"DATA_SCOPE_DENIED"}），交由
        // ProxyController 原样透传；不要让 4xx 被折叠成 200。
        return {
          ok: false,
          error: `upstream responded ${res.status}`,
          data,
          status: res.status,
        };
      }
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
