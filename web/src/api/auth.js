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

// 钉钉登录相关（JSAPI 免登 / OAuth2 网页登录 / 绑定）
export async function dingtalkConfig() {
  return request('/auth/dingtalk/config');
}
export async function dingtalkJsapi(authCode) {
  return request('/auth/dingtalk/jsapi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authCode }),
  });
}
export async function dingtalkBind(username, unionid) {
  return request('/auth/dingtalk/bind', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, unionid }),
  });
}
