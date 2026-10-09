import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';

import App from './App.vue';
import router from './router';
import './styles/element-overrides.css';
import './styles/base.css';

const app = createApp(App);

// 全量注册 Element Plus 图标，组件内可直接 <el-icon><IconName/></el-icon>
for (const [key, comp] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, comp);
}

app.use(createPinia());
app.use(router);
// 中文语言包：月份选择器等组件显示中文（Jan → 1月）
app.use(ElementPlus, { locale: zhCn });

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
