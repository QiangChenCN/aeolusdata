/**
 * 配送超时看板的**公开面**（barrel）。
 *
 * 约定（见 `apps/api/scripts/check-arch.mjs` 的 R1 规则）：其它模块要用到本看板的能力时，
 * 只允许 `import { ... } from '.'`（本文件）或装配体
 * `delivery-timeout.module.ts`，**不得**深引内部的 service / controller 实现文件。
 * 目的：把「改内部实现会不会波及别人」这件事变成编译期就能看出来的东西 ——
 * 本看板的取数、落库、路由都可以随意重构，只要公开面不变，外部就不受影响。
 */
export { DeliveryTimeoutConfigService } from './delivery-timeout-config.service';
export { DeliveryTimeoutRefreshService } from './delivery-timeout-refresh.service';
export { DeliveryTimeoutOrdersStoreService } from './delivery-timeout-orders-store.service';
export type { DeliveryTimeoutRefreshResult } from './delivery-timeout-refresh.service';
