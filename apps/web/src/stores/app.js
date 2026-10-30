import { defineStore } from 'pinia';

// 全局 UI / 外壳状态：连接态、胶囊、导航展开、抽屉、toast、confirm 队列
const NAV_OPEN_KEY = 'wb_nav_open';
const SIDE_KEY = 'wb_side';

export const useAppStore = defineStore('app', {
  state: () => ({
    // 后端可达性（由 /api/health 探测裁决）：true / false / null(未知)
    connected: null,
    sseBroken: false,
    // 后端可达但事件流静默（半开连接 / 重连中）：true 时胶囊显示 muted「事件流重连中」
    sseStale: false,
    // /api/health 返回的三项子服务状态：{ api, python, worker }，每项 { ok, detail, ... }
    // 未探测过时为 { api:null, python:null, worker:null }（UI 显示为「未知」）
    services: { api: null, python: null, worker: null },
    cookie: null,    // { status, checked_at, reason, _net }
    quark: null,     // { status, checked_at, reason, age_hours }
    navOpen: JSON.parse(localStorage.getItem(NAV_OPEN_KEY) || '{}'),
    sideOpen: JSON.parse(localStorage.getItem(SIDE_KEY) || 'true'),
    confirm: null,   // { id, message, title, okText, cancelText, resolve }
    _tid: 0,
  }),
  actions: {
    setConnected(v) { this.connected = v; },
    setSseBroken(v) { this.sseBroken = v; },
    setSseStale(v) { this.sseStale = v; },
    setServices(v) {
      this.services = Object.assign({ api: null, python: null, worker: null }, v || {});
    },
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
  getters: {
    /** 后端（Nest 8787）是否可达：/api/health 能应答即算可达。 */
    apiOk: (s) => s.connected === true,
    /** Python 计算服务（8900）是否可达：由后端代为探测后随 /api/health 下发。 */
    pythonOk: (s) => s.services?.python?.ok === true,
    /**
     * 圆点配色只取「后端 + Python」两项（用户约定）：
     *   · 两者都在线 → 'ok' 绿
     *   · 两者都挂   → 'err' 红
     *   · 任一挂     → 'warn' 黄
     *   · 尚未探测   → 'muted' 灰
     * worker 不参与配色（它不承载看板读请求，挂了的表现是任务一直排队，而非看板打不开），
     * 只在 connTitle 里如实展示。
     */
    connDot: (s) => {
      const api = s.connected === true;
      const py = s.services?.python?.ok === true;
      if (api && py) return 'ok';
      if (!api && !py) return 'err';
      if (s.connected === null && s.services?.python == null) return 'muted';
      return 'warn';
    },
    connText: (s) => {
      if (s.connected === null && s.services?.python == null) return '连接中';
      const api = s.connected === true;
      const py = s.services?.python?.ok === true;
      if (api && py) return s.sseStale ? '事件流重连中' : '已连接';
      if (!api && !py) return '已断开';
      return '部分可用';
    },
    /** tooltip：逐项列出 NestJS / Python / Worker 的状态（只要状态，不带补充说明）。 */
    connTitle: (s) => {
      const svc = s.services || {};
      const fmt = (v) => (v == null ? '未知' : v.ok ? '正常' : '异常');
      const apiLine = `NestJS：${s.connected === false ? '不可达' : s.connected ? '正常' : '未知'}`;
      const pyLine = `Python：${fmt(svc.python)}`;
      const wkLine = `Worker：${fmt(svc.worker)}`;
      return [apiLine, pyLine, wkLine].join('\n');
    },
  },
});
