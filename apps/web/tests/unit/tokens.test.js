import { describe, it, expect } from 'vitest';
import { STATUS_TXT, STATUS_CLS, GROUP_ICONS, PARAM_CONTROL } from '../../src/utils/tokens.js';

// 状态文案 / 色、分组图标、参数控件类型等常量映射，是 UI 渲染的单一事实来源。
describe('tokens 常量映射', () => {
  it('STATUS_TXT 覆盖五种任务状态文案', () => {
    expect(STATUS_TXT).toMatchObject({
      running: '执行中',
      failed: '失败',
      success: '成功',
      stopped: '已停止',
      queued: '排队中',
    });
  });

  it('STATUS_CLS 每个状态都有非空类名', () => {
    for (const k of ['running', 'failed', 'success', 'stopped', 'queued']) {
      expect(typeof STATUS_CLS[k]).toBe('string');
      expect(STATUS_CLS[k].length).toBeGreaterThan(0);
    }
  });

  it('GROUP_ICONS 含已知业务分组图标', () => {
    expect(GROUP_ICONS.attendance).toBe('UserFilled');
    expect(GROUP_ICONS.delivery).toBe('Van');
  });

  it('PARAM_CONTROL 含常用控件类型', () => {
    expect(PARAM_CONTROL.date).toBe('单日');
    expect(PARAM_CONTROL.daterange).toBe('区间');
    expect(PARAM_CONTROL.multiselect).toBe('多选');
  });
});
