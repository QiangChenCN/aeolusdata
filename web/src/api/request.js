// 请求层：统一封装 fetch（同源 Cookie 自动携带会话、超时、401 回调、GET 5xx 重试一次、中文报错）。
// 鉴权改为 HttpOnly 会话 Cookie：登录后后端通过 Set-Cookie 下发，浏览器同源请求自动携带，
// 不再由前端手动维护 X-Token 头或 sessionStorage（避免 XSS 窃取长时效令牌）。
const API_BASE = '/api';

let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) { unauthorizedHandler = fn; }
function emitUnauthorized() { if (unauthorizedHandler) unauthorizedHandler(); }

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/** 返回解析后的 JSON（2xx）；非 2xx 抛 ApiError；401 触发登录重定向。 */
export async function request(path, opts = {}) {
  const url = path.startsWith('http') ? path : API_BASE + path;
  const headers = Object.assign({}, opts.headers);

  const ctrl = new AbortController();
  const timeout = opts.timeout ?? 15000;
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    // credentials: 'include' 确保同源（及跨源）请求携带会话 Cookie；
    // 同源场景浏览器本就会带，这里显式声明以兼容可能的跨源部署。
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
      signal: ctrl.signal,
      credentials: 'include',
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new ApiError('请求超时，请稍后再试', 0);
    throw new ApiError('网络异常：' + e.message, 0);
  }
  clearTimeout(timer);

  if (res.status === 401) {
    emitUnauthorized();
    throw new ApiError('登录已失效，请重新登录', 401);
  }
  // GET 5xx 重试一次（与旧逻辑一致：/api/state 等偶发 502）
  if ((!opts.method || opts.method === 'GET') && res.status >= 500 && res.status < 600 && !opts._retried) {
    return request(path, Object.assign({}, opts, { _retried: true }));
  }

  const ct = res.headers.get('Content-Type') || '';
  let data = null;
  if (ct.includes('application/json')) data = await res.json().catch(() => ({}));
  else data = await res.text().catch(() => '');

  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `请求失败（${res.status}）`;
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

/** 返回原始 Response（用于需要自定义解码的文本/二进制）。 */
export function requestRaw(path, opts = {}) {
  const url = path.startsWith('http') ? path : API_BASE + path;
  const headers = Object.assign({}, opts.headers);
  return fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
    signal: opts.signal,
    credentials: 'include',
  });
}
