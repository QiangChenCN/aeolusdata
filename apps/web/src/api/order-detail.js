// 运单明细看板自有接口（2026-10-24 新建，独立命名空间 /api/order-detail/*）。
//
// 隔离约定：本看板只使用 `/api/order-detail/*`，不与其它看板共用接口文件 ——
// 改这里的字段 / 超时 / 路径不会波及考核、配送超时、标准达成等看板。
import { request } from './request.js';

const enc = encodeURIComponent;
const j = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * 运单明细查询（服务端过滤 + 排序 + 分页）。
 *
 * 支持两种口径：
 *   · 区间：传 start + end（YYYY-MM-DD），联合实时表（当天）与历史表（T-1~T-7）跨日查询；
 *   · 单日：仅传 date（兼容旧调用），等价于 start=end=date。
 *
 * 返回 `{ok, date, team, columns, teams, states, rows, total, page, pageSize, fetched_at}`：
 *   · columns 是列定义（key/label/kind），前端据此渲染表头；
 *   · teams 是该区间各站点的行数，states 是该区间出现过的运单状态（供筛选下拉）。
 */
export function fetchOrderDetail({ start, end, date, team, q, state, sort, order, page, pageSize } = {}) {
  const p = [];
  if (start) p.push('start=' + enc(start));
  if (end) p.push('end=' + enc(end));
  if (date) p.push('date=' + enc(date));
  const tv = Array.isArray(team) ? team.join(',') : team;
  if (tv) p.push('team=' + enc(tv));
  if (q) p.push('q=' + enc(q));
  if (state) p.push('state=' + enc(state));
  if (sort) p.push('sort=' + enc(sort));
  if (order) p.push('order=' + enc(order));
  if (page) p.push('page=' + enc(page));
  if (pageSize) p.push('pageSize=' + enc(pageSize));
  // 区间全站是万级行：服务端要读全量再过滤排序，放宽超时避免误报「请求超时」。
  return request('/order-detail/orders' + (p.length ? '?' + p.join('&') : ''), { timeout: 30000 });
}

/** 刷新：拉全站运单明细入库（同步返回，前端无需轮询）。风神导出较慢，放宽超时。 */
export function refreshOrderDetail({ date } = {}) {
  return request('/order-detail/refresh', { ...j({ date }), timeout: 120000 });
}

/**
 * 历史运单明细状态：滚动窗口（T-1 ~ T-7）每天的入库行数与写入时间，
 * 外加上次滚动运行的逐天结果快照。
 */
export function fetchOrderDetailHistoryStatus() {
  return request('/order-detail/history/status', { timeout: 15000 });
}
