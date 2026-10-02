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

/* ============ 工作内容（Todo） ============ */
export function fetchTodo() { return request('/todo'); }
export function postTodoList(op, payload = {}) {
  return request('/todo/lists', j(Object.assign({ op }, payload)));
}
export function postTodoItem(op, payload = {}) {
  return request('/todo/items', j(Object.assign({ op }, payload)));
}
export function triggerTodoItem(itemId) {
  return request('/todo/trigger', j({ item_id: itemId }));
}
export function importTodo(lists, items) {
  return request('/todo/import', j({ lists, items }));
}
export function fetchTodoRuns(itemId, limit = 20) {
  return request('/todo/runs?item_id=' + enc(itemId) + '&limit=' + limit);
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
/* 后端在风神接口失败/无返回时，会把三站兜底放进 `fallback` 而 `teams` 为空；
   前端必须合并两者，否则选择器会空白。优先用 teams，空则回落 fallback。 */
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

/* 等级标准（按月 × 站点配置 std1~5 的单量与时长阈值） */
export function fetchGradeStandards({ month, team } = {}) {
  const p = [];
  if (month) p.push('month=' + enc(month));
  if (team) p.push('team=' + enc(team));
  return request('/standard/grade-standards' + (p.length ? '?' + p.join('&') : ''));
}
export function saveGradeStandard(body = {}) {
  return request('/standard/grade-standards', j(body));
}
/* 门槛/封顶（本月全局，对所有站点统一生效） */
export function fetchThresholds({ month } = {}) {
  const p = [];
  if (month) p.push('month=' + enc(month));
  return request('/standard/thresholds' + (p.length ? '?' + p.join('&') : ''));
}
export function saveThresholds(body = {}) {
  return request('/standard/thresholds', j(body));
}
export function refreshStandard(body = {}) {
  return request('/standard/refresh-all', j(body));
}
export function fetchRefreshStatus() {
  return request('/standard/refresh-all-status');
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

/* ============ 实时数据 ============ */
export function fetchRealtimeStation({ team, start, end } = {}) {
  const p = [];
  if (team) p.push('team=' + enc(team));
  if (start) p.push('start=' + enc(start));
  if (end) p.push('end=' + enc(end));
  return request('/realtime/station' + (p.length ? '?' + p.join('&') : ''));
}

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
export function fetchBotCredentials() { return request('/bot/credentials'); }
export function saveBotCredentials(groups) { return request('/bot/credentials', j({ groups })); }
