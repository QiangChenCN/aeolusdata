import { defineStore } from 'pinia';

// 全局 UI / 外壳状态：连接态、胶囊、导航展开、抽屉、toast、confirm 队列
const NAV_OPEN_KEY = 'wb_nav_open';
const SIDE_KEY = 'wb_side';

export const useAppStore = defineStore('app', {
  state: () => ({
    connected: null, // true / false / null(连接中)
    sseBroken: false,
    cookie: null,    // { status, checked_at, reason, _net }
    quark: null,     // { status, checked_at, reason, age_hours }
    navOpen: JSON.parse(localStorage.getItem(NAV_OPEN_KEY) || '{}'),
    sideOpen: JSON.parse(localStorage.getItem(SIDE_KEY) || 'false'),
    confirm: null,   // { id, message, title, okText, cancelText, resolve }
    _tid: 0,
  }),
  actions: {
    setConnected(v) { this.connected = v; },
    setSseBroken(v) { this.sseBroken = v; },
    setCapsule(kind, data) {
      if (kind === 'cookie') this.cookie = data;
      else if (kind === 'quark') this.quark = data;
    },
    toggleNav(kind) {
      this.navOpen = Object.assign({}, this.navOpen, { [kind]: !this.navOpen[kind] });
      localStorage.setItem(NAV_OPEN_KEY, JSON.stringify(this.navOpen));
    },
    setNavOpen(kind, v) {
      this.navOpen = Object.assign({}, this.navOpen, { [kind]: v });
      localStorage.setItem(NAV_OPEN_KEY, JSON.stringify(this.navOpen));
    },
    toggleSide() {
      this.sideOpen = !this.sideOpen;
      localStorage.setItem(SIDE_KEY, JSON.stringify(this.sideOpen));
    },
    // 返回一个 Promise，用户点确定→resolve(true)，取消/关闭→resolve(false)
    confirmDialog({ message, title = '请确认', okText = '确定', cancelText = '取消' }) {
      return new Promise((resolve) => {
        const id = ++this._tid;
        this.confirm = { id, message, title, okText, cancelText, resolve };
      });
    },
    resolveConfirm(v) {
      if (this.confirm) { this.confirm.resolve(v); this.confirm = null; }
    },
  },
});
