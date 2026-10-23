// 看板 / 业务模块接口封装。取代原原生 app 各视图里散落的 fetch 调用。
import { request } from './request.js';

const enc = encodeURIComponent;
const j = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/* ============ 运行记录 ============ */
export function fetchHistory() { return request('/history'); }

/* ============ 自动任务（Cron） ============ */
export function fetchCron() { return request('/cron'); }
export function postCronList(op, payload = {}) {
  return request('/cron/lists', j(Object.assign({ op }, payload)));
}
export function postCronItem(op, payload = {}) {
  return request('/cron/items', j(Object.assign({ op }, payload)));
}
export function triggerCronItem(itemId) {
  return request('/cron/trigger', j({ item_id: itemId }));
}
/** 全局「自动执行」总开关：paused=true 暂停全部自动任务的点火与重试。 */
export function setCronAutoPaused(paused) {
  return request('/cron/auto-paused', j({ paused }));
}
export function importCron(lists, items) {
  return request('/cron/import', j({ lists, items }));
}
export function fetchCronRuns(itemId, limit = 20) {
  return request('/cron/runs?item_id=' + enc(itemId) + '&limit=' + limit);
}

/* ============ 群组 ============ */
export function fetchGroups(q) {
  return request('/groups' + (q != null && q !== '' ? '?q=' + enc(q) : ''));
}
export function markGroupUsed(id, title) {
  return request('/groups/used', j({ id, title }));
}
export function forgetGroup(id) {
  return request('/groups/forget', j({ id }));
}

/* ============ 站点目录 ============ */
/* 站点目录的唯一来源是 `GET /api/teams`（数据来自 Nest 落盘的 apps/api/runtime/teams.json，
   由风神真实站点目录写入）。成功时 `teams` 为真实站点列表、`fallback` 为空；
   风神不可达时 `teams` 为空、`fallback` 回落落盘文件。前端合并两者，优先 teams，空则回落 fallback。 */
export async function fetchTeams() {
  const t = await request('/teams');
  const arr = (t && (Array.isArray(t.teams) && t.teams.length ? t.teams : t.fallback)) || [];
  return { teams: arr };
}

/* ============ 标准达成 ============ */
export function fetchStandardAchievement({ team, start, end } = {}) {
  const p = [];
  if (team) p.push('team=' + enc(team));
  if (start) p.push('start=' + enc(start));
  if (end) p.push('end=' + enc(end));
  return request('/standard/achievement' + (p.length ? '?' + p.join('&') : ''));
}
export function fetchStandardStationReport({ team, start, end, month } = {}) {
  const p = [];
  if (team) p.push('team=' + enc(team));
  if (start) p.push('start=' + enc(start));
  if (end) p.push('end=' + enc(end));
  if (month) p.push('month=' + enc(month));
  return request('/standard/station-report' + (p.length ? '?' + p.join('&') : ''));
}
export function fetchStandardRiders({ team, start, end, month } = {}) {
  const p = [];
  if (team) p.push('team=' + enc(team));
  if (start) p.push('start=' + enc(start));
  if (end) p.push('end=' + enc(end));
  if (month) p.push('month=' + enc(month));
  return request('/standard/riders' + (p.length ? '?' + p.join('&') : ''));
}

/* 「标准达成设置」（按月份 × 站点：默认模板 + 该月各站点档位），看板与机器人共用 */
export function fetchStandardGradeGlobal(month) {
  const q = month ? '?month=' + encodeURIComponent(month) : '';
  return request('/standard/grade-global' + q);
}
export function saveStandardGradeGlobal(body = {}) {
  return request('/standard/grade-global', j(body));
}
export function refreshStandard(body = {}) {
  return request('/standard/refresh-all', j(body));
}
export function fetchRefreshStatus() {
  return request('/standard/refresh-all-status');
}

/* ============ 服务质量考核设置（考核项 × 周中/周末 × 天气，按月份） ============ */
export function fetchServiceQualityTargets(month) {
  const q = month ? '?month=' + encodeURIComponent(month) : '';
  return request('/service-quality/targets' + q);
}
export function saveServiceQualityTargets(body = {}) {
  return request('/service-quality/targets', j(body));
}

/* ============ 时段出勤 ============ */
/* 站点配置：GET 返回 {teams: 已配置展示站点id, all: 全部可选站点{id,name}}；POST 保存配置 */
export function fetchAttendTeams() {
  return request('/attend-period/teams');
}
export function saveAttendTeams(teams) {
  return request('/attend-period/teams', j({ teams }));
}
export function fetchAttendValid({ team, date, refresh } = {}) {
  const p = [];
  if (team) p.push('team=' + enc(team));
  if (date) p.push('start=' + enc(date)); // 后端该端点按 start 字段读取日期
  if (refresh) p.push('refresh=1');        // 必须显式传 refresh 才会真正拉取实时数据
  // 实时计算逐站逐时段拉取风神考勤，首次约 30~40s；放宽超时避免误报"请求超时"。
  return request('/attend-period/valid' + (p.length ? '?' + p.join('&') : ''), { timeout: 30000 });
}
export function fetchAttendDataset({ team, date, refresh } = {}) {
  const p = [];
  if (team) p.push('team=' + enc(team));
  if (date) p.push('start=' + enc(date));
  if (refresh) p.push('refresh=1');
  // 实时计算逐站拼装骑手×时段明细，首次约 30~40s；放宽超时避免误报「请求超时」。
  return request('/attend-period/dataset' + (p.length ? '?' + p.join('&') : ''), { timeout: 120000 });
}

/* ============ 总览 ============ */
export function fetchOverviewSiteOrders({ start, end } = {}) {
  const p = [];
  if (start) p.push('start=' + enc(start));
  if (end) p.push('end=' + enc(end));
  return request('/overview/site-orders' + (p.length ? '?' + p.join('&') : ''));
}
export function fetchOverviewStandard({ start, end } = {}) {
  const p = [];
  if (start) p.push('start=' + enc(start));
  if (end) p.push('end=' + enc(end));
  return request('/overview/standard' + (p.length ? '?' + p.join('&') : ''));
}
export function fetchOverviewAssessment({ date } = {}) {
  const p = [];
  if (date) p.push('date=' + enc(date));
  return request('/overview/assessment' + (p.length ? '?' + p.join('&') : ''));
}

/* ============ 考核看板 ============ */
/** 读取服务端自动取数配置（enabled / intervalSec，多端共享）：前端「自动/手动」与间隔选择以此为准。 */
export function fetchAssessmentAutoConfig() {
  return request('/assessment-fetch/auto');
}
/** 写入服务端自动取数配置：enabled=自动开关，intervalSec=取数间隔（秒）。 */
export function saveAssessmentAutoConfig({ enabled, intervalSec } = {}) {
  return request('/assessment-fetch/auto', j({ enabled, intervalSec }));
}
export function fetchAssessmentStation({ team, teams, start, end } = {}) {
  const p = [];
  if (team) p.push('team=' + enc(team));
  // 批量：teams 为站点 id 数组，拼成逗号分隔一次性取回（替代前端逐站 N 次请求）。
  if (teams && teams.length) p.push('teams=' + enc(teams.join(',')));
  if (start) p.push('start=' + enc(start));
  if (end) p.push('end=' + enc(end));
  // 首刷后全站 cache miss 会触发整批重算（9 站一次），耗时明显，故设 30s 超时避免被误判「请求超时」。
  return request('/assessment/station' + (p.length ? '?' + p.join('&') : ''), { timeout: 30000 });
}
/* 考核看板「展示站点」配置（/assessment/teams）：GET 返回
   {teams: 已配置展示站点id, all: 全部可选站点{id,name}}；POST 保存展示站点。
   未配置任何站点时回落全部站点。仅控制前端展示，不影响考核计算（计算仍按 team 全量可用）。 */
export function fetchAssessmentTeams() {
  return request('/assessment/teams');
}
export function saveAssessmentTeams(teams) {
  return request('/assessment/teams', j({ teams }));
}

/* 注：配送超时看板的接口已迁到 api/delivery-timeout.js（2026-10-21，看板独立）。 */

/* 考核看板自有刷新：独立拉取违规处罚明细入库（与标准达成取数解耦，见 Nest AssessmentViolationFetchService） */
export function refreshAssessment({ teams = [], date, manual = false } = {}) {
  return request('/assessment-fetch/violation', j({ teams, date, manual }));
}
/* 考核看板刷新时一并拉取运单明细（看板主指标推配送/完成/T8 依赖 PG 表 delivery_realtime，
   由 Nest AssessmentDeliveryFetchService 入库）。 */
export function refreshAssessmentDelivery(body = {}) {
  // 风神导出运单较慢，放宽超时到 120s，避免默认 15s 被中断误报「运单数据拉取失败」
  return request('/assessment-fetch/delivery', { ...j(Object.assign({ manual: true }, body)), timeout: 120000 });
}
/** 查询手动刷新冷却剩余（页面加载恢复读秒用）。 */
export function fetchRefreshCooldown() {
  return request('/assessment-fetch/refresh-cooldown');
}
/** 主动写入一次冷却时间戳（如从自动切回手动时默认 1 分钟冷却）。不触发取数。 */
export function markRefreshCooldown() {
  return request('/assessment-fetch/refresh-cooldown', j({}));
}
/* 配送超时看板的刷新与站点配置接口见 api/delivery-timeout.js（已迁出本共享文件）。 */

/* IM 电联看板的接口已迁到 api/im-contact.js（2026-10-21，看板独立）。 */

/* ============ 系统设置（Admin） ============ */
export function fetchUsers() { return request('/admin/users'); }
export function createUser({ username, password, role }) {
  return request('/admin/user', j({ username, password, role }));
}
export function updateUser(payload) { return request('/admin/user/update', j(payload)); }
export function resetUserPw({ username, password }) {
  return request('/admin/user/reset-pw', j({ username, password }));
}
export function deleteUser(username) { return request('/admin/user/delete', j({ username })); }

export function fetchRoles() { return request('/admin/roles'); }
export function saveRole(op, payload = {}) {
  return request('/admin/role' + (op === 'update' ? '/update' : op === 'delete' ? '/delete' : ''),
    j(Object.assign({ op }, payload)));
}
export function fetchPolicy() { return request('/policy'); }
export function savePolicy(patch) { return request('/policy', j(patch)); }
export function changePw({ old_password, new_password }) {
  return request('/account/change-pw', j({ old_password, new_password }));
}

/* ============ 钉钉机器人配置（Admin） ============ */
export function fetchBotConfig() { return request('/bot/config'); }
export function saveBotConfig(patch = {}) { return request('/bot/config', j(patch)); }
export function reloadBot() { return request('/bot/reload', j({})); }
export function fetchBotStatus() { return request('/bot/status'); }
export function setBotEnabled(botId, enabled) { return request('/bot/bots', j({ botId, enabled })); }
export function setBotCredentialsRef(botId, ref) { return request('/bot/bots', j({ botId, credentialsRef: ref })); }
/** 通用实例补丁：可同时/分别传 enabled / credentialsRef / displayName。 */
export function patchBot(botId, patch = {}) { return request('/bot/bots', j(Object.assign({ botId }, patch))); }
export function fetchBotCredentials() { return request('/bot/credentials'); }
export function saveBotCredentials(groups) { return request('/bot/credentials', j({ groups })); }

/* ============ 钉钉授权（设备流 WebUI） ============ */
export function dingAuthStart() { return request('/ding/auth/device-login', { ...j({}), timeout: 30000 }); }
export function dingAuthStatus() { return request('/ding/auth/status'); }
export function dingAuthLogout() { return request('/ding/auth/logout', j({})); }

/* ============ 钉钉 CLI 配置（WebUI 设置） ============ */
export function dingConfig() { return request('/ding/config'); }
export function saveDingConfig(patch = {}) { return request('/ding/config', j({ patch })); }

// 钉钉 SSO（免登 / OAuth2 扫码）配置：前端可持久化，无需改 .env
export function getSsoConfig() { return request('/auth/dingtalk/sso-config'); }
export function saveSsoConfig(patch = {}) { return request('/auth/dingtalk/sso-config', j(patch)); }

/* ============ 风神账号配置（WebUI 系统设置） ============ */
export function fetchAeolusCreds() { return request('/fetch/settings/aeolus'); }
export function saveAeolusCreds({ account, password } = {}) {
  return request('/fetch/settings/aeolus', j({ account, password }));
}
export function logoutAeolus() { return request('/fetch/settings/aeolus/logout', j({})); }
// 凭据验证：跑一遍完整 SSO 登录并探活 cookie。不传参=用已保存凭据（通过则落盘 cookie）；
// 传 {account,password} = 试登验证，不落盘。
export function testAeolusCreds({ account, password } = {}) {
  return request('/fetch/settings/aeolus/test', j({ account, password }));
}
