import { AEOLUS_MONOREPO_NAME } from '@aeolus/shared';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus, { ElMessage, ElNotification } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';

import App from './App.vue';
import router from './router';
import './styles/element-overrides.css';
import './styles/base.css';
import './styles/responsive.css';

// 跨应用共享包（workspace 依赖）冒烟：确认 @aeolus/shared 在 web 侧可被解析与打包
console.log(`[shared] monorepo name = ${AEOLUS_MONOREPO_NAME}`);

// ---- OpenTelemetry（前端侧，默认关闭，由 VITE_OTEL_ENABLED 控制）----
// 动态 import 使 otel 代码独立成 chunk：关闭时不加载，也不影响首屏。
// 浏览器→Nest 同源（/api），traceparent 同源不视为敏感头，注入无障碍；跨域部署时
// 需在 Collector 放开 CORS 并对 FetchInstrumentation.propagateTraceHeaderCorsUrls 配白名单。
function initOtel() {
  if (import.meta.env.VITE_OTEL_ENABLED !== 'true') return;
  Promise.all([
    import('@opentelemetry/sdk-trace-web'), // 同时导出 WebTracerProvider 与 BatchSpanProcessor
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/instrumentation-fetch'),
    import('@opentelemetry/instrumentation'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/context-zone'),
  ])
    .then(
      ([
        { WebTracerProvider, BatchSpanProcessor },
        { OTLPTraceExporter },
        { FetchInstrumentation },
        { registerInstrumentations },
        { Resource },
        { ZoneContextManager },
      ]) => {
        const provider = new WebTracerProvider({
          resource: new Resource({ 'service.name': 'aeolus-web' }),
        });
        provider.addSpanProcessor(
          new BatchSpanProcessor(
            new OTLPTraceExporter({ url: import.meta.env.VITE_OTEL_COLLECTOR }),
          ),
        );
        provider.register({ contextManager: new ZoneContextManager() });
        registerInstrumentations({
          instrumentations: [
            new FetchInstrumentation({ propagateTraceHeaderCorsUrls: [/.+/] }),
          ],
        });
      },
    )
    .catch((e) => console.warn('[otel] init failed', e));
}
initOtel();

const app = createApp(App);

// 全量注册 Element Plus 图标，组件内可直接 <el-icon><IconName/></el-icon>
for (const [key, comp] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, comp);
}

app.use(createPinia());
app.use(router);
// 中文语言包：月份选择器等组件显示中文（Jan → 1月）
app.use(ElementPlus, { locale: zhCn });

// 全局暴露 ElMessage / ElNotification：大量历史代码以「裸标识符」调用（未逐文件 import），
// 若缺失会在运行时抛 ReferenceError —— 典型表现：操作已成功（API 先执行）却无提示、弹窗不关闭。
// ES 模块严格模式下，裸标识符会沿作用域链解析到全局对象属性，故挂到 window 即可让所有裸调用生效。
window.ElMessage = ElMessage;
window.ElNotification = ElNotification;

// 全局错误兜底：让失败可见（原 main.js 同款处理）
window.addEventListener('error', (e) => {
  console.error('[未捕获异常]', e.message, (e.error && e.error.stack) || e.error || '');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[未处理的 Promise 拒绝]', (e.reason && e.reason.stack) || e.reason);
});

// 等初始导航完成（含鉴权守卫里的 /auth/me 会话校验）后再挂载 App。
// 否则 App.vue 会先于守卫完成就挂载并读取登录态，产生「刷新即跳登录页」的竞态。
router.isReady().then(() => {
  app.mount('#app');
});
