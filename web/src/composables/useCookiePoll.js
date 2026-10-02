import { fetchCookieStatus } from '../api/cookie.js';
import { useAppStore } from '../stores/app.js';

// Cookie / Quark 探针链：打开即探一次，之后每 60s±15s 探一次；可见性恢复立即补探
export function useCookiePoll() {
  const app = useAppStore();
  let timer = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const data = await fetchCookieStatus();
      if (data) {
        app.setCapsule('cookie', {
          status: data.status, checked_at: data.checked_at, reason: data.reason, _net: false,
        });
        if (data.quark) app.setCapsule('quark', data.quark);
      }
    } catch (e) {
      app.setCapsule('cookie', { status: 'unknown', checked_at: '', reason: '校验异常', _net: true });
    }
    schedule();
  }
  function schedule() {
    if (stopped) return;
    const base = 60000, jitter = (Math.random() * 2 - 1) * 15000;
    timer = setTimeout(tick, base + jitter);
  }
  function onVisible() { if (!document.hidden && !timer) tick(); }
  function start() {
    stopped = false;
    tick();
    document.addEventListener('visibilitychange', onVisible);
  }
  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    document.removeEventListener('visibilitychange', onVisible);
  }
  return { start, stop };
}
