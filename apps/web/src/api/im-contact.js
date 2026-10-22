// IM 电联看板自有接口（2026-10-21 从共享的 dashboards.js 迁出）。
//
// 隔离约定：本看板只使用 `/im-contact/*`（数据）与 `/im-contact-fetch/*`（取数）两个命名空间，
// 与其它看板不共用接口文件 —— 改这里的字段/超时/路径不会波及考核、配送超时、标准达成。
import { request } from './request.js';

const enc = encodeURIComponent;
const j = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/* 站点数据：GET /api/im-contact/data?team=<id>&start=<>&end=<>
   （通配转发 Python analytics.im_contact；start/end 为前端展示区间，计算按此进行） */
export function fetchImContact({ team, start, end } = {}) {
  const p = [];
  if (team) p.push('team=' + enc(team));
  if (start) p.push('start=' + enc(start));
  if (end) p.push('end=' + enc(end));
  return request('/im-contact/data' + (p.length ? '?' + p.join('&') : ''));
}

/* 取数落盘：POST /api/im-contact-fetch/refresh {start, end}（Nest 原生，Quark 导出较慢放宽超时） */
export function refreshImContact(body = {}) {
  return request('/im-contact-fetch/refresh', { ...j(body), timeout: 180000 });
}

/* 当前落盘状态（区间 / 取数时间 / fetch_ok），供前端判断所选区间是否已落盘 */
export function fetchImContactStatus() {
  return request('/im-contact-fetch/status');
}

/* 「展示站点」配置（独立命名空间 /im-contact/teams）：GET 返回
   {teams: 已配置展示站点id, all: 全部可选站点{id,name}}；POST 保存（config:write）。 */
export function fetchImContactTeams() {
  return request('/im-contact/teams');
}
export function saveImContactTeams(teams) {
  return request('/im-contact/teams', j({ teams }));
}
