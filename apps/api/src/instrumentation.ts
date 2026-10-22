/**
 * OpenTelemetry 插桩引导（NestJS 侧）。
 *
 * 必须在本文件里、且早于 NestFactory.create 执行 —— 故 main.ts 把本文件作为「第一个」import。
 * 默认关闭（OTEL_ENABLED !== 'true' 时整个模块是 no-op），上线/本地默认零影响。
 *
 * 自动插桩覆盖（来自 @opentelemetry/auto-instrumentations-node）：
 *  · @opentelemetry/instrumentation-express  → 每个入站 HTTP 请求一个 span
 *  · @opentelemetry/instrumentation-undici   → 全局 fetch（转发到 8900 计算服务）自动注入 traceparent，
 *                                             Nest→Python 链路因此天然贯通，无需手写透传
 *  · @opentelemetry/instrumentation-pg       → 每条 SQL 一个子 span（直接看到慢查询）
 *
 * 三端都用 W3C Trace Context 作为默认传播协议，浏览器→Nest→Python 自动串成一条 trace。
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const enabled = process.env.OTEL_ENABLED === 'true';

if (enabled) {
  const sdk = new NodeSDK({
    // serviceName 选项会自动构建 resource（避免直接依赖 @opentelemetry/resources 的版本线分歧）
    serviceName: process.env.OTEL_SERVICE_NAME || 'aeolus-api',
    traceExporter: new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317',
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // 文件系统 span 极噪且价值低，关掉
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  sdk.start();
}

export {};
