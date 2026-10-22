import { test, expect } from '@playwright/test';

// 未登录时，所有受保护路由都应被全局前置守卫重定向到 /login（并保留来源）。
// 这是「一改就崩且难自测」的链路：守卫逻辑或 bootstrap 判定一旦出错，整站会无限跳登录。
const PROTECTED = [
  '/tasks',
  '/assessment',
  '/settings/dingtalk',
  '/settings/rbac/users',
  '/overview',
];

test.describe('路由守卫', () => {
  for (const path of PROTECTED) {
    test(`未登录访问 ${path} 重定向到 /login`, async ({ page }) => {
      await page.goto(path);
      await page.waitForURL('**/login');
      expect(page.url()).toContain('/login');
    });
  }

  test('重定向保留原始目标到 redirect 参数', async ({ page }) => {
    await page.goto('/settings/dingtalk');
    await page.waitForURL('**/login');
    expect(new URL(page.url()).searchParams.get('redirect')).toBe('/settings/dingtalk');
  });
});

test('公开路由 /login 可访问并渲染登录卡片', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('.login-card')).toBeVisible();
});
