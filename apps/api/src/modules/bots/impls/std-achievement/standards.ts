/** 运力等级标准（单量 + 有效在线时长，两者同时满足才算达成该等级）。
 * 具体档位（单量/时长要求）由「考核设置」按 (月,站) 配置，运行时读取，不再在此写死。 */
export interface Standard {
  level: number;
  orders: number;
  hours: number;
}
