import { test, expect } from '@playwright/test';

// 钉钉设置页是「一改就崩且难自测」的典型：藏在登录守卫之后，且承载 SSO / DWS 大量配置项。
// 真实 SSO 需要后端 + 钉钉凭证，这里用 page.route 模拟已登录会话与各接口的 benign 响应，
// 让页面能正常渲染，从而验证「登录守卫放行 + 页面与 SSO 配置表单渲染」这条链路。
test.beforeEach(async ({ page }) => {
  // 已登录会话：守卫据此放行
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { username: 'admin' },
        role: 'admin',
        name: 'Admin',
        avatar: null,
        phone: null,
        email: null,
      }),
    }),
  );
  // 其余钉钉相关接口返回无害默认值，避免页面报错（不影响关键表单渲染）
  await page.route('**/api/ding/auth/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { authenticated: false, profile: {} } }),
    }),
  );
  await page.route('**/api/ding/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [] } }),
    }),
  );
  await page.route('**/api/auth/dingtalk/sso-config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          enabled: false,
          appKey: '',
          appSecretSet: false,
          corpId: '',
          oauthRedirectUri: '',
          frontendUrl: '',
        },
      }),
    }),
  );
});

test('已登录可进入钉钉设置页并渲染 SSO 配置表单', async ({ page }) => {
  await page.goto('/settings/dingtalk');
  // 守卫放行：停留在钉钉设置页而非跳登录
  await expect(page).toHaveURL(/\/settings\/dingtalk/);

  // 收敛到页面容器 .dt，避免与侧边栏同名菜单项触发严格模式冲突
  const dt = page.locator('.dt');
  await expect(dt).toBeVisible();
  await expect(dt.getByText('钉钉设置')).toBeVisible();

  // SSO 配置卡片（关键配置项：AppKey / AppSecret / OAuth2 回跳地址）
  await expect(dt.getByText('钉钉单点登录', { exact: false })).toBeVisible();
  await expect(dt.getByText('AppKey')).toBeVisible();
  await expect(dt.getByText('OAuth2 回跳地址')).toBeVisible();
});
