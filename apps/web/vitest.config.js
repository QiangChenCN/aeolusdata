import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// Vitest 配置（与 vite.config.js 平行，root 仍为 web/）。
// 只覆盖「开发期秒级反馈、CI 成本低」的单元层：工具函数 / store / 组件渲染。
// E2E 仍由 Playwright 负责（见 playwright.config.js，其 testDir=tests，本配置 exclude 掉 tests/unit）。
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/unit/setup.js'],
    include: ['tests/unit/**/*.test.js'],
    css: false,
    clearMocks: true,
    // @aeolus/shared 是 workspace 预构建包，交给 Vite 直接转换（不进 optimizeDeps 预打包），
    // 避免 CJS/ESM 互操作问题。
    server: { deps: { inline: ['@aeolus/shared'] } },
  },
});
