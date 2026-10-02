import { defineStore } from 'pinia';
import { signin as apiSignin, signout as apiSignout, me as apiMe } from '../api/auth.js';
import { getToken, clearToken } from '../api/request.js';

// 鉴权状态：token(sessionStorage) + 用户信息 + 登录弹窗控制
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: getToken() || '',
    user: null,
    role: null,
    loginVisible: false,
    loginForced: false,
    bootstrapped: false,
  }),
  getters: {
    authenticated: (s) => !!s.token && !!s.user,
    isAdmin: (s) => s.role === 'admin',
  },
  actions: {
    // 启动时：有 token 则校验，否则弹登录
    async bootstrap() {
      if (this.bootstrapped) return;
      this.bootstrapped = true;
      if (!this.token) { this.loginVisible = true; return; }
      try {
        const data = await apiMe();
        if (data && data.authenticated) {
          this.user = data.user; this.role = data.role;
        } else { this.token = ''; clearToken(); this.loginVisible = true; }
      } catch (e) {
        this.token = ''; clearToken(); this.loginVisible = true;
      }
    },
    async signin(username, password) {
      const data = await apiSignin(username, password);
      if (data && data.token) {
        this.token = data.token; this.user = data.user; this.role = data.role;
        this.loginVisible = false; this.loginForced = false;
        return data;
      }
      throw new Error((data && data.message) || '登录失败');
    },
    async signout() {
      try { await apiSignout(); } catch (e) { /* ignore */ }
      this.token = ''; clearToken();
      this.user = null; this.role = null;
      this.loginVisible = true; this.loginForced = true;
    },
    // 任意请求 401 时由 request 层调用 → 强制弹登录
    requireLogin() { this.loginVisible = true; this.loginForced = true; },
  },
});
