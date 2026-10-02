import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { COMPUTE_PORT } from './compute.port';
import { ComputeService } from './compute.service';
import { NodeComputeAdapter } from './adapters/node-compute.adapter';
import { PythonComputeAdapter } from './adapters/python-compute.adapter';

@Module({
  providers: [
    ComputeService,
    NodeComputeAdapter,
    PythonComputeAdapter,
    {
      // 运行时按 COMPUTE_PROVIDER 切换实现；两个 Adapter 均由 Nest 构造（依赖正常注入）
      provide: COMPUTE_PORT,
      inject: [ConfigService, NodeComputeAdapter, PythonComputeAdapter],
      useFactory: (
        config: ConfigService,
        node: NodeComputeAdapter,
        python: PythonComputeAdapter,
      ) => (config.get<string>('COMPUTE_PROVIDER') === 'python' ? python : node),
    },
  ],
  exports: [ComputeService, COMPUTE_PORT],
})
export class ComputeModule {}
