// 违规处罚（原「不满意单」）看板接口封装。
import { request } from './request.js';

/* 实时接口：整段区间全量（后端自动翻页） */
export function fetchViolationRange({ start_ms, end_ms, page_size, cookie } = {}) {
  return request('/fetch/violation-range', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_ms, end_ms, page_size, cookie }),
  });
}

/* 月累计：按日期区间读取已落库的违规明细（配合含快捷选项的日期范围选择器） */
export function fetchViolationMonthRange({ start, end } = {}) {
  return request('/fetch/violation-month-range', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start, end }),
  });
}

/* 实时看板：读取本地已落盘缓存（按日期区间，不再请求风神） */
export function fetchViolationRangeDb({ start, end } = {}) {
  return request('/fetch/violation-range-db', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start, end }),
  });
}

/* 实时看板：将一批明细落盘（刷新时调用） */
export function saveViolationRows(rows) {
  return request('/fetch/violation-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
}
