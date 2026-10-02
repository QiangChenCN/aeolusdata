/** 运力等级标准（单量 + 有效在线时长，两者同时满足才算达成该等级）。 */

export interface Standard {
  level: number;
  orders: number;
  hours: number;
}

/**
 * 来源：站点运力等级表（三个站点当前一致）。
 * 修改标准直接改这里（纯数据，不必动逻辑）。
 */
export const STANDARDS: Standard[] = [
  { level: 1, orders: 18, hours: 6 },
  { level: 2, orders: 30, hours: 6 },
  { level: 3, orders: 37, hours: 6 },
  { level: 4, orders: 45, hours: 7 },
  { level: 5, orders: 56, hours: 8 },
];
