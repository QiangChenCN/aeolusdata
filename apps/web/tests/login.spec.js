import { test, expect } from '@playwright/test';

// 登录页是 SSO 入口的承载处，且「钉钉扫码登录」按钮由后端 SSO 配置开关控制。
// 这条链路「一改就崩」——配置开关接线一旦失效，用户就再也看不到钉钉登录入口。
test('账密登录表单渲染', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByText('用户名')).toBeVisible();
  await expect(page.getByText('密码')).toBeVisible();
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
});

test('钉钉 SSO 入口受配置开关控制', async ({ page }) => {
  // 默认（无后端 / SSO 未启用）：不显示钉钉扫码登录按钮
  await page.goto('/login');
  await expect(page.getByRole('button', { name: '使用钉钉扫码登录' })).toHaveCount(0);

  // 后端返回 enabled:true 时，SSO 入口应出现（验证开关接线正确）
  await page.route('**/api/auth/dingtalk/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        corpId: 'test-corp',
        authorizeUrl: 'https://login.dingtalk.com/oauth2/auth?...',
      }),
    }),
  );
  await page.goto('/login');
  await expect(page.getByRole('button', { name: '使用钉钉扫码登录' })).toBeVisible();
});
