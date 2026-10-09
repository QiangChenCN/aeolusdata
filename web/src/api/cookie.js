import { request } from './request.js';

// 只读探针：返回 { ok, status: 'valid'|'invalid'|'unknown'|..., checked_at, reason, quark:{...} }
export function fetchCookieStatus() {
  return request('/cookies/status');
}
