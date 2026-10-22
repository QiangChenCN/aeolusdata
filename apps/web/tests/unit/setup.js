// Vitest 全局 setup：让组件渲染测试能直接挂载 Element Plus 组件（与 main.js 生产装配一致）。
import { config } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';

// 全局注册 Element Plus + 中文语言包（月份选择器等显示中文），对齐 main.js 的 app.use(ElementPlus)。
config.global.plugins.push([ElementPlus, { locale: zhCn }]);
for (const [key, comp] of Object.entries(ElementPlusIconsVue)) {
  config.global.components[key] = comp;
}

// 生产代码里大量以「裸标识符」调用 ElMessage / ElNotification（挂在 window 上）。
// 测试环境补上占位，避免 ReferenceError。
globalThis.window.ElMessage = () => {};
globalThis.window.ElNotification = () => {};
