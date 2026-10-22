import { Injectable, Inject } from '@nestjs/common';
import {
  COMPUTE_PORT,
  ComputePort,
  ComputeTaskInput,
  ComputeResult,
  ProxyRequest,
} from './compute.port';
import { AppLogger } from '../../common/utils/logger.util';

@Injectable()
export class ComputeService {
  private readonly logger = new AppLogger(ComputeService.name);

  constructor(@Inject(COMPUTE_PORT) private readonly compute: ComputePort) {}

  async run(input: ComputeTaskInput): Promise<ComputeResult> {
    this.logger.log(`compute kind=${input.kind}`);
    return this.compute.run(input);
  }

  /** 透传 Python 生态独占端点（NestJS 侧前置 RBAC / 数据权限闸门后调用）。 */
  async proxy(req: ProxyRequest): Promise<ComputeResult> {
    return this.compute.proxy(req);
  }
}
