import { describe, it, expect } from 'vitest';
import { navTo } from '../../src/utils/nav.js';

// navTo 是纯函数（不依赖 useRoute），映射任务中心侧栏 kind -> 路由路径。
// 这是前端路由导航的核心映射，回归它会直接暴露「点了菜单跳错页」。
describe('navTo', () => {
  const cases = [
    ['home', '/'],
    ['tasks', '/tasks'],
    ['history', '/history'],
    ['standard', '/standard'],
    ['attendPeriod', '/attend-period'],
    ['assessment', '/assessment'],
    ['timeout', '/timeout'],
    ['imContact', '/im-contact'],
    ['unsatisfied', '/unsatisfied'],
    ['cron', '/cron'],
    ['assessService', '/assess/service'],
    ['assessStandard', '/assess/standard'],
    ['rbac-users', '/settings/rbac/users'],
    ['rbac-roles', '/settings/rbac/roles'],
    ['rbac-policy', '/settings/rbac/policy'],
    ['rbac-pw', '/settings/rbac/pw'],
    ['rbac', '/settings/rbac'],
    ['profile', '/settings/profile'],
    ['bots', '/bot'],
    ['syscfg', '/settings'],
    ['sys-dingtalk', '/settings/dingtalk'],
    ['sys-aeolus', '/settings/aeolus'],
  ];

  it.each(cases)('kind=%s -> %s', (kind, expected) => {
    expect(navTo({ kind })).toBe(expected);
  });

  it('botcfg 带 id 拼接路径', () => {
    expect(navTo({ kind: 'botcfg', id: '42' })).toBe('/bot/42');
  });

  it('未知 kind 回落到首页', () => {
    expect(navTo({ kind: 'something-else' })).toBe('/');
  });
});
