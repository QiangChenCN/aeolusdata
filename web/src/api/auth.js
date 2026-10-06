import { request } from './request.js';

// 登录/登出不再由前端存令牌：后端在 signin 响应里 Set-Cookie(wb_token, HttpOnly)，
// 后续同源请求由浏览器自动携带；logout 由后端清 Cookie。
export async function signin(username, password, remember = false) {
  return request('/auth/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, remember }),
  });
}

export async function signout() {
  return request('/auth/logout', { method: 'POST' });
}

export async function me() {
  return request('/auth/me');
}
