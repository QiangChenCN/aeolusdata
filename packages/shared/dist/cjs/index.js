"use strict";
/**
 * @aeolus/shared —— 跨应用共享代码包。
 *
 * apps/api（NestJS 后端）与 apps/web（Vue 前端）的公共常量 / 工具在此定义，
 * 以 workspace 依赖（"@aeolus/shared": "workspace:*"）方式被两者引用，避免重复定义与漂移。
 *
 * 接入方式（在 apps/api 或 apps/web 的 package.json 中）：
 *   "dependencies": { "@aeolus/shared": "workspace:*" }
 * 然后：
 *   import { AEOLUS_MONOREPO_NAME, sleep } from '@aeolus/shared';
 *
 * 本包以 CommonJS 产物（dist/index.js + .d.ts）对外，NestJS（CJS）与 Vite（CJS 互操作）均可直接消费。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AEOLUS_MONOREPO_NAME = void 0;
exports.sleep = sleep;
exports.greet = greet;
/** 仓库 / 产品统一名（跨端保持一致，避免各处硬编码）。 */
exports.AEOLUS_MONOREPO_NAME = 'aeolusdata';
/** Promise 化的 setTimeout，跨端通用的「等待」工具。 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** 简单问候（示例导出，便于验证跨包引用）。 */
function greet(scope) {
    return `[${exports.AEOLUS_MONOREPO_NAME}] hello from ${scope}`;
}
//# sourceMappingURL=index.js.map