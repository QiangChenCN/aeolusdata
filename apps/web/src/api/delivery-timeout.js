// 配送超时看板自有接口（2026-10-21 从共享的 dashboards.js 迁出）。
//
// 隔离约定：本看板只使用 `/api/delivery-timeout/*` 命名空间（/data · /refresh · /teams），
// 与其他看板不共用接口文件 —— 改这里的字段/超时/路径不会波及标准达成、考核、IM 电联。
import { request } from './request.js';

const enc = encodeURIComponent;
const j = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/* 站点数据：GET /api/delivery-timeout/data?team=<id>
   （通配转发 Python analytics.delivery_timeout：站点超时汇总 + 骑手/订单下钻） */
export function fetchDeliveryTimeout({ team } = {}) {
  const p = [];
  if (team) p.push('team=' + enc(team));
  return request('/delivery-timeout/data' + (p.length ? '?' + p.join('&') : ''));
}

/* 独立刷新：拉全站运单明细落盘（与标准达成落盘文件名一致），标准达成计算时也能读。
   同步返回抓取+落盘结果，前端无需轮询；风神导出可能耗时，放宽超时。 */
export function refreshDeliveryTimeout(body = {}) {
  return request('/delivery-timeout/refresh', { ...j(body), timeout: 120000 });
}

/* 「展示站点」配置（独立命名空间 /delivery-timeout/teams）：GET 返回
   {teams: 已配置展示站点id, all: 全部可选站点{id,name}}；POST 保存展示站点（config:write）。
   未配置任何站点时回落全部站点。 */
export function fetchDeliveryTimeoutTeams() {
  return request('/delivery-timeout/teams');
}
export function saveDeliveryTimeoutTeams(teams) {
  return request('/delivery-timeout/teams', j({ teams }));
}
