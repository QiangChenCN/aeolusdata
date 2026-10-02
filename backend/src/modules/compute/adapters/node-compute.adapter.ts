import { Injectable } from '@nestjs/common';
import {
  ComputePort,
  ComputeTaskInput,
  ComputeResult,
  ProxyRequest,
} from '../compute.port';

/**
 * 当前默认实现：在 Node 进程内就地计算（轻计算阶段）。
 * 受控计算（run）可在此实现；Python 生态独占端点（proxy）在 Node 模式下不支持，
 * 返回 NEED_PYTHON，提示切到 python 模式。
 */
@Injectable()
export class NodeComputeAdapter implements ComputePort {
  async run(input: ComputeTaskInput): Promise<ComputeResult> {
    // TODO: 在此实现 Node 侧轻计算逻辑。
    return { ok: true, data: { echoed: input, engine: 'node' } };
  }

  async proxy(_req: ProxyRequest): Promise<ComputeResult> {
    return {
      ok: false,
      code: 'NEED_PYTHON',
      error: '该端点依赖 Python 生态，请将 COMPUTE_PROVIDER 切换为 python',
    };
  }
}
