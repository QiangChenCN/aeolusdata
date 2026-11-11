import { Module } from '@nestjs/common';
import { COMPUTE_PORT } from './compute.port';
import { ComputeService } from './compute.service';
import { PythonComputeAdapter } from './adapters/python-compute.adapter';

/**
 * 计算端口唯一实现 = PythonComputeAdapter（HTTP 转发 8900 计算服务）。
 *
 * 历史：曾有 NodeComputeAdapter + COMPUTE_PROVIDER 环境变量做 DI 层切换，
 * 但 node 模式下 proxy 端点恒返回 NEED_PYTHON（这些端点依赖 aeolus_sdk /
 * pandas / openpyxl，Node 侧本无对应生态），run() 通道也零调用点，
 * 该开关纯属误导（2026-11-11 线上即因服务器 .env 残留 COMPUTE_PROVIDER=node
 * 导致考核看板报错）。已移除，分工固定为：Nest 做取数/轻计算/编排/权限闸门，
 * 重计算一律下沉 Python（ADR-2026-09-20）。
 */
@Module({
  providers: [ComputeService, PythonComputeAdapter, { provide: COMPUTE_PORT, useClass: PythonComputeAdapter }],
  exports: [ComputeService, COMPUTE_PORT],
})
export class ComputeModule {}
