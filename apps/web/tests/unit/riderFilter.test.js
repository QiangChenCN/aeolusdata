import { describe, it, expect } from 'vitest';
import { filterRiders } from '../../src/utils/riderFilter.js';

// 骑手看板筛选纯函数（与 python/analytics/rider_dimension.py 口径一致）。
const rows = [
  { rider_name: '张三', achieved_standard: '已达标', online_status: '在线' },
  { rider_name: '李四', achieved_standard: '未达标', online_status: '小休' },
  { rider_name: '王五', achieved_standard: '已达标', online_status: '下线' },
  { rider_name: '赵六', achieved_standard: '已达标', online_status: '在线' },
];

describe('filterRiders', () => {
  it('无过滤条件返回全部', () => {
    expect(filterRiders(rows)).toHaveLength(4);
  });

  it('按姓名（包含）过滤', () => {
    const r = filterRiders(rows, { name: '张' });
    expect(r).toHaveLength(1);
    expect(r[0].rider_name).toBe('张三');
  });

  it('姓名前后空白被 trim', () => {
    expect(filterRiders(rows, { name: ' 张 ' })).toHaveLength(1);
  });

  it('按达成标准精确匹配', () => {
    expect(filterRiders(rows, { std: '已达标' })).toHaveLength(3);
    expect(filterRiders(rows, { std: '未达标' })).toHaveLength(1);
  });

  it('按在线状态精确匹配', () => {
    expect(filterRiders(rows, { online: '在线' })).toHaveLength(2);
    expect(filterRiders(rows, { online: '下线' })).toHaveLength(1);
  });

  it('组合条件取交集', () => {
    expect(filterRiders(rows, { std: '已达标', online: '在线' })).toHaveLength(2);
  });

  it('空 / 非法输入安全返回空数组', () => {
    expect(filterRiders(null, {})).toEqual([]);
    expect(filterRiders(undefined)).toEqual([]);
  });
});
