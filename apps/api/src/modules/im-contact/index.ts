/**
 * IM 电联看板的**公开面**（barrel）。
 *
 * 约定（由 `apps/api/scripts/check-arch.mjs` 的 R1 / R6 强制）：其它模块要用到本看板的能力时，
 * 只能从这里（或装配体 `im-contact.module.ts`）导入，**不得**深引内部的
 * service / controller 实现文件。
 *
 * 当前消费者：`ProxyController`（`im-contact/{*path}` 通配在命中配置端点时改派配置服务）。
 * 新增导出前先问一句：是不是真的需要跨看板？—— 跨看板即共享，共享即耦合。
 */
export { ImContactConfigService } from './im-contact-config.service';
export { ImContactFetchService } from './im-contact-fetch.service';
export { ImContactModule } from './im-contact.module';
