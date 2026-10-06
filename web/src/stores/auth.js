import { defineStore } from 'pinia';
import { signin as apiSignin, signout as apiSignout, me as apiMe } from '../api/auth.js';

// 由 App.vue 注入：将用户送到登录页（保留当前页用于登录后返回）。
// store 不直接依赖 router，避免循环引用。
let loginRedirector = null;
export function setLoginRedirector(fn) { loginRedirector = fn; }

// 会话校验的 Promise：路由守卫与 App.vue 可能同时发起 bootstrap（初始导航未完成时 App 已挂载），
// 必须共用同一个 Promise，否则后发起的一方会因「已在引导中」而跳过等待，
// 拿到尚未填充的登录态 → 误判未登录 → 刷新即跳登录页。
let bootPromise = null;

// 鉴权状态：登录态完全由后端会话 Cookie 决定。前端只缓存「me 校验得到的用户信息」，
// 用于界面展示与路由守卫判定；不持有令牌本身（HttpOnly Cookie 由浏览器管理，XSS 不可读）。
export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    role: null,
  }),
  getters: {
    authenticated: (s) => !!s.user,
    isAdmin: (s) => s.role === 'admin',
  },
  actions: {
    // 启动时：调 /auth/me 校验会话 Cookie；有效则填充用户信息，无效则保持未登录（由路由守卫跳登录页）。
    // 幂等：多次调用共享同一个 Promise，调用方 await 到的永远是「校验已完成」的时点。
    async bootstrap() {
      if (!bootPromise) {
        bootPromise = (async () => {
          try {
            const data = await apiMe();
            if (data && data.authenticated) {
              this.user = data.user; this.role = data.role;
            }
          } catch (e) { /* 未登录 / 网络异常：保持 user=null，等待守卫重定向 */ }
        })();
      }
      await bootPromise;
    },
    async signin(username, password, remember = false) {
      const data = await apiSignin(username, password, remember);
      if (data && data.token) {
        this.user = data.user; this.role = data.role;
        return data;
      }
      throw new Error((data && data.error) || '登录失败');
    },
    async signout() {
      try { await apiSignout(); } catch (e) { /* ignore */ }
      this.user = null; this.role = null;
      this.requireLogin();
    },
    // 401 或主动退出时触发：重定向到登录页（保留当前页用于登录后返回）。
    requireLogin() { if (loginRedirector) loginRedirector(); },
  },
});
