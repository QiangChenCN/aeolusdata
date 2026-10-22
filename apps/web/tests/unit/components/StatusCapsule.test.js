import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import StatusCapsule from '../../../src/components/common/StatusCapsule.vue';

// 组件渲染测试：状态胶囊把语义 dot 映射到 el-tag type，并渲染 label / text。
// 验证「圆点语义 -> Element 视觉状态色」这一层不会因重构而错位。
describe('StatusCapsule 渲染', () => {
  it('dot=ok 映射到 el-tag 的 success 类型并渲染 label', () => {
    const w = mount(StatusCapsule, { props: { dot: 'ok', label: '运行中' } });
    expect(w.html()).toContain('el-tag');
    expect(w.html()).toContain('success');
    expect(w.find('.cap-label').text()).toBe('运行中');
  });

  it('默认 dot=muted 映射到 info', () => {
    const w = mount(StatusCapsule, { props: {} });
    expect(w.html()).toContain('info');
  });

  it('dot=err 映射到 danger', () => {
    const w = mount(StatusCapsule, { props: { dot: 'err' } });
    expect(w.html()).toContain('danger');
  });

  it('dot=warn 映射到 warning', () => {
    const w = mount(StatusCapsule, { props: { dot: 'warn' } });
    expect(w.html()).toContain('warning');
  });

  it('text 文案被渲染', () => {
    const w = mount(StatusCapsule, { props: { dot: 'info', text: '12 条' } });
    expect(w.find('.cap-text').text()).toBe('12 条');
  });
});
