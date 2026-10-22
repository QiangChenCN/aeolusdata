import { defineConfig, devices } from '@playwright/test';

// E2E 配置：用 `vite preview` 起一个静态托管的 SPA（与 Nest 生产托管同形态），
// 不依赖实时后端——登录态与钉钉相关接口由用例内的 page.route 拦截 mock。
// 覆盖的关键链路：路由守卫重定向、登录页/SSO 入口、钉钉设置页（已登录态渲染）。
export default defineConfig({
  testDir: './tests',
  // 仅把 E2E（*.spec.js）纳入 Playwright；Vitest 单元用例放在 tests/unit/*.test.js，
  // 既不匹配 testMatch，也被 testIgnore 显式排除，避免被 E2E runner 误当成 spec 执行。
  testMatch: '**/*.spec.js',
  testIgnore: ['**/unit/**', '**/node_modules/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // 先构建再预览；preview 为 SPA 形态，深层路由（如 /settings/dingtalk）自动回退 index.html。
    command: 'npm run build && npm run preview',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
