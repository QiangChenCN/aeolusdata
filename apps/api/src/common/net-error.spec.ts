import * as dns from 'dns';
import { probeRuntime } from './net-error';

/**
 * 现场取证的「不得挂住调用方」回归。
 *
 * 事故（2026-10-27）：宿主 DNS 无响应时 `dns.promises.lookup` 既不 resolve 也不 reject
 * （进程里只留一条到 53 端口的 ESTABLISHED 连接）。它当时被用在「阶段 0 取数失败」的
 * catch 里做取证 ⇒ catch 永不返回 ⇒ 刷新的 `finally` 不执行 ⇒ 单飞标记 `running`
 * 永久为 true ⇒ 前端刷新按钮永远「刷新中…」，只能重启后端恢复。
 * 故这里的底线是：**取证永远有上限**，哪怕一条诊断信息都拿不到也要按时返回。
 */
describe('probeRuntime —— 宿主 DNS 无响应时', () => {
  it('探测必须在超时内返回（永不 settle 的 lookup 不得拖住调用方）', async () => {
    const spy = jest
      .spyOn(dns.promises, 'lookup')
      .mockImplementation(() => new Promise<never>(() => {}) as never);
    try {
      const t0 = Date.now();
      const out = await probeRuntime('dns-never-answers.invalid', 443, 300);
      const dt = Date.now() - t0;
      // 300ms 的探测：整体兜底 = 300*2+2000ms，再留些余量。
      expect(dt).toBeLessThan(4000);
      expect(out).toContain('timeout');
      expect(out).toContain('dns=timeout');
    } finally {
      spy.mockRestore();
    }
  }, 15000);
});
