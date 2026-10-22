// 配送超时看板的公开面：外部（路由/其它页面）只从这里导入。
// 与后端 modules/<board>/index.ts 同约定 —— 见 apps/web/scripts/check-arch.mjs。
export { default as DeliveryTimeoutView } from './DeliveryTimeoutView.vue';
export { useDeliveryTimeout } from './useDeliveryTimeout.js';
