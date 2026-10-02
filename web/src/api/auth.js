import { request, setToken, clearToken } from './request.js';

export async function signin(username, password) {
  const data = await request('/auth/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (data && data.token) setToken(data.token);
  return data;
}

export async function signout() {
  try { await request('/auth/logout', { method: 'POST' }); } finally { clearToken(); }
}

export async function me() {
  return request('/auth/me');
}
