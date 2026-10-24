/**
 * 权限目录与路由→权限映射（端口自 core/auth.py 的 PERM_CATALOG / GET_ROUTE_PERMS /
 * POST_ROUTE_PERMS；原 Python 实现已删除，这里是唯一入口）。
 * 这是 RBAC 的"事实表"：路由命中映射即要求对应权限点，未命中默认要求最低 'view'（与旧 server 一致）。
 * 'self' 表示「已登录即可」（个人改密等）。
 */

export interface PermItem {
  perm: string;
  label: string;
  group: string;
}
export const PERM_CATALOG: PermItem[] = [
  { perm: 'view', label: '查看看板', group: '只读' },
  { perm: 'file:read', label: '读取文件/下载', group: '数据' },
  { perm: 'task:run', label: '执行任务', group: '操作' },
  { perm: 'data:refresh', label: '刷新数据', group: '操作' },
  { perm: 'cron:write', label: '编辑自动任务', group: '操作' },
  { perm: 'groups:write', label: '管理分组', group: '操作' },
  { perm: 'config:write', label: '修改系统配置', group: '配置' },
  { perm: 'realtime:targets', label: '考核目标配置', group: '配置' },
  { perm: 'admin:users', label: '账号管理', group: '管理' },
  { perm: 'admin:roles', label: '角色权限管理', group: '管理' },
  { perm: 'admin:policy', label: '密码策略管理', group: '管理' },
  { perm: 'admin:data-perm', label: '数据权限管理', group: '管理' },
  { perm: 'admin:bot', label: '机器人配置管理', group: '管理' },
  { perm: 'admin:aeolus', label: '风神账号配置', group: '管理' },
];
export const ALL_PERMS = new Set(PERM_CATALOG.map((p) => p.perm));

export const GET_ROUTE_PERMS: Record<string, string> = {
  '/api/file': 'file:read',
  '/api/files': 'file:read',
  '/api/download': 'file:read',
  '/api/sheet': 'file:read',
  '/api/admin/users': 'admin:users',
  '/api/admin/roles': 'admin:roles',
  '/api/policy': 'admin:policy',
  '/api/data-perms': 'admin:data-perm',
  '/api/service-quality/targets': 'view',
  '/api/delivery-timeout/teams': 'config:write',
  '/api/im-contact/teams': 'config:write',
  '/api/bot/config': 'admin:bot',
  '/api/bot/status': 'admin:bot',
  '/api/bot/credentials': 'admin:bot',
  // 风神登录凭据（系统设置「风神设置」）：限管理员，明文密码不外泄
  '/api/fetch/settings/aeolus': 'admin:aeolus',
  // 钉钉授权（设备流发起 / 状态查询）：限管理员，绕过 /api/ding/.*→machine 前缀
  '/api/ding/auth/status': 'admin:bot',
  // 钉钉 DWS 配置读取（系统设置页）：限管理员机器人配置权限，绕过 machine 前缀
  '/api/ding/config': 'admin:bot',
  // 钉钉 SSO 配置读取（系统设置页）：限管理员机器人配置权限
  '/api/auth/dingtalk/sso-config': 'admin:bot',
};

export const POST_ROUTE_PERMS: Record<string, string> = {
  '/api/run': 'task:run',
  '/api/stop': 'task:run',
  '/api/cancel': 'task:run',
  '/api/standard/refresh-all': 'data:refresh',
  '/api/delivery-timeout/refresh': 'data:refresh',
  // 运单明细看板刷新：拉全站运单入库，与配送超时刷新同性质，限 data:refresh
  '/api/order-detail/refresh': 'data:refresh',
  '/api/im-contact-fetch/refresh': 'data:refresh',
  '/api/attend-period/config': 'config:write',
  '/api/attend-period/teams': 'config:write',
  '/api/delivery-timeout/teams': 'config:write',
  '/api/cron/lists': 'cron:write',
  '/api/cron/items': 'cron:write',
  '/api/cron/trigger': 'cron:write',
  '/api/cron/import': 'cron:write',
  '/api/groups/used': 'groups:write',
  '/api/groups/forget': 'groups:write',
  '/api/admin/user': 'admin:users',
  '/api/admin/user/update': 'admin:users',
  '/api/admin/user/reset-pw': 'admin:users',
  '/api/admin/user/delete': 'admin:users',
  '/api/admin/role': 'admin:roles',
  '/api/admin/role/update': 'admin:roles',
  '/api/admin/role/delete': 'admin:roles',
  '/api/policy': 'admin:policy',
  '/api/data-perms': 'admin:data-perm',
  '/api/bot/config': 'admin:bot',
  '/api/bot/reload': 'admin:bot',
  '/api/bot/bots': 'admin:bot',
  '/api/bot/credentials': 'admin:bot',
  // 风神登录凭据保存：限管理员
  '/api/fetch/settings/aeolus': 'admin:aeolus',
  // 风神退出登录：限管理员（精确匹配，避免落入默认 'view'）
  '/api/fetch/settings/aeolus/logout': 'admin:aeolus',
  // 风神凭据验证（会真跑一次 SSO 登录）：限管理员，避免任何人拿它当撞库/顶号入口
  '/api/fetch/settings/aeolus/test': 'admin:aeolus',
  // 钉钉授权发起（设备流）：限管理员，绕过 /api/ding/.*→machine 前缀
  '/api/ding/auth/device-login': 'admin:bot',
  // 钉钉退出登录（触发重新授权）：限管理员
  '/api/ding/auth/logout': 'admin:bot',
  // 钉钉 DWS 配置保存（系统设置页）：限管理员机器人配置权限，绕过 machine 前缀
  '/api/ding/config': 'admin:bot',
  // 钉钉 SSO 配置保存（系统设置页）：限管理员机器人配置权限
  '/api/auth/dingtalk/sso-config': 'admin:bot',
  '/api/service-quality/targets': 'config:write',
  '/api/account/change-pw': 'self',
};

// 前缀匹配：proxy/通配端点按前缀归并到合适的权限点（避免逐子路径登记）。
const GET_PREFIX_PERMS: [RegExp, string][] = [
  // 钉钉读取（列群 / 按群名解析）：同样仅内部服务，避免登录用户枚举企业群列表
  [/^\/api\/ding\/.*$/, 'machine'],
  // 配送超时看板的「实时运单明细」读端点（PG → Python 计算的内部接缝）：
  // 仅内部服务（机器令牌）可调，登录用户不能直接枚举全站运单明细。
  [/^\/api\/delivery-timeout-internal\/.*$/, 'machine'],
  // 考核看板的「明细读端点」（PG → Python 计算的内部接缝）：同样仅内部服务可调。
  [/^\/api\/assessment-internal\/.*$/, 'machine'],
  [/^\/api\/std\/.*$/, 'view'],
  [/^\/api\/ov\/.*$/, 'view'],
  [/^\/api\/ap\/.*$/, 'view'],
  [/^\/api\/standard\/.*$/, 'view'],
  [/^\/api\/attend-period\/.*$/, 'view'],
  [/^\/api\/delivery-timeout\/.*$/, 'view'],
  // 运单明细看板：明细查询是只读展示，登录即可看（'view'）
  [/^\/api\/order-detail\/.*$/, 'view'],
  [/^\/api\/im-contact\/.*$/, 'view'],
  [/^\/api\/todo\/.*$/, 'view'],
  [/^\/api\/groups\/.*$/, 'view'],
  [/^\/api\/cookies\/status$/, 'view'],
  [/^\/api\/teams$/, 'view'],
  [/^\/api\/sheet$/, 'file:read'],
  [/^\/api\/data-perms(\/.*)?$/, 'admin:data-perm'],
];
const POST_PREFIX_PERMS: [RegExp, string][] = [
  // 钉钉推送：仅内部服务（有效机器令牌）可调用。往群里发消息是强操作，
  // 不能落回默认的 'view' —— 否则任何登录用户都能触发。
  [/^\/api\/ding\/.*$/, 'machine'],
  [/^\/api\/standard\/refresh-all$/, 'data:refresh'],
  [/^\/api\/standard\/.*$/, 'view'],
  [/^\/api\/attend-period\/(config|teams)$/, 'config:write'],
  [/^\/api\/attend-period\/.*$/, 'view'],
  [/^\/api\/delivery-timeout\/.*$/, 'view'],
  [/^\/api\/order-detail\/.*$/, 'view'],
  [/^\/api\/im-contact\/.*$/, 'view'],
  [/^\/api\/todo\/.*$/, 'cron:write'],
  [/^\/api\/groups\/.*$/, 'groups:write'],
  [/^\/api\/std\/.*$/, 'view'],
  [/^\/api\/ov\/.*$/, 'view'],
  [/^\/api\/ap\/.*$/, 'view'],
  [/^\/api\/cookies\/status$/, 'view'],
  [/^\/api\/teams$/, 'view'],
  [/^\/api\/sheet$/, 'file:read'],
  [/^\/api\/data-perms(\/.*)?$/, 'admin:data-perm'],
];

/** 返回路由所需权限点；未命中映射则默认 'view'（与旧 server 一致）。 */
export function routePerm(method: string, path: string): string {
  const m = method.toUpperCase() === 'POST' ? POST_ROUTE_PERMS : GET_ROUTE_PERMS;
  if (m[path]) return m[path];
  const prefixes = method.toUpperCase() === 'POST' ? POST_PREFIX_PERMS : GET_PREFIX_PERMS;
  for (const [re, perm] of prefixes) if (re.test(path)) return perm;
  return 'view';
}
