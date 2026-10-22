import { describe, it, expect } from 'vitest';
import { AEOLUS_MONOREPO_NAME, sleep, greet } from '@aeolus/shared';

// 跨应用共享包：常量 + 纯工具，零 DOM 依赖，最便宜的单元覆盖。
describe('@aeolus/shared', () => {
  it('导出统一的 monorepo 名', () => {
    expect(AEOLUS_MONOREPO_NAME).toBe('aeolusdata');
  });

  it('greet 用 monorepo 名拼接 scope', () => {
    expect(greet('web')).toBe('[aeolusdata] hello from web');
  });

  it('sleep 在指定毫秒后 resolve', async () => {
    const t0 = Date.now();
    await sleep(10);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(8);
  });
});
