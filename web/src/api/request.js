// 请求层：统一封装 fetch（X-Token 头、超时、401 回调、GET 5xx 重试一次、中文报错）。
// 替代原 main.js 的 api()；令牌存 sessionStorage（键名沿用 wb_token，兼容旧会话）。
const TOKEN_KEY = 'wb_token';
const API_BASE = '/api';

export function getToken() { return sessionStorage.getItem(TOKEN_KEY) || ''; }
export function setToken(t) { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); }
export function clearToken() { sessionStorage.removeItem(TOKEN_KEY); }

let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) { unauthorizedHandler = fn; }
function emitUnauthorized() { if (unauthorizedHandler) unauthorizedHandler(); }

/** 给一个路径拼上 ?token= （仅用于 <img>/<iframe>/EventSource 等不能加请求头的地方） */
export function withToken(path) {
  const t = getToken();
  if (!t) return path;
  const sep = path.includes('?') ? '&' : '?';
  return path + sep + 'token=' + encodeURIComponent(t);
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/** 返回解析后的 JSON（2xx）；非 2xx 抛 ApiError；401 触发登录弹窗。 */
export async function request(path, opts = {}) {
  const url = path.startsWith('http') ? path : API_BASE + path;
  const headers = Object.assign({}, opts.headers);
  const token = getToken();
  if (token) headers['X-Token'] = token;

  const ctrl = new AbortController();
  const timeout = opts.timeout ?? 15000;
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
      signal: ctrl.signal,
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
  const token = getToken();
  if (token) headers['X-Token'] = token;
  return fetch(url, { method: opts.method || 'GET', headers, body: opts.body, signal: opts.signal });
}
